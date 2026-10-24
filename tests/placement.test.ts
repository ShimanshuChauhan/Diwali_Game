import { describe, expect, it } from 'vitest';
import type {
  CrackerSnapshot,
  NeighbourSnapshot,
  PlacementRequest,
  SurfaceHit,
  WorldModule,
} from '../src/core/contracts';
import { TUNING } from '../src/core/tuning';
import type { Aabb, CrackerType, Vec3 } from '../src/core/types';
import { PlacementRules } from '../src/interaction';
import { createWorld } from '../src/world';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const UP = v(0, 1, 0);

/**
 * A flat test yard, 100 m square, with one of each obstacle well apart:
 *
 * - a pillar at x ∈ [-5, -4], z ∈ [-1, 1]     (geometry clearance)
 * - an awning over x ∈ [-11, -9], 2.5 m up    (rocket sky clearance)
 * - a railing top at x ∈ [10, 11], 1 m up     (unsupported surface)
 * - a ramp at x ∈ [20, 22], tilted 30°        (too steep)
 * - a doorway at (0, 0, -10), r = 1.2
 * - a neighbour area at (-20, 0, 0), r = 2
 */
function fakeWorld(): WorldModule {
  const pillar: Aabb = { min: v(-5, 0, -1), max: v(-4, 3, 1) };
  const awning: Aabb = { min: v(-11, 2.5, -1), max: v(-9, 2.7, 1) };
  const railing: Aabb = { min: v(10, 0, -1), max: v(11, 1, 1) };
  const inside = (b: Aabb, p: Vec3) => p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;
  const tilt = (30 * Math.PI) / 180;
  return {
    bounds: { min: v(-50, -1, -50), max: v(50, 20, 50) },
    spawn: v(0, 0, 0),
    doorways: [{ id: 'door', centre: v(0, 0.8, -10), radius: 1.2 }],
    diyaSites: [],
    neighbourAreas: [{ id: 'gathering', centre: v(-20, 0, 0), radius: 2 }],
    surfaceBelow(p): SurfaceHit | null {
      if (Math.abs(p.x) > 50 || Math.abs(p.z) > 50) return null;
      if (inside(railing, p) && p.y >= 1) return { point: v(p.x, 1, p.z), normal: UP, supportsPlacement: false };
      if (p.x >= 20 && p.x <= 22) {
        return { point: v(p.x, 0, p.z), normal: v(-Math.sin(tilt), Math.cos(tilt), 0), supportsPlacement: true };
      }
      return { point: v(p.x, 0, p.z), normal: UP, supportsPlacement: true };
    },
    isClear(p, radius) {
      const { min, max } = pillar;
      const dx = Math.max(min.x - p.x, 0, p.x - max.x);
      const dy = Math.max(min.y - p.y, 0, p.y - max.y);
      const dz = Math.max(min.z - p.z, 0, p.z - max.z);
      return dx * dx + dy * dy + dz * dz >= radius * radius;
    },
    clearanceAbove(p, maxHeight) {
      return inside(awning, p) ? Math.min(maxHeight, awning.min.y - p.y) : maxHeight;
    },
  };
}

function cracker(id: string, position: Vec3, state: CrackerSnapshot['state'] = 'placed'): CrackerSnapshot {
  return { id, type: 'anar', state, position, stateTime: 0 };
}

interface Setup {
  crackers?: CrackerSnapshot[];
  neighbours?: NeighbourSnapshot[];
}

function rules(setup: Setup = {}): PlacementRules {
  return new PlacementRules({
    world: fakeWorld(),
    crackers: () => setup.crackers ?? [],
    neighbours: () => setup.neighbours ?? [],
  });
}

/** Player standing 1.5 m south of the target on flat ground. */
function at(target: Vec3, type: CrackerType = 'anar'): PlacementRequest {
  return { type, target, playerPosition: v(target.x, 0, target.z + 1.5) };
}

