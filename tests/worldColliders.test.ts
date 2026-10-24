import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorld, LAYOUT } from '../src/world';
import { addWorldColliders, type WorldColliders } from '../src/world/colliders';

const world = createWorld();
let physics: RAPIER.World;
let colliders: WorldColliders;

beforeAll(async () => {
  await RAPIER.init();
  physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  colliders = addWorldColliders(physics, world.solids);
  physics.step(); // populate the query pipeline
});

function castDown(x: number, z: number, fromY = 30) {
  const hit = physics.castRay(new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 100, true);
  return hit ? { y: fromY - hit.timeOfImpact, solid: colliders.solidByHandle.get(hit.collider.handle) } : null;
}

describe('world colliders', () => {
  it('creates one collider per solid on a single fixed body', () => {
    expect(colliders.body.isFixed()).toBe(true);
    expect(physics.colliders.len()).toBe(world.solids.length);
  });

  it('covers walls, ground, stairs, rooftop, railings and boundaries', () => {
    for (const kind of ['house', 'wall', 'ground', 'stair', 'landing', 'rooftop', 'railing', 'boundary'] as const) {
      expect(colliders.countByKind[kind], kind).toBeGreaterThan(0);
    }
  });

  it('stops a downward ray on the lane ground and the rooftop', () => {
    expect(castDown(0, -5)).toMatchObject({ y: 0, solid: { kind: 'ground' } });
    const roof = castDown(15, -25, 4.5);
    expect(roof?.solid?.kind).toBe('rooftop');
    expect(roof?.y).toBeCloseTo(LAYOUT.rooftopHeight);
  });

  it('stops a downward ray on a stair step', () => {
    const { stair } = LAYOUT;
    const hit = castDown(stair.x - stair.width / 2, stair.startZ - stair.tread * 5.5, 10);
    expect(hit?.solid?.kind).toBe('stair');
    expect(hit?.y).toBeCloseTo(stair.rise * 6);
  });

  it('blocks walking off the rooftop with a railing', () => {
    const ray = new RAPIER.Ray({ x: 15, y: LAYOUT.rooftopHeight + 0.5, z: -25 }, { x: 1, y: 0, z: 0 });
    const hit = physics.castRay(ray, 10, true);
    expect(colliders.solidByHandle.get(hit!.collider.handle)?.kind).toBe('railing');
  });

  it('blocks walking out of the lane past the entrance', () => {
    const ray = new RAPIER.Ray({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    const hit = physics.castRay(ray, 50, true);
    expect(['wall', 'boundary']).toContain(colliders.solidByHandle.get(hit!.collider.handle)?.kind);
    expect(hit!.timeOfImpact).toBeCloseTo(LAYOUT.laneSouthZ);
  });
});
