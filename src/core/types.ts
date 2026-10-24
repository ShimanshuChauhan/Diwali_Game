/**
 * Shared, renderer-free value types used across module contracts.
 *
 * Plain data only: no Three.js or Rapier types, so rule modules and their
 * tests can run headless. Rendering code converts at its own boundary.
 */

/** World-space vector in metres. Y is up. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Axis-aligned box in world space. */
export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Circular keep-out area on the ground plane (y ignored). */
export interface ExclusionZone {
  readonly id: string;
  readonly centre: Vec3;
  /** Metres. Callers add the relevant tuning clearance on top. */
  readonly radius: number;
}

/** The four cracker types; slot order matches keys 1–4. */
export const CRACKER_TYPES = ['phuljhari', 'anar', 'chakri', 'rocket'] as const;
export type CrackerType = (typeof CRACKER_TYPES)[number];

/** Crackers held in the hand rather than placed on the ground. */
export function isHandheld(type: CrackerType): boolean {
  return type === 'phuljhari';
}

export type CrackerId = string;
export type DiyaId = string;
export type NeighbourId = string;

export type CameraMode = 'firstPerson' | 'thirdPerson';

export type QualityLevel = 'low' | 'medium' | 'high';

/** Why a candidate placement was refused; shown to the player as feedback. */
export type PlacementRejection =
  | 'outOfReach'
  | 'unsupportedSurface'
  | 'blockedByGeometry'
  | 'nearDoorway'
  | 'nearNeighbour'
  | 'noSkyClearance'
  | 'capacity'
  | 'handheldOnly';

/** Why lighting a cracker was refused. */
export type IgnitionRejection = 'notFound' | 'alreadyLit' | 'outOfReach' | 'capacity';

/** Rocket burst shapes. */
export type BurstPattern = 'peony' | 'ring' | 'willow' | 'crossette' | 'palm' | 'heart';

/**
 * A rocket's path from launch to burst: it climbs `apexHeight` metres in
 * `ascent` seconds while drifting `drift` metres sideways.
 */
export interface RocketFlight {
  readonly ascent: number;
  readonly apexHeight: number;
  /** Horizontal offset of the burst from the launch point, metres. */
  readonly drift: { readonly x: number; readonly z: number };
}
