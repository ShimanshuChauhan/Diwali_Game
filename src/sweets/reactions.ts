import type { Resettable, Steppable } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { FamilyMemberId, HouseholdModule } from '../core/homes';

/** Placeholder pacing for comments on the player eating; seconds. */
export const SWEETS_BEHAVIOUR = {
  /** At most one comment on the player's eating this often, however fast they eat. */
  eatCommentGap: 8,
  /** Who remarks on the eating, in turn. */
  eatCommentOrder: ['mother', 'sibling', 'grandmother', 'father', 'grandfather'] as readonly FamilyMemberId[],
} as const;

export interface SweetsReactionsOptions {
  /** Follows `sweetsEaten`. */
  readonly bus: GameEventBus;
  readonly household: Pick<HouseholdModule, 'members' | 'react'>;
}

/**
 * The family noticing the player eat from the tray (issue #63). Eating is
 * unlimited, so the remarks are paced: one family member comments, in
 * turn, at most once per `eatCommentGap`, and only while nobody in the
 * family is already speaking, so an eating spree never stacks lines.
 *
 * Offering the plate needs no pacing here: the household answers
 * `sweetsOffered` from the member offered to, within that member's own
 * line and cooldown. Time is the fixed step from `update(dt)`.
 */
export class SweetsReactions implements Steppable, Resettable {
  private readonly household: Pick<HouseholdModule, 'members' | 'react'>;
  private readonly unsubscribes: Unsubscribe[] = [];
  /** Seconds until the next eating comment may be made. */
  private quiet = 0;
  private turn = 0;

  constructor(options: SweetsReactionsOptions) {
    this.household = options.household;
    this.unsubscribes.push(options.bus.on('sweetsEaten', () => this.ate()));
  }

  update(dt: number): void {
    if (dt > 0) this.quiet = Math.max(0, this.quiet - dt);
  }

  reset(): void {
    this.quiet = 0;
    this.turn = 0;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private ate(): void {
    if (this.quiet > 0) return;
    const family = this.household.members().filter((m) => m.home === 'familyHome');
    if (family.some((m) => m.line !== null)) return;
    const order = SWEETS_BEHAVIOUR.eatCommentOrder;
    for (let i = 0; i < order.length; i++) {
      const member = order[(this.turn + i) % order.length]!;
      if (!this.household.react(member, 'ateSweets')) continue;
      this.turn = (this.turn + i + 1) % order.length;
      this.quiet = SWEETS_BEHAVIOUR.eatCommentGap;
      return;
    }
  }
}
