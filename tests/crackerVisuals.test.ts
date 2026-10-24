import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_PROFILES, type QualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, type CrackerType, type Vec3 } from '../src/core/types';
import { CRACKER_DEFINITIONS, Crackers, rollRocketVariant, ROCKET_PALETTES } from '../src/crackers';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { FireworksEngine, NO_EFFECT } from '../src/effects/fireworksEngine';
import { BURST_PATTERNS, PATTERN_SHAPES, SPINNER } from '../src/effects/presets';

const step = 1 / 60;
const { fuse, activeDuration } = TUNING.crackers;

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

function run(e: { update(dt: number): void }, seconds: number): void {
  for (let t = 0; t < seconds; t += step) e.update(step);
}

interface Extent {
  /** Highest spark above the source, metres. */
  height: number;
  /** Furthest spark from the source on the ground plane, metres. */
  reach: number;
}

function extent(engine: FireworksEngine, origin: Vec3): Extent {
  const p = engine.particles.positions;
  let height = 0;
  let reach = 0;
  for (let i = 0; i < engine.particles.count; i++) {
    height = Math.max(height, p[i * 3 + 1]! - origin.y);
    reach = Math.max(reach, Math.hypot(p[i * 3]! - origin.x, p[i * 3 + 2]! - origin.z));
  }
  return { height, reach };
}

function effectsFor(quality: QualityProfile = QUALITY_PROFILES.medium, hand = { position: { x: 0, y: 1.1, z: 0 } }) {
  const bus = createGameEventBus();
  const effects = new FireworksEffects(bus, { quality, random: seeded(5), handPosition: () => hand.position });
  return { bus, effects, hand };
}

describe('fuse sparkle', () => {
  it('sparkles while the fuse burns, then hands over to the main effect', () => {
    const { bus, effects } = effectsFor();
    bus.emit('fuseLit', { id: 'a', type: 'anar', position: { x: 2, y: 0, z: 0 } });
    const fuseHandle = effects.handleFor('a');
    expect(fuseHandle).not.toBe(NO_EFFECT);
    run(effects, 0.5);
    expect(effects.stats.liveParticles).toBeGreaterThan(10);
    // Tiny: nothing strays far from the fuse.
    expect(extent(effects.engine, { x: 2, y: 0, z: 0 }).reach).toBeLessThan(1);

    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 2, y: 0, z: 0 } });
    expect(effects.handleFor('a')).not.toBe(fuseHandle);
    run(effects, 0.5);
    expect(effects.engine.isAlive(fuseHandle)).toBe(false);
  });

  it('stops if the cracker is reclaimed or finished before it goes off', () => {
    const { bus, effects } = effectsFor();
    bus.emit('fuseLit', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    run(effects, 0.2);
    bus.emit('crackerFinished', { id: 'c', type: 'chakri', reason: 'completed' });
    run(effects, 1);
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0 });
  });
});

