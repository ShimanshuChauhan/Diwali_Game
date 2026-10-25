import type { BurstPattern, QualityLevel } from '../core/types';

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
  /** Trailing sparks behind each burst star, so it reads as a streak. */
  readonly tail?: TailSpec;
  /** Colour multiplier for bursts; above 1 pushes cores into the bloom. */
  readonly brightness?: number;
  /** Brief bright sprite at the heart of a burst: the bang. */
  readonly core?: CoreSpec;
  /** White-hot sparks at a fountain's mouth (anar) or a rocket's head. */
  readonly nozzle?: NozzleSpec;
}

export interface NozzleSpec {
  /** Sparks per second at a count scale of 1. */
  readonly rate: number;
  readonly speed: Range;
  readonly life: Range;
  readonly size: number;
  /** Height of the mouth above the source, metres. */
  readonly height: number;
  /** 0xRRGGBB. */
  readonly colour: number;
  /** Colour multiplier; above 1 pushes it into the bloom. */
  readonly brightness: number;
}

export interface TailSpec {
  /** Trailing sparks per star. */
  readonly count: number;
  /** Speed lost by each successive tail spark, as a fraction of the star's. */
  readonly step: number;
  /** Brightness kept by each successive tail spark. */
  readonly fade: number;
}

export interface CoreSpec {
  /** Sprite size, metres. */
  readonly size: number;
  readonly life: number;
  /** 0xRRGGBB. */
  readonly colour: number;
  /** Colour multiplier. */
  readonly brightness: number;
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

/**
 * How strongly a surging stream runs `age` seconds in: it builds up over
 * `rampUp`, then swells and dips around 1. Shared by the fountain's sparks
 * and its roar so they rise and fall together.
 */
export function surgeFactor(surge: SurgeSpec, age: number): number {
  const ramp = surge.rampUp > 0 ? Math.min(1, 0.5 + (0.5 * age) / surge.rampUp) : 1;
  const phase = Math.PI * 2 * surge.frequency * age;
  return ramp * (1 + surge.amplitude * (0.65 * Math.sin(phase) + 0.35 * Math.sin(phase * 2.3 + 1.7)));
}

export interface CrackleSpec {
  /** Pops per second (at a count scale of 1 this many on average). */
  readonly rate: number;
  /** Sparks per pop. */
  readonly count: number;
  /** Pops happen within this distance of the source, metres. */
  readonly radius: number;
  /** Height of the pops' centre above the source, metres; default 0. */
  readonly height?: number;
  readonly speed: Range;
  readonly life: Range;
  readonly size: number;
  /** 0xRRGGBB for the pops instead of the stream's colours. */
  readonly colour?: number;
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

/**
 * Rocket exhaust: a white-hot head riding the rocket, and fine golden
 * streaks thrown back from it that droop and fade to embers, so the climb
 * draws a soft, falling trail rather than a straight line.
 */
export const ROCKET_TRAIL: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 380,
  duration: Infinity,
  speed: { min: 1.5, max: 4 },
  life: { min: 0.45, max: 1 },
  direction: DOWN,
  spread: 0.45,
  spin: 0,
  gravity: 0.7,
  drag: 1.6,
  size0: 0.12,
  size1: 0.03,
  flicker: 0.5,
  fade: 0.25,
  endColour: 0x902808,
  inherit: 0.1,
  colours: [0xffc870, 0xffe2a8, 0xffa040],
  tail: { count: 1, step: 0.25, fade: 0.6 },
  brightness: 1.4,
  nozzle: {
    rate: 90,
    speed: { min: 0, max: 0.4 },
    life: { min: 0.05, max: 0.09 },
    size: 0.32,
    height: 0,
    colour: 0xfff4d6,
    brightness: 3,
  },
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

/**
 * Anar: a tight cone of fine, streaking sparks about three metres tall that
 * arc over and fall as embers, swelling and dipping as it burns, with a
 * white-hot mouth, crackling pops near the crown and a flickering light
 * that warms the houses round it.
 */
export const FOUNTAIN: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 800,
  duration: Infinity,
  speed: { min: 5.2, max: 7.2 },
  life: { min: 0.9, max: 1.5 },
  direction: UP,
  spread: 0.32,
  spin: 0,
  gravity: 1.1,
  drag: 0.8,
  size0: 0.055,
  size1: 0.02,
  flicker: 0.45,
  fade: 0.3,
  endColour: 0xb0400c,
  inherit: 0,
  colours: [0xffd27a, 0xfff2c4, 0xffb04a],
  surge: { amplitude: 0.18, frequency: 0.9, rampUp: 0.8 },
  tail: { count: 2, step: 0.05, fade: 0.6 },
  brightness: 1.3,
  nozzle: {
    rate: 240,
    speed: { min: 0.6, max: 1.6 },
    life: { min: 0.06, max: 0.14 },
    size: 0.12,
    height: 0,
    colour: 0xfff6dc,
    brightness: 2.5,
  },
  crackle: {
    rate: 9,
    count: 7,
    radius: 0.7,
    height: 1.8,
    speed: { min: 1.5, max: 3.5 },
    life: { min: 0.06, max: 0.16 },
    size: 0.05,
    colour: 0xfff8e8,
  },
  light: { peak: 14, range: 10, interval: 0.08, height: 0.8 },
};

/** Spark colours an anar may burn with; one is picked per anar. */
export const ANAR_PALETTES: readonly (readonly number[])[] = [
  [0xffd27a, 0xfff2c4, 0xffb04a],
  [0xf6f8ff, 0xdfe8ff, 0xffffff],
  [0xffd27a, 0x9dff6a, 0xfff2c4],
  [0xffd27a, 0xff5a3c, 0xfff2c4],
];

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

/**
 * Phuljhari: a white-hot point on the stick throwing fine, fast streaks in
 * every direction, ringed by tiny branching pops, with a flickering light
 * on the hands and ground. Sizes are small because it is seen up close.
 */
export const SPARKLER: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 520,
  duration: Infinity,
  speed: { min: 1, max: 2.4 },
  life: { min: 0.1, max: 0.24 },
  direction: UP,
  spread: Math.PI,
  spin: 0,
  gravity: 0.35,
  drag: 3.5,
  size0: 0.0065,
  size1: 0.002,
  flicker: 0.6,
  fade: 0.3,
  endColour: 0xff9a3a,
  inherit: 1,
  colours: [0xfff6e0, 0xffe2a0, 0xffffff],
  tail: { count: 3, step: 0.13, fade: 0.65 },
  brightness: 1.4,
  nozzle: {
    rate: 160,
    speed: { min: 0, max: 0.15 },
    life: { min: 0.04, max: 0.07 },
    size: 0.028,
    height: 0,
    colour: 0xfffbe8,
    brightness: 3,
  },
  crackle: {
    rate: 40,
    count: 5,
    radius: 0.14,
    speed: { min: 0.8, max: 2 },
    life: { min: 0.04, max: 0.1 },
    size: 0.005,
    colour: 0xffffff,
  },
  light: { peak: 3, range: 4, interval: 0.05, height: 0 },
};

