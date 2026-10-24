import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import {
  FAMILY_MEMBERS,
  type DialogueLine,
  type FamilyMemberId,
  type HouseholdActivity,
  type HouseholdMemberId,
  type HouseholdMemberSnapshot,
  type HouseholdModule,
  type LocationId,
  type Placement,
  type ReactionCause,
} from '../core/homes';
import { TUNING, type Tuning } from '../core/tuning';
import type { Vec3 } from '../core/types';
import { FAMILY_DIALOGUE, type DialogueCatalogue } from './dialogue';

/** Where the evening has got to for the family. */
export type HouseholdPhase =
  /** Gathered at the puja corner, inviting the player now and then. */
  | 'gathered'
  /** The ceremony is running, with or without the player. */
  | 'aarti'
  /** Aarti is over; walking to the seats, the tray being served. */
  | 'settling'
  /** Everyone seated, chatting over sweets. */
  | 'seated';

/** Everything the scene needs to pose one family member. */
export interface HouseholdMemberView extends HouseholdMemberSnapshot {
  /** Walking between the puja corner, the tray and a seat. */
  readonly walking: boolean;
  /** Seconds spent in the current activity. */
  readonly activityTime: number;
  /** Seated and holding the conversation's turn; the others listen. */
  readonly talking: boolean;
}

/** The anchors the family moves between; `FamilyHomeLayout` provides them. */
export interface HouseholdLayout {
  readonly gathering: Readonly<Record<FamilyMemberId, Placement>>;
  readonly seats: Readonly<Record<FamilyMemberId, Placement>>;
  readonly routes: Readonly<Record<FamilyMemberId, readonly Vec3[]>>;
  readonly serving: Placement;
}

/** Placeholder behaviour tuning; times in seconds, distances in metres. */
export const HOUSEHOLD_BEHAVIOUR = {
  walkSpeed: 0.9,
  /** Radians per second a walker turns toward where it is heading. */
  turnSpeed: 4,
  /** After entering the home, the family notices the player this long later. */
  entryDelay: 1.5,
  /** How long the tray is served before the server sits down. */
  servingTime: 5,
  /** Each seated member holds the conversation this long before the next. */
  chatTurn: 4,
  /** Mummy turns between clapping and folded hands this often during aarti. */
  aartiSwap: 12,
  /** Who serves the tray after aarti. */
  server: 'mother' as FamilyMemberId,
  /** Seconds after completion before each member starts for their seat, so walkers do not bunch. */
  settleDelay: { mother: 0, sibling: 0.4, father: 0.9, grandmother: 1.8, grandfather: 2.6 } as Readonly<
    Record<FamilyMemberId, number>
  >,
  /** Who calls the player over, in turn. */
  inviteOrder: ['mother', 'grandmother', 'father', 'sibling', 'grandfather'] as readonly FamilyMemberId[],
  /** Order of turns in the seated conversation. */
  chatOrder: ['father', 'grandmother', 'sibling', 'mother', 'grandfather'] as readonly FamilyMemberId[],
} as const;

/**
 * What each member does while aarti runs: the ritual's three gestures
 * spread across the family. Nobody sings; the recording carries the voices.
 */
const AARTI_ROLES: Readonly<Record<FamilyMemberId, HouseholdActivity>> = {
  mother: 'clapping',
  father: 'clapping',
  sibling: 'ringingBell',
  grandmother: 'praying',
  grandfather: 'praying',
};

export interface HouseholdOptions {
  /** Follows `aartiJoined`, `aartiCompleted`, `locationChanged` and `sweetsOffered`; publishes `householdReacted`. */
  readonly bus: GameEventBus;
  readonly layout: HouseholdLayout;
  readonly dialogue?: DialogueCatalogue;
  readonly tuning?: Tuning;
  /** Where the player is when the household is created; outdoors by default. */
  readonly location?: LocationId;
}

type MutableView = { -readonly [K in keyof HouseholdMemberView]: HouseholdMemberView[K] };

