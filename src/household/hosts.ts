import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import {
  NEIGHBOUR_HOSTS,
  type CommandResult,
  type DialogueLine,
  type GiftExchangeModule,
  type GiftHandoverStep,
  type HandItem,
  type HouseholdActivity,
  type HouseholdMemberId,
  type HouseholdMemberSnapshot,
  type HouseholdModule,
  type ItemRejection,
  type LocationId,
  type NeighbourHostId,
  type Placement,
  type ReactionCause,
} from '../core/homes';
import { TUNING, type Tuning } from '../core/tuning';
import type { DialogueCatalogue } from './dialogue';
import type { HouseholdMemberView } from './household';
import { HOST_DIALOGUE, HOST_DIALOGUE_AFTER_AARTI } from './hostDialogue';

/** Where Uncle and Aunty stand; `NeighbourHomeLayout` provides it. */
export interface HostsLayout {
  readonly hosts: Readonly<Record<NeighbourHostId, Placement>>;
  /** The gift receiver turns to this facing to set the box down and lift the return box. */
  readonly sideTable?: { readonly yaw: number };
}

/** Placeholder hospitality tuning; times in seconds. */
export const HOSTS_BEHAVIOUR = {
  /** After the player comes in, Uncle recognises them this long later. */
  entryDelay: 1.2,
  /** Who greets first and asks after the family. */
  greeter: 'uncle' as NeighbourHostId,
  /** Who offers mithai once the greeter has finished. */
  offerer: 'aunty' as NeighbourHostId,
  /** Who answers the player eating, in order of preference. */
  eatResponders: ['aunty', 'uncle'] as readonly NeighbourHostId[],
} as const;

/** What the receiver of the gift does at each handover step. */
const HANDOVER_ACTIVITY: Readonly<Record<GiftHandoverStep, HouseholdActivity>> = {
  receiving: 'receivingGift',
  settingAside: 'settingGiftAside',
  giving: 'givingGift',
};
const HANDOVER_ACTIVITIES: readonly HouseholdActivity[] = Object.values(HANDOVER_ACTIVITY);

/** What eating next door needs to know about the hands. `HeldItems` satisfies it. */
export interface HostHands {
  readonly hands: HandItem | null;
}

export interface NeighbourHostsOptions {
  /** Follows `locationChanged`, `aartiCompleted` and the gift events; publishes `householdReacted` and `itemRejected`. */
  readonly bus: GameEventBus;
  readonly layout: HostsLayout;
  /** Without it, nothing in hand keeps the player from eating. */
  readonly hands?: HostHands;
  /** The gift handover the receiver acts out; without it, nobody does. */
  readonly gifts?: Pick<GiftExchangeModule, 'handover'>;
  readonly dialogue?: DialogueCatalogue;
  /** Greetings used instead once aarti has completed at home. */
  readonly afterAarti?: DialogueCatalogue;
  readonly tuning?: Tuning;
  /** Where the player is when the hosts are created; outdoors by default. */
  readonly location?: LocationId;
}

type MutableView = { -readonly [K in keyof HouseholdMemberView]: HouseholdMemberView[K] };

interface Host {
  readonly id: NeighbourHostId;
  readonly view: MutableView;
  /** Seconds until this host may react again. */
  cooldown: number;
  /** Seconds the current line stays up. */
  lineLeft: number;
  /** Next variation to use, per cause, so lines rotate rather than repeat. */
  readonly nextLine: Partial<Record<ReactionCause, number>>;
}

/** How far the welcome on the current visit has got. */
type Welcome =
  /** Waiting for Uncle to notice the player who just came in. */
  | 'noticing'
  /** Uncle is greeting; Aunty offers mithai once he has finished. */
  | 'greeting'
  /** Aunty is due to offer mithai. */
  | 'offering'
  /** Both have welcomed the player this visit, or the player is not here. */
  | 'done';

const OK: CommandResult<ItemRejection> = Object.freeze({ ok: true });

/**
 * Uncle and Aunty next door (issue #65): familiar hosts who welcome the
 * player on every visit, at any point in the evening, as often as they come.
 *
 * - A moment after the player comes in, Uncle recognises them and asks after
 *   the family; when he has finished, Aunty offers mithai. Neither depends
 *   on a gift or on aarti, though once aarti is over at home they ask how it
 *   went. If one of them is still mid-line or on cooldown (a quick
 *   in-and-out), the welcome waits for them rather than being skipped.
 * - The player may greet either of them again at any time (`react`), and eat
 *   from their mithai table whenever their hands are free of a gift box
 *   (`eatMithai`). This is not the family tray: it is never gated on aarti
 *   and publishes no `sweetsEaten`, which belongs to the family's tray.
 * - The special gift exchange (#66) is decided by `GiftExchange`; the hosts
 *   act it out. As the box changes hands they fall quiet — any line cut
 *   short, cooldowns cleared, the rest of the welcome dropped — so Uncle's
 *   thanks comes at once and nobody is holding out mithai meanwhile; Uncle
 *   then takes each handover step as an activity (`receivingGift`,
 *   `settingGiftAside`, `givingGift`), which is what his hands hold.
 *   Mithai waits until the handover is done.
 *
 * Time is the fixed step from `update(dt)`, so pausing freezes the welcome
 * and lines. Reactions are bounded exactly like the family's: one line per
 * host at a time, held `dialogueDuration`, at most one per
 * `reactionCooldown`. Renderer-free; views are live and reused.
 */
