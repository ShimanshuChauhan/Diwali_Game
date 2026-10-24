import { describe, expect, it } from 'vitest';
import { FlashPool } from '../src/effects/flashPool';
import { GRAVITY, ParticlePool, createParticleSpec } from '../src/effects/particlePool';

const step = 1 / 60;

function spec(overrides: Partial<ReturnType<typeof createParticleSpec>> = {}) {
  return { ...createParticleSpec(), ...overrides };
}

describe('ParticlePool', () => {
  it('refuses spawns beyond its limit and keeps live particles packed', () => {
    const pool = new ParticlePool(8, () => 0.5);
    pool.setLimit(3);
    expect([1, 2, 3, 4].map(() => pool.spawn(spec()))).toEqual([true, true, true, false]);
    expect(pool.count).toBe(3);
    expect(pool.available).toBe(0);
  });

  it('never raises the limit above capacity', () => {
    const pool = new ParticlePool(4);
    pool.setLimit(100);
    expect(pool.limit).toBe(4);
  });

  it('applies gravity and drag to the trajectory', () => {
    const pool = new ParticlePool(2);
    pool.spawn(spec({ vx: 10, gravity: 1, drag: 0, life: 10 }));
    pool.spawn(spec({ vx: 10, gravity: 0, drag: 2, life: 10 }));
    for (let i = 0; i < 60; i++) pool.update(step);
    // Free fall: ~g/2 metres in one second, 10 m sideways.
    expect(pool.positions[0]).toBeCloseTo(10, 3);
    expect(pool.positions[1]).toBeCloseTo(-GRAVITY / 2, 0);
    // Drag slows the second particle well short of 10 m and it does not fall.
    expect(pool.positions[3]).toBeLessThan(5);
    expect(pool.positions[4]).toBeCloseTo(0, 5);
  });

  it('interpolates colour and size over life and fades out', () => {
    const pool = new ParticlePool(1);
    pool.spawn(spec({ r0: 1, g0: 0, b0: 0, r1: 0, g1: 0, b1: 1, size0: 1, size1: 0, life: 1, gravity: 0 }));
    expect(Array.from(pool.colours)).toEqual([1, 0, 0, 1]);
    expect(pool.sizes[0]).toBe(1);
    for (let i = 0; i < 30; i++) pool.update(step);
    const alpha = pool.colours[3]!;
    expect(alpha).toBeCloseTo(0.75, 2); // 1 - t² at t = 0.5
    expect(pool.colours[0]).toBeCloseTo(0.5 * alpha, 2);
    expect(pool.colours[2]).toBeCloseTo(0.5 * alpha, 2);
    expect(pool.sizes[0]).toBeCloseTo(0.5, 2);
  });

  it('removes expired particles by swapping in the last one and reports owners', () => {
    const pool = new ParticlePool(4);
    const died: number[] = [];
    pool.onParticleDied = (owner) => died.push(owner);
    pool.spawn(spec({ life: 0.05, owner: 7, x: 1 }));
    pool.spawn(spec({ life: 1, owner: 3, x: 2, gravity: 0 }));
    pool.spawn(spec({ life: 1, owner: -1, x: 3, gravity: 0 }));
    for (let i = 0; i < 4; i++) pool.update(step);
    expect(pool.count).toBe(2);
    expect(died).toEqual([7]);
    // Survivors stay packed at the front.
    expect([pool.positions[0], pool.positions[3]].sort()).toEqual([2, 3]);
  });

  it('keeps its buffers when cleared and reused', () => {
    const pool = new ParticlePool(16);
    const buffers = [pool.positions, pool.colours, pool.sizes];
    for (let round = 0; round < 50; round++) {
      while (pool.spawn(spec({ life: 0.1 }))) {
        // fill to the limit
      }
      for (let i = 0; i < 10; i++) pool.update(step);
      expect(pool.count).toBe(0);
    }
    expect([pool.positions, pool.colours, pool.sizes]).toEqual(buffers);
    expect(pool.positions).toBe(buffers[0]);
  });
});

describe('FlashPool', () => {
  it('decays a flash and frees the slot when it ends', () => {
    const flashes = new FlashPool(2);
    expect(flashes.trigger(0, 10, 0, 0xffffff, 100, 30, 0.5)).toBe(0);
    expect(flashes.activeCount).toBe(1);
    flashes.update(0.25);
    expect(flashes.slots[0]!.intensity).toBeCloseTo(25); // (1 - 0.5)² × 100
    flashes.update(0.3);
    expect(flashes.activeCount).toBe(0);
    expect(flashes.slots[0]!.intensity).toBe(0);
  });

  it('replaces the dimmest flash when full, but only with a brighter one', () => {
    const flashes = new FlashPool(2);
    flashes.trigger(0, 0, 0, 0xff0000, 100, 10, 1);
    flashes.update(0.5); // first flash now at 25
    flashes.trigger(0, 0, 0, 0x00ff00, 100, 10, 1);
    expect(flashes.trigger(0, 0, 0, 0x0000ff, 10, 10, 1)).toBe(-1);
    expect(flashes.trigger(0, 0, 0, 0x0000ff, 50, 10, 1)).toBe(0);
    expect(flashes.slots[0]!.colour).toBe(0x0000ff);
    expect(flashes.activeCount).toBe(2);
  });

  it('respects a lowered limit and switches off slots above it', () => {
    const flashes = new FlashPool(4);
    for (let i = 0; i < 4; i++) flashes.trigger(0, 0, 0, 0xffffff, 10, 10, 1);
    flashes.setLimit(1);
    expect(flashes.activeCount).toBe(1);
    expect(flashes.slots.filter((s) => s.active)).toHaveLength(1);
    flashes.setLimit(0);
    expect(flashes.trigger(0, 0, 0, 0xffffff, 10, 10, 1)).toBe(-1);
  });
});
