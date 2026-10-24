import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_PROFILES } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES } from '../src/core/types';
import { FireworksEffects, countScaleFor } from '../src/effects/fireworksEffects';
import { FireworksEngine, NO_EFFECT } from '../src/effects/fireworksEngine';
import { BURST_PATTERNS, FOUNTAIN, ROCKET_TRAIL, SKY_BURST } from '../src/effects/presets';

const step = 1 / 60;

/** Deterministic PRNG (mulberry32) so particle counts are repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function engine(budget: Partial<Parameters<FireworksEngine['applyBudget']>[0]> = {}) {
  const e = new FireworksEngine({ particleCapacity: 5000, emitterCapacity: 8, flashCapacity: 4, random: seeded(1) });
  e.applyBudget({ maxParticles: 5000, maxActiveEffects: 8, maxDynamicLights: 4, countScale: 1, ...budget });
  return e;
}

function run(e: { update(dt: number): void }, seconds: number): void {
  for (let t = 0; t < seconds; t += step) e.update(step);
}

describe('FireworksEngine', () => {
  it('spawns a burst with a flash and cleans the effect up once its sparks die', () => {
    const e = engine();
    const handle = e.burst(0, 30, 0, 'peony', [0xff0000]);
    expect(handle).not.toBe(NO_EFFECT);
    expect(e.stats.liveParticles).toBe(SKY_BURST.count);
    expect(e.stats.activeEffects).toBe(1);
    expect(e.stats.dynamicLights).toBe(1);
    run(e, 6);
    expect(e.isAlive(handle)).toBe(false);
    expect(e.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
  });

  it.each(BURST_PATTERNS)('produces a visible %s burst', (pattern) => {
    const e = engine();
    e.burst(0, 30, 0, pattern, [0x00ff00, 0x0000ff]);
    expect(e.stats.liveParticles).toBeGreaterThan(100);
    run(e, 0.5);
    // Sparks have travelled outwards from the centre.
    const pos = e.particles.positions;
    let far = 0;
    for (let i = 0; i < e.particles.count; i++) {
      if (Math.hypot(pos[i * 3]!, pos[i * 3 + 1]! - 30, pos[i * 3 + 2]!) > 2) far++;
    }
    expect(far / e.particles.count).toBeGreaterThan(0.8);
  });

  it('lays ring bursts out in a single plane', () => {
    const e = engine();
    e.burst(0, 0, 0, 'ring', [0xffffff]);
    e.update(step);
    const p = e.particles.positions;
    // Plane normal from two spark positions; every spark lies on it.
    const a = [p[0]!, p[1]!, p[2]!];
    const k = Math.floor(e.particles.count / 4) * 3;
    const b = [p[k]!, p[k + 1]!, p[k + 2]!];
    const n = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    for (let i = 0; i < e.particles.count; i++) {
      const d = (p[i * 3]! * n[0]! + p[i * 3 + 1]! * n[1]! + p[i * 3 + 2]! * n[2]!) / len;
      expect(Math.abs(d)).toBeLessThan(0.05);
    }
  });

  it('moves a stream emitter with its velocity and leaves a trail behind it', () => {
    const e = engine();
    const handle = e.startStream(ROCKET_TRAIL, 0, 0, 0);
    e.setEmitterVelocity(handle, 0, 20, 0);
    run(e, 1);
    expect(e.emitterPosition(handle)!.y).toBeCloseTo(20, 0);
    expect(e.stats.liveParticles).toBeGreaterThan(50);
    const pos = e.particles.positions;
    let below = 0;
    for (let i = 0; i < e.particles.count; i++) if (pos[i * 3 + 1]! < 19) below++;
    expect(below).toBeGreaterThan(e.particles.count / 2);
    e.stopEmitter(handle);
    run(e, 2);
    expect(e.isAlive(handle)).toBe(false);
    expect(e.stats.liveParticles).toBe(0);
  });

  it('caps live particles at the budget and counts what it dropped', () => {
    const e = engine({ maxParticles: 500 });
    for (let i = 0; i < 4; i++) e.burst(0, 30, 0, 'peony', [0xffffff]);
    expect(e.stats.liveParticles).toBe(500);
    expect(e.stats.droppedParticles).toBe(4 * SKY_BURST.count - 500);
  });

  it('scales particle counts with the quality scale', () => {
    const low = engine({ countScale: 0.5 });
    low.burst(0, 30, 0, 'peony', []);
    expect(low.stats.liveParticles).toBe(SKY_BURST.count / 2);
  });

  it('evicts the oldest finished-emitting effect rather than refusing a new one', () => {
    const e = engine({ maxActiveEffects: 2 });
    const first = e.burst(0, 30, 0, 'peony', [0xff0000]);
    const second = e.burst(5, 30, 0, 'peony', [0x00ff00]);
    const third = e.burst(10, 30, 0, 'peony', [0x0000ff]);
    expect(e.isAlive(first)).toBe(false);
    expect([e.isAlive(second), e.isAlive(third)]).toEqual([true, true]);
    expect(e.stats.activeEffects).toBe(2);
    expect(e.stats.evictedEffects).toBe(1);
    // The evicted burst's sparks keep flying until they expire.
    expect(e.stats.liveParticles).toBe(3 * SKY_BURST.count);
  });

  it('refuses a new effect when every slot is still emitting', () => {
    const e = engine({ maxActiveEffects: 1 });
    expect(e.startStream(FOUNTAIN, 0, 0, 0)).not.toBe(NO_EFFECT);
    expect(e.startStream(FOUNTAIN, 1, 0, 0)).toBe(NO_EFFECT);
    expect(e.stats.rejectedEffects).toBe(1);
  });

  it('ignores stale handles after a slot is reused', () => {
    const e = engine({ maxActiveEffects: 1 });
    const old = e.burst(0, 30, 0, 'peony', []);
    run(e, 6);
    const fresh = e.startStream(FOUNTAIN, 0, 0, 0);
    expect(fresh).not.toBe(old);
    e.stopEmitter(old);
    expect(e.isAlive(fresh)).toBe(true);
  });

  it('reset drops every effect, particle and flash', () => {
    const e = engine();
    e.burst(0, 30, 0, 'willow', []);
    e.startStream(FOUNTAIN, 0, 0, 0);
    e.reset();
    expect(e.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
  });

  it('stays bounded over a long session of repeated bursts', () => {
    const e = engine({ maxParticles: 2000, maxActiveEffects: 4, maxDynamicLights: 2 });
    const buffers = [e.particles.positions, e.particles.colours, e.particles.sizes];
    let peak = 0;
    let fountain = NO_EFFECT;
    for (let second = 0; second < 300; second++) {
      e.burst(0, 30, 0, BURST_PATTERNS[second % BURST_PATTERNS.length]!, [0xffaa00]);
      if (second % 10 === 0) fountain = e.startStream(FOUNTAIN, 0, 0, 0);
      if (second % 10 === 5) e.stopEmitter(fountain);
      for (let i = 0; i < 60; i++) {
        e.update(step);
        peak = Math.max(peak, e.stats.liveParticles);
        expect(e.stats.activeEffects).toBeLessThanOrEqual(4);
        expect(e.stats.dynamicLights).toBeLessThanOrEqual(2);
      }
    }
    expect(peak).toBeLessThanOrEqual(2000);
    expect([e.particles.positions, e.particles.colours, e.particles.sizes]).toEqual(buffers);
    expect(e.particles.positions).toBe(buffers[0]);
    run(e, 8);
    expect(e.stats).toMatchObject({ liveParticles: 0, dynamicLights: 0 });
  });
});

describe('FireworksEffects', () => {
  function setup() {
    const bus = createGameEventBus();
    const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.medium, random: seeded(2) });
    return { bus, effects };
  }

  it('starts a stream effect for every cracker type when it becomes active', () => {
    const { bus, effects } = setup();
    CRACKER_TYPES.forEach((type, i) => {
      bus.emit('crackerActive', { id: `c${i}`, type, position: { x: i, y: 0, z: 0 } });
    });
    effects.update(step);
    expect(effects.stats.activeEffects).toBe(CRACKER_TYPES.length);
    expect(effects.stats.liveParticles).toBeGreaterThan(0);
    for (let i = 0; i < CRACKER_TYPES.length; i++) expect(effects.handleFor(`c${i}`)).not.toBe(NO_EFFECT);
  });

  it('flies a rocket trail up to the apex in the active duration, then bursts', () => {
    const { bus, effects } = setup();
    bus.emit('crackerActive', { id: 'r', type: 'rocket', position: { x: 0, y: 0, z: 0 } });
    const trail = effects.handleFor('r');
    run(effects, TUNING.crackers.activeDuration.rocket);
    expect(effects.engine.emitterPosition(trail)!.y).toBeCloseTo(TUNING.crackers.rocketApexHeight, -1);
    bus.emit('burst', { id: 'r', position: { x: 0, y: 40, z: 0 }, pattern: 'palm', colours: [0xff0000] });
    bus.emit('crackerFinished', { id: 'r', type: 'rocket', reason: 'completed' });
    expect(effects.handleFor('r')).toBe(NO_EFFECT);
    expect(effects.stats.dynamicLights).toBe(1);
    run(effects, 8);
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
  });

  it('stops a ground effect when its cracker finishes', () => {
    const { bus, effects } = setup();
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    run(effects, 1);
    bus.emit('crackerFinished', { id: 'a', type: 'anar', reason: 'completed' });
    run(effects, 3);
    expect(effects.stats.activeEffects).toBe(0);
    expect(effects.stats.liveParticles).toBe(0);
  });

  it('applies quality budgets from qualityChanged without reallocating', () => {
    const { bus, effects } = setup();
    const positions = effects.engine.particles.positions;
    bus.emit('qualityChanged', { profile: QUALITY_PROFILES.low });
    expect(effects.stats).toMatchObject({
      particleLimit: QUALITY_PROFILES.low.maxParticles,
      effectLimit: QUALITY_PROFILES.low.maxActiveEffects,
      lightLimit: QUALITY_PROFILES.low.maxDynamicLights,
    });
    bus.emit('qualityChanged', { profile: QUALITY_PROFILES.high });
    expect(effects.stats.particleLimit).toBe(QUALITY_PROFILES.high.maxParticles);
    expect(effects.engine.particles.positions).toBe(positions);
  });

  it('keeps recognisable bursts on Low', () => {
    expect(countScaleFor(QUALITY_PROFILES.low)).toBeGreaterThanOrEqual(0.5);
    expect(countScaleFor(QUALITY_PROFILES.high)).toBeGreaterThan(countScaleFor(QUALITY_PROFILES.medium));
    const bus = createGameEventBus();
    const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.low, random: seeded(3) });
    bus.emit('burst', { id: 'r', position: { x: 0, y: 40, z: 0 }, pattern: 'peony', colours: [0xffffff] });
    expect(effects.stats.liveParticles).toBeGreaterThanOrEqual(150);
  });

  it('clears everything on sessionReset and stops listening after dispose', () => {
    const { bus, effects } = setup();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    effects.update(step);
    bus.emit('sessionReset', {});
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0 });
    effects.dispose();
    bus.emit('burst', { id: 'x', position: { x: 0, y: 40, z: 0 }, pattern: 'ring', colours: [] });
    expect(effects.stats.liveParticles).toBe(0);
    expect(bus.listenerCount('burst')).toBe(0);
  });
});

describe('effects simulation stays renderer-free', () => {
  // Only the renderer and demo draw; the simulation must run headless.
  const sources = import.meta.glob<string>(
    ['../src/effects/*.ts', '!../src/effects/effectsRenderer.ts', '!../src/effects/effectsDemo.ts'],
    { query: '?raw', import: 'default', eager: true },
  );

  it.each(Object.entries(sources))('%s does not import three', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"]three/);
  });
});
