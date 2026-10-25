import type { MutableVec3 } from './rocketFlight';
import type { Vec3 } from './types';

/**
 * A ladi's string, shared by the crackers (where each banger pops), its
 * prop (where each banger is drawn) and the effects (where the fuse is), so
 * all three agree. Renderer-free.
 *
 * The string lies on the ground centred on the cracker's position, running
 * along its `heading` (radians about +Y, the player's yaw when it was
 * placed) away from the player. The fuse sticks out of the near end; the
 * bangers are tied on in pairs, one each side of the cord, leaning a little
 * away from the fuse like a herringbone, and pop in string order.
 */
export const LADI_STRING = {
  /** Bangers on the string; each pops once. */
  bangers: 56,
  /** Length of the corded part, metres. */
  length: 0.8,
  /** Fuse sticking out of the near end, metres. */
  fuse: 0.07,
  /** One banger: a paper tube, metres. */
  bangerLength: 0.028,
  bangerRadius: 0.0055,
  /** Turn of each banger from square-on to the cord, radians. */
  lean: 0.45,
} as const;

/** One banger going off: when, which, and whether it is one of the louder ones. */
export interface LadiPop {
  /** Seconds after the ladi became active. */
  readonly time: number;
  /** Index along the string from the fuse end. */
  readonly banger: number;
  /** A louder bang: a brighter flash, the odd real light, a harder crack. */
  readonly loud: boolean;
}

/** A lit ladi's pops, rolled when its fuse is lit. */
export interface LadiChain {
  /** In time order; one per banger, in string order. */
  readonly pops: readonly LadiPop[];
  /** Seconds active: the last pop plus a moment for the smoke to settle. */
  readonly duration: number;
}

/** Unit vector along the string, away from the fuse, for `heading`. */
function along(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}

/**
 * Where banger `index` is tied on: its distance along the cord from the
 * fuse end, which side it hangs off (+1 right of the direction of travel,
 * -1 left) and its turn about +Y relative to the heading, so a model's +X
 * axis points from the cord out along the banger.
 */
export function ladiBanger(index: number): { readonly along: number; readonly side: 1 | -1; readonly turn: number } {
  const pairs = Math.ceil(LADI_STRING.bangers / 2);
  const pair = Math.floor(index / 2);
  const side = index % 2 === 0 ? 1 : -1;
  // Both sides lean away from the fuse: right turns by +lean, left by π − lean.
  const turn = side === 1 ? LADI_STRING.lean : Math.PI - LADI_STRING.lean;
  return { along: ((pair + 0.5) / pairs) * LADI_STRING.length, side, turn };
}

/**
 * World point `distance` metres along the cord from the fuse end of a ladi
 * centred on `centre`, pushed `side` metres to the right of its direction.
 */
export function ladiPoint(centre: Vec3, heading: number, distance: number, side: number, out: MutableVec3): MutableVec3 {
  const d = along(heading);
  const s = distance - LADI_STRING.length / 2;
  // Right of the direction of travel: (cos h, -sin h).
  out.x = centre.x + d.x * s + Math.cos(heading) * side;
  out.y = centre.y;
  out.z = centre.z + d.z * s - Math.sin(heading) * side;
  return out;
}

/** Middle of banger `index`, where it pops. */
export function ladiBangerCentre(centre: Vec3, heading: number, index: number, out: MutableVec3): MutableVec3 {
  const banger = ladiBanger(index);
  const reach = LADI_STRING.bangerLength / 2;
  const angle = heading + banger.turn;
  // A turn of `angle` about +Y takes +X to (cos, -sin); measure it against the right vector.
  const dx = Math.cos(angle) * reach;
  const dz = -Math.sin(angle) * reach;
  ladiPoint(centre, heading, banger.along, 0, out);
  out.x += dx;
  out.y += LADI_STRING.bangerRadius;
  out.z += dz;
  return out;
}

/** Tip of the fuse, where it is lit. */
export function ladiFuseTip(centre: Vec3, heading: number, out: MutableVec3): MutableVec3 {
  ladiPoint(centre, heading, -LADI_STRING.fuse, 0, out);
  out.y += 0.012;
  return out;
}
