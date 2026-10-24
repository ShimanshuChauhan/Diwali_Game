import type { DoorwaySnapshot } from '../core/homes';
import type { Vec3 } from '../core/types';

/**
 * The nearest of `doorways` within `range` of the player's feet (on the
 * ground plane), skipping any whose destination `canEnter` refuses, e.g. a
 * home whose interior is not built yet. A stand-in for E at a door until the
 * interaction routing (#56) owns doors.
 */
export function doorInReach(
  doorways: readonly DoorwaySnapshot[],
  feet: Vec3,
  range: number,
  canEnter: (doorway: DoorwaySnapshot) => boolean = () => true,
): DoorwaySnapshot | null {
  let best: DoorwaySnapshot | null = null;
  let bestDistSq = range * range;
  for (const doorway of doorways) {
    if (!canEnter(doorway)) continue;
    const dx = doorway.position.x - feet.x;
    const dz = doorway.position.z - feet.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = doorway;
    }
  }
  return best;
}
