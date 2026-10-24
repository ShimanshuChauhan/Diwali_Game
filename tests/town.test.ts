import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Atmosphere } from '../src/atmosphere';
import { atmosphereBudget } from '../src/atmosphere/budget';
import { planTown, townKeepOut } from '../src/atmosphere/town';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import { createWorld } from '../src/world';

const { layout } = createWorld();
const budgets = QUALITY_LEVELS.map((level) => atmosphereBudget(qualityProfile(level)));
const plans = budgets.map((b) => planTown(layout, b));
const keepOut = townKeepOut(layout);

const key = (p: { x: number; y: number; z: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
const nonDecreasing = (values: readonly number[]) => values.every((v, i) => i === 0 || v >= values[i - 1]!);

describe('town plan', () => {
  it('is deterministic', () => {
    expect(planTown(createWorld().layout, budgets[1]!)).toEqual(plans[1]);
  });

  it('never intrudes on the playable map', () => {
    for (const plan of plans) {
      for (const { box } of plan.boxes) {
        const inside =
          box.min.x < keepOut.maxX && box.max.x > keepOut.minX && box.min.z < keepOut.maxZ && box.max.z > keepOut.minZ;
        expect(inside, JSON.stringify(box)).toBe(false);
      }
      // Panes sit a few centimetres proud of walls that may stand on the keep-out edge.
      const pane = 0.05;
      for (const w of plan.windows) {
        const inside =
          w.position.x > keepOut.minX + pane &&
          w.position.x < keepOut.maxX - pane &&
          w.position.z > keepOut.minZ + pane &&
          w.position.z < keepOut.maxZ - pane;
        expect(inside).toBe(false);
      }
    }
  });

  it('stays inside the fog, well short of the sky dome', () => {
    const cx = (keepOut.minX + keepOut.maxX) / 2;
    const cz = (keepOut.minZ + keepOut.maxZ) / 2;
    for (const { box } of plans[2]!.boxes) {
      for (const x of [box.min.x, box.max.x]) {
        for (const z of [box.min.z, box.max.z]) expect(Math.hypot(x - cx, z - cz)).toBeLessThan(130);
      }
      expect(box.max.y).toBeLessThan(60);
    }
  });

  it('scales up from Low to High and keeps the basics on Low', () => {
    const [low] = plans;
    expect(nonDecreasing(plans.map((p) => p.buildings))).toBe(true);
    expect(nonDecreasing(plans.map((p) => p.windows.length))).toBe(true);
    expect(nonDecreasing(plans.map((p) => p.lights.length))).toBe(true);
    expect(nonDecreasing(plans.map((p) => p.trees.length))).toBe(true);
    expect(plans[0]!.buildings).toBeLessThan(plans[2]!.buildings);
    expect(low!.buildings).toBe(budgets[0]!.townBuildings);
    expect(low!.windows.length).toBeGreaterThan(100);
    expect(low!.lamps).toBeGreaterThan(0);
    expect(low!.trees.length).toBeGreaterThan(0);
    expect(low!.boxes.some((b) => b.lit)).toBe(true); // the temple
  });

  it('shows a superset of the lower level at each higher one', () => {
    for (let i = 1; i < plans.length; i++) {
      const higher = new Set(plans[i]!.windows.map((w) => key(w.position)));
      for (const w of plans[i - 1]!.windows) expect(higher.has(key(w.position))).toBe(true);
      const boxes = new Set(plans[i]!.boxes.map((b) => key(b.box.min) + key(b.box.max)));
      for (const b of plans[i - 1]!.boxes) expect(boxes.has(key(b.box.min) + key(b.box.max))).toBe(true);
    }
  });

  it('keeps the houses beside the colony low enough to see over from the rooftop', () => {
    const nearest = plans[0]!.boxes.filter(
      (b) =>
        !b.lit &&
        Math.max(keepOut.minX - b.box.max.x, b.box.min.x - keepOut.maxX, keepOut.minZ - b.box.max.z, b.box.min.z - keepOut.maxZ) < 1,
    );
    expect(nearest.length).toBeGreaterThan(0);
    for (const b of nearest) expect(b.box.max.y, JSON.stringify(b.box)).toBeLessThan(10);
  });
});

describe('town drawing', () => {
  it('draws the town in a handful of draw calls at every level and rebuilds on quality change', () => {
    const scene = new THREE.Scene();
    const atmosphere = new Atmosphere({ scene, layout, profile: qualityProfile('low') });
    const townMeshes = () => {
      const found: THREE.Object3D[] = [];
      atmosphere.object.traverse((o) => o.name.startsWith('atmosphere.town') && found.push(o));
      return found;
    };
    expect(townMeshes()).toHaveLength(6);
    expect(atmosphere.stats.town.buildings).toBe(budgets[0]!.townBuildings);

    atmosphere.setQuality(qualityProfile('high'));
    expect(townMeshes()).toHaveLength(6);
    expect(atmosphere.stats.town.windows).toBe(plans[2]!.windows.length);
    const windows = townMeshes().find((o) => o.name === 'atmosphere.town.windows') as THREE.InstancedMesh;
    expect(windows.count).toBe(plans[2]!.windows.length);
    atmosphere.dispose();
  });
});
