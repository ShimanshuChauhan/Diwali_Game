import { CRACKER_TYPES, type CrackerType } from './types';

/**
 * Gameplay actions produced by the session/input module. Downstream modules
 * consume these rather than raw DOM events, so they never see a keyboard.
 *
 * Proposed bindings (PRD → Controls): WASD move, Shift run, mouse look,
 * 1–5 select, click place (hold to circle the thali in aarti), E
 * light/interact, V toggle camera, Escape pause.
 */
export type GameAction =
  /** Movement axes in [-1, 1]; the latest value replaces the previous one. */
  | { readonly type: 'move'; readonly forward: number; readonly right: number }
  /** Run is held, so it carries the current state rather than a toggle. */
  | { readonly type: 'run'; readonly active: boolean }
  /** Mouse delta in pixels since the previous look action. */
  | { readonly type: 'look'; readonly dx: number; readonly dy: number }
  | { readonly type: 'select'; readonly slot: SelectSlot }
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

export function isSelectSlot(value: number): value is SelectSlot {
  return Number.isInteger(value) && value >= 1 && value <= CRACKER_TYPES.length;
}
