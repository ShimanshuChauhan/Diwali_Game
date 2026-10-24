import RAPIER from '@dimforge/rapier3d-compat';
import type { InteriorLayout } from './layout';

/**
 * Adds one fixed body holding a cuboid collider per interior solid: floor,
 * walls, ceiling and furniture. Interiors sit far from the street, so their
 * colliders live in the same physics world as the street's and stay there
 * across visits; nothing is rebuilt on entry. `RAPIER.init()` must already
 * have resolved, and the world must be stepped once before queries see them.
 */
export function addInteriorColliders(physics: RAPIER.World, layout: InteriorLayout): RAPIER.RigidBody {
  const body = physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const { box, kind } of layout.solids) {
    const { min, max } = box;
    const desc = RAPIER.ColliderDesc.cuboid((max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2)
      .setTranslation((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
      // Walls and furniture let the player slide along them rather than stick.
      .setFriction(kind === 'floor' ? 0.8 : 0);
    physics.createCollider(desc, body);
  }
  return body;
}
