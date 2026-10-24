import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../src/atmosphere';
import { atmosphereBudget, MAX_DISTANT_PARTICLES } from '../src/atmosphere/budget';
import { hitsSolid, KANDIL_HALF, planDecorations, spreadIndices } from '../src/atmosphere/decorations';
import { DISTANT_DEFAULTS, DistantFireworks } from '../src/atmosphere/distantFireworks';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { createWorld } from '../src/world';

const world = createWorld();
const { layout } = world;
const budgets = QUALITY_LEVELS.map((level) => atmosphereBudget(qualityProfile(level)));
const plans = budgets.map((b) => planDecorations(layout, b));

/** Small deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nonDecreasing(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || v >= values[i - 1]!);
}

describe('atmosphere budget', () => {
  it('scales every atmosphere cost up from Low to High', () => {
    expect(nonDecreasing(plans.map((p) => p.bulbs.length))).toBe(true);
    expect(nonDecreasing(plans.map((p) => p.litKandils.length))).toBe(true);
    expect(nonDecreasing(budgets.map((b) => b.stars))).toBe(true);
    expect(nonDecreasing(budgets.map((b) => b.rangoliSegments))).toBe(true);
    expect(nonDecreasing(budgets.map((b) => b.maxDistantShells * b.particlesPerShell))).toBe(true);
    expect(plans[0]!.bulbs.length).toBeLessThan(plans[2]!.bulbs.length);
  });

  it('keeps the festive basics on Low: lights, kandils, rangoli and distant fireworks', () => {
    const [low] = plans;
    expect(low!.bulbs.length).toBeGreaterThan(50);
    expect(low!.kandils.length).toBeGreaterThan(0);
    expect(low!.rangolis.length).toBeGreaterThan(0);
    expect(budgets[0]!.maxDistantShells).toBeGreaterThan(0);
    expect(budgets[0]!.lanternLights).toBe(0);
  });

  it('turns distant fireworks off when the profile disables them', () => {
    const budget = atmosphereBudget({ ...qualityProfile('high'), ambientFireworks: false });
    expect(budget.maxDistantShells).toBe(0);
  });

  it('sizes the shared spark buffer for the largest budget', () => {
    for (const b of budgets) expect(b.maxDistantShells * (b.particlesPerShell + 1)).toBeLessThanOrEqual(MAX_DISTANT_PARTICLES);
  });
});

describe('decoration plan', () => {
  const plan = plans[1]!;

  it('is deterministic', () => {
    expect(planDecorations(layout, budgets[1]!)).toEqual(plan);
  });

  it('puts a rangoli in front of every doorway, plus a courtyard centrepiece', () => {
    expect(plan.rangolis).toHaveLength(world.doorways.length + 1);
    for (const doorway of world.doorways) {
      const near = plan.rangolis.some(
        (r) => Math.hypot(r.centre.x - doorway.centre.x, r.centre.z - doorway.centre.z) < 1.5,
      );
      expect(near, doorway.id).toBe(true);
    }
  });

  it('lays rangoli flat on open ground without covering a diya', () => {
    for (const r of plan.rangolis) {
      const hit = world.surfaceBelow({ ...r.centre, y: r.centre.y + 0.01 });
      expect(hit?.point.y, r.id).toBeCloseTo(r.centre.y);
      expect(world.isClear({ ...r.centre, y: r.centre.y + 0.05 }, 0.04), r.id).toBe(true);
      for (const diya of world.diyaSites) {
        expect(Math.hypot(diya.position.x - r.centre.x, diya.position.z - r.centre.z), `${r.id} / ${diya.id}`).toBeGreaterThan(r.radius);
      }
    }
  });

  it('hangs a kandil by every door, above head height and clear of geometry', () => {
    expect(plan.kandils).toHaveLength(world.doorways.length);
    const headroom = TUNING.player.eyeHeight + 0.3;
    for (const k of plan.kandils) {
      expect(k.position.y - KANDIL_HALF.y, k.id).toBeGreaterThan(headroom);
      expect(hitsSolid(layout.solids, k.position, KANDIL_HALF.x, KANDIL_HALF.y), k.id).toBe(false);
    }
  });

  it('strings lights along every balcony', () => {
    const rails = layout.solids.filter((s) => s.id.endsWith('.balcony.rail.front'));
    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      const { min, max } = rail.box;
      const along = plan.bulbs.filter(
        (b) =>
          b.position.x > min.x - 0.3 &&
          b.position.x < max.x + 0.3 &&
          b.position.z > min.z - 0.3 &&
          b.position.z < max.z + 0.3 &&
          Math.abs(b.position.y - max.y) < 0.4,
      );
      expect(along.length, rail.id).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps every bulb out of solid geometry', () => {
    for (const b of plans[2]!.bulbs) expect(hitsSolid(layout.solids, b.position, 0.05, 0.05)).toBe(false);
  });

  it('gives point lights to as many distinct kandils as the budget allows', () => {
    budgets.forEach((b, i) => {
      const lit = plans[i]!.litKandils;
      expect(lit).toHaveLength(b.lanternLights);
      expect(new Set(lit.map((k) => k.id)).size).toBe(lit.length);
    });
    expect(spreadIndices(10, 3)).toEqual([1, 5, 8]);
    expect(spreadIndices(2, 5)).toEqual([0, 1]);
  });
});

describe('distant fireworks', () => {
  const run = (sky: DistantFireworks, seconds: number, onStep?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      sky.update(1 / 60);
      onStep?.();
    }
  };

  it('launches irregular shells and stays within the shell and spark budget', () => {
    budgets.forEach((budget, i) => {
      const sky = new DistantFireworks({ capacity: MAX_DISTANT_PARTICLES, random: seeded(i + 1) });
      sky.setBudget(budget);
      let peakShells = 0;
      let peakSparks = 0;
      run(sky, 120, () => {
        peakShells = Math.max(peakShells, sky.stats.activeShells);
        peakSparks = Math.max(peakSparks, sky.liveParticles);
      });
      expect(sky.stats.launched, budget.level).toBeGreaterThan(120 / budget.distantInterval / 3);
      expect(peakShells, budget.level).toBeLessThanOrEqual(budget.maxDistantShells);
      expect(peakSparks, budget.level).toBeLessThanOrEqual(budget.maxDistantShells * (budget.particlesPerShell + 1));
      expect(peakSparks).toBeGreaterThan(budget.particlesPerShell / 2);
    });
  });

  it('never exceeds a small capacity even with a generous budget', () => {
    const sky = new DistantFireworks({ capacity: 50, random: seeded(7) });
    sky.setBudget({ maxDistantShells: 10, particlesPerShell: 30, distantInterval: 0.3 });
    run(sky, 30, () => expect(sky.liveParticles).toBeLessThanOrEqual(50));
    expect(sky.stats.skipped).toBeGreaterThan(0);
  });

  it('bursts far beyond the map, on the horizon', () => {
    const sky = new DistantFireworks({ capacity: MAX_DISTANT_PARTICLES, random: seeded(3) });
    sky.setBudget(budgets[2]!);
    run(sky, 20, () => {
      for (let i = 0; i < sky.liveParticles; i++) {
        const x = sky.positions[i * 3]!;
        const z = sky.positions[i * 3 + 2]!;
        expect(Math.hypot(x - DISTANT_DEFAULTS.centreX, z - DISTANT_DEFAULTS.centreZ)).toBeGreaterThan(90);
      }
    });
  });

  it('launches nothing with a zero-shell budget, and reset clears the sky', () => {
    const sky = new DistantFireworks({ capacity: MAX_DISTANT_PARTICLES, random: seeded(5) });
    sky.setBudget({ ...budgets[1]!, maxDistantShells: 0 });
    run(sky, 30);
    expect(sky.stats.launched).toBe(0);
    expect(sky.liveParticles).toBe(0);

    sky.setBudget(budgets[1]!);
    run(sky, 10);
    expect(sky.liveParticles).toBeGreaterThan(0);
    sky.reset();
    expect(sky.liveParticles).toBe(0);
    expect(sky.stats.activeShells).toBe(0);
  });

  it('applies a lower budget to later launches', () => {
    const sky = new DistantFireworks({ capacity: MAX_DISTANT_PARTICLES, random: seeded(9) });
    sky.setBudget(budgets[2]!);
    run(sky, 10);
    sky.setBudget(budgets[0]!);
    run(sky, 5); // let high-budget shells finish
    let peak = 0;
    run(sky, 60, () => (peak = Math.max(peak, sky.stats.activeShells)));
    expect(peak).toBeLessThanOrEqual(budgets[0]!.maxDistantShells);
  });

  it('allocates nothing per update (buffers are fixed)', () => {
    const sky = new DistantFireworks({ capacity: 100, random: seeded(11) });
    const { positions, colours, sizes } = sky;
    sky.setBudget(budgets[1]!);
    run(sky, 10);
    expect(sky.positions).toBe(positions);
    expect(sky.colours).toBe(colours);
    expect(sky.sizes).toBe(sizes);
  });
});

describe('atmosphere scene', () => {
  const lights = (scene: THREE.Scene) => {
    let n = 0;
    scene.getObjectByName('atmosphere')!.traverse((o) => (n += o instanceof THREE.PointLight ? 1 : 0));
    return n;
  };

  it('dresses the scene, grades fog and exposure, and scales with quality changes', () => {
    const scene = new THREE.Scene();
    const renderer = { toneMapping: THREE.NoToneMapping as THREE.ToneMapping, toneMappingExposure: 1 };
    const bus = createGameEventBus();
    const atmosphere = new Atmosphere({ scene, layout, profile: qualityProfile('low'), renderer, bus, random: seeded(1) });

    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBeGreaterThan(1);
    for (const name of ['atmosphere.bulbs', 'atmosphere.kandils', 'atmosphere.rangoli', 'atmosphere.stars', 'atmosphere.horizon', 'atmosphere.distantFireworks']) {
      expect(scene.getObjectByName(name), name).toBeDefined();
    }
    const bulbs = scene.getObjectByName('atmosphere.bulbs') as THREE.InstancedMesh;
    expect(bulbs.count).toBe(plans[0]!.bulbs.length);
    expect(lights(scene)).toBe(0);
    const lowStats = atmosphere.stats;

    bus.emit('qualityChanged', { profile: qualityProfile('high') });
    const high = atmosphere.stats;
    expect(high.level).toBe('high');
    expect(high.bulbs).toBeGreaterThan(lowStats.bulbs);
    expect(high.stars).toBeGreaterThan(lowStats.stars);
    expect(lights(scene)).toBe(budgets[2]!.lanternLights);
    // Rebuilding replaces the decorations rather than stacking them.
    expect(scene.getObjectByName('atmosphere')!.children.filter((c) => c.name === 'atmosphere.decor')).toHaveLength(1);

    atmosphere.dispose();
  });

  it('runs distant fireworks, clears them on session reset and detaches on dispose', () => {
    const scene = new THREE.Scene();
    const bus = createGameEventBus();
    const atmosphere = new Atmosphere({ scene, layout, profile: qualityProfile('medium'), bus, random: seeded(2) });
    for (let i = 0; i < 600; i++) atmosphere.update(1 / 60);
    atmosphere.frame();
    expect(atmosphere.stats.distant.launched).toBeGreaterThan(0);

    bus.emit('sessionReset', {});
    expect(atmosphere.distant.liveParticles).toBe(0);

    atmosphere.dispose();
    expect(scene.getObjectByName('atmosphere')).toBeUndefined();
    expect(bus.listenerCount('qualityChanged')).toBe(0);
  });
});
