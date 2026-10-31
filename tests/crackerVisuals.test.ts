import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_PROFILES, type QualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, type CrackerType, type Vec3 } from '../src/core/types';
import { CRACKER_DEFINITIONS, Crackers, rollRocketVariant, ROCKET_PALETTES } from '../src/crackers';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { burstSparkCount, FireworksEngine, NO_EFFECT } from '../src/effects/fireworksEngine';
import { BURST_STAR } from '../src/effects/particlePool';
import {
  ANAR_PALETTES,
  BURST_CRACKLE,
  BURST_LOOKS,
  BURST_PATTERNS,
  CHAKRI_PALETTES,
  PATTERN_SHAPES,
  SKY_BURST,
  SPINNER,
  SPINNER_LOW,
  spinRampFactor,
} from '../src/effects/presets';

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

describe('anar fountain', () => {
  it('rises from the mouth of its pot to about three metres, and no higher', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    let tallest = 0;
    let lowestSpawn = Infinity;
    for (let window = 0; window < 20; window++) {
      run(effects, 0.25);
      tallest = Math.max(tallest, extent(effects.engine, { x: 0, y: 0, z: 0 }).height);
    }
    const p = effects.engine.particles.positions;
    for (let i = 0; i < effects.engine.particles.count; i++) lowestSpawn = Math.min(lowestSpawn, p[i * 3 + 1]!);
    expect(tallest).toBeGreaterThan(2);
    expect(tallest).toBeLessThan(4.5);
    // Embers fall back to (and past) the ground around the pot.
    expect(lowestSpawn).toBeLessThan(0.26);
  });

  it('keeps a white-hot glow at the mouth and lights the lane while it burns', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    for (let sample = 0; sample < 8; sample++) {
      run(effects, 0.25);
      expect(effects.engine.flashes.activeCount).toBeGreaterThan(0);
    }
    const { positions: p, colours: c } = effects.engine.particles;
    let hotAtMouth = 0;
    for (let i = 0; i < effects.engine.particles.count; i++) {
      const nearMouth = Math.hypot(p[i * 3]!, p[i * 3 + 1]! - 0.26, p[i * 3 + 2]!) < 0.3;
      if (nearMouth && c[i * 4]! > 1 && c[i * 4 + 2]! > 0.5) hotAtMouth++;
    }
    expect(hotAtMouth).toBeGreaterThan(3);
    bus.emit('crackerFinished', { id: 'a', type: 'anar', reason: 'completed' });
    run(effects, 0.4);
    expect(effects.engine.flashes.activeCount).toBe(0);
  });

  it('burns in one of the anar palettes and sparkles its fuse at the mouth', () => {
    const firsts = new Set(ANAR_PALETTES.map((palette) => palette[0]));
    const seen = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const bus = createGameEventBus();
      const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.medium, random: seeded(seed) });
      bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
      run(effects, 0.05);
      const lit = effects.engine.flashes.slots.find((slot) => slot.active)!;
      expect(firsts.has(lit.colour)).toBe(true);
      seen.add(lit.colour);
    }
    expect(seen.size).toBeGreaterThan(1);

    const { bus, effects } = effectsFor();
    bus.emit('fuseLit', { id: 'f', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    expect(effects.engine.emitterPosition(effects.handleFor('f'))!.y).toBeCloseTo(0.27);
  });
});

