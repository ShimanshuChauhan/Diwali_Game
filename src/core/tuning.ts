import type { CrackerType } from './types';

/**
 * Central gameplay tuning values. Distances are metres, times seconds.
 * All values are placeholders to be tuned in play; rule modules read them
 * from here (or take an override in tests) rather than hard-coding numbers.
 */
export interface Tuning {
  readonly player: {
    readonly walkSpeed: number;
    readonly runSpeed: number;
    readonly eyeHeight: number;
    /** Highest step the controller climbs without jumping. */
    readonly maxStepHeight: number;
  };
  readonly camera: {
    readonly mouseSensitivity: number;
    readonly pitchLimit: number;
    readonly thirdPersonDistance: number;
    readonly thirdPersonHeight: number;
    /** Gap kept between the third-person camera and obstacles. */
    readonly collisionMargin: number;
  };
  readonly interaction: {
    /** Range for E to light a placed cracker or diya. */
    readonly interactRange: number;
  };
  readonly placement: {
    /** Max distance from the player to a placement point. */
    readonly reach: number;
    /** Steepest surface (degrees from horizontal) that supports a cracker. */
    readonly maxSurfaceSlope: number;
    readonly geometryClearance: number;
    readonly doorwayClearance: number;
    readonly neighbourClearance: number;
    /** Minimum clear height above a rocket's launch point. */
    readonly rocketSkyClearance: number;
    /** Minimum distance between two placed crackers. */
    readonly crackerSpacing: number;
  };
  readonly crackers: {
    /** Fuse burn time before the cracker becomes active. */
    readonly fuse: Readonly<Record<CrackerType, number>>;
    /** Time spent active before finishing (rocket: ascent to burst). */
    readonly activeDuration: Readonly<Record<CrackerType, number>>;
    readonly rocketApexHeight: number;
  };
  readonly caps: {
    /** Placed, not yet finished crackers in the world. */
    readonly maxPlacedCrackers: number;
    /** Crackers whose fuse is burning or that are active at once. */
    readonly maxLitCrackers: number;
    /** Unlit placed crackers older than this may be reclaimed. */
    readonly unlitReclaimAfter: number;
  };
  readonly neighbours: {
    /** Distance within which a neighbour reacts to a firework. */
    readonly reactionRadius: number;
    /** Minimum gap between one neighbour's reactions. */
    readonly reactionCooldown: number;
  };
}

export const TUNING: Tuning = {
  player: {
    walkSpeed: 2.5,
    runSpeed: 5,
    eyeHeight: 1.6,
    maxStepHeight: 0.3,
  },
  camera: {
    mouseSensitivity: 0.0025,
    pitchLimit: Math.PI / 2 - 0.05,
    thirdPersonDistance: 3.5,
    thirdPersonHeight: 1.8,
    collisionMargin: 0.2,
  },
  interaction: {
    interactRange: 2,
  },
  placement: {
    reach: 3,
    maxSurfaceSlope: 15,
    geometryClearance: 0.4,
    doorwayClearance: 1.5,
    neighbourClearance: 2,
    rocketSkyClearance: 12,
    crackerSpacing: 0.6,
  },
  crackers: {
    fuse: { phuljhari: 0.5, anar: 2.5, chakri: 2, rocket: 3 },
    activeDuration: { phuljhari: 30, anar: 8, chakri: 6, rocket: 1.8 },
    rocketApexHeight: 40,
  },
  caps: {
    maxPlacedCrackers: 12,
    maxLitCrackers: 6,
    unlitReclaimAfter: 120,
  },
  neighbours: {
    reactionRadius: 25,
    reactionCooldown: 6,
  },
};