interface Member {
  readonly id: FamilyMemberId;
  readonly view: MutableView;
  readonly position: { x: number; y: number; z: number };
  readonly placement: { position: Vec3; yaw: number };
  /** Points still to walk to, the seat last. */
  path: Vec3[];
  /** Seconds left before setting off for the seat. */
  delay: number;
  /** Seconds left serving the tray; 0 when not serving. */
  serving: number;
  /** Seconds until this member may react again. */
  cooldown: number;
  /** Seconds the current line stays up. */
  lineLeft: number;
  /** Next variation to use, per cause, so lines rotate rather than repeat. */
  readonly nextLine: Partial<Record<ReactionCause, number>>;
}

const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z) < 1e-6;

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * The family household (issue #61): mother, father, a younger sibling and
 * two grandparents, who keep their own evening whether or not the player is
 * watching.
 *
 * - Gathered at the puja corner while aarti waits. When the player comes in
 *   one of them calls them over, then again every `inviteInterval` while the
 *   ceremony waits: encouragement only, never a countdown.
 * - Once the player first joins, the family prays, claps and rings the bell
 *   until the ceremony completes — through the player leaving and rejoining.
 * - On `aartiCompleted` they walk to their seats along the room's routes,
 *   one stopping to serve the tray, then sit and chat. That happens on the
 *   logical clock even while the home is not shown; with nobody there to see
 *   the walk, they settle at once, so coming back finds them seated.
 *
 * Time is the fixed step from `update(dt)`, so a paused game freezes the
 * family with the ceremony. Reactions are bounded: one line per member at a
 * time, held `dialogueDuration`, and at most one per `reactionCooldown`.
 * Renderer-free; views are live and reused, so copy one to keep it.
 */
export class Household implements HouseholdModule {
  private readonly bus: GameEventBus;
  private readonly layout: HouseholdLayout;
  private readonly dialogue: DialogueCatalogue;
  private readonly tuning: Tuning;
  private readonly initialLocation: LocationId;
  private readonly roster: Member[];
  private readonly byId: Map<HouseholdMemberId, Member>;
  private readonly viewCache: MutableView[];
  private readonly unsubscribes: Unsubscribe[] = [];

  private phase: HouseholdPhase = 'gathered';
  private location: LocationId;
  /** Seconds in the current phase. */
  private phaseTime = 0;
  /** Seconds until the family notices the player who just came in; null when not pending. */
  private noticeIn: number | null = null;
  /** Seconds until the next invitation while the player is home and aarti waits; null when none is due. */
  private inviteIn: number | null = null;
  private inviteTurn = 0;

  constructor(options: HouseholdOptions) {
    this.bus = options.bus;
    this.layout = options.layout;
    this.dialogue = options.dialogue ?? FAMILY_DIALOGUE;
    this.tuning = options.tuning ?? TUNING;
    this.initialLocation = options.location ?? 'outdoors';
    this.location = this.initialLocation;
    this.roster = FAMILY_MEMBERS.map((id) => this.createMember(id));
    this.byId = new Map(this.roster.map((member) => [member.id, member]));
    this.viewCache = this.roster.map((member) => member.view);

    this.unsubscribes.push(
      this.bus.on('aartiJoined', () => {
        if (this.phase === 'gathered') this.enter('aarti');
      }),
      this.bus.on('aartiCompleted', () => this.settle()),
      this.bus.on('locationChanged', ({ to }) => this.arrive(to)),
      this.bus.on('sweetsOffered', ({ member }) => this.react(member, 'sweetsOffered')),
    );
  }

  get state(): HouseholdPhase {
    return this.phase;
  }

  members(): readonly HouseholdMemberSnapshot[] {
    return this.viewCache;
  }

  views(): readonly HouseholdMemberView[] {
    return this.viewCache;
  }

  /** A keepable copy of one member's view. */
  get(id: HouseholdMemberId): HouseholdMemberView | undefined {
    const view = this.byId.get(id)?.view;
    if (!view) return undefined;
    return {
      ...view,
      placement: { position: { ...view.placement.position }, yaw: view.placement.yaw },
    };
  }

  react(member: HouseholdMemberId, cause: ReactionCause): DialogueLine | null {
    const m = this.byId.get(member);
    if (!m || m.view.line !== null || m.cooldown > 0) return null;
    const variants = this.dialogue[cause]?.[member];
    if (!variants || variants.length === 0) return null;
    const index = m.nextLine[cause] ?? 0;
    m.nextLine[cause] = (index + 1) % variants.length;
    const variant = variants[index % variants.length]!;
    const { dialogueDuration, reactionCooldown } = this.tuning.homes;
    const line: DialogueLine = { member, text: variant.text, gesture: variant.gesture, duration: dialogueDuration };
    m.view.line = line;
    m.lineLeft = dialogueDuration;
    m.cooldown = Math.max(reactionCooldown, dialogueDuration);
    this.bus.emit('householdReacted', { line });
    return line;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    this.phaseTime += dt;
    for (const m of this.roster) {
      m.view.activityTime += dt;
      m.cooldown = Math.max(0, m.cooldown - dt);
      if (m.view.line !== null) {
        m.lineLeft -= dt;
        if (m.lineLeft <= 0) m.view.line = null;
      }
    }

    if (this.phase === 'aarti') this.stepAarti();
    else if (this.phase === 'settling') this.stepSettling(dt);
    if (this.phase === 'seated') this.stepChat();
    this.stepAttention(dt);
  }

  /** Fresh session: gathered again at the puja corner, quiet, with the player outdoors. */
  reset(): void {
    this.phase = 'gathered';
    this.phaseTime = 0;
    this.location = this.initialLocation;
    this.noticeIn = this.location === 'familyHome' ? HOUSEHOLD_BEHAVIOUR.entryDelay : null;
    this.inviteIn = null;
    this.inviteTurn = 0;
    for (const m of this.roster) {
      this.place(m, this.layout.gathering[m.id]);
      this.setActivity(m, 'gathered');
      m.path = [];
      m.delay = 0;
      m.serving = 0;
      m.cooldown = 0;
      m.lineLeft = 0;
      m.view.line = null;
      m.view.walking = false;
      m.view.talking = false;
      for (const cause of Object.keys(m.nextLine) as ReactionCause[]) delete m.nextLine[cause];
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── phases ─────────────────────────────────────────────────────────────

  private enter(phase: HouseholdPhase): void {
    this.phase = phase;
    this.phaseTime = 0;
    if (phase === 'aarti') {
      this.inviteIn = null;
      for (const m of this.roster) this.setActivity(m, AARTI_ROLES[m.id]);
    }
  }

  private stepAarti(): void {
    // Mummy moves between clapping and folded hands; the rest keep their role.
    const mother = this.byId.get('mother')!;
    const clapping = Math.floor(this.phaseTime / HOUSEHOLD_BEHAVIOUR.aartiSwap) % 2 === 0;
    this.setActivity(mother, clapping ? 'clapping' : 'praying');
  }

  /** Aarti completed: everyone heads for their seat, the server via the tray. */
  private settle(): void {
    if (this.phase === 'settling' || this.phase === 'seated') return;
    this.enter('settling');
    this.inviteIn = null;
    for (const m of this.roster) {
      m.path = [...this.layout.routes[m.id], this.layout.seats[m.id].position];
      m.delay = HOUSEHOLD_BEHAVIOUR.settleDelay[m.id] ?? 0;
      m.serving = 0;
      this.setActivity(m, 'idle');
    }
    if (!this.homeShown) this.settleAtOnce();
  }

  private stepSettling(dt: number): void {
    // Nobody is watching the walk, so it is already done.
    if (!this.homeShown) {
      this.settleAtOnce();
      return;
    }
    let done = true;
    for (const m of this.roster) {
      if (m.view.activity === 'seated') continue;
      done = false;
      if (m.delay > 0) {
        m.delay = Math.max(0, m.delay - dt);
        continue;
      }
      if (m.serving > 0) {
        m.serving = Math.max(0, m.serving - dt);
        if (m.serving === 0) this.setActivity(m, 'idle');
        continue;
      }
      this.walk(m, dt);
    }
    if (done) this.enter('seated');
  }

  /** Walk `m` along its path; serve at the serving spot; sit on reaching the seat. */
  private walk(m: Member, dt: number): void {
    const target = m.path[0];
    if (!target) return;
    const p = m.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const distance = Math.hypot(dx, dz);
    const stepLength = HOUSEHOLD_BEHAVIOUR.walkSpeed * dt;
    m.view.walking = true;
    if (distance > 0) {
      const heading = Math.atan2(-dx, -dz);
      const turn = angleDelta(m.placement.yaw, heading);
      const maxTurn = HOUSEHOLD_BEHAVIOUR.turnSpeed * dt;
      m.placement.yaw += Math.abs(turn) <= maxTurn ? turn : Math.sign(turn) * maxTurn;
    }
    if (distance > stepLength) {
      p.x += (dx / distance) * stepLength;
      p.z += (dz / distance) * stepLength;
      return;
    }
    p.x = target.x;
    p.z = target.z;
    m.path.shift();
    if (m.id === HOUSEHOLD_BEHAVIOUR.server && near(target, this.layout.serving.position)) {
      m.view.walking = false;
      m.placement.yaw = this.layout.serving.yaw;
      m.serving = HOUSEHOLD_BEHAVIOUR.servingTime;
      this.setActivity(m, 'serving');
      if (this.location === 'familyHome') this.react(m.id, 'welcome');
    } else if (m.path.length === 0) {
      this.sit(m);
    }
  }

  private settleAtOnce(): void {
    for (const m of this.roster) if (m.view.activity !== 'seated') this.sit(m);
    this.enter('seated');
  }

  private sit(m: Member): void {
    m.path = [];
    m.delay = 0;
    m.serving = 0;
    m.view.walking = false;
    this.place(m, this.layout.seats[m.id]);
    this.setActivity(m, 'seated');
  }

  /** One seated member holds the conversation at a time, in turn. */
  private stepChat(): void {
    const order = HOUSEHOLD_BEHAVIOUR.chatOrder;
    const turn = order[Math.floor(this.phaseTime / HOUSEHOLD_BEHAVIOUR.chatTurn) % order.length];
    for (const m of this.roster) m.view.talking = m.view.line !== null || m.id === turn;
  }

  // ── the player's comings and goings ────────────────────────────────────

  private arrive(to: LocationId): void {
    this.location = to;
    this.noticeIn = to === 'familyHome' ? HOUSEHOLD_BEHAVIOUR.entryDelay : null;
    this.inviteIn = null;
  }

  /** Invite on arrival and now and then while aarti waits; welcome back once seated. */
  private stepAttention(dt: number): void {
    if (this.location !== 'familyHome') return;
    if (this.noticeIn !== null) {
      this.noticeIn -= dt;
      if (this.noticeIn > 0) return;
      this.noticeIn = null;
      if (this.phase === 'gathered') this.invite();
      else if (this.phase === 'seated') this.welcome();
      return;
    }
    if (this.phase !== 'gathered' || this.inviteIn === null) return;
    this.inviteIn -= dt;
    if (this.inviteIn <= 0) this.invite();
  }

  private invite(): void {
    const order = HOUSEHOLD_BEHAVIOUR.inviteOrder;
    for (let i = 0; i < order.length; i++) {
      const member = order[(this.inviteTurn + i) % order.length]!;
      if (this.react(member, 'invite')) {
        this.inviteTurn = (this.inviteTurn + i + 1) % order.length;
        break;
      }
    }
    // Whether or not anyone could speak, the next call waits a full interval.
    this.inviteIn = this.tuning.homes.inviteInterval;
  }

  private welcome(): void {
    const order = HOUSEHOLD_BEHAVIOUR.inviteOrder;
    for (let i = 0; i < order.length; i++) {
      const member = order[(this.inviteTurn + i) % order.length]!;
      if (this.react(member, 'welcome')) {
        this.inviteTurn = (this.inviteTurn + i + 1) % order.length;
        return;
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** True while the player is in the family home, so its presentation is drawn. */
  private get homeShown(): boolean {
    return this.location === 'familyHome';
  }

  private createMember(id: FamilyMemberId): Member {
    const start = this.layout.gathering[id];
    const position = { ...start.position };
    const placement = { position, yaw: start.yaw };
    const view: MutableView = {
      id,
      home: 'familyHome',
      activity: 'gathered',
      placement,
      line: null,
      walking: false,
      activityTime: 0,
      talking: false,
    };
    return { id, view, position, placement, path: [], delay: 0, serving: 0, cooldown: 0, lineLeft: 0, nextLine: {} };
  }

  private place(m: Member, placement: Placement): void {
    m.position.x = placement.position.x;
    m.position.y = placement.position.y;
    m.position.z = placement.position.z;
    m.placement.yaw = placement.yaw;
  }

  private setActivity(m: Member, activity: HouseholdActivity): void {
    if (m.view.activity === activity) return;
    m.view.activity = activity;
    m.view.activityTime = 0;
  }
}