describe('placement acceptance', () => {
  it('accepts every ground cracker on open, flat, supported ground', () => {
    for (const type of ['anar', 'chakri', 'rocket'] as const) {
      expect(rules().validate(at(v(5, 0, 5), type))).toEqual({
        ok: true,
        preview: { type, position: v(5, 0, 5) },
      });
    }
  });

  it('snaps the preview onto the surface under the aim point', () => {
    const result = rules().validate(at(v(5, 0.04, 5)));
    expect(result.ok && result.preview.position).toEqual(v(5, 0, 5));
  });

  it('accepts a target exactly at reach', () => {
    const request: PlacementRequest = { type: 'anar', target: v(5, 0, 5), playerPosition: v(5, 0, 5 + TUNING.placement.reach) };
    expect(rules().validate(request).ok).toBe(true);
  });

  it('accepts just outside each clearance', () => {
    const { doorwayClearance, neighbourClearance, crackerSpacing, geometryClearance } = TUNING.placement;
    const r = rules({
      crackers: [cracker('c1', v(30, 0, 30))],
      neighbours: [{ id: 'n1', position: v(-30, 0, 30) }],
    });
    expect(r.validate(at(v(0, 0, -10 + 1.2 + doorwayClearance + 0.01))).ok).toBe(true);
    expect(r.validate(at(v(-20 + 2 + neighbourClearance + 0.01, 0, 0))).ok).toBe(true);
    expect(r.validate(at(v(-30 + neighbourClearance + 0.01, 0, 30))).ok).toBe(true);
    expect(r.validate(at(v(30 + crackerSpacing + 0.01, 0, 30))).ok).toBe(true);
    expect(r.validate(at(v(-4 + geometryClearance + 0.01, 0, 0))).ok).toBe(true);
  });

  it('lets a ground cracker sit under an awning, but not a rocket', () => {
    expect(rules().validate(at(v(-10, 0, 0), 'chakri')).ok).toBe(true);
    expect(rules().validate(at(v(-10, 0, 0), 'rocket'))).toEqual({ ok: false, reason: 'noSkyClearance' });
  });

  it('spaces crackers only against ones on the same level', () => {
    const r = rules({ crackers: [cracker('high', v(5, 4, 5))] });
    expect(r.validate(at(v(5, 0, 5))).ok).toBe(true);
  });
});

describe('placement rejection', () => {
  const reason = (r: PlacementRules, request: PlacementRequest) => {
    const result = r.validate(request);
    return result.ok ? 'ok' : result.reason;
  };

  it('refuses to place the handheld phuljhari', () => {
    expect(reason(rules(), at(v(5, 0, 5), 'phuljhari'))).toBe('handheldOnly');
  });

  it('refuses targets beyond reach', () => {
    const request: PlacementRequest = { type: 'anar', target: v(5, 0, 5), playerPosition: v(5, 0, 5 + TUNING.placement.reach + 0.01) };
    expect(reason(rules(), request)).toBe('outOfReach');
  });

  it('measures reach in 3D, so a rooftop below is out of reach from far above', () => {
    const request: PlacementRequest = { type: 'anar', target: v(5, 0, 5), playerPosition: v(5, 4, 4) };
    expect(reason(rules(), request)).toBe('outOfReach');
  });

  it('refuses surfaces that do not support placement', () => {
    expect(reason(rules(), at(v(10.5, 1, 0)))).toBe('unsupportedSurface');
  });

  it('refuses aim points off the edge of the world', () => {
    expect(reason(rules(), { type: 'anar', target: v(51, 0, 0), playerPosition: v(49, 0, 0) })).toBe('unsupportedSurface');
  });

  it('refuses aim points on a vertical face rather than a top', () => {
    expect(reason(rules(), at(v(-5, 1.5, 0)))).toBe('unsupportedSurface');
  });

  it('refuses surfaces steeper than the slope limit', () => {
    expect(reason(rules(), at(v(21, 0, 0)))).toBe('unsupportedSurface');
  });

  it('refuses spots inside the geometry clearance', () => {
    expect(reason(rules(), at(v(-4 + TUNING.placement.geometryClearance - 0.05, 0, 0)))).toBe('blockedByGeometry');
  });

  it('refuses spots too close to another cracker', () => {
    const r = rules({ crackers: [cracker('c1', v(5, 0, 5))] });
    expect(reason(r, at(v(5 + TUNING.placement.crackerSpacing - 0.05, 0, 5)))).toBe('blockedByGeometry');
  });

  it('refuses spots inside doorway clearance', () => {
    expect(reason(rules(), at(v(0, 0, -10 + 1.2 + TUNING.placement.doorwayClearance - 0.05)))).toBe('nearDoorway');
  });

  it('refuses spots near a static neighbour area', () => {
    expect(reason(rules(), at(v(-20 + 2 + TUNING.placement.neighbourClearance - 0.05, 0, 0)))).toBe('nearNeighbour');
  });

  it('refuses spots near a live neighbour', () => {
    const r = rules({ neighbours: [{ id: 'n1', position: v(5, 0, 6) }] });
    expect(reason(r, at(v(5, 0, 5)))).toBe('nearNeighbour');
  });

  it('refuses any spot once the placed-cracker cap is reached', () => {
    const full = Array.from({ length: TUNING.caps.maxPlacedCrackers }, (_, i) => cracker(`c${i}`, v(40, 0, i * 2)));
    expect(reason(rules({ crackers: full }), at(v(5, 0, 5)))).toBe('capacity');
    expect(reason(rules({ crackers: full.slice(1) }), at(v(5, 0, 5)))).toBe('ok');
  });

  it('refuses rockets without clear sky above', () => {
    expect(reason(rules(), at(v(-10, 0, 0), 'rocket'))).toBe('noSkyClearance');
  });

  it('reports the first failing check in a fixed order', () => {
    const full = Array.from({ length: TUNING.caps.maxPlacedCrackers }, (_, i) => cracker(`c${i}`, v(40, 0, i * 2)));
    // Beyond reach and on a railing: reach is checked first.
    expect(reason(rules(), { type: 'anar', target: v(10.5, 1, 0), playerPosition: v(0, 0, 0) })).toBe('outOfReach');
    // Capacity wins over everything except handheld.
    expect(reason(rules({ crackers: full }), { type: 'rocket', target: v(-10, 0, 0), playerPosition: v(30, 0, 30) })).toBe('capacity');
    expect(reason(rules({ crackers: full }), at(v(5, 0, 5), 'phuljhari'))).toBe('handheldOnly');
    // A doorway inside a neighbour's clearance reports the doorway.
    const r = rules({ neighbours: [{ id: 'n1', position: v(0, 0, -8) }] });
    expect(reason(r, at(v(0, 0, -8.5)))).toBe('nearDoorway');
  });
});

