import { describe, expect, it } from 'vitest';
import { TUNING } from '../src/core/tuning';
import type { Vec3 } from '../src/core/types';
import { atmosphereBudget } from '../src/atmosphere/budget';
import { planDecorations } from '../src/atmosphere/decorations';
import { qualityProfile } from '../src/core/quality';
import { HOME_ENTRANCES } from '../src/homes/doorways';
import { createWorld, LAYOUT } from '../src/world';
import { ENTERABLE_HOUSES } from '../src/world/layout';

const world = createWorld();
const { layout } = world;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const groundDistance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('world data', () => {
  it('exposes doorway zones, diya sites and neighbour areas', () => {
    expect(world.doorways.length).toBeGreaterThanOrEqual(8);
    expect(world.diyaSites.length).toBeGreaterThanOrEqual(8);
    expect(world.neighbourAreas.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every solid, decor box, doorway and diya a unique id', () => {
    const ids = [
      ...layout.solids.map((s) => s.id),
      ...layout.decor.map((d) => d.id),
      ...world.doorways.map((d) => d.id),
      ...world.diyaSites.map((d) => d.id),
      ...world.neighbourAreas.map((n) => n.id),
      ...layout.lights.map((l) => l.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has solids of every kind the acceptance criteria name', () => {
    const kinds = new Set(layout.solids.map((s) => s.kind));
    for (const kind of ['ground', 'house', 'wall', 'stair', 'rooftop', 'railing', 'boundary'] as const) {
      expect(kinds, kind).toContain(kind);
    }
  });

  it('only builds non-degenerate boxes', () => {
    for (const { id, box } of [...layout.solids, ...layout.decor]) {
      expect(box.max.x - box.min.x, id).toBeGreaterThan(0);
      expect(box.max.y - box.min.y, id).toBeGreaterThan(0);
      expect(box.max.z - box.min.z, id).toBeGreaterThan(0);
    }
  });

  it('keeps balconies above head height', () => {
    for (const s of layout.solids.filter((s) => s.kind === 'balcony')) {
      expect(s.box.min.y, s.id).toBeGreaterThan(2.5);
    }
  });

  it('uses only a few practical lights', () => {
    expect(layout.lights.length).toBeGreaterThan(0);
    expect(layout.lights.length).toBeLessThanOrEqual(6);
  });
});

describe('spawn and bounds', () => {
  it('spawns the player clear, on placement-ready ground, inside the bounds', () => {
    expect(world.contains(world.spawn)).toBe(true);
    const below = world.surfaceBelow(world.spawn);
    expect(below?.point.y).toBe(0);
    expect(world.isClear(v(world.spawn.x, 1, world.spawn.z), 0.5)).toBe(true);
  });

  it('lines every side of the bounds with a boundary wall', () => {
    const { min, max } = world.bounds;
    const boundaries = layout.solids.filter((s) => s.kind === 'boundary');
    expect(boundaries.every((b) => !b.visible)).toBe(true);
    const probes = [v(min.x - 0.1, 2, -10), v(max.x + 0.1, 2, -10), v(0, 2, min.z - 0.1), v(0, 2, max.z + 0.1)];
    for (const p of probes) {
      expect(world.isClear(p, 0.05), JSON.stringify(p)).toBe(false);
    }
  });

  it('keeps every walkable surface inside the bounds', () => {
    for (const s of world.traversableSurfaces) {
      expect(world.contains(v(s.minX, s.y, s.minZ)), s.id).toBe(true);
      expect(world.contains(v(s.maxX, s.y, s.maxZ)), s.id).toBe(true);
    }
  });
});

describe('doorways, diyas and neighbour areas', () => {
  it('puts every doorway zone on placement ground in front of its door', () => {
    for (const d of world.doorways) {
      const below = world.surfaceBelow(d.centre);
      expect(below?.point.y, d.id).toBe(0);
      expect(below?.supportsPlacement, d.id).toBe(true);
      expect(world.isClear(v(d.centre.x, 1, d.centre.z), 0.3), d.id).toBe(true);
    }
  });

  it('rests every diya on a surface, in the open', () => {
    for (const site of world.diyaSites) {
      const below = world.surfaceBelow(site.position);
      expect(below, site.id).not.toBeNull();
      expect(below!.point.y, site.id).toBeCloseTo(site.position.y);
      expect(world.isClear(v(site.position.x, site.position.y + 0.1, site.position.z), 0.08), site.id).toBe(true);
    }
  });

  it('places diyas on the rooftop', () => {
    expect(world.diyaSites.filter((d) => d.position.y === LAYOUT.rooftopHeight).length).toBeGreaterThan(0);
  });

  it('keeps neighbour areas on open ground and away from doorways', () => {
    for (const area of world.neighbourAreas) {
      expect(world.surfaceBelow(area.centre)?.supportsPlacement, area.id).toBe(true);
      expect(world.isClear(v(area.centre.x, 1, area.centre.z), 0.9), area.id).toBe(true);
      for (const door of world.doorways) {
        expect(groundDistance(area.centre, door.centre), `${area.id} vs ${door.id}`).toBeGreaterThan(
          area.radius + door.radius,
        );
      }
    }
  });
});

describe('surface queries', () => {
  it('finds supported ground in the lane and courtyard', () => {
    for (const p of [v(0, 1, -5), v(-8, 1, -24)]) {
      expect(world.surfaceBelow(p)).toEqual({ point: { ...p, y: 0 }, normal: { x: 0, y: 1, z: 0 }, supportsPlacement: true });
    }
  });

  it('finds feet resting exactly on a surface', () => {
    expect(world.surfaceBelow(v(0, 0, -5))?.point.y).toBe(0);
  });

  it('finds the rooftop terrace and allows placement there', () => {
    const hit = world.surfaceBelow(v(15, 6, -25));
    expect(hit?.point.y).toBe(LAYOUT.rooftopHeight);
    expect(hit?.supportsPlacement).toBe(true);
  });

  it('refuses placement on stairs, railings and house tops', () => {
    const { stair } = LAYOUT;
    expect(world.surfaceBelow(v(stair.x - 0.6, 3, stair.startZ - 0.1))?.supportsPlacement).toBe(false);
    expect(world.surfaceBelow(v(17.95, 8, -25))?.supportsPlacement).toBe(false);
    expect(world.surfaceBelow(v(-8, 20, 0))?.supportsPlacement).toBe(false);
  });

  it('returns null over nothing', () => {
    expect(world.surfaceBelow(v(40, 5, 40))).toBeNull();
    expect(world.surfaceBelow(v(0, -2, 0))).toBeNull();
  });

  it('reports walls as blocking and the open lane as clear', () => {
    expect(world.isClear(v(0, 1, -5), 1)).toBe(true);
    expect(world.isClear(v(-3.8, 1, -5), 0.4)).toBe(false);
    expect(world.isClear(v(0, 0.2, -5), 0.3)).toBe(false); // touches the ground
  });

  it('gives open sky above the lane and rooftop but not under a balcony', () => {
    const max = TUNING.placement.rocketSkyClearance;
    expect(world.clearanceAbove(v(0, 0, -5), max)).toBe(max);
    expect(world.clearanceAbove(v(15, LAYOUT.rooftopHeight, -25), max)).toBe(max);
    const balcony = layout.solids.find((s) => s.kind === 'balcony')!;
    const under = v((balcony.box.min.x + balcony.box.max.x) / 2, 0, (balcony.box.min.z + balcony.box.max.z) / 2);
    expect(world.clearanceAbove(under, max)).toBeCloseTo(balcony.box.min.y);
  });

  it('reports zero clearance inside a solid', () => {
    expect(world.clearanceAbove(v(-8, 1, 0), 10)).toBe(0);
  });
});

describe('stairs and rooftop', () => {
  const stairs = layout.solids.filter((s) => s.kind === 'stair' || s.kind === 'landing');

  it('climbs in rises the player can step without jumping', () => {
    const tops = [0, ...stairs.map((s) => s.box.max.y)];
    for (let i = 1; i < tops.length; i++) {
      const rise = tops[i]! - tops[i - 1]!;
      expect(rise).toBeGreaterThan(0);
      expect(rise).toBeLessThanOrEqual(TUNING.player.maxStepHeight);
    }
    expect(tops.at(-1)).toBe(LAYOUT.rooftopHeight);
  });

  it('rails the stairs and every rooftop edge', () => {
    const railings = layout.solids.filter((s) => s.kind === 'railing');
    expect(railings.filter((r) => r.id.startsWith('stair.rail.')).length).toBe(LAYOUT.stair.steps);
    expect(railings.filter((r) => r.id.startsWith('rooftop.rail.')).length).toBe(5);
  });
});

/**
 * Walks a grid flood-fill from the spawn the way a character controller
 * would: step up at most `maxStepHeight`, step down any amount, and only
 * where a capsule fits. Checks the map is traversable as the PRD requires.
 */
describe('traversal', () => {
  const cell = 0.25;
  const radius = 0.3;
  const height = 1.7;
  const maxStep = TUNING.player.maxStepHeight;

  /** Surface the player would stand on at (x, z) arriving from height `fromY`. */
  function standAt(x: number, z: number, fromY: number): number | null {
    const hit = world.surfaceBelow(v(x, fromY + maxStep, z));
    if (!hit) return null;
    const y = hit.point.y;
    // Capsule body above the step-up height must be free.
    for (let h = maxStep + radius; h <= height - radius; h += radius) {
      if (!world.isClear(v(x, y + h, z), radius)) return null;
    }
    return y;
  }

  function flood(): Map<string, number> {
    const seen = new Map<string, number>();
    const start = world.spawn;
    const queue: [number, number, number][] = [[Math.round(start.x / cell), Math.round(start.z / cell), 0]];
    seen.set(`${queue[0]![0]},${queue[0]![1]}`, 0);
    while (queue.length) {
      const [i, k, y] = queue.pop()!;
      for (const [di, dk] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di;
        const nk = k + dk;
        const key = `${ni},${nk}`;
        const ny = standAt(ni * cell, nk * cell, y);
        if (ny === null) continue;
        const prev = seen.get(key);
        if (prev !== undefined && prev >= ny) continue;
        seen.set(key, ny);
        queue.push([ni, nk, ny]);
      }
    }
    return seen;
  }

  const reached = flood();
  const points = [...reached].map(([key, y]) => {
    const [i, k] = key.split(',').map(Number) as [number, number];
    return v(i * cell, y, k * cell);
  });

  it('reaches the courtyard from the lane', () => {
    expect(points.some((p) => p.z < -30 && p.y === 0)).toBe(true);
  });

  it('reaches the rooftop by the stairs', () => {
    expect(points.some((p) => p.y === LAYOUT.rooftopHeight && p.x > LAYOUT.rooftopHouse.minX + 1)).toBe(true);
  });

  it('never leaves the bounds or climbs onto anything but ground, stairs and rooftop', () => {
    const heights = new Set(world.traversableSurfaces.map((s) => s.y));
    for (const p of points) {
      expect(world.contains(p)).toBe(true);
      expect(heights.has(p.y)).toBe(true);
    }
  });

  it('cannot walk through houses', () => {
    expect(points.some((p) => p.x < -LAYOUT.laneHalfWidth && p.z > LAYOUT.courtyardSouthZ)).toBe(false);
  });
});

describe('world module stays renderer-free', () => {
  const sources = import.meta.glob<string>(['../src/world/*.ts', '!../src/world/scene.ts', '!../src/world/colliders.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it.each(Object.entries(sources))('%s imports neither three nor rapier', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });
});

describe('street and house detail', () => {
  const props = layout.solids.filter((s) => s.kind === 'prop' && s.id !== 'courtyard.platform');

  it('adds pots, planters and scooters as solids the player walks round', () => {
    expect(props.some((p) => p.id.includes('.pot.'))).toBe(true);
    expect(props.some((p) => p.id.startsWith('gate.planter'))).toBe(true);
    expect(props.some((p) => p.id.startsWith('scooter.'))).toBe(true);
    for (const p of props) expect(p.supportsPlacement, p.id).toBe(false);
  });

  it('keeps props clear of doorways, diyas and neighbour areas', () => {
    const clearOf = (p: (typeof props)[number], c: Vec3, r: number) => {
      const dx = Math.max(p.box.min.x - c.x, 0, c.x - p.box.max.x);
      const dz = Math.max(p.box.min.z - c.z, 0, c.z - p.box.max.z);
      return Math.hypot(dx, dz) > r;
    };
    for (const p of props) {
      for (const d of world.doorways) expect(clearOf(p, d.centre, d.radius), `${p.id} / ${d.id}`).toBe(true);
      for (const d of world.diyaSites) expect(clearOf(p, d.position, 0.3), `${p.id} / ${d.id}`).toBe(true);
      for (const n of world.neighbourAreas) expect(clearOf(p, n.centre, n.radius), `${p.id} / ${n.id}`).toBe(true);
    }
  });

  it('gives every house a plinth, trimmed windows and, bar the rooftop house, a parapet and water tank', () => {
    const houses = layout.solids.filter((s) => s.kind === 'house').map((s) => s.id.slice(0, -'.body'.length));
    const decor = new Set(layout.decor.map((d) => d.id));
    for (const id of houses) {
      expect(decor.has(`${id}.plinth`), id).toBe(true);
      expect(layout.decor.some((d) => d.id.startsWith(`${id}.window.`) && d.id.endsWith('.shade')), id).toBe(true);
      if (id === 'house.court.e') continue;
      expect(decor.has(`${id}.parapet.n`), id).toBe(true);
      expect(decor.has(`${id}.tank`), id).toBe(true);
    }
  });

  it('keeps paving overlays a few millimetres proud of the ground', () => {
    for (const d of layout.decor.filter((d) => d.id.startsWith('paving.'))) {
      expect(d.box.max.y, d.id).toBeGreaterThan(0);
      expect(d.box.max.y, d.id).toBeLessThan(0.01);
    }
  });
});

describe('enterable homes stand out', () => {
  const houses = layout.solids.filter((s) => s.kind === 'house').map((s) => s.id.slice(0, -'.body'.length));
  const decor = new Set(layout.decor.map((d) => d.id));
  /** Decor that marks an open, enterable door. */
  const ENTRANCE_PARTS = ['.door.', '.marigold.', '.nameplate', '.doormat'];
  const entranceDecor = (house: string) =>
    layout.decor.filter((d) => ENTRANCE_PARTS.some((part) => d.id.startsWith(`${house}${part}`)));
  /** Ground distance from a box's footprint to a point. */
  const footprintDistance = (b: { min: Vec3; max: Vec3 }, p: Vec3) =>
    Math.hypot(Math.max(b.min.x - p.x, 0, p.x - b.max.x), Math.max(b.min.z - p.z, 0, p.z - b.max.z));

  it('marks exactly the homes the player can enter', () => {
    const entrances = Object.values(HOME_ENTRANCES).map((e) => e.house);
    expect([...ENTERABLE_HOUSES].sort()).toEqual([...entrances].sort());
    for (const house of ENTERABLE_HOUSES) expect(houses, house).toContain(house);
  });

  it('opens the enterable doors on a lit room, garlanded and name-plated; the rest stay shut', () => {
    for (const house of houses) {
      const open = ENTERABLE_HOUSES.includes(house);
      expect(decor.has(`${house}.door`), house).toBe(!open);
      for (const part of ['door.glow', 'door.leaf.left', 'door.leaf.right', 'nameplate', 'nameplate.face', 'doormat']) {
        expect(decor.has(`${house}.${part}`), `${house}.${part}`).toBe(open);
      }
      expect(layout.decor.some((d) => d.id.startsWith(`${house}.marigold.`)), house).toBe(open);
    }
    expect(layout.decor.find((d) => d.id === 'house.lane.w0.door.glow')?.material).toBe('doorGlow');
  });

  it('adds no colliders at the doors', () => {
    for (const house of ENTERABLE_HOUSES) {
      const solids = layout.solids.filter((s) => ENTRANCE_PARTS.some((part) => s.id.startsWith(`${house}${part}`)));
      expect(solids, house).toEqual([]);
      const zone = world.doorways.find((d) => d.id === `${house}.doorway`)!;
      expect(world.isClear(v(zone.centre.x, 1, zone.centre.z), 0.3), house).toBe(true);
    }
  });

  it('keeps the new decor flush with the facade or flat, and clear of diyas and rangoli', () => {
    const rangolis = planDecorations(layout, atmosphereBudget(qualityProfile('low'))).rangolis;
    for (const house of ENTERABLE_HOUSES) {
      const body = layout.solids.find((s) => s.id === `${house}.body`)!.box;
      const parts = entranceDecor(house);
      expect(parts.length, house).toBeGreaterThan(10);
      for (const { id, box } of parts) {
        const flat = box.max.y <= 0.02;
        // Upright parts stand within a hand's breadth of the wall, well short of the doorway zone's centre.
        const fromWall = Math.max(0, ...[box.min, box.max].map((p) => footprintDistance(body, p)));
        if (!flat) expect(fromWall, id).toBeLessThan(0.25);
        for (const site of world.diyaSites) expect(footprintDistance(box, site.position), `${id} / ${site.id}`).toBeGreaterThan(0.2);
        for (const r of rangolis) expect(footprintDistance(box, r.centre), `${id} / ${r.id}`).toBeGreaterThan(r.radius);
      }
    }
  });

  it('keeps the name plate under any balcony and the garland over the door frame', () => {
    for (const house of ENTERABLE_HOUSES) {
      const plate = layout.decor.find((d) => d.id === `${house}.nameplate`)!.box;
      const balcony = layout.solids.find((s) => s.id === `${house}.balcony`);
      if (balcony) expect(plate.max.y, house).toBeLessThan(balcony.box.min.y);
      expect(plate.min.y, house).toBeGreaterThan(LAYOUT.doorHeight + 0.2);
    }
  });
});
