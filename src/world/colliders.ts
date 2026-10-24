import RAPIER from '@dimforge/rapier3d-compat';
import type { Solid, SolidKind } from './layout';

export interface WorldColliders {
  readonly body: RAPIER.RigidBody;
  /** Collider handle → the solid it was built from. */
  readonly solidByHandle: ReadonlyMap<number, Solid>;
  readonly countByKind: Readonly<Record<SolidKind, number>>;
}

const KINDS: readonly SolidKind[] = [
  'ground',
  'house',
  'wall',
  'balcony',
  'railing',
  'stair',
  'landing',
  'rooftop',
  'prop',
  'boundary',
];

/**
 * Adds one fixed body holding a cuboid collider per solid. `RAPIER.init()`
 * must already have resolved.
 */
export function addWorldColliders(physics: RAPIER.World, solids: readonly Solid[]): WorldColliders {
  const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const solidByHandle = new Map<number, Solid>();
  const countByKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<SolidKind, number>;

  for (const solid of solids) {
    const { min, max } = solid.box;
    const desc = RAPIER.ColliderDesc.cuboid((max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2)
      .setTranslation((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
      .setFriction(solid.kind === 'railing' || solid.kind === 'boundary' ? 0 : 0.8);
    const collider = physics.createCollider(desc, body);
    solidByHandle.set(collider.handle, solid);
    countByKind[solid.kind]++;
  }

  return { body, solidByHandle, countByKind };
}
