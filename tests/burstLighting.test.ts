import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import type { QualityLevel } from '../src/core/types';
import { EffectsRenderer } from '../src/effects/effectsRenderer';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { FlashPool, SkyGlow, flashIntensity, lightReaching } from '../src/effects/flashPool';
import { BURST_STAR, SPARK } from '../src/effects/particlePool';
import {
  BURST_LIGHT_FLOOR,
  BURST_LOOKS,
  BURST_PATTERNS,
  FOUNTAIN,
  FUSE,
  LADI_BURN,
  LADI_POP,
  ROCKET_TRAIL,
  SPARKLER,
  SPINNER,
} from '../src/effects/presets';
import { renderSettings } from '../src/quality/renderSettings';

const step = 1 / 60;
const BURST = { x: 0, y: 28, z: -20 } as const;
/** Lane surfaces under a burst: the ground below it and a house front beside it. */
const GROUND = { x: 0, y: 0, z: -20, normal: [0, 1, 0] } as const;
const HOUSE_FRONT = { x: 4, y: 5, z: -20, normal: [-1, 0, 0] } as const;

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

function effectsAt(level: QualityLevel): FireworksEffects {
  return new FireworksEffects(null, { quality: qualityProfile(level), random: seeded(7) });
}

function burst(effects: FireworksEffects, colours: readonly number[] = [0xff4f6d], id = 'r1'): void {
  effects.onBurst({ id, position: BURST, pattern: 'peony', colours });
}

/** Light one surface gets from a slot, with the angle of incidence (no shadowing). */
function received(
  slot: { x: number; y: number; z: number; intensity: number; range: number; decay: number },
  surface: typeof GROUND | typeof HOUSE_FRONT,
): number {
  const dx = slot.x - surface.x;
  const dy = slot.y - surface.y;
  const dz = slot.z - surface.z;
  const distance = Math.hypot(dx, dy, dz);
  const [nx, ny, nz] = surface.normal;
  const cos = Math.max(0, (dx * nx + dy * ny + dz * nz) / distance);
  return lightReaching(slot.intensity, slot.range, slot.decay, distance) * cos;
}

interface BurstLightProfile {
  /** Light-seconds the surface receives over the whole burst. */
  readonly exposure: number;
  readonly peak: number;
  /** Seconds the burst light stays on. */
  readonly lit: number;
}

function measure(level: QualityLevel, surface: typeof GROUND | typeof HOUSE_FRONT): BurstLightProfile {
  const effects = effectsAt(level);
  burst(effects);
  let exposure = 0;
  let peak = 0;
  let lit = 0;
  for (let t = 0; t < 6; t += step) {
    const slot = effects.engine.flashes.slots.find((s) => s.active);
    if (slot) {
      const light = received(slot, surface);
      exposure += light * step;
      peak = Math.max(peak, light);
      lit += step;
    }
    effects.update(step);
  }
  return { exposure, peak, lit };
}

function lightsIn(view: EffectsRenderer): { point: number; hemisphere: number } {
  let point = 0;
  let hemisphere = 0;
  view.object.traverse((object) => {
    if (object instanceof THREE.PointLight) point++;
    if (object instanceof THREE.HemisphereLight) hemisphere++;
  });
  return { point, hemisphere };
}