export class NeighbourHosts implements HouseholdModule {
  private readonly bus: GameEventBus;
  private readonly layout: HostsLayout;
  private readonly hands: HostHands | undefined;
  private readonly gifts: Pick<GiftExchangeModule, 'handover'> | undefined;
  private readonly dialogue: DialogueCatalogue;
  private readonly later: DialogueCatalogue;
  private readonly tuning: Tuning;
  private readonly initialLocation: LocationId;
  private readonly roster: Host[];
  private readonly byId: Map<HouseholdMemberId, Host>;
  private readonly viewCache: MutableView[];
  private readonly unsubscribes: Unsubscribe[] = [];

  private location: LocationId;
  private aartiDone = false;
  private welcome: Welcome = 'done';
  /** Seconds until Uncle notices the player, while `noticing`. */
  private noticeIn = 0;
  private visitCount = 0;
  private mithaiCount = 0;

  constructor(options: NeighbourHostsOptions) {
    this.bus = options.bus;
    this.layout = options.layout;
    this.hands = options.hands;
    this.gifts = options.gifts;
    this.dialogue = options.dialogue ?? HOST_DIALOGUE;
    this.later = options.afterAarti ?? HOST_DIALOGUE_AFTER_AARTI;
    this.tuning = options.tuning ?? TUNING;
    this.initialLocation = options.location ?? 'outdoors';
    this.location = this.initialLocation;
    this.roster = NEIGHBOUR_HOSTS.map((id) => this.createHost(id));
    this.byId = new Map(this.roster.map((host) => [host.id, host]));
    this.viewCache = this.roster.map((host) => host.view);
    if (this.location === 'neighbourHome') this.arrive('neighbourHome');

    this.unsubscribes.push(
      this.bus.on('locationChanged', ({ to }) => this.arrive(to)),
      this.bus.on('aartiCompleted', () => (this.aartiDone = true)),
      this.bus.on('giftReceived', () => this.makeRoom()),
      this.bus.on('giftExchanged', () => this.followHandover()),
    );
  }

  /** Visits this session, counted as the player comes through the door. */
  get visits(): number {
    return this.visitCount;
  }

  /** Mithai eaten next door this session; unlimited. */
  get mithaiEaten(): number {
    return this.mithaiCount;
  }

  /** True until both hosts have welcomed the player on this visit. */
  get welcoming(): boolean {
    return this.welcome !== 'done';
  }

  members(): readonly HouseholdMemberSnapshot[] {
    return this.viewCache;
  }

  views(): readonly HouseholdMemberView[] {
    return this.viewCache;
  }

  /** A keepable copy of one host's view. */
  get(id: HouseholdMemberId): HouseholdMemberView | undefined {
    const view = this.byId.get(id)?.view;
    if (!view) return undefined;
    return { ...view, placement: { position: { ...view.placement.position }, yaw: view.placement.yaw } };
  }

  react(member: HouseholdMemberId, cause: ReactionCause): DialogueLine | null {
    const host = this.byId.get(member);
    if (!host || host.view.line !== null || host.cooldown > 0) return null;
    const variants = (this.aartiDone ? this.later[cause]?.[member] : undefined) ?? this.dialogue[cause]?.[member];
    if (!variants || variants.length === 0) return null;
    const index = host.nextLine[cause] ?? 0;
    host.nextLine[cause] = (index + 1) % variants.length;
    const variant = variants[index % variants.length]!;
    const { dialogueDuration, reactionCooldown } = this.tuning.homes;
    const line: DialogueLine = { member, text: variant.text, gesture: variant.gesture, duration: dialogueDuration };
    host.view.line = line;
    host.view.talking = true;
    host.lineLeft = dialogueDuration;
    host.cooldown = Math.max(reactionCooldown, dialogueDuration);
    this.bus.emit('householdReacted', { line });
    return line;
  }

  /**
   * Eat from Uncle and Aunty's table: unlimited, at any point in the evening.
   * Refused only away from their home or while a gift box (or the thali)
   * fills the hands; the refusal goes out as `itemRejected` like the family
   * tray's. Whichever host is free answers.
   */
  eatMithai(): CommandResult<ItemRejection> {
    if (this.location !== 'neighbourHome') return this.reject('outOfReach');
    if (this.gifts?.handover) return this.reject('midHandover');
    const held = this.hands?.hands?.kind;
    if (held === 'giftBox') return this.reject('carryingGift');
    if (held === 'thali') return this.reject('holdingThali');
    this.mithaiCount++;
    for (const id of HOSTS_BEHAVIOUR.eatResponders) if (this.react(id, 'ateSweets')) break;
    return OK;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    for (const host of this.roster) {
      host.view.activityTime += dt;
      host.cooldown = Math.max(0, host.cooldown - dt);
      if (host.view.line !== null) {
        host.lineLeft -= dt;
        if (host.lineLeft <= 0) {
          host.view.line = null;
          host.view.talking = false;
        }
      }
    }
    this.stepWelcome(dt);
    this.followHandover();
  }

