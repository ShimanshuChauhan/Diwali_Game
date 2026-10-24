import { describe, expect, it } from 'vitest';
import type { GameAction } from '../src/core/actions';
import { createGameEventBus } from '../src/core/events';
import { bindingFor, KEY_BINDINGS } from '../src/session/bindings';
import { Input } from '../src/session/input';

function press(input: Input, code: string): readonly GameAction[] {
  input.keyDown(code);
  input.keyUp(code);
  return input.drainActions();
}

describe('key bindings', () => {
  it('binds every control the PRD lists', () => {
    expect(Object.keys(KEY_BINDINGS).sort()).toEqual(
      [
        'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight',
        'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'KeyE', 'KeyV', 'Escape',
      ].sort(),
    );
  });

  it('ignores unbound codes and inherited object keys', () => {
    expect(bindingFor('KeyQ')).toBeUndefined();
    expect(bindingFor('toString')).toBeUndefined();
  });
});

describe('Input action mapping', () => {
  it('maps WASD to move axes', () => {
    const input = new Input();
    input.keyDown('KeyW');
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 1, right: 0 }]);
    input.keyDown('KeyD');
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 1, right: 1 }]);
    input.keyUp('KeyW');
    input.keyDown('KeyA');
    expect(input.drainActions()).toEqual([
      { type: 'move', forward: 0, right: 1 },
      { type: 'move', forward: 0, right: 0 },
    ]);
    input.keyDown('KeyS');
    input.keyUp('KeyD');
    expect(input.drainActions()).toEqual([
      { type: 'move', forward: -1, right: 0 },
      { type: 'move', forward: -1, right: -1 },
    ]);
  });

  it('cancels opposite keys', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.keyDown('KeyS');
    expect(input.drainActions().at(-1)).toEqual({ type: 'move', forward: 0, right: 0 });
  });

  it('runs while either Shift is held', () => {
    const input = new Input();
    input.keyDown('ShiftLeft');
    input.keyDown('ShiftRight');
    input.keyUp('ShiftLeft');
    expect(input.drainActions()).toEqual([{ type: 'run', active: true }]);
    input.keyUp('ShiftRight');
    expect(input.drainActions()).toEqual([{ type: 'run', active: false }]);
  });

  it('maps 1–5, E, V and Escape to one-shot actions', () => {
    const input = new Input();
    expect(press(input, 'Digit1')).toEqual([{ type: 'select', slot: 1 }]);
    expect(press(input, 'Digit4')).toEqual([{ type: 'select', slot: 4 }]);
    expect(press(input, 'Digit5')).toEqual([{ type: 'select', slot: 5 }]);
    expect(press(input, 'KeyE')).toEqual([{ type: 'interact' }]);
    expect(press(input, 'KeyV')).toEqual([{ type: 'toggleCamera' }]);
    expect(press(input, 'Escape')).toEqual([{ type: 'pause' }]);
  });

  it('ignores key auto-repeat', () => {
    const input = new Input();
    input.keyDown('KeyE');
    input.keyDown('KeyE');
    input.keyDown('KeyW');
    input.keyDown('KeyW');
    expect(input.drainActions()).toEqual([{ type: 'interact' }, { type: 'move', forward: 1, right: 0 }]);
  });

  it('places on left click only', () => {
    const input = new Input();
    input.mouseDown(2);
    input.mouseDown(0);
    expect(input.drainActions()).toEqual([{ type: 'place' }]);
  });

  it('ends a held click with one release, ignoring releases it did not see start', () => {
    const input = new Input();
    input.mouseUp(0);
    input.mouseDown(2);
    input.mouseUp(2);
    expect(input.drainActions()).toEqual([]);
    input.mouseDown(0);
    input.mouseUp(0);
    input.mouseUp(0);
    expect(input.drainActions()).toEqual([{ type: 'place' }, { type: 'placeReleased' }]);
  });

  it('merges consecutive mouse deltas into one look action', () => {
    const input = new Input();
    input.look(3, -1);
    input.look(2, 4);
    input.look(0, 0);
    input.mouseDown(0);
    input.look(1, 1);
    expect(input.drainActions()).toEqual([
      { type: 'look', dx: 5, dy: 3 },
      { type: 'place' },
      { type: 'look', dx: 1, dy: 1 },
    ]);
  });

  it('reports whether a code is bound so defaults can be suppressed', () => {
    const input = new Input();
    expect(input.keyDown('KeyW')).toBe(true);
    expect(input.keyDown('KeyQ')).toBe(false);
    expect(input.keyUp('KeyW')).toBe(true);
  });

  it('drains each action once', () => {
    const input = new Input();
    input.keyDown('KeyV');
    expect(input.drainActions()).toHaveLength(1);
    expect(input.drainActions()).toEqual([]);
  });
});

