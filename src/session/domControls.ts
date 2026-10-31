import type { GameEventBus } from '../core/events';
import type { Input } from './input';
import type { Session } from './session';

/**
 * Browser edge of session/input: forwards DOM events to `Input`, drives the
 * session from pointer lock, and releases held keys whenever focus goes.
 * Bound keys have their browser defaults suppressed (Space would scroll or
 * click a focused button), except that while the pointer is free a focused
 * form control or text field keeps its keys, so the pause menu stays usable.
 *
 * Targets are typed structurally so tests can pass plain `EventTarget`s.
 */
export interface PointerLockDocument extends EventTarget {
  readonly pointerLockElement: unknown;
  readonly visibilityState: string;
  hasFocus(): boolean;
  exitPointerLock(): void;
}

export interface PointerLockElement extends EventTarget {
  requestPointerLock(): unknown;
}

export interface DomControlsOptions {
  readonly input: Input;
  readonly session: Session;
  readonly bus: GameEventBus;
  /** Usually the renderer canvas. */
  readonly element: PointerLockElement;
  readonly doc: PointerLockDocument;
  /** Receives keyboard and blur events, usually `window`. */
  readonly win: EventTarget;
}

export interface DomControls {
  readonly pointerLocked: boolean;
  /**
   * Ask for pointer lock from a player gesture. The session starts (or
   * resumes) once the lock is granted; a refused lock leaves it paused.
   */
  requestStart(): void;
  dispose(): void;
}

interface KeyLike extends Event {
  readonly code?: string;
}

interface MouseLike extends Event {
  readonly button?: number;
  readonly movementX?: number;
  readonly movementY?: number;
}

export function createDomControls(options: DomControlsOptions): DomControls {
  const { input, session, bus, element, doc, win } = options;
  const isLocked = (): boolean => doc.pointerLockElement === element;
  const ownsKeys = (event: Event): boolean => !isLocked() && isKeyTaker(event.target);

  const releaseAndPause = (reason: 'user' | 'focusLost'): void => {
    input.releaseAll();
    session.pause(reason);
  };

  const listeners: [EventTarget, string, (event: Event) => void][] = [
    [
      win,
      'keydown',
      (event: KeyLike) => {
        if (event.code === undefined || ownsKeys(event)) return;
        if (input.keyDown(event.code)) event.preventDefault();
      },
    ],
    [
      win,
      'keyup',
      // Releases always reach `Input`, so a key held into a menu never sticks.
      (event: KeyLike) => {
        if (event.code !== undefined && input.keyUp(event.code) && !ownsKeys(event)) event.preventDefault();
      },
    ],
    [win, 'blur', () => releaseAndPause('focusLost')],
    [
      doc,
      'visibilitychange',
      () => {
        if (doc.visibilityState === 'hidden') releaseAndPause('focusLost');
      },
    ],
    [
      doc,
      'pointerlockchange',
      () => {
        if (isLocked()) {
          if (session.started) session.resume();
          else session.start();
        } else {
          // Escape exits the lock before the page sees the key, so a lost
          // lock with focus intact is the player's own pause.
          const focused = doc.hasFocus() && doc.visibilityState !== 'hidden';
          releaseAndPause(focused ? 'user' : 'focusLost');
        }
      },
    ],
    [
      doc,
      'mousemove',
      (event: MouseLike) => {
        if (isLocked()) input.look(event.movementX ?? 0, event.movementY ?? 0);
      },
    ],
    [
      element,
      'mousedown',
      (event: MouseLike) => {
        if (isLocked() && event.button !== undefined) input.mouseDown(event.button);
      },
    ],
    // Releases count wherever they land, so a hold never sticks; `Input` ignores ones it did not see start.
    [
      doc,
      'mouseup',
      (event: MouseLike) => {
        if (event.button !== undefined) input.mouseUp(event.button);
      },
    ],
  ];

  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  // A pause from gameplay (the Escape action) also hands the pointer back.
  const offPaused = bus.on('paused', () => {
    if (isLocked()) doc.exitPointerLock();
  });

  return {
    get pointerLocked() {
      return isLocked();
    },
    requestStart() {
      try {
        const result = element.requestPointerLock();
        if (result instanceof Promise) result.catch(onLockRefused);
      } catch (error) {
        onLockRefused(error);
      }
    },
    dispose() {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
      offPaused();
    },
  };
}

/** Elements that use keys themselves: Space clicks a button, letters type into a field. */
const KEY_TAKER_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

function isKeyTaker(target: EventTarget | null): boolean {
  const el = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown } | null;
  if (!el) return false;
  return el.isContentEditable === true || (typeof el.tagName === 'string' && KEY_TAKER_TAGS.has(el.tagName.toUpperCase()));
}

function onLockRefused(error: unknown): void {
  // Browsers refuse a re-lock shortly after Escape; the overlay stays up
  // and the next click tries again.
  console.warn('Pointer lock refused', error);
}
