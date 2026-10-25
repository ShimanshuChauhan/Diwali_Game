import type { Resettable, Steppable } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { HomeId, HouseholdMemberId, HouseholdModule, LocationId, ReactionCause } from '../core/homes';

/** Who answers each gift moment, in the order they speak. */
export const GIFT_BEHAVIOUR = {
  /** Uncle thanks the player as he takes the box, holding it. */
  receiveSpeakers: ['uncle'] as readonly HouseholdMemberId[],
  /** Aunty adds a warm word once Uncle has handed over the return box. */
  exchangeSpeakers: ['aunty'] as readonly HouseholdMemberId[],
  /** The family on seeing the return box after aarti. */
  acknowledgementSpeakers: ['mother', 'grandmother', 'sibling'] as readonly HouseholdMemberId[],
} as const;

export interface GiftReactionsOptions {
  /** Follows `giftReceived`, `giftExchanged`, `giftAcknowledged` and `locationChanged`. */
  readonly bus: GameEventBus;
  readonly household: Pick<HouseholdModule, 'members' | 'react'>;
  /** Where the player is: lines wait until they are in the speakers' home. */
  readonly location: () => LocationId;
}

/** The neighbours' lines, said only during the visit they belong to. */
const HANDOVER_CAUSES: readonly ReactionCause[] = ['giftReceived', 'giftExchanged'];

interface Pending {
  readonly member: HouseholdMemberId;
  readonly home: HomeId;
  readonly cause: ReactionCause;
}

/**
 * The household's lines for the gift round trip (issue #66). Each gift event
 * fires once, but a member may be mid-sentence or on cooldown at that
 * moment, so the lines queue here and are said one at a time, each once the
 * home has fallen quiet, rather than being lost or talking over the welcome.
 *
 * The family's acknowledgement can come from aarti ending while the player
 * is out, so it waits until they are home to hear it. Uncle and Aunty's
 * lines belong to the handover itself: queued only while the player is
 * there, and dropped if they walk out before they are said. The hosts fall
 * quiet as the handover starts (`NeighbourHosts`), so Uncle's thanks comes
 * at once, while he holds the box. Time is the fixed step from `update(dt)`.
 */
export class GiftReactions implements Steppable, Resettable {
  private readonly household: Pick<HouseholdModule, 'members' | 'react'>;
  private readonly location: () => LocationId;
  private readonly unsubscribes: Unsubscribe[] = [];
  private queue: Pending[] = [];

  constructor(options: GiftReactionsOptions) {
    this.household = options.household;
    this.location = options.location;
    const { bus } = options;
    this.unsubscribes.push(
      bus.on('giftReceived', () => this.enqueue('neighbourHome', 'giftReceived', GIFT_BEHAVIOUR.receiveSpeakers, true)),
      bus.on('giftExchanged', () => this.enqueue('neighbourHome', 'giftExchanged', GIFT_BEHAVIOUR.exchangeSpeakers, true)),
      bus.on('giftAcknowledged', () =>
        this.enqueue('familyHome', 'giftAcknowledged', GIFT_BEHAVIOUR.acknowledgementSpeakers),
      ),
      bus.on('locationChanged', ({ from }) => {
        if (from === 'neighbourHome') this.queue = this.queue.filter((p) => !HANDOVER_CAUSES.includes(p.cause));
      }),
    );
  }

  /** Lines still to be said, in order. */
  get pending(): readonly { readonly member: HouseholdMemberId; readonly cause: ReactionCause }[] {
    return this.queue;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    const next = this.queue[0];
    if (!next || this.location() !== next.home) return;
    const members = this.household.members();
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (m.home === next.home && m.line !== null) return;
    }
    if (this.household.react(next.member, next.cause)) this.queue.shift();
  }

  reset(): void {
    this.queue = [];
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** With `present`, only while the player is in `home`: a moment they walked out of is not replayed. */
  private enqueue(home: HomeId, cause: ReactionCause, speakers: readonly HouseholdMemberId[], present = false): void {
    if (present && this.location() !== home) return;
    for (const member of speakers) this.queue.push({ member, home, cause });
  }
}
