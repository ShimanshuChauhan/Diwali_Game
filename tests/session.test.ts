import { describe, expect, it, vi } from 'vitest';
import type { Resettable } from '../src/core/contracts';
import { createGameEventBus, type GameEventName } from '../src/core/events';
import type { DiyaId, Vec3 } from '../src/core/types';
import { Session } from '../src/session/session';

// Minimal stand-ins for the modules a fresh session must restore.
const SPAWN: Vec3 = { x: 0, y: 0, z: 4 };

class FakeDiyas implements Resettable {
  readonly lit = new Set<DiyaId>();
  reset(): void {
    this.lit.clear();
  }
}

class FakeCrackers implements Resettable {
  placed: string[] = [];
  reset(): void {
    this.placed = [];
  }
}

class FakePlayer implements Resettable {
  position: Vec3 = SPAWN;
  reset(): void {
    this.position = SPAWN;
  }
}

function recordEvents(bus: ReturnType<typeof createGameEventBus>, names: GameEventName[]): string[] {
  const log: string[] = [];
  for (const name of names) bus.on(name, () => log.push(name));
  return log;
}

describe('Session lifecycle', () => {
  it('begins idle on the start screen, paused', () => {
    const session = new Session({ bus: createGameEventBus() });
    expect(session.state).toBe('idle');
    expect(session.started).toBe(false);
    expect(session.paused).toBe(true);
  });

  it('start resets then starts', () => {
    const bus = createGameEventBus();
    const log = recordEvents(bus, ['sessionReset', 'sessionStarted']);
    const session = new Session({ bus });
    session.start();
    expect(log).toEqual(['sessionReset', 'sessionStarted']);
    expect(session.state).toBe('running');
    expect(session.paused).toBe(false);
  });

  it('pauses with a reason and resumes', () => {
    const bus = createGameEventBus();
    const paused = vi.fn();
    const resumed = vi.fn();
    bus.on('paused', paused);
    bus.on('resumed', resumed);
    const session = new Session({ bus });
    session.start();

    session.pause('focusLost');
    expect(session.paused).toBe(true);
    expect(paused).toHaveBeenCalledExactlyOnceWith({ reason: 'focusLost' });

    session.resume();
    expect(session.paused).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();
  });

  it('ignores pause before start, repeated pauses and stray resumes', () => {
    const bus = createGameEventBus();
    const log = recordEvents(bus, ['paused', 'resumed']);
    const session = new Session({ bus });

    session.pause('user');
    session.resume();
    expect(session.state).toBe('idle');

    session.start();
    session.resume();
    session.pause('user');
    session.pause('focusLost');
    expect(log).toEqual(['paused']);
  });
});

describe('Session reset', () => {
  function playedSession() {
    const bus = createGameEventBus();
    const diyas = new FakeDiyas();
    const crackers = new FakeCrackers();
    const player = new FakePlayer();
    const session = new Session({ bus, resettables: [diyas, crackers] });
    session.register(player);
    session.start();

    diyas.lit.add('d1');
    crackers.placed.push('c1', 'c2');
    player.position = { x: 12, y: 3, z: -8 };
    return { bus, session, diyas, crackers, player };
  }

  it('restores diyas unlit, no placed crackers and the player at spawn', () => {
    const { session, diyas, crackers, player } = playedSession();
    session.reset();
    expect(diyas.lit.size).toBe(0);
    expect(crackers.placed).toEqual([]);
    expect(player.position).toEqual(SPAWN);
  });

  it('start after play also gives a fresh world', () => {
    const { session, diyas, crackers, player } = playedSession();
    session.pause('user');
    session.start();
    expect(session.state).toBe('running');
    expect(diyas.lit.size).toBe(0);
    expect(crackers.placed).toEqual([]);
    expect(player.position).toEqual(SPAWN);
  });

  it('reaches modules that listen for sessionReset on the bus', () => {
    const { bus, session } = playedSession();
    const listener = vi.fn();
    bus.on('sessionReset', listener);
    session.reset();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the run/pause state', () => {
    const { session } = playedSession();
    session.pause('user');
    session.reset();
    expect(session.state).toBe('paused');
  });

  it('stops resetting a module once unregistered', () => {
    const session = new Session({ bus: createGameEventBus() });
    const module = { reset: vi.fn() };
    const unregister = session.register(module);
    unregister();
    session.reset();
    expect(module.reset).not.toHaveBeenCalled();
  });
});

describe('fresh session on reload', () => {
  // No persistence means a reload can only ever start fresh.
  const sources = import.meta.glob<string>('../src/session/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it.each(Object.entries(sources))('%s stores nothing in the browser', (_file, source) => {
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it.each(Object.entries(sources))('%s imports neither three nor rapier', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });
});
