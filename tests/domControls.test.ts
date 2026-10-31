import { describe, expect, it, vi } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { createDomControls, type PointerLockDocument } from '../src/session/domControls';
import { Input } from '../src/session/input';
import { Session } from '../src/session/session';

// Headless stand-ins for the browser: plain EventTargets with just the
// pointer-lock and focus surface that createDomControls reads.
class FakeElement extends EventTarget {
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): Promise<void> {
    this.doc.setLock(this);
    return Promise.resolve();
  }
}

class FakeDocument extends EventTarget implements PointerLockDocument {
  pointerLockElement: unknown = null;
  visibilityState = 'visible';
  focused = true;
  hasFocus(): boolean {
    return this.focused;
  }
  exitPointerLock(): void {
    this.setLock(null);
  }
  setLock(element: unknown): void {
    this.pointerLockElement = element;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

function event(type: string, fields: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), fields);
}

function setup() {
  const bus = createGameEventBus();
  const session = new Session({ bus });
  const input = new Input({ bus, enabled: false });
  const doc = new FakeDocument();
  const element = new FakeElement(doc);
  const win = new EventTarget();
  const controls = createDomControls({ input, session, bus, element, doc, win });
  const paused = vi.fn();
  bus.on('paused', paused);
  return { bus, session, input, doc, element, win, controls, paused };
}

function startWalking() {
  const ctx = setup();
  ctx.controls.requestStart();
  ctx.win.dispatchEvent(event('keydown', { code: 'KeyW' }));
  expect(ctx.input.drainActions()).toEqual([{ type: 'move', forward: 1, right: 0 }]);
  return ctx;
}

describe('DOM controls', () => {
  it('starts the session once pointer lock is granted', () => {
    const { session, controls } = setup();
    controls.requestStart();
    expect(controls.pointerLocked).toBe(true);
    expect(session.state).toBe('running');
  });

  it('stays paused when pointer lock is refused', async () => {
    const { session, element, controls } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    element.requestPointerLock = () => Promise.reject(new Error('too soon'));
    controls.requestStart();
    await Promise.resolve();
    expect(session.state).toBe('idle');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('suppresses browser defaults only for bound keys', () => {
    const { win, controls } = setup();
    controls.requestStart();
    const bound = event('keydown', { code: 'Digit1' });
    const unbound = event('keydown', { code: 'F5' });
    win.dispatchEvent(bound);
    win.dispatchEvent(unbound);
    expect(bound.defaultPrevented).toBe(true);
    expect(unbound.defaultPrevented).toBe(false);
  });

  it('Space jumps in play without scrolling the page or clicking a focused button', () => {
    const { win, input, controls } = setup();
    controls.requestStart();
    const down = event('keydown', { code: 'Space' });
    Object.defineProperty(down, 'target', { value: { tagName: 'BUTTON' } });
    const up = event('keyup', { code: 'Space' });
    win.dispatchEvent(down);
    win.dispatchEvent(up);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(input.drainActions()).toEqual([{ type: 'jump' }]);
  });

  it('while paused, Space does not jump and a focused menu button or field keeps its keys', () => {
    const { win, doc, input, controls, session } = setup();
    controls.requestStart();
    doc.exitPointerLock();
    expect(session.paused).toBe(true);
    for (const tagName of ['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA']) {
      const down = event('keydown', { code: 'Space' });
      Object.defineProperty(down, 'target', { value: { tagName } });
      win.dispatchEvent(down);
      expect(down.defaultPrevented, tagName).toBe(false);
    }
    // On the page itself the key is still swallowed, so it cannot scroll.
    const onPage = event('keydown', { code: 'Space' });
    win.dispatchEvent(onPage);
    expect(onPage.defaultPrevented).toBe(true);
    controls.requestStart();
    expect(input.drainActions()).toEqual([]);
  });

  it('alt-tab (blur) while holding W stops the player and pauses', () => {
    const { win, session, input, paused } = startWalking();
    win.dispatchEvent(event('blur'));
    expect(session.paused).toBe(true);
    expect(paused).toHaveBeenCalledWith({ reason: 'focusLost' });
    expect(input.heldKeys).toEqual([]);
  });

  it('hiding the tab while walking releases keys', () => {
    const { doc, input, session } = startWalking();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(event('visibilitychange'));
    expect(input.heldKeys).toEqual([]);
    expect(session.paused).toBe(true);
  });

  it('losing pointer lock (Escape) is a user pause that releases keys', () => {
    const { doc, input, paused } = startWalking();
    doc.exitPointerLock();
    expect(paused).toHaveBeenCalledWith({ reason: 'user' });
    expect(input.heldKeys).toEqual([]);
  });

  it('losing pointer lock without focus is a focus-loss pause', () => {
    const { doc, paused } = startWalking();
    doc.focused = false;
    doc.exitPointerLock();
    expect(paused).toHaveBeenCalledWith({ reason: 'focusLost' });
  });

  it('resumes with a neutral move after regaining the lock', () => {
    const { win, controls, input, session } = startWalking();
    win.dispatchEvent(event('blur'));
    controls.requestStart();
    expect(session.state).toBe('running');
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 0, right: 0 }]);
  });

  it('a gameplay pause releases the pointer', () => {
    const { session, controls } = setup();
    controls.requestStart();
    session.pause('user');
    expect(controls.pointerLocked).toBe(false);
  });

  it('forwards mouse look and clicks only while locked', () => {
    const { doc, element, controls, input } = setup();
    doc.dispatchEvent(event('mousemove', { movementX: 9, movementY: 9 }));
    element.dispatchEvent(event('mousedown', { button: 0 }));
    controls.requestStart();
    expect(input.drainActions()).toEqual([]);

    doc.dispatchEvent(event('mousemove', { movementX: 4, movementY: -2 }));
    element.dispatchEvent(event('mousedown', { button: 0 }));
    expect(input.drainActions()).toEqual([{ type: 'look', dx: 4, dy: -2 }, { type: 'place' }]);
  });

  it('forwards the end of a held click wherever it is released', () => {
    const { doc, element, controls, input } = setup();
    controls.requestStart();
    element.dispatchEvent(event('mousedown', { button: 0 }));
    doc.dispatchEvent(event('mouseup', { button: 0 }));
    expect(input.drainActions()).toEqual([{ type: 'place' }, { type: 'placeReleased' }]);
  });

  it('losing the pointer mid-hold releases the click', () => {
    const { doc, element, controls, input } = setup();
    controls.requestStart();
    element.dispatchEvent(event('mousedown', { button: 0 }));
    input.drainActions();
    doc.focused = false;
    doc.exitPointerLock();
    controls.requestStart();
    expect(input.drainActions()).toEqual([{ type: 'placeReleased' }]);
  });

  it('dispose detaches every listener', () => {
    const { win, controls, input, session } = setup();
    controls.requestStart();
    controls.dispose();
    win.dispatchEvent(event('keydown', { code: 'KeyW' }));
    win.dispatchEvent(event('blur'));
    expect(input.drainActions()).toEqual([]);
    expect(session.state).toBe('running');
  });
});