describe('burst lighting per quality level', () => {
  it.each([
    ['ground under the burst', GROUND],
    ['house fronts beside it', HOUSE_FRONT],
  ] as const)('lights the %s strictly more from Low to Medium to High', (_name, surface) => {
    const [low, medium, high] = QUALITY_LEVELS.map((level) => measure(level, surface));
    expect(low!.exposure).toBeGreaterThan(0);
    expect(medium!.exposure).toBeGreaterThan(low!.exposure * 3);
    expect(high!.exposure).toBeGreaterThan(medium!.exposure * 1.5);
    expect(medium!.peak).toBeGreaterThan(low!.peak);
    expect(high!.peak).toBeGreaterThan(medium!.peak);
    expect(medium!.lit).toBeGreaterThan(low!.lit);
    expect(high!.lit).toBeGreaterThan(medium!.lit);
  });

  it('reaches further, lasts longer and falls off more softly on richer levels', () => {
    const [low, medium, high] = QUALITY_LEVELS.map((level) => BURST_LOOKS[level]);
    const span = (look: typeof low) => Math.max(look!.duration, look!.glowDuration);
    expect(medium!.range).toBeGreaterThan(low!.range);
    expect(high!.range).toBeGreaterThan(medium!.range);
    expect(span(medium)).toBeGreaterThan(span(low));
    expect(span(high)).toBeGreaterThan(span(medium));
    expect(medium!.decay).toBeLessThan(low!.decay);
    expect(high!.decay).toBeLessThan(medium!.decay);
    expect(high!.tailStretch).toBeGreaterThan(medium!.tailStretch);
    expect(medium!.tailStretch).toBeGreaterThan(low!.tailStretch);
  });

  it('keeps Low to its single brief flash, with no afterglow or sky wash', () => {
    const effects = effectsAt('low');
    burst(effects);
    expect(effects.engine.flashes.activeCount).toBe(1);
    expect(effects.engine.sky.level).toBe(0);
    for (let t = 0; t < 0.55; t += step) effects.update(step);
    expect(effects.engine.flashes.activeCount).toBe(0);
  });

  it('fades the High afterglow with the sparks rather than cutting off', () => {
    const effects = effectsAt('high');
    burst(effects);
    const slot = effects.engine.flashes.slots.find((s) => s.active)!;
    const samples: number[] = [];
    for (let t = 0; t < 2.5; t += 0.25) {
      samples.push(slot.intensity);
      for (let i = 0; i < 15; i++) effects.update(step);
    }
    // Monotonic fade, still lit while the shell is at its brightest (≈1 s).
    for (let i = 1; i < samples.length; i++) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    expect(samples[4]!).toBeGreaterThan(samples[0]! * 0.2);
    expect(effects.engine.particles.count).toBeGreaterThan(0);
  });

  it('puts the light inside the shell, never below the rooftops', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      burst(effects);
      const slot = effects.engine.flashes.slots.find((s) => s.active)!;
      expect(slot.y).toBe(Math.max(BURST_LIGHT_FLOOR, BURST.y - BURST_LOOKS[level].drop));
      expect(slot.colour).toBe(0xff4f6d);
      effects.onBurst({ id: 'low', position: { x: 0, y: 16, z: 0 }, pattern: 'ring', colours: [0x00ff00] });
      const lowBurst = effects.engine.flashes.slots.find((s) => s.active && s.colour === 0x00ff00)!;
      expect(lowBurst.y).toBeGreaterThanOrEqual(Math.min(16, BURST_LIGHT_FLOOR));
    }
  });

  it('washes the sky in the burst colour on High only', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      burst(effects, [0x4fb6ff]);
      const sky = effects.engine.sky;
      if (level !== 'high') {
        expect(sky.level).toBe(0);
        continue;
      }
      expect(sky.level).toBeCloseTo(BURST_LOOKS.high.sky);
      expect(sky.colour).toBe(0x4fb6ff);
      for (let t = 0; t < BURST_LOOKS.high.skyDuration + 0.1; t += step) effects.update(step);
      expect(sky.level).toBe(0);
    }
  });

  it('gives a High burst its light even with every light slot busy', () => {
    const effects = effectsAt('high');
    const { engine } = effects;
    const cap = qualityProfile('high').maxDynamicLights;
    // Chakri glows and earlier bursts fill every slot.
    for (let i = 0; i < cap; i++) engine.startStream(SPINNER, i, 0, 0, [0xffaa00]);
    for (let t = 0; t < 0.2; t += step) effects.update(step);
    for (let i = 0; i < 3; i++) burst(effects, [0x112233], `old${i}`);
    for (let t = 0; t < 0.4; t += step) effects.update(step);
    expect(engine.flashes.activeCount).toBe(cap);
    burst(effects, [0x4fb6ff], 'new');
    const lit = engine.flashes.slots.filter((s) => s.active && s.colour === 0x4fb6ff);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.age).toBe(0);
    expect(engine.flashes.activeCount).toBeLessThanOrEqual(cap);
  });

  it('shares the fixed light pool with ladi pops: pops take only idle lights, bursts win', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      const { engine } = effects;
      const cap = qualityProfile(level).maxDynamicLights;
      const ladi = engine.startStream(LADI_BURN, 0, 0, 0);
      // Loud pops fill every idle light...
      for (let i = 0; i < cap + 4; i++) engine.pop(ladi, i * 0.1, 0.01, 0, LADI_POP, true);
      expect(engine.flashes.activeCount).toBe(cap);
      // ...yet a burst still takes one, at full strength.
      burst(effects, [0x4fb6ff]);
      expect(engine.flashes.slots.filter((s) => s.active && s.colour === 0x4fb6ff)).toHaveLength(1);
      expect(engine.flashes.activeCount).toBe(cap);
      // With bursts glowing in every light, pops never steal one.
      for (let i = 0; i < cap; i++) burst(effects, [0x00ff00 + i], `g${i}`);
      const before = engine.flashes.slots.map((s) => s.colour);
      engine.pop(ladi, 0, 0.01, 0, LADI_POP, true);
      expect(engine.flashes.slots.map((s) => s.colour)).toEqual(before);
      expect(engine.flashes.activeCount).toBeLessThanOrEqual(cap);
    }
  });

  it('never lights more than the level allows', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      const cap = qualityProfile(level).maxDynamicLights;
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        burst(effects, [0x100000 * (i % 15) + 0x00ff00], `r${i}`);
        for (let t = 0; t < 0.25; t += step) {
          effects.update(step);
          worst = Math.max(worst, effects.engine.flashes.activeCount);
        }
      }
      expect(worst).toBeLessThanOrEqual(cap);
      expect(effects.stats.dynamicLights).toBeLessThanOrEqual(cap);
    }
  });
});

