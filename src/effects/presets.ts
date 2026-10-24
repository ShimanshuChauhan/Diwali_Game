import type { BurstPattern } from '../core/types';

/**
 * Emitter presets: plain data describing how an effect sprays particles.
 * Counts are for a scale of 1 (Medium quality); the engine scales them by
 * the quality profile. Values are placeholders to tune in play (#12 refines
 * the per-cracker looks).
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

/** Anar ground fountain. */
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
};

/** Chakri: a spinning horizontal jet just above the ground. */
export const SPINNER: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 360,
  duration: Infinity,
  speed: { min: 3, max: 5 },
  life: { min: 0.25, max: 0.6 },
  direction: { x: 1, y: 0.05, z: 0 },
  spread: 0.15,
  spin: 14,
  gravity: 0.6,
  drag: 2,
  size0: 0.14,
  size1: 0.03,
  flicker: 0.5,
  fade: 0.25,
  inherit: 0,
  colours: [0xffe08a, 0x9cff8a, 0xff7aa8],
};

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
  crossette: { countScale: 0.7, speedScale: 1.05, lifeScale: 1, drag: 1, gravity: 0.35, arms: 6, armLift: 0, planar: false },
  palm: { countScale: 0.6, speedScale: 1.2, lifeScale: 1.3, drag: 1, gravity: 0.6, arms: 7, armLift: 0.6, planar: false },
};

export const BURST_PATTERNS = Object.keys(PATTERN_SHAPES) as BurstPattern[];
