import { CRACKER_TYPES, type CrackerType } from './types';

/**
 * Gameplay actions produced by the session/input module. Downstream modules
 * consume these rather than raw DOM events, so they never see a keyboard.
 *
 * Proposed bindings (PRD → Controls): WASD move, Shift run, mouse look,
 * 1–4 select, click place, E light/interact, V toggle camera, Escape pause.
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
  | { readonly type: 'interact' }
  | { readonly type: 'toggleCamera' }
  | { readonly type: 'pause' };

export type GameActionType = GameAction['type'];

export type SelectSlot = 1 | 2 | 3 | 4;

/** Maps a number-key slot to its cracker type (1 = phuljhari … 4 = rocket). */
export function crackerForSlot(slot: SelectSlot): CrackerType {
  return CRACKER_TYPES[slot - 1] as CrackerType;
}

export function isSelectSlot(value: number): value is SelectSlot {
  return Number.isInteger(value) && value >= 1 && value <= CRACKER_TYPES.length;
}