describe('burst light rendering', () => {
  const skyFill = () => new THREE.HemisphereLight('#4a4290', '#2a1a10', 0.7);

  it('keeps a fixed light set per level while bursts come and go', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      const view = new EffectsRenderer(effects.engine, { skyLight: skyFill() });
      const before = lightsIn(view);
      // Only the pooled point lights: the sky wash tints the scene's own fill.
      expect(before).toEqual({ point: qualityProfile(level).maxDynamicLights, hemisphere: 0 });
      for (let i = 0; i < 12; i++) {
        burst(effects, [0xff0000], `r${i}`);
        for (let t = 0; t < 0.5; t += step) {
          effects.update(step);
          view.sync();
          expect(lightsIn(view)).toEqual(before);
        }
      }
      view.dispose();
    }
  });

  it('copies colour, intensity, reach and falloff onto the pooled lights', () => {
    const effects = effectsAt('high');
    const view = new EffectsRenderer(effects.engine);
    burst(effects, [0x4fb6ff]);
    effects.update(step);
    view.sync();
    const lights: THREE.PointLight[] = [];
    view.object.traverse((object) => {
      if (object instanceof THREE.PointLight) lights.push(object);
    });
    const lit = lights.filter((light) => light.intensity > 0);
    expect(lit).toHaveLength(1);
    expect(lit[0]!.distance).toBe(BURST_LOOKS.high.range);
    expect(lit[0]!.decay).toBe(BURST_LOOKS.high.decay);
    expect(lit[0]!.color.getHex()).toBe(0x4fb6ff);
    view.dispose();
  });

  it('tints the sky fill towards the burst colour on High, then restores it', () => {
    const effects = effectsAt('high');
    const sky = skyFill();
    const base = { sky: sky.color.clone(), ground: sky.groundColor.clone(), intensity: sky.intensity };
    const view = new EffectsRenderer(effects.engine, { skyLight: sky });
    burst(effects, [0x0000ff]);
    view.sync();
    expect(sky.intensity).toBe(base.intensity);
    // Blue rises by the glow level (in light units: colour × intensity); red is untouched.
    expect((sky.color.b - base.sky.b) * sky.intensity).toBeCloseTo(BURST_LOOKS.high.sky);
    expect(sky.color.r).toBeCloseTo(base.sky.r);
    expect(sky.groundColor.b).toBeGreaterThan(base.ground.b);
    for (let t = 0; t < BURST_LOOKS.high.skyDuration + 0.1; t += step) effects.update(step);
    view.sync();
    expect(sky.color.equals(base.sky)).toBe(true);
    expect(sky.groundColor.equals(base.ground)).toBe(true);
    view.dispose();
  });

  it('leaves the sky fill alone on Low and Medium, and restores it when leaving High mid-wash', () => {
    for (const level of ['low', 'medium'] as const) {
      const effects = effectsAt(level);
      const sky = skyFill();
      const base = sky.color.clone();
      const view = new EffectsRenderer(effects.engine, { skyLight: sky });
      burst(effects);
      effects.update(step);
      view.sync();
      expect(sky.color.equals(base)).toBe(true);
    }
    const effects = effectsAt('high');
    const sky = skyFill();
    const base = sky.color.clone();
    const view = new EffectsRenderer(effects.engine, { skyLight: sky });
    burst(effects);
    view.sync();
    expect(sky.color.equals(base)).toBe(false);
    effects.applyQuality(qualityProfile('medium'));
    view.syncLightCount();
    view.sync();
    expect(sky.color.equals(base)).toBe(true);
  });

  it('changes the light count only when the level changes', () => {
    const effects = effectsAt('medium');
    const view = new EffectsRenderer(effects.engine);
    expect(lightsIn(view)).toEqual({ point: 4, hemisphere: 0 });
    effects.applyQuality(qualityProfile('high'));
    view.syncLightCount();
    expect(lightsIn(view)).toEqual({ point: 8, hemisphere: 0 });
    effects.applyQuality(qualityProfile('low'));
    view.syncLightCount();
    expect(lightsIn(view)).toEqual({ point: 2, hemisphere: 0 });
    view.dispose();
  });

  it('blooms wider and stronger on High than Medium, and not at all on Low', () => {
    const [low, medium, high] = QUALITY_LEVELS.map((level) => renderSettings(qualityProfile(level), 2));
    expect(low!.bloom).toBe(false);
    expect(high!.bloomStyle.strength).toBeGreaterThan(medium!.bloomStyle.strength);
    expect(high!.bloomStyle.radius).toBeGreaterThan(medium!.bloomStyle.radius);
  });
});