/**
 * Ladi: the fire running along the string. The stream itself throws no
 * sparks; it carries a hot spitting point that hops to each banger as it
 * pops (`LADI_POP` adds the bangs), so a whole ladi holds one effect.
 */
export const LADI_BURN: EmitterPreset = {
  kind: 'stream',
  count: 0,
  rate: 0,
  duration: Infinity,
  speed: { min: 0.3, max: 1.2 },
  life: { min: 0.05, max: 0.12 },
  direction: UP,
  spread: 1.1,
  spin: 0,
  gravity: 0.4,
  drag: 2,
  size0: 0.03,
  size1: 0.01,
  flicker: 0.7,
  fade: 0.3,
  inherit: 0,
  colours: [0xffd890, 0xffb050],
  nozzle: {
    rate: 70,
    speed: { min: 0.2, max: 1 },
    life: { min: 0.04, max: 0.1 },
    size: 0.035,
    height: 0.005,
    colour: 0xffe6b0,
    brightness: 2,
  },
};

export interface LadiPopPart {
  /** Particles per pop at a count scale of 1. */
  readonly count: number;
  readonly speed: Range;
  readonly life: Range;
  readonly size0: number;
  readonly size1: number;
  readonly gravity: number;
  readonly drag: number;
  /** 0xRRGGBB. */
  readonly colour: number;
  /** Colour at death as a fraction of `colour`. */
  readonly fade: number;
}