  /** Fresh session: no visits yet, aarti not done, both hosts quiet in their places. */
  reset(): void {
    this.aartiDone = false;
    this.visitCount = 0;
    this.mithaiCount = 0;
    this.welcome = 'done';
    this.location = this.initialLocation;
    for (const host of this.roster) {
      this.place(host, this.layout.hosts[host.id]);
      host.cooldown = 0;
      host.lineLeft = 0;
      host.view.line = null;
      host.view.talking = false;
      for (const cause of Object.keys(host.nextLine) as ReactionCause[]) delete host.nextLine[cause];
      this.setActivity(host, 'idle');
    }
    if (this.location === 'neighbourHome') this.arrive('neighbourHome');
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── the welcome ────────────────────────────────────────────────────────

  private arrive(to: LocationId): void {
    this.location = to;
    if (to !== 'neighbourHome') {
      this.welcome = 'done';
      for (const host of this.roster) this.setActivity(host, 'idle');
      return;
    }
    this.visitCount++;
    this.welcome = 'noticing';
    this.noticeIn = HOSTS_BEHAVIOUR.entryDelay;
    // Hands folded in welcome as the player comes in.
    for (const host of this.roster) this.setActivity(host, 'greeting');
  }

  private stepWelcome(dt: number): void {
    switch (this.welcome) {
      case 'noticing':
        this.noticeIn -= dt;
        if (this.noticeIn > 0) return;
        if (this.react(HOSTS_BEHAVIOUR.greeter, 'welcome')) {
          this.welcome = 'greeting';
          this.setActivity(this.host(HOSTS_BEHAVIOUR.greeter), 'idle');
        }
        return;
      case 'greeting':
        // Aunty waits for Uncle to finish rather than talking over him.
        if (this.host(HOSTS_BEHAVIOUR.greeter).view.line === null) this.welcome = 'offering';
        return;
      case 'offering':
        if (this.react(HOSTS_BEHAVIOUR.offerer, 'welcome')) {
          this.welcome = 'done';
          this.setActivity(this.host(HOSTS_BEHAVIOUR.offerer), 'idle');
        }
        return;
      case 'done':
        return;
    }
  }

  // ── the gift handover ──────────────────────────────────────────────────

  /** The box is changing hands: quiet, hands unfolded, with nothing left to say or wait for. */
  private makeRoom(): void {
    this.welcome = 'done';
    for (const host of this.roster) {
      host.view.line = null;
      host.view.talking = false;
      host.lineLeft = 0;
      host.cooldown = 0;
      if (host.view.activity === 'greeting') this.setActivity(host, 'idle');
    }
    this.followHandover();
  }

  /**
   * The receiver on the handover's current step, turned to the side table
   * while setting the box down; back to idle, facing the room, once it is over.
   */
  private followHandover(): void {
    const handover = this.gifts?.handover ?? null;
    for (const host of this.roster) {
      let activity: HouseholdActivity | null = null;
      if (handover?.host === host.id) activity = HANDOVER_ACTIVITY[handover.step];
      else if (HANDOVER_ACTIVITIES.includes(host.view.activity)) activity = 'idle';
      if (!activity || host.view.activity === activity) continue;
      this.setActivity(host, activity);
      const yaw = activity === 'settingGiftAside' ? this.layout.sideTable?.yaw : undefined;
      host.view.placement = { position: host.view.placement.position, yaw: yaw ?? this.layout.hosts[host.id].yaw };
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private host(id: NeighbourHostId): Host {
    return this.byId.get(id)!;
  }

  private createHost(id: NeighbourHostId): Host {
    const start = this.layout.hosts[id];
    const view: MutableView = {
      id,
      home: 'neighbourHome',
      activity: 'idle',
      placement: { position: { ...start.position }, yaw: start.yaw },
      line: null,
      walking: false,
      activityTime: 0,
      talking: false,
    };
    return { id, view, cooldown: 0, lineLeft: 0, nextLine: {} };
  }

  private place(host: Host, placement: Placement): void {
    host.view.placement = { position: { ...placement.position }, yaw: placement.yaw };
  }

  private setActivity(host: Host, activity: HouseholdActivity): void {
    if (host.view.activity === activity) return;
    host.view.activity = activity;
    host.view.activityTime = 0;
  }

  private reject(reason: ItemRejection): CommandResult<ItemRejection> {
    this.bus.emit('itemRejected', { action: 'eat', reason });
    return { ok: false, reason };
  }
}