describe('chakri wheel', () => {
  it.each([
    ['full', SPINNER],
    ['lean', SPINNER_LOW],
  ] as const)('throws its %s sparks from the rim of the wheel, not its centre', (_name, preset) => {
    const engine = new FireworksEngine({ particleCapacity: 4000, emitterCapacity: 2, flashCapacity: 4, random: seeded(3) });
    engine.startStream({ ...preset, wander: undefined }, 0, 0, 0);
    engine.update(1 / 120);
    const rim = preset.rim!;
    const p = engine.particles.positions;
    expect(engine.particles.count).toBeGreaterThan(3);
    for (let i = 0; i < engine.particles.count; i++) {
      const r = Math.hypot(p[i * 3]!, p[i * 3 + 2]!);
      expect(r).toBeGreaterThan(rim.radius - 0.02);
      expect(r).toBeLessThan(rim.radius + 0.08);
      expect(p[i * 3 + 1]).toBeCloseTo(rim.height, 1);
    }
  });

  /** Live sparks, white-hot sparks at the rim, and sparks well out in the shower, after `seconds`. */
  function chakriAt(level: 'low' | 'medium' | 'high', seconds: number) {
    const { bus, effects } = effectsFor(QUALITY_PROFILES[level]);
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    run(effects, seconds);
    const at = effects.engine.emitterPosition(effects.handleFor('c'))!;
    const { positions: p, colours: c } = effects.engine.particles;
    let hotAtRim = 0;
    let far = 0;
    for (let i = 0; i < effects.engine.particles.count; i++) {
      const r = Math.hypot(p[i * 3]! - at.x, p[i * 3 + 2]! - at.z);
      if (r < SPINNER.rim!.radius + 0.1 && c[i * 4]! > 1.2 && c[i * 4 + 2]! > 0.5) hotAtRim++;
      if (r > 1) far++;
    }
    return { effects, live: effects.engine.particles.count, hotAtRim, far };
  }

  it('dresses the chakri like the anar on Medium and High: a dense, streaking shower and a white-hot ring', () => {
    const low = chakriAt('low', 3);
    const medium = chakriAt('medium', 3);
    const high = chakriAt('high', 3);
    // Tails and longer-lived sparks: several times Low's spark count, scaled up again on High.
    expect(medium.live).toBeGreaterThan(low.live * 4);
    expect(high.live).toBeGreaterThan(medium.live * 1.3);
    // Sparks fly well out from the wheel in its spiral arms.
    expect(medium.far).toBeGreaterThan(100);
    expect(medium.far).toBeGreaterThan(low.far * 5);
    // Jet heads bright enough to bloom, which Low's lean wheel never has.
    expect(medium.hotAtRim).toBeGreaterThan(5);
    expect(low.hotAtRim).toBe(0);
    // A stronger light on the ground round it.
    expect(SPINNER.light!.peak).toBeGreaterThan(SPINNER_LOW.light!.peak * 2);
    expect(SPINNER.light!.range).toBeGreaterThan(SPINNER_LOW.light!.range);
    // Every level stays inside its particle budget.
    for (const { effects } of [low, medium, high]) {
      expect(effects.stats.liveParticles).toBeLessThanOrEqual(effects.stats.particleLimit);
    }
  });

  it('crackles in the shower round the wheel on Medium, but not on Low', () => {
    const crackle = SPINNER.crackle!;
    expect(SPINNER_LOW.crackle).toBeUndefined();
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    let pops = 0;
    for (let i = 0; i < 2 / step; i++) {
      effects.update(step);
      const { positions: p, colours: c } = effects.engine.particles;
      for (let k = 0; k < effects.engine.particles.count; k++) {
        // Crackle sparks are the near-white ones above the ground plane, away from the rim.
        const r = Math.hypot(p[k * 3]!, p[k * 3 + 2]!);
        const white = c[k * 4]! > 1.2 && c[k * 4 + 2]! > 1;
        if (white && r > 0.4 && p[k * 3 + 1]! > -0.05) pops++;
      }
    }
    expect(pops).toBeGreaterThan(crackle.count);
  });

  it('spins up after lighting and winds down as it burns out, on Medium and High', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    const spinOver = (seconds: number): number => {
      const before = effects.spinnerPose('c')!.angle;
      run(effects, seconds);
      return (effects.spinnerPose('c')!.angle - before) / seconds;
    };
    const catching = spinOver(0.2);
    run(effects, 1);
    const full = spinOver(0.5);
    const sparksAtFull = effects.engine.particles.count;
    run(effects, activeDuration.chakri - 2.4);
    const dying = spinOver(0.5);
    expect(catching).toBeLessThan(full * 0.75);
    expect(full / SPINNER.spin).toBeCloseTo(1, 1);
    expect(dying).toBeLessThan(full * 0.6);
    expect(effects.engine.particles.count).toBeLessThan(sparksAtFull * 0.75);
    // The ramp holds at full speed in the middle and never stops the wheel dead.
    const ramp = SPINNER.spinRamp!;
    expect(spinRampFactor(ramp, 3, activeDuration.chakri)).toBe(1);
    expect(spinRampFactor(ramp, activeDuration.chakri, activeDuration.chakri)).toBeCloseTo(ramp.end);
    expect(spinRampFactor(ramp, 100, Infinity)).toBe(1);
  });

  it('keeps the lean chakri on Low, spinning at full speed from the start', () => {
    const { bus, effects } = effectsFor(QUALITY_PROFILES.low);
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    const first = effects.spinnerPose('c')!;
    run(effects, 0.2);
    expect(effects.spinnerPose('c')!.angle - first.angle).toBeCloseTo(SPINNER_LOW.spin * 0.2, 0);
  });

  it('keeps a flickering light on while it burns and lets it fade after', () => {
    const { bus, effects } = effectsFor();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
    for (let sample = 0; sample < 12; sample++) {
      run(effects, 0.25);
      expect(effects.engine.flashes.activeCount).toBeGreaterThan(0);
    }
    bus.emit('crackerFinished', { id: 'c', type: 'chakri', reason: 'completed' });
    run(effects, 0.5);
    expect(effects.engine.flashes.activeCount).toBe(0);
  });

  it('burns in one of the chakri palettes, varying between chakris', () => {
    const firsts = new Set(CHAKRI_PALETTES.map((palette) => palette[0]));
    const seen = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const bus = createGameEventBus();
      const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.medium, random: seeded(seed) });
      bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 0, y: 0, z: 0 } });
      run(effects, 0.05);
      const lit = effects.engine.flashes.slots.find((slot) => slot.active);
      expect(lit).toBeDefined();
      expect(firsts.has(lit!.colour)).toBe(true);
      seen.add(lit!.colour);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reports where the wheel is and how far it has turned, only while it spins', () => {
    const { bus, effects } = effectsFor();
    expect(effects.spinnerPose('c')).toBeNull();
    bus.emit('crackerActive', { id: 'c', type: 'chakri', position: { x: 2, y: 0, z: -1 } });
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: 0 } });
    expect(effects.spinnerPose('a')).toBeNull();
    run(effects, 1);
    const first = effects.spinnerPose('c')!;
    run(effects, 0.2);
    const later = effects.spinnerPose('c')!;
    expect(later.angle - first.angle).toBeCloseTo(SPINNER.spin * 0.2, 0);
    expect(Math.hypot(later.x - 2, later.z + 1)).toBeLessThanOrEqual(SPINNER.wander!.radius + 1e-6);
    bus.emit('crackerFinished', { id: 'c', type: 'chakri', reason: 'completed' });
    expect(effects.spinnerPose('c')).toBeNull();
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

