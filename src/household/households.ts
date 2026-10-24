import type {
  DialogueLine,
  HouseholdMemberId,
  HouseholdMemberSnapshot,
  HouseholdModule,
  ReactionCause,
} from '../core/homes';

/**
 * Several households behind the one `HouseholdModule` the rest of the game
 * talks to: the family at home and Uncle and Aunty next door. Members are
 * listed in the order the parts were given; a reaction goes to whichever
 * part has that member. Stepping and resetting reach every part.
 */
export class Households implements HouseholdModule {
  private readonly parts: readonly HouseholdModule[];
  /** Each part's member list and its length when the roster was last built. */
  private sources: { list: readonly HouseholdMemberSnapshot[]; length: number }[] = [];
  private roster: HouseholdMemberSnapshot[] = [];

  constructor(parts: readonly HouseholdModule[]) {
    this.parts = parts;
  }

  /** Every member of every part. Rebuilt only when a part's list changes, so polling allocates nothing. */
  members(): readonly HouseholdMemberSnapshot[] {
    const stale =
      this.sources.length !== this.parts.length ||
      this.parts.some((part, i) => {
        const list = part.members();
        const source = this.sources[i]!;
        return list !== source.list || list.length !== source.length;
      });
    if (stale) {
      this.sources = this.parts.map((part) => {
        const list = part.members();
        return { list, length: list.length };
      });
      this.roster = this.sources.flatMap((source) => source.list);
    }
    return this.roster;
  }

  react(member: HouseholdMemberId, cause: ReactionCause): DialogueLine | null {
    for (const part of this.parts) {
      if (part.members().some((m) => m.id === member)) return part.react(member, cause);
    }
    return null;
  }

  update(dt: number): void {
    for (const part of this.parts) part.update(dt);
  }

  reset(): void {
    for (const part of this.parts) part.reset();
  }
}