/** One banger going off: a tiny white flash, a spit of sparks, red paper shreds and a puff of smoke. */
export interface LadiPopSpec {
  /** The bang: one brief, hot sprite. */
  readonly core: CoreSpec;
  /** Sparks thrown up and out in a wide cone. */
  readonly sparks: LadiPopPart & { readonly spread: number; readonly brightness: number };
  /** Shreds of the banger's red paper, tossed up to flutter down (drawn opaque, not glowing). */
  readonly paper: LadiPopPart;
  /** A soft grey puff that swells and rises (drawn see-through). */
  readonly smoke: LadiPopPart & { readonly opacity: number };
  /** Louder bangs: bigger core and more sparks. */
  readonly loudScale: number;
  /** Some loud bangs also briefly light the ground, if a light is free. */
  readonly flash: FlashSpec;
}

export const LADI_POP: LadiPopSpec = {
  core: { size: 0.16, life: 0.045, colour: 0xfff4dc, brightness: 2.6 },
  sparks: {
    count: 9,
    speed: { min: 1.2, max: 3.6 },
    life: { min: 0.05, max: 0.16 },
    size0: 0.02,
    size1: 0.006,
    gravity: 0.6,
    drag: 4,
    colour: 0xffd27a,
    fade: 0.3,
    spread: 1.2,
    brightness: 1.8,
  },
  paper: {
    count: 4,
    speed: { min: 0.8, max: 2.4 },
    life: { min: 0.7, max: 1.3 },
    size0: 0.012,
    size1: 0.01,
    gravity: 0.3,
    drag: 3,
    colour: 0xb81418,
    fade: 0.6,
  },
  smoke: {
    count: 2,
    speed: { min: 0.15, max: 0.45 },
    life: { min: 1.2, max: 2.2 },
    size0: 0.09,
    size1: 0.42,
    gravity: -0.03,
    drag: 1.2,
    colour: 0x4a4744,
    fade: 0.7,
    opacity: 0.22,
  },
  loudScale: 1.6,
  flash: { peak: 2.5, range: 4, duration: 0.08 },
};

/** Shared base for overhead rocket bursts; patterns adjust it. */
export const SKY_BURST: EmitterPreset = {
  kind: 'burst',
  count: 200,
  rate: 0,
  duration: 0,
  speed: { min: 16, max: 19.5 },
  life: { min: 2.6, max: 3.4 },
  direction: UP,
  spread: Math.PI,
  spin: 0,
  gravity: 0.4,
  drag: 1.15,
  size0: 1.1,
  size1: 0.8,
  flicker: 0.2,
  fade: 0.9,
  inherit: 0,
  colours: [0xff4f6d, 0xffd34f, 0x4fb6ff],
  // The burst's light comes from `BURST_LOOKS`, which varies by quality.
  tail: { count: 6, step: 0.028, fade: 0.72 },
  brightness: 1.35,
  core: { size: 3.5, life: 0.14, colour: 0xfff6e0, brightness: 1.8 },
};

/**
 * How a rocket burst lights the street and how rich it looks, per quality
 * level. The burst light is one pooled point light (the pool's size is fixed
 * per level), so richer levels spend intensity, reach and time, not lights.
 */
export interface BurstLook {
  /**
   * Point-light intensity of the initial flash. Only comparable between
   * looks with the same `decay`; `lightReaching` gives what a surface gets.
   */
  readonly peak: number;
  /** Light reach in metres. */
  readonly range: number;
  /** Seconds the initial flash takes to fade out. */
  readonly duration: number;
  /** Light falloff exponent; 2 is physical, lower is softer and reaches further. */
  readonly decay: number;
  /**
   * The light sits this far below the burst, towards the middle of the
   * expanding shell, so its colour reaches the lane and house fronts.
   */
  readonly drop: number;
  /** Afterglow that follows the sparks: a fraction of `peak`, 0 = none. */
  readonly glow: number;
  /** Seconds the afterglow lasts at a pattern life scale of 1. */
  readonly glowDuration: number;
  /** Brief sky wash in the burst colour: hemisphere-light intensity, 0 = none. */
  readonly sky: number;
  readonly skyDuration: number;
  /**
   * Multiplier on star brightness. With bloom the stars add up in HDR before
   * tone mapping, so a dense shell (and its overlapping tails) washes out to
   * white; below 1 keeps the palette readable. `starCap` keeps each star's
   * core bright enough for the bloom.
   */
  readonly brightness: number;
  /** Multiplier on the speed step between tail sparks; above 1 draws longer trails. */
  readonly tailStretch: number;
  /**
   * Bloom levels: the brightest a burst star's sprite may be, scaled down
   * whole so its hue holds (0 = uncapped). Tone mapping turns HDR overlaps
   * white; capped stars stay in the burst's colours and bloom adds the glow.
   */
  readonly starCap: number;
}

