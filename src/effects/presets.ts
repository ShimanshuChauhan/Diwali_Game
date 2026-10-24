import type { BurstPattern } from '../core/types';

/**
 * Emitter presets: plain data describing how an effect sprays particles.
 * Counts are for a scale of 1 (Medium quality); the engine scales them by
 * the quality profile. Values are tuned by eye; adjust in play.
 */

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface FlashSpec {
  /** Point-light intensity (candela) at the moment of the flash. */
  readonly peak: number;
  /** Light reach in metres. */
  readonly range: number;
  readonly duration: number;
}

export interface EmitterPreset {
  /** One-shot (`burst`) or continuous (`stream`). */
  readonly kind: 'burst' | 'stream';
  /** Particles spawned at once by a burst. */
  readonly count: number;
  /** Particles per second for a stream. */
  readonly rate: number;
  /** Seconds a stream emits; Infinity runs until stopped. */
  readonly duration: number;
  /** Launch speed, m/s. */
  readonly speed: Range;
  /** Particle lifetime, seconds. */
  readonly life: Range;
  /** Unit emission axis for streams. */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number };
  /** Cone half-angle around `direction`, radians (π = every direction). */
  readonly spread: number;
  /** Rotation of `direction` about +Y in rad/s (chakri). */
  readonly spin: number;
  readonly gravity: number;
  readonly drag: number;
  readonly size0: number;
  readonly size1: number;
  readonly flicker: number;
  /** End colour as a fraction of the start colour. */
  readonly fade: number;
  /** Optional 0xRRGGBB colour every particle fades towards instead. */
  readonly endColour?: number;
  /** Fraction of the emitter's own velocity passed to its particles. */
  readonly inherit: number;
  /** Default colours when the caller gives none. */
  readonly colours: readonly number[];
  readonly flash?: FlashSpec;
  /** Evenly spaced jets around `direction` as it spins (chakri); default 1. */
  readonly jets?: number;
  /** Speed swells over time so a fountain rises and falls (anar). */
  readonly surge?: SurgeSpec;
  /** Small pops of sparks around the source (phuljhari crackle). */
  readonly crackle?: CrackleSpec;
  /** The source drifts on the ground near where it started (chakri). */
  readonly wander?: WanderSpec;
  /** Sparks leave a spinning wheel's rim instead of its centre (chakri). */
  readonly rim?: RimSpec;
  /** A light that keeps flickering while the stream burns (chakri). */
  readonly light?: GlowLightSpec;
}

export interface RimSpec {
  /** Radius of the wheel the jets sit on, metres. */
  readonly radius: number;
  /** Height of the jets above the source, metres. */
  readonly height: number;
  /** How far the jets turn out from the tangent, radians. */
  readonly outward: number;
  /** Upward part of each spark's direction, before normalising. */
  readonly lift: number;
  /** Bright, short-lived sparks hugging the rim: the blurred wheel of fire. */
  readonly glow: {
    /** Glow sparks per second at a count scale of 1. */
    readonly rate: number;
    readonly life: Range;
    readonly size: number;
    /** 0xRRGGBB; the glow is hotter than the thrown sparks. */
    readonly colour: number;
  };
}

export interface GlowLightSpec {
  /** Point-light intensity (candela) at full flicker. */
  readonly peak: number;
  /** Light reach in metres. */
  readonly range: number;
  /** Seconds between flickers; each flicker lasts twice this. */
  readonly interval: number;
  /** Height of the light above the source, metres. */
  readonly height: number;
}

export interface SurgeSpec {
  /** Peak fraction added to or taken from the launch speed. */
  readonly amplitude: number;
  /** Base swell frequency, Hz; a second, faster swell breaks the rhythm. */
  readonly frequency: number;
  /** Seconds to build from a low start to full speed. */
  readonly rampUp: number;
}

export interface CrackleSpec {
  /** Pops per second (at a count scale of 1 this many on average). */
  readonly rate: number;
  /** Sparks per pop. */
  readonly count: number;
  /** Pops happen within this distance of the source, metres. */
  readonly radius: number;
  readonly speed: Range;
  readonly life: Range;
  readonly size: number;
}

