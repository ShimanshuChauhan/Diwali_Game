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
    /** Speed gained per second while a direction is held (m/s²). */
    readonly acceleration: number;
    /** Speed lost per second once input is released (m/s²). */
    readonly deceleration: number;
    /** Steepest slope (degrees from horizontal) the player walks up. */
    readonly maxSlope: number;
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
    /** Unlit placed crackers older than this are reclaimed as abandoned. */
    readonly unlitReclaimAfter: number;
    /**
     * When the placed cap is full, the oldest unlit cracker at least this
     * old is reclaimed to make room for a new one.
     */
    readonly reclaimWhenFullAfter: number;
    /** Most abandoned crackers reclaimed in one step, so removal is gradual. */
    readonly maxReclaimsPerStep: number;
  };
  readonly neighbours: {
    /** Distance within which a neighbour reacts to a firework. */
    readonly reactionRadius: number;
    /** Minimum gap between one neighbour's reactions. */
    readonly reactionCooldown: number;
  };
  /** Family and neighbour homes expansion. */
  readonly homes: {
    /** Whole door fade, out and back in; the player moves at the midpoint. */
    readonly fadeDuration: number;
    /** Range for E at a door. */
    readonly doorRange: number;
    /** Range from which looking at an enterable street door hints that it opens. */
    readonly doorHintRange: number;
    /** Range to join aarti at the puja corner. */
    readonly pujaRange: number;
    /** Range to eat from or return the plate to the sweets tray. */
    readonly trayRange: number;
    /** Range to offer sweets to, or greet, a household member. */
    readonly personRange: number;
    /** Range to put a gift box back on its spot or the sweets table. */
    readonly returnSpotRange: number;
    /** Minimum gap between one household member's reactions. */
    readonly reactionCooldown: number;
    /** How long a Hinglish line stays on screen. */
    readonly dialogueDuration: number;
    /** Gap between the family's gentle invitations; never a countdown. */
    readonly inviteInterval: number;
  };
}

export const TUNING: Tuning = {
  player: {
    walkSpeed: 2.5,
    runSpeed: 5,
    eyeHeight: 1.6,
    maxStepHeight: 0.3,
    acceleration: 30,
    deceleration: 40,
    maxSlope: 45,
  },
  camera: {
    mouseSensitivity: 0.0025,
    pitchLimit: Math.PI / 2 - 0.05,
    thirdPersonDistance: 3.5,
    thirdPersonHeight: 1.8,
    collisionMargin: 0.2,
  },
  interaction: {
    interactRange: 2.5,
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
    rocketApexHeight: 30,
  },
  caps: {
    maxPlacedCrackers: 12,
    maxLitCrackers: 6,
    unlitReclaimAfter: 120,
    reclaimWhenFullAfter: 20,
    maxReclaimsPerStep: 1,
  },
  neighbours: {
    reactionRadius: 25,
    reactionCooldown: 6,
  },
  homes: {
    fadeDuration: 0.6,
    doorRange: 2,
    doorHintRange: 8,
    pujaRange: 2,
    trayRange: 1.5,
    personRange: 1.8,
    returnSpotRange: 1.5,
    reactionCooldown: 4,
    dialogueDuration: 3,
    inviteInterval: 45,
  },
};
