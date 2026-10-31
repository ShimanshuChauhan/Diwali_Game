import { CRACKER_TYPES, type CrackerType } from './types';

/**
 * Gameplay actions produced by the session/input module. Downstream modules
 * consume these rather than raw DOM events, so they never see a keyboard.
 *
 * Proposed bindings (PRD → Controls): WASD move, Shift run, Space jump,
 * mouse look, 1–5 select, ` or 0 bare hands, mouse wheel cycle, H holster,
 * click place (hold to circle the thali in aarti), E light/interact, V toggle
 * camera, Escape pause.
 */
export type GameAction =
  /** Movement axes in [-1, 1]; the latest value replaces the previous one. */
  | { readonly type: 'move'; readonly forward: number; readonly right: number }
  /** Run is held, so it carries the current state rather than a toggle. */
  | { readonly type: 'run'; readonly active: boolean }
  /** One jump per press; the player only leaves the ground if standing on it. */
  | { readonly type: 'jump' }
  /** Mouse delta in pixels since the previous look action. */
  | { readonly type: 'look'; readonly dx: number; readonly dy: number }
  | { readonly type: 'select'; readonly slot: SelectSlot }
  /** Put everything away: nothing in hand, like GTA's fists. */
  | { readonly type: 'bareHands' }
  /** Step through bare hands and the crackers, wrapping round; +1 is the next one. */
  | { readonly type: 'cycleItem'; readonly step: 1 | -1 }
  /** Quick holster: bare hands if holding a cracker, else take out the last one again. */
  | { readonly type: 'holster' }
  | { readonly type: 'place' }
  /**
   * The place button was let go, or dropped on focus loss. Ends a hold that
   * `place` began, e.g. circling the thali during aarti.
   */
  | { readonly type: 'placeReleased' }
  | { readonly type: 'interact' }
  | { readonly type: 'toggleCamera' }
  | { readonly type: 'pause' };

export type GameActionType = GameAction['type'];

export type SelectSlot = 1 | 2 | 3 | 4 | 5;

/** Maps a number-key slot to its cracker type (1 = phuljhari … 5 = ladi). */
export function crackerForSlot(slot: SelectSlot): CrackerType {
  return CRACKER_TYPES[slot - 1] as CrackerType;
}

/**
 * What the hands hold: a cracker type, or null for bare hands. Bare hands
 * come first in the cycle, before slot 1, like the fists in GTA.
 */
export type HandSelection = CrackerType | null;

export const ITEM_CYCLE: readonly HandSelection[] = [null, ...CRACKER_TYPES];

/** The selection `step` places along `ITEM_CYCLE` from `current`, wrapping at both ends. */
export function cycleSelection(current: HandSelection, step: 1 | -1): HandSelection {
  const count = ITEM_CYCLE.length;
  const index = ITEM_CYCLE.indexOf(current);
  return ITEM_CYCLE[(((index + step) % count) + count) % count]!;
}

export function isSelectSlot(value: number): value is SelectSlot {
  return Number.isInteger(value) && value >= 1 && value <= CRACKER_TYPES.length;
}
