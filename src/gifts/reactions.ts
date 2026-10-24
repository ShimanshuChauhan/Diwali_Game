import type { Resettable, Steppable } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { HomeId, HouseholdMemberId, HouseholdModule, LocationId, ReactionCause } from '../core/homes';

/** Who answers each gift moment, in the order they speak. */
export const GIFT_BEHAVIOUR = {
  /** Uncle thanks the player, then Aunty hands over the return box. */
  exchangeSpeakers: ['uncle', 'aunty'] as readonly HouseholdMemberId[],
  /** The family on seeing the return box after aarti. */
  acknowledgementSpeakers: ['mother', 'grandmother', 'sibling'] as readonly HouseholdMemberId[],
} as const;

export interface GiftReactionsOptions {
  /** Follows `giftExchanged`, `giftAcknowledged` and `locationChanged`. */
  readonly bus: GameEventBus;
  readonly household: Pick<HouseholdModule, 'members' | 'react'>;
  /** Where the player is: lines wait until they are in the speakers' home. */
  readonly location: () => LocationId;
}

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
 * thanks belong to the handover itself and are dropped if the player walks
 * out before they finish. Time is the fixed step from `update(dt)`.
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
      bus.on('giftExchanged', () => this.enqueue('neighbourHome', 'giftExchanged', GIFT_BEHAVIOUR.exchangeSpeakers)),
      bus.on('giftAcknowledged', () =>
        this.enqueue('familyHome', 'giftAcknowledged', GIFT_BEHAVIOUR.acknowledgementSpeakers),
      ),
      bus.on('locationChanged', ({ from }) => {
        if (from === 'neighbourHome') this.queue = this.queue.filter((p) => p.cause !== 'giftExchanged');
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

  private enqueue(home: HomeId, cause: ReactionCause, speakers: readonly HouseholdMemberId[]): void {
    for (const member of speakers) this.queue.push({ member, home, cause });
  }
}