describe('ground and handheld cracker looks', () => {
  /** Shape of each cracker's spray after it has run a while. */
  function sprayOf(type: CrackerType): Extent {
    const { bus, effects } = effectsFor();
    const origin = type === 'phuljhari' ? { x: 0, y: 1.1, z: 0 } : { x: 0, y: 0, z: 0 };
    bus.emit('crackerActive', { id: type, type, position: origin });
    run(effects, type === 'rocket' ? 1 : 2);
    if (type === 'rocket') return { height: effects.engine.emitterPosition(effects.handleFor(type))!.y, reach: 0 };
    return extent(effects.engine, origin);
  }

  it('gives every type a distinct silhouette', () => {
    const phuljhari = sprayOf('phuljhari');
    const anar = sprayOf('anar');
    const chakri = sprayOf('chakri');
    const rocket = sprayOf('rocket');
    // Phuljhari: a small ball of sparks in the hand.
    expect(phuljhari.height).toBeLessThan(1);
    expect(phuljhari.reach).toBeLessThan(1.2);
    // Anar: a tall, narrow fountain.
    expect(anar.height).toBeGreaterThan(2);
    expect(anar.height).toBeGreaterThan(anar.reach);
    // Chakri: low and wide.
    expect(chakri.height).toBeLessThan(0.6);
    expect(chakri.reach).toBeGreaterThan(chakri.height * 2);
    // Rocket: climbs away from the ground.
    expect(rocket.height).toBeGreaterThan(10);
  });

  it('keeps the phuljhari sparks at the hand as the player moves', () => {
    const { bus, effects, hand } = effectsFor();
    bus.emit('fuseLit', { id: 'p', type: 'phuljhari', position: hand.position });
    hand.position = { x: 3, y: 1.1, z: -2 };
    run(effects, 0.2);
    expect(effects.engine.emitterPosition(effects.handleFor('p'))).toMatchObject(hand.position);

    bus.emit('crackerActive', { id: 'p', type: 'phuljhari', position: hand.position });
    hand.position = { x: -4, y: 1.1, z: 5 };
    run(effects, 1);
    expect(effects.engine.emitterPosition(effects.handleFor('p'))).toMatchObject(hand.position);
    // Most sparks are within crackle range of the new hand position.
    expect(extent(effects.engine, hand.position).reach).toBeLessThan(1.5);
  });

  it('crackles: sparks pop in small clusters on top of the steady stream', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'p', type: 'phuljhari', position: { x: 0, y: 1.1, z: 0 } });
    const counts: number[] = [];
    for (let i = 0; i < 120; i++) {
      effects.update(step);
      counts.push(effects.stats.liveParticles);
    }
    // Pops make the spark count jump between steps rather than creep.
    const jumps = counts.slice(1).filter((n, i) => n - counts[i]! >= 6).length;
    expect(jumps).toBeGreaterThan(5);
  });

  it('varies the anar fountain height as it burns', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    run(effects, 1.5);
    const heights: number[] = [];
    for (let window = 0; window < 12; window++) {
      run(effects, 0.4);
      heights.push(extent(effects.engine, { x: 0, y: 0, z: 0 }).height);
    }
    expect(Math.max(...heights) / Math.min(...heights)).toBeGreaterThan(1.25);
  });

  it('spins the chakri with radial sparks and lets it wander a little', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 5, y: 0, z: 5 } });
    const handle = effects.handleFor('c');
    let moved = 0;
    for (let i = 0; i < 6 / step; i++) {
      effects.update(step);
      const at = effects.engine.emitterPosition(handle)!;
      const from = Math.hypot(at.x - 5, at.z - 5);
      moved = Math.max(moved, from);
      expect(from).toBeLessThanOrEqual(SPINNER.wander!.radius + 1e-6);
      expect(at.y).toBe(0);
    }
    expect(moved).toBeGreaterThan(0.1);
    // Sparks land on every side of the wheel.
    const quadrants = new Set<number>();
    const at = effects.engine.emitterPosition(handle)!;
    const p = effects.engine.particles.positions;
    for (let i = 0; i < effects.engine.particles.count; i++) {
      quadrants.add((p[i * 3]! > at.x ? 1 : 0) + (p[i * 3 + 2]! > at.z ? 2 : 0));
    }
    expect(quadrants.size).toBe(4);
  });
});