describe('Input held-key clearing', () => {
  it('releaseAll stops movement and running and drops pending presses', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.keyDown('ShiftLeft');
    input.keyDown('KeyE');
    input.drainActions();
    input.keyDown('KeyV');

    input.releaseAll();

    expect(input.heldKeys).toEqual([]);
    expect(input.drainActions()).toEqual([
      { type: 'move', forward: 0, right: 0 },
      { type: 'run', active: false },
    ]);
  });

  it('a repeated releaseAll keeps the pending neutral move', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.drainActions();
    input.releaseAll();
    input.releaseAll();
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 0, right: 0 }]);
  });

  it('releaseAll lets go of a held click, so a hold cannot stick', () => {
    const input = new Input();
    input.mouseDown(0);
    input.drainActions();
    input.releaseAll();
    input.releaseAll();
    expect(input.drainActions()).toEqual([{ type: 'placeReleased' }]);
    // The real release arrives later, or never; either way nothing more happens.
    input.mouseUp(0);
    expect(input.drainActions()).toEqual([]);
  });

  it('disabling mid-hold delivers the release once re-enabled', () => {
    const input = new Input();
    input.mouseDown(0);
    input.drainActions();
    input.setEnabled(false);
    expect(input.drainActions()).toEqual([]);
    input.setEnabled(true);
    expect(input.drainActions()).toEqual([{ type: 'placeReleased' }]);
  });

  it('releaseAll while idle queues nothing', () => {
    const input = new Input();
    input.releaseAll();
    expect(input.drainActions()).toEqual([]);
  });

  it('a key released after focus loss does not move the player', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.releaseAll();
    input.drainActions();
    // The keyup arrives after focus returns, or never; either way nothing moves.
    input.keyUp('KeyW');
    expect(input.drainActions()).toEqual([]);
  });

  it('a key still held after focus returns starts moving again on its next keydown', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.releaseAll();
    input.drainActions();
    input.keyDown('KeyW');
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 1, right: 0 }]);
  });

  it('while disabled, ignores input and drains nothing', () => {
    const input = new Input({ enabled: false });
    input.keyDown('KeyW');
    input.mouseDown(0);
    input.look(4, 4);
    expect(input.heldKeys).toEqual([]);
    expect(input.drainActions()).toEqual([]);
  });

  it('disabling mid-walk delivers the neutral move once re-enabled', () => {
    const input = new Input();
    input.keyDown('KeyW');
    input.drainActions();
    input.setEnabled(false);
    expect(input.drainActions()).toEqual([]);
    input.setEnabled(true);
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 0, right: 0 }]);
  });

  it('follows session events on the bus', () => {
    const bus = createGameEventBus();
    const input = new Input({ bus, enabled: false });

    bus.emit('sessionStarted', {});
    expect(input.isEnabled).toBe(true);
    input.keyDown('KeyW');
    input.drainActions();

    bus.emit('paused', { reason: 'focusLost' });
    expect(input.isEnabled).toBe(false);
    expect(input.heldKeys).toEqual([]);

    bus.emit('resumed', {});
    expect(input.drainActions()).toEqual([{ type: 'move', forward: 0, right: 0 }]);

    input.keyDown('KeyD');
    bus.emit('sessionReset', {});
    expect(input.heldKeys).toEqual([]);

    input.dispose();
    bus.emit('paused', { reason: 'user' });
    expect(input.isEnabled).toBe(true);
  });
});
