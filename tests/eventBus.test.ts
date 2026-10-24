import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/eventBus';
import { createGameEventBus } from '../src/core/events';

interface TestEvents {
  ping: { n: number };
  pong: { text: string };
}

describe('EventBus', () => {
  it('delivers emitted payloads to subscribers of that event only', () => {
    const bus = new EventBus<TestEvents>();
    const ping = vi.fn();
    const pong = vi.fn();
    bus.on('ping', ping);
    bus.on('pong', pong);

    bus.emit('ping', { n: 1 });

    expect(ping).toHaveBeenCalledExactlyOnceWith({ n: 1 });
    expect(pong).not.toHaveBeenCalled();
  });

  it('calls listeners in subscription order', () => {
    const bus = new EventBus<TestEvents>();
    const order: string[] = [];
    bus.on('ping', () => order.push('a'));
    bus.on('ping', () => order.push('b'));
    bus.emit('ping', { n: 0 });
    expect(order).toEqual(['a', 'b']);
  });

  it('emitting with no subscribers is a no-op', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.emit('ping', { n: 0 })).not.toThrow();
  });

  it('stops delivery after the returned unsubscribe is called', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    const unsubscribe = bus.on('ping', listener);

    unsubscribe();
    bus.emit('ping', { n: 1 });

    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('stops delivery after off and leaves other listeners subscribed', () => {
    const bus = new EventBus<TestEvents>();
    const removed = vi.fn();
    const kept = vi.fn();
    bus.on('ping', removed);
    bus.on('ping', kept);

    bus.off('ping', removed);
    bus.emit('ping', { n: 2 });

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledOnce();
  });

  it('unsubscribing twice is harmless', () => {
    const bus = new EventBus<TestEvents>();
    const unsubscribe = bus.on('ping', () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('once delivers a single time', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    bus.once('ping', listener);
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ n: 1 });
  });

  it('applies changes made during an emit from the next emit', () => {
    const bus = new EventBus<TestEvents>();
    const late = vi.fn();
    const second = vi.fn();
    const unsubscribeSecond = bus.on('ping', () => {
      unsubscribeSecond();
      bus.on('ping', late);
    });
    bus.on('ping', second);

    bus.emit('ping', { n: 1 });
    expect(second).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();

    bus.emit('ping', { n: 2 });
    expect(late).toHaveBeenCalledOnce();
  });

  it('clear removes every listener', () => {
    const bus = new EventBus<TestEvents>();
    const listener = vi.fn();
    bus.on('ping', listener);
    bus.on('pong', listener);
    bus.clear();
    bus.emit('ping', { n: 1 });
    bus.emit('pong', { text: 'x' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('counts listeners across every event', () => {
    const bus = new EventBus<TestEvents>();
    expect(bus.totalListenerCount()).toBe(0);
    const offPing = bus.on('ping', () => undefined);
    bus.on('ping', () => undefined);
    bus.on('pong', () => undefined);
    expect(bus.totalListenerCount()).toBe(3);
    offPing();
    expect(bus.totalListenerCount()).toBe(2);
    bus.clear();
    expect(bus.totalListenerCount()).toBe(0);
  });

  it('carries typed game events', () => {
    const bus = createGameEventBus();
    const placed = vi.fn();
    bus.on('crackerPlaced', placed);
    const payload = { id: 'c1', type: 'anar' as const, position: { x: 1, y: 0, z: 2 } };
    bus.emit('crackerPlaced', payload);
    expect(placed).toHaveBeenCalledExactlyOnceWith(payload);
  });
});