/** The burst light never sinks below this height, so it stays above the rooftops. */
export const BURST_LIGHT_FLOOR = 14;

export const BURST_LOOKS: Readonly<Record<QualityLevel, BurstLook>> = {
  // A single brief flash, as cheap as before.
  low: {
    peak: 700,
    range: 55,
    duration: 0.5,
    decay: 2,
    drop: 0,
    glow: 0,
    glowDuration: 0,
    sky: 0,
    skyDuration: 0,
    brightness: 1,
    tailStretch: 1,
    starCap: 0,
  },
  // A coloured flash that visibly lights the lane, rooftops and courtyard,
  // with a short glow while the shell is at its brightest.
  medium: {
    peak: 3000,
    range: 80,
    duration: 0.5,
    decay: 1.5,
    drop: 4,
    glow: 0.5,
    glowDuration: 1.4,
    sky: 0,
    skyDuration: 0,
    brightness: 0.6,
    tailStretch: 1.15,
    starCap: 1.4,
  },
  // A strong flash, then a softer, wider glow in the burst colour that fades
  // with the sparks, washing over house fronts and the ground; the sky and
  // everything under it lift towards the burst colour too.
  high: {
    peak: 1300,
    range: 110,
    duration: 0.7,
    decay: 1.2,
    drop: 6,
    glow: 0.5,
    glowDuration: 2.6,
    sky: 0.12,
    skyDuration: 1.8,
    brightness: 0.45,
    tailStretch: 1.4,
    starCap: 1.4,
  },
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
  /** Inner shell in a second colour, as a fraction of the star count (pistil). */
  readonly pistil?: number;
  /** Tail sparks per star instead of the burst's default. */
  readonly tailCount?: number;
  /** Speed step between tail sparks instead of the burst's default; larger draws longer trails. */
  readonly tailStep?: number;
  /** Stars twinkle hard as they fade (glitter). */
  readonly glitter?: boolean;
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
  peony: {
    countScale: 1,
    speedScale: 1,
    lifeScale: 1,
    drag: 1.15,
    gravity: 0.4,
    arms: 0,
    armLift: 0,
    planar: false,
    pistil: 0.3,
  },
  ring: {
    countScale: 0.7,
    speedScale: 1.05,
    lifeScale: 0.9,
    drag: 1,
    gravity: 0.25,
    arms: 0,
    armLift: 0,
    planar: true,
  },
  willow: {
    countScale: 0.8,
    speedScale: 0.9,
    lifeScale: 1.6,
    drag: 1.35,
    gravity: 0.9,
    arms: 0,
    armLift: 0,
    planar: false,
    endColour: 0x8a4a08,
    tailCount: 7,
    tailStep: 0.07,
    glitter: true,
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
    tailCount: 2,
    breaks: { stars: 12, delay: 0.75, sparks: 32, speed: 8, starSize: 1 },
  },
  palm: {
    countScale: 0.7,
    speedScale: 1.15,
    lifeScale: 1.3,
    drag: 1,
    gravity: 0.6,
    arms: 8,
    armLift: 0.6,
    planar: false,
    endColour: 0xa05a10,
    tailCount: 6,
    tailStep: 0.05,
    glitter: true,
  },
  heart: {
    countScale: 0.6,
    speedScale: 0.85,
    lifeScale: 1,
    drag: 1.2,
    gravity: 0.12,
    arms: 0,
    armLift: 0,
    planar: true,
    outline: 'heart',
    tailCount: 2,
  },
};

export const BURST_PATTERNS = Object.keys(PATTERN_SHAPES) as BurstPattern[];