describe('rocket bursts on Medium and High, as rich as the anar', () => {
  const SKY = { x: 0, y: 40, z: 0 } as const;
  const levels = ['low', 'medium', 'high'] as const;

  function burstAt(level: (typeof levels)[number], pattern: (typeof BURST_PATTERNS)[number], colours = [0xffd34f]) {
    const { bus, effects } = effectsFor(QUALITY_PROFILES[level]);
    bus.emit('burst', { id: 'r', position: SKY, pattern, colours });
    return effects;
  }

  /** Burst-star particles born in the last `within` seconds: the shell's crackle, once its stars are old. */
  function freshStars(engine: FireworksEngine, within: number): number {
    let fresh = 0;
    for (let i = 0; i < engine.particles.count; i++) {
      if (engine.particles.styles[i] === BURST_STAR && engine.particles.ageOf(i) < within) fresh++;
    }
    return fresh;
  }

  it('crackles with white-hot pops as a round shell fades, on Medium and High only', () => {
    const counts = levels.map((level) => {
      const effects = burstAt(level, 'peony');
      let seen = 0;
      // Sample after the crossette-free shell's stars are all well over a second old.
      for (let t = 0; t < 3; t += step) {
        effects.update(step);
        if (t > 1.3) seen = Math.max(seen, freshStars(effects.engine, 0.3));
      }
      return seen;
    });
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(counts[1]!);
  });

  it('keeps flat and armed shapes free of crackle, so pops never land between their lines', () => {
    for (const pattern of ['ring', 'heart', 'palm'] as const) {
      const effects = burstAt('high', pattern);
      let seen = 0;
      for (let t = 0; t < 3; t += step) {
        effects.update(step);
        if (t > 1.3) seen = Math.max(seen, freshStars(effects.engine, 0.3));
      }
      expect(seen).toBe(0);
    }
  });

  it('crackles where the stars are: out on the drooping shell, not at its centre', () => {
    const effects = burstAt('high', 'peony');
    run(effects, 1.6);
    const p = effects.engine.particles.positions;
    let pops = 0;
    for (let i = 0; i < effects.engine.particles.count; i++) {
      if (effects.engine.particles.styles[i] !== BURST_STAR || effects.engine.particles.ageOf(i) > 0.2) continue;
      pops++;
      const r = Math.hypot(p[i * 3]! - SKY.x, p[i * 3 + 1]! - SKY.y, p[i * 3 + 2]! - SKY.z);
      expect(r).toBeGreaterThan(8);
      expect(r).toBeLessThan(22);
    }
    expect(pops).toBeGreaterThan(0);
  });

  it('draws finer stars than Low, trailing tails that cool to a gold ember', () => {
    // A blue ring: no pistil, and the ember is far warmer than the star.
    const tailWarmth = (level: (typeof levels)[number]) => {
      const effects = burstAt(level, 'ring', [0x4fb6ff]);
      const pool = effects.engine.particles;
      let head = 0;
      let headWarmth = 0;
      let tailWarmthSum = 0;
      let tails = 0;
      let largest = 0;
      for (let i = 0; i < pool.count; i++) {
        if (pool.styles[i] !== BURST_STAR) continue;
        const size = pool.sizes[i]!;
        largest = Math.max(largest, size);
        const warmth = pool.colours[i * 4]! / Math.max(1e-6, pool.colours[i * 4 + 2]!);
        if (size >= SKY_BURST.size0 * BURST_LOOKS[level].starSize * 0.99) {
          head++;
          headWarmth += warmth;
        } else if (size < SKY_BURST.size0 * BURST_LOOKS[level].starSize * 0.4) {
          tails++;
          tailWarmthSum += warmth;
        }
      }
      expect(head).toBeGreaterThan(0);
      expect(tails).toBeGreaterThan(0);
      return { head: headWarmth / head, tail: tailWarmthSum / tails, largest };
    };
    const low = tailWarmth('low');
    expect(low.tail).toBeCloseTo(low.head, 5);
    for (const level of ['medium', 'high'] as const) {
      const look = tailWarmth(level);
      expect(look.largest).toBeLessThan(low.largest);
      expect(look.tail).toBeGreaterThan(look.head * 3);
    }
  });

  it('lets the stars sag and burn out one by one as they fade', () => {
    const settle = (level: (typeof levels)[number]) => {
      const effects = burstAt(level, 'peony');
      run(effects, 2.4);
      const pool = effects.engine.particles;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < pool.count; i++) {
        if (pool.styles[i] !== BURST_STAR) continue;
        sum += pool.positions[i * 3 + 1]!;
        n++;
      }
      return { meanY: sum / n, live: n };
    };
    const [low, medium, high] = levels.map(settle);
    expect(medium!.meanY).toBeLessThan(low!.meanY);
    expect(high!.meanY).toBeLessThan(medium!.meanY);
    // Low's stars all outlive 2.4 s (life 2.6 s+); on High some have already burnt out.
    const highStars = Math.round(SKY_BURST.count * 1.5);
    expect(high!.live).toBeLessThan(burstSparkCount('peony', 1.5));
    expect(high!.live).toBeGreaterThan(highStars * 0.3);
  });

  it('keeps a willow hanging as authored instead of dropping it out of the sky', () => {
    const lowest = (level: (typeof levels)[number]) => {
      const effects = burstAt(level, 'willow');
      let y: number = SKY.y;
      for (let t = 0; t < 7; t += step) {
        effects.update(step);
        const pool = effects.engine.particles;
        for (let i = 0; i < pool.count; i++) y = Math.min(y, pool.positions[i * 3 + 1]!);
      }
      return y;
    };
    expect(lowest('high')).toBeGreaterThan(lowest('low') - 1);
  });

  it('stays within the particle budget: crackle is a trickle on top of the shell', () => {
    for (const level of ['medium', 'high'] as const) {
      const effects = burstAt(level, 'peony');
      const shell = effects.stats.liveParticles;
      let peak = shell;
      let spawned = 0;
      let last = shell;
      for (let t = 0; t < 4; t += step) {
        effects.update(step);
        peak = Math.max(peak, effects.stats.liveParticles);
        spawned += Math.max(0, effects.stats.liveParticles - last);
        last = effects.stats.liveParticles;
      }
      expect(peak).toBe(shell);
      expect(spawned).toBeLessThan(BURST_LOOKS[level].crackle * 4 * BURST_CRACKLE.count * 1.5);
      expect(effects.stats.droppedParticles).toBe(0);
    }
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