describe('FlashPool afterglow', () => {
  it('adds a held glow that eases out after the flash', () => {
    expect(flashIntensity(100, 0.5, 0.5, 2, 0)).toBeCloseTo(150);
    expect(flashIntensity(100, 0.5, 0.5, 2, 0.25)).toBeCloseTo(25 + 50 * (1 - 0.125 ** 2 * (3 - 0.25)));
    expect(flashIntensity(100, 0.5, 0.5, 2, 1)).toBeCloseTo(25); // glow alone, half way
    expect(flashIntensity(100, 0.5, 0.5, 2, 2)).toBe(0);
  });

  it('keeps a slot until its afterglow ends', () => {
    const flashes = new FlashPool(1);
    flashes.trigger(0, 0, 0, 0xffffff, 100, 30, 0.5, { glow: 0.5, glowDuration: 2, decay: 1.5 });
    expect(flashes.slots[0]).toMatchObject({ intensity: 150, decay: 1.5 });
    flashes.update(1);
    expect(flashes.activeCount).toBe(1);
    flashes.update(1.01);
    expect(flashes.activeCount).toBe(0);
  });

  it('will not swap a starting flash-and-glow for a weaker one', () => {
    const flashes = new FlashPool(1);
    flashes.trigger(0, 0, 0, 0xff0000, 100, 30, 0.5, { glow: 0.5, glowDuration: 2 });
    expect(flashes.trigger(0, 0, 0, 0x00ff00, 120, 30, 0.5)).toBe(-1);
    expect(flashes.trigger(0, 0, 0, 0x00ff00, 160, 30, 0.5)).toBe(0);
  });

  it('matches three.js punctual falloff', () => {
    expect(lightReaching(100, 0, 2, 10)).toBeCloseTo(1);
    expect(lightReaching(100, 20, 2, 10)).toBeCloseTo((1 - 1 / 16) ** 2);
    expect(lightReaching(100, 20, 2, 25)).toBe(0);
  });
});