export interface WanderSpec {
  /** Drift speed, m/s. */
  readonly speed: number;
  /** Maximum distance from the start, metres. */
  readonly radius: number;
  /** Random heading change, rad/s. */
  readonly turn: number;
}

const UP = { x: 0, y: 1, z: 0 } as const;
const DOWN = { x: 0, y: -1, z: 0 } as const;

/** Rocket exhaust: short warm sparks left behind the rising rocket. */
export const ROCKET_TRAIL: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 260,
  duration: Infinity,
  speed: { min: 0.5, max: 2.5 },
  life: { min: 0.35, max: 0.8 },
  direction: DOWN,
  spread: 0.35,
  spin: 0,
  gravity: 0.25,
  drag: 1.5,
  size0: 0.22,
  size1: 0.05,
  flicker: 0.5,
  fade: 0.2,
  endColour: 0x802000,
  inherit: 0.15,
  colours: [0xffc870, 0xffe2a8],
};

/** Fuse sparkle: a few tiny sparks while the fuse burns. */
export const FUSE: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 70,
  duration: Infinity,
  speed: { min: 0.6, max: 1.8 },
  life: { min: 0.1, max: 0.3 },
  direction: UP,
  spread: 1.2,
  spin: 0,
  gravity: 0.5,
  drag: 2,
  size0: 0.07,
  size1: 0.02,
  flicker: 0.9,
  fade: 0.3,
  inherit: 0,
  colours: [0xffe6a0, 0xffb050],
};

/** Anar ground fountain; its height swells and dips as it burns. */
export const FOUNTAIN: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 420,
  duration: Infinity,
  speed: { min: 6, max: 10 },
  life: { min: 0.8, max: 1.6 },
  direction: UP,
  spread: 0.28,
  spin: 0,
  gravity: 1,
  drag: 0.4,
  size0: 0.18,
  size1: 0.04,
  flicker: 0.6,
  fade: 0.3,
  inherit: 0,
  colours: [0xffd27a, 0xfff2c4, 0xff9a3c],
  flash: { peak: 15, range: 12, duration: 0.6 },
  surge: { amplitude: 0.3, frequency: 0.7, rampUp: 1 },
};

/**
 * Chakri: a wheel spinning about four times a second, throwing sparks off
 * its rim along the direction of travel so they trace spiral arcs, with a
 * blurred ring of fire round the wheel and a flickering glow on the ground.
 * It skitters a little as it spins.
 */
export const SPINNER: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 1500,
  duration: Infinity,
  speed: { min: 4, max: 7.5 },
  life: { min: 0.18, max: 0.42 },
  direction: { x: 1, y: 0, z: 0 },
  spread: 0.08,
  spin: 25,
  gravity: 0.9,
  drag: 2.6,
  size0: 0.045,
  size1: 0.012,
  flicker: 0.55,
  fade: 0.25,
  endColour: 0xc02a08,
  inherit: 0,
  colours: [0xffd36b, 0xffb43c, 0xfff0c0],
  jets: 2,
  surge: { amplitude: 0.15, frequency: 1.3, rampUp: 0.5 },
  wander: { speed: 0.25, radius: 0.35, turn: 6 },
  rim: {
    radius: 0.14,
    height: 0.05,
    outward: 0.35,
    lift: 0.12,
    glow: { rate: 420, life: { min: 0.04, max: 0.08 }, size: 0.06, colour: 0xfff3c8 },
  },
  light: { peak: 5, range: 6, interval: 0.1, height: 0.3 },
};

/** Spark colours a chakri may burn with; one is picked per chakri. */
export const CHAKRI_PALETTES: readonly (readonly number[])[] = [
  [0xffd36b, 0xffb43c, 0xfff0c0],
  [0xf4f6ff, 0xd8e4ff, 0xffffff],
  [0x9dff6a, 0xffd36b, 0xe8ffc8],
  [0xff5a3c, 0xffc04a, 0xffe0b0],
];

