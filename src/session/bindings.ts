import type { GameAction } from '../core/actions';

/**
 * Default key bindings (PRD → Controls), keyed by `KeyboardEvent.code` so
 * they follow physical key position rather than keyboard layout.
 *
 * - `axis` keys are held and combine into the move action.
 * - `run` keys are held; either Shift runs.
 * - `press` keys fire their action once per press (auto-repeat ignored).
 *
 * Mouse look and click-to-place are handled by `Input` directly.
 */
export type Binding =
  | { readonly kind: 'axis'; readonly axis: 'forward' | 'right'; readonly sign: 1 | -1 }
  | { readonly kind: 'run' }
  | { readonly kind: 'press'; readonly action: GameAction };

export const KEY_BINDINGS: Readonly<Record<string, Binding>> = {
  KeyW: { kind: 'axis', axis: 'forward', sign: 1 },
  KeyS: { kind: 'axis', axis: 'forward', sign: -1 },
  KeyD: { kind: 'axis', axis: 'right', sign: 1 },
  KeyA: { kind: 'axis', axis: 'right', sign: -1 },
  ShiftLeft: { kind: 'run' },
  ShiftRight: { kind: 'run' },
  Space: { kind: 'press', action: { type: 'jump' } },
  Digit1: { kind: 'press', action: { type: 'select', slot: 1 } },
  Digit2: { kind: 'press', action: { type: 'select', slot: 2 } },
  Digit3: { kind: 'press', action: { type: 'select', slot: 3 } },
  Digit4: { kind: 'press', action: { type: 'select', slot: 4 } },
  Digit5: { kind: 'press', action: { type: 'select', slot: 5 } },
  KeyE: { kind: 'press', action: { type: 'interact' } },
  KeyV: { kind: 'press', action: { type: 'toggleCamera' } },
  Escape: { kind: 'press', action: { type: 'pause' } },
};

/** `MouseEvent.button` that places the selected ground cracker. */
export const PLACE_BUTTON = 0;

export function bindingFor(code: string): Binding | undefined {
  return Object.hasOwn(KEY_BINDINGS, code) ? KEY_BINDINGS[code] : undefined;
}