describe('rocket sky bursts', () => {
  function engine(countScale = 1) {
    const e = new FireworksEngine({ particleCapacity: 20000, emitterCapacity: 8, flashCapacity: 4, random: seeded(9) });
    e.applyBudget({ maxParticles: 20000, maxActiveEffects: 8, maxDynamicLights: 4, countScale });
    return e;
  }

  it('offers at least six distinct patterns, including a multi-break and a heart', () => {
    expect(BURST_PATTERNS.length).toBeGreaterThanOrEqual(6);
    expect(BURST_PATTERNS).toEqual(expect.arrayContaining(['peony', 'ring', 'willow', 'crossette', 'heart']));
    expect(CRACKER_DEFINITIONS.rocket.effect.patterns).toEqual(expect.arrayContaining(BURST_PATTERNS));
  });

  it('splits crossette stars into crosses of sparks after a delay', () => {
    const e = engine();
    const breaks = PATTERN_SHAPES.crossette.breaks!;
    const handle = e.burst(0, 40, 0, 'crossette', [0xffd34f]);
    expect(e.pendingBreaks).toBe(breaks.stars);
    const before = e.stats.liveParticles;
    run(e, breaks.delay + step * 2);
    expect(e.pendingBreaks).toBe(0);
    expect(e.stats.liveParticles).toBeGreaterThan(before);
    expect(e.isAlive(handle)).toBe(true);
    run(e, 6);
    expect(e.isAlive(handle)).toBe(false);
    expect(e.stats.liveParticles).toBe(0);
  });

  it('cancels pending splits when its effect is reset or evicted', () => {
    const e = engine();
    e.burst(0, 40, 0, 'crossette', [0xffffff]);
    e.reset();
    expect(e.pendingBreaks).toBe(0);

    e.applyBudget({ maxParticles: 20000, maxActiveEffects: 1, maxDynamicLights: 4, countScale: 1 });
    e.burst(0, 40, 0, 'crossette', [0xffffff]);
    e.burst(10, 40, 0, 'peony', [0xffffff]);
    expect(e.pendingBreaks).toBe(0);
    expect(e.stats.evictedEffects).toBe(1);
  });

  it('turns heart bursts square-on to the viewer', () => {
    for (const viewer of [
      { x: 0, y: 1.7, z: 60 }, // street, looking along the lane
      { x: 45, y: 9, z: 0 }, // rooftop, off to the side
    ]) {
      const e = engine();
      e.setViewpoint(viewer.x, viewer.y, viewer.z);
      e.burst(0, 40, 0, 'heart', [0xff4f6d]);
      run(e, 0.6);
      const toViewer = { x: viewer.x, z: viewer.z };
      const len = Math.hypot(toViewer.x, toViewer.z);
      const p = e.particles.positions;
      let wide = 0;
      let tall = 0;
      for (let i = 0; i < e.particles.count; i++) {
        const x = p[i * 3]!;
        const z = p[i * 3 + 2]!;
        // Depth along the line of sight stays flat; the shape spreads across it.
        expect(Math.abs((x * toViewer.x + z * toViewer.z) / len)).toBeLessThan(0.2);
        wide = Math.max(wide, Math.abs((x * toViewer.z - z * toViewer.x) / len));
        tall = Math.max(tall, Math.abs(p[i * 3 + 1]! - 40));
      }
      expect(wide).toBeGreaterThan(3);
      expect(tall).toBeGreaterThan(3);
    }
  });

  it.each(BURST_PATTERNS)('keeps a recognisable %s burst with a flash on Low', (pattern) => {
    const { bus, effects } = effectsFor(QUALITY_PROFILES.low);
    bus.emit('burst', { id: 'r', position: { x: 0, y: 40, z: 0 }, pattern, colours: [0xffd34f, 0x4fb6ff] });
    expect(effects.stats.dynamicLights).toBe(1);
    let peak = 0;
    let widest = 0;
    for (let i = 0; i < 1.5 / step; i++) {
      effects.update(step);
      peak = Math.max(peak, effects.stats.liveParticles);
      widest = Math.max(widest, extent(effects.engine, { x: 0, y: 40, z: 0 }).reach);
    }
    expect(peak).toBeGreaterThanOrEqual(90);
    // At least 10 m across: big enough to read from the street 40 m below.
    expect(widest).toBeGreaterThan(5);
  });

  it('draws each rocket from one themed palette, using several over a session', () => {
    const random = seeded(11);
    const used = new Set<readonly number[]>();
    for (let i = 0; i < 80; i++) {
      const { colours } = rollRocketVariant(CRACKER_DEFINITIONS.rocket, random);
      const palette = ROCKET_PALETTES.find((set) => colours.every((c) => set.includes(c)));
      expect(palette).toBeDefined();
      if (palette !== ROCKET_PALETTES[ROCKET_PALETTES.length - 1]) used.add(palette!);
    }
    expect(used.size).toBeGreaterThan(3);
  });
});

describe('full lifecycle with effects', () => {
  it.each(CRACKER_TYPES)('%s lights, runs its effect and leaves nothing behind', (type) => {
    const bus = createGameEventBus();
    const hand = { x: 0, y: 1.1, z: 0 };
    const crackers = new Crackers({ bus, random: seeded(3), handPosition: () => hand, initialSelection: type });
    const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.low, random: seeded(4), handPosition: () => hand });
    let id: string;
    if (type === 'phuljhari') {
      expect(crackers.igniteHeld().ok).toBe(true);
      id = crackers.held!.id;
    } else {
      const placed = crackers.place({ type, position: { x: 2, y: 0, z: -3 } });
      if (!placed.ok) throw new Error('placement refused');
      id = placed.id;
      expect(crackers.ignite(id).ok).toBe(true);
    }
    const tick = () => {
      crackers.update(step);
      effects.update(step);
    };
    run({ update: tick }, fuse[type] / 2);
    expect(effects.handleFor(id)).not.toBe(NO_EFFECT); // fuse sparkle
    run({ update: tick }, fuse[type] / 2 + 0.2);
    expect(effects.stats.liveParticles).toBeGreaterThan(0);
    run({ update: tick }, activeDuration[type] * 1.3);
    expect(effects.handleFor(id)).toBe(NO_EFFECT);
    run({ update: tick }, 8);
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
    expect(effects.engine.pendingBreaks).toBe(0);
  });
});