/** Phuljhari: a small crackling ball of sparks at the stick tip. */
export const SPARKLER: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 160,
  duration: Infinity,
  speed: { min: 0.8, max: 2.2 },
  life: { min: 0.15, max: 0.4 },
  direction: UP,
  spread: Math.PI,
  spin: 0,
  gravity: 0.4,
  drag: 3,
  size0: 0.06,
  size1: 0.015,
  flicker: 0.8,
  fade: 0.3,
  inherit: 1,
  colours: [0xfff4d6, 0xffd08a],
  crackle: { rate: 14, count: 8, radius: 0.25, speed: { min: 1.5, max: 3.5 }, life: { min: 0.06, max: 0.18 }, size: 0.05 },
};

/** Shared base for overhead rocket bursts; patterns adjust it. */
export const SKY_BURST: EmitterPreset = {
  kind: 'burst',
  count: 360,
  rate: 0,
  duration: 0,
  speed: { min: 13, max: 16 },
  life: { min: 1.6, max: 2.4 },
  direction: UP,
  spread: Math.PI,
  spin: 0,
  gravity: 0.35,
  drag: 1.1,
  size0: 0.55,
  size1: 0.2,
  flicker: 0.25,
  fade: 0.35,
  inherit: 0,
  colours: [0xff4f6d, 0xffd34f, 0x4fb6ff],
  flash: { peak: 3000, range: 70, duration: 0.6 },
};

/** Per-pattern changes applied on top of `SKY_BURST`. */
export interface PatternShape {
  readonly countScale: number;
  readonly speedScale: number;
  readonly lifeScale: number;
  readonly drag: number;
  readonly gravity: number;
  /** 0 = spherical shell; otherwise sparks gather into this many arms. */
  readonly arms: number;
  /** Lean arms upward (palm). */
  readonly armLift: number;
  /** Ring bursts lie in a single plane. */
  readonly planar: boolean;
  readonly endColour?: number;
  /** Sparks trace a flat outline facing the viewer instead of a shell. */
  readonly outline?: 'heart';
  /** Bright stars that each split again after a delay (crossette). */
  readonly breaks?: BreakSpec;
}

export interface BreakSpec {
  /** Stars launched by the main burst. */
  readonly stars: number;
  /** Seconds before each star splits. */
  readonly delay: number;
  /** Sparks per split, laid out as a cross. */
  readonly sparks: number;
  /** Launch speed of the split's sparks, m/s. */
  readonly speed: number;
  /** Size of a star while it flies, metres. */
  readonly starSize: number;
}

export const PATTERN_SHAPES: Readonly<Record<BurstPattern, PatternShape>> = {
  peony: { countScale: 1, speedScale: 1, lifeScale: 1, drag: 1.1, gravity: 0.35, arms: 0, armLift: 0, planar: false },
  ring: { countScale: 0.6, speedScale: 1.1, lifeScale: 0.9, drag: 1, gravity: 0.25, arms: 0, armLift: 0, planar: true },
  willow: {
    countScale: 0.9,
    speedScale: 0.7,
    lifeScale: 2,
    drag: 1.8,
    gravity: 0.7,
    arms: 0,
    armLift: 0,
    planar: false,
    endColour: 0xb06a10,
  },
  crossette: {
    countScale: 0.3,
    speedScale: 1,
    lifeScale: 0.6,
    drag: 1,
    gravity: 0.35,
    arms: 0,
    armLift: 0,
    planar: false,
    breaks: { stars: 10, delay: 0.75, sparks: 28, speed: 7, starSize: 0.8 },
  },
  palm: { countScale: 0.6, speedScale: 1.2, lifeScale: 1.3, drag: 1, gravity: 0.6, arms: 7, armLift: 0.6, planar: false },
  heart: {
    countScale: 0.55,
    speedScale: 1,
    lifeScale: 1,
    drag: 1.2,
    gravity: 0.12,
    arms: 0,
    armLift: 0,
    planar: true,
    outline: 'heart',
  },
};

export const BURST_PATTERNS = Object.keys(PATTERN_SHAPES) as BurstPattern[];