describe('per-frame preview', () => {
  it('reuses one feedback object and one position between frames', () => {
    const r = rules();
    const first = r.preview(at(v(5, 0, 5)));
    const position = first.position;
    const second = r.preview(at(v(-10, 0, 0), 'rocket'));
    expect(second).toBe(first);
    expect(second.position).toBe(position);
    expect(second).toMatchObject({ type: 'rocket', ok: false, reason: 'noSkyClearance', position: v(-10, 0, 0) });
  });

  it('reports ok with a null reason and the snapped position', () => {
    expect(rules().preview(at(v(5, 0.05, 5)))).toEqual({ type: 'anar', ok: true, reason: null, position: v(5, 0, 5) });
  });

  it('keeps the aim point as the position when no surface is found', () => {
    const feedback = rules().preview({ type: 'anar', target: v(60, 2, 0), playerPosition: v(59, 0, 0) });
    expect(feedback).toMatchObject({ ok: false, reason: 'unsupportedSurface', position: v(60, 2, 0) });
  });

  it('shares frozen rejection results instead of allocating', () => {
    const r = rules();
    const a = r.validate(at(v(-10, 0, 0), 'rocket'));
    const b = r.validate(at(v(-10.5, 0, 0.5), 'rocket'));
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('returns a fresh, independent preview from validate', () => {
    const r = rules();
    const a = r.validate(at(v(5, 0, 5)));
    r.preview(at(v(6, 0, 6)));
    expect(a.ok && a.preview.position).toEqual(v(5, 0, 5));
  });
});

describe('placement in the test lane', () => {
  const world = createWorld();
  const lane = new PlacementRules({ world });

  it('accepts a rocket just ahead of the spawn', () => {
    const target = v(world.spawn.x, 0, world.spawn.z - 2);
    expect(lane.validate({ type: 'rocket', target, playerPosition: world.spawn }).ok).toBe(true);
  });

  it('keeps every doorway clear', () => {
    const clearance = TUNING.placement.doorwayClearance;
    for (const door of world.doorways) {
      const reasons = new Set<string>();
      for (let a = 0; a < 16; a++) {
        const angle = (a / 16) * Math.PI * 2;
        const d = door.radius + clearance * 0.5;
        const target = v(door.centre.x + Math.cos(angle) * d, 0, door.centre.z + Math.sin(angle) * d);
        const result = lane.validate({ type: 'anar', target, playerPosition: target });
        reasons.add(result.ok ? 'ok' : result.reason);
      }
      expect(reasons.has('ok'), door.id).toBe(false);
      expect(reasons.has('nearDoorway'), door.id).toBe(true);
    }
  });

  it('keeps every neighbour area clear', () => {
    for (const area of world.neighbourAreas) {
      const result = lane.validate({ type: 'anar', target: area.centre, playerPosition: area.centre });
      expect(result.ok ? 'ok' : result.reason, area.id).toBe('nearNeighbour');
    }
  });
});
