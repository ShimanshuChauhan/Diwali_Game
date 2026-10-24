import type { Resettable } from '../core/contracts';

/**
 * Every stateful module of the homes expansion. A fresh session must clear
 * all of them (issue #51 → Acceptance #11), so each has a reset hook here
 * from the start; modules not built yet are stubbed until they land.
 *
 * Interior presentation is absent on purpose: it holds no progression and
 * rebuilds from the other modules' snapshots.
 */
export const HOMES_STATEFUL_MODULES = [
  'locations',
  'aartiCeremony',
  'aartiAudio',
  'household',
  'heldItems',
  'giftExchange',
] as const;

export type HomesStatefulModule = (typeof HOMES_STATEFUL_MODULES)[number];

export type HomesResetHooks = Readonly<Record<HomesStatefulModule, Resettable>>;

/** Placeholder hook for a module that is not built yet; resetting does nothing. */
export class PendingReset implements Resettable {
  constructor(readonly module: HomesStatefulModule) {}

  reset(): void {}
}

/** A hook for every stateful module: the `built` ones, stubs for the rest. */
export function homesResetHooks(built: Partial<HomesResetHooks> = {}): HomesResetHooks {
  const hooks = {} as Record<HomesStatefulModule, Resettable>;
  for (const module of HOMES_STATEFUL_MODULES) hooks[module] = built[module] ?? new PendingReset(module);
  return hooks;
}

/** Modules not built yet, i.e. still on a `PendingReset` stub. */
export function pendingModules(hooks: HomesResetHooks): HomesStatefulModule[] {
  return HOMES_STATEFUL_MODULES.filter((module) => hooks[module] instanceof PendingReset);
}

interface ResetRegistry {
  register(resettable: Resettable): () => void;
}

/** Include every hook in the session's reset. Returns a function that removes them. */
export function registerHomesReset(session: ResetRegistry, hooks: HomesResetHooks): () => void {
  const removals = HOMES_STATEFUL_MODULES.map((module) => session.register(hooks[module]));
  return () => {
    for (const remove of removals) remove();
  };
}