describe('SkyGlow', () => {
  it('blends overlapping bursts and caps the stack', () => {
    const sky = new SkyGlow();
    sky.trigger(0xff0000, 1, 2);
    sky.trigger(0x0000ff, 1, 2);
    expect(sky.level).toBeCloseTo(1.5);
    expect(sky.colour).toBe(0x800080);
    sky.update(10);
    expect(sky.level).toBe(0);
    sky.trigger(0x00ff00, 0.5, 1);
    expect(sky.colour).toBe(0x00ff00);
  });
});

describe('burst star shading', () => {
  const styles = (effects: FireworksEffects) => Array.from(effects.engine.particles.styles.subarray(0, effects.engine.particles.count));

  it.each(BURST_PATTERNS)('tags every %s star and tail as a burst star, and the bang as a plain spark', (pattern) => {
    const effects = effectsAt('high');
    effects.onBurst({ id: 'r', position: BURST, pattern, colours: [0xff4f6d, 0xffd34f] });
    // Crossette stars split later: their sparks are burst stars too.
    for (let t = 0; t < 1; t += step) effects.update(step);
    const all = styles(effects);
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((s) => s === BURST_STAR).length).toBe(all.length - all.filter((s) => s === SPARK).length);
    expect(all.filter((s) => s === BURST_STAR).length / all.length).toBeGreaterThan(0.95);
  });

  it('leaves anar, chakri, phuljhari, fuse, rocket trail and ladi sparks plain, even right after a burst', () => {
    const effects = effectsAt('high');
    const { engine } = effects;
    // A burst first, so any style left on the shared spawn spec would leak into what follows.
    burst(effects);
    effects.reset();
    for (const preset of [FOUNTAIN, SPINNER, SPARKLER, FUSE, ROCKET_TRAIL]) engine.startStream(preset, 0, 0, 0);
    const ladi = engine.startStream(LADI_BURN, 2, 0, 0);
    for (let t = 0; t < 1; t += step) {
      engine.pop(ladi, 2, 0.01, -t, LADI_POP, true);
      effects.update(step);
    }
    const all = styles(effects);
    expect(all.length).toBeGreaterThan(100);
    expect(all.every((s) => s === SPARK)).toBe(true);
  });

  it('caps burst stars only on bloom levels', () => {
    expect(BURST_LOOKS.low.starCap).toBe(0);
    for (const level of ['medium', 'high'] as const) {
      expect(qualityProfile(level).postEffects).toBe(true);
      expect(BURST_LOOKS[level].starCap).toBeGreaterThan(0.9); // still above the bloom threshold
    }
  });

  it('uploads styles and the level\'s star cap to the spark material', () => {
    for (const level of QUALITY_LEVELS) {
      const effects = effectsAt(level);
      const view = new EffectsRenderer(effects.engine);
      burst(effects);
      view.sync();
      let material: THREE.ShaderMaterial | null = null;
      let geometry: THREE.BufferGeometry | null = null;
      view.object.traverse((object) => {
        if (object instanceof THREE.Points && object.renderOrder === 10) {
          material = object.material as THREE.ShaderMaterial;
          geometry = object.geometry;
        }
      });
      expect(material!.uniforms.uStarCap!.value).toBe(BURST_LOOKS[level].starCap);
      expect(geometry!.getAttribute('aStyle').array).toBe(effects.engine.particles.styles);
      view.dispose();
    }
  });
});
