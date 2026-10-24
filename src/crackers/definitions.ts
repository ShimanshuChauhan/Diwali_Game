import { TUNING, type Tuning } from '../core/tuning';
import { CRACKER_TYPES, isHandheld, type BurstPattern, type CrackerType } from '../core/types';

/**
 * Cracker type definitions: timing comes from the central tuning, effect
 * parameters live here. Plain data, so effects, audio and UI can read the
 * same numbers the lifecycle runs on.
 */

export interface PhuljhariEffect {
  readonly kind: 'sparks';
  /** Spark emission rate while lit, per second. */
  readonly sparksPerSecond: number;
}

export interface AnarEffect {
  readonly kind: 'fountain';
  /** Peak height of the fountain, metres. */
  readonly height: number;
}

export interface ChakriEffect {
  readonly kind: 'spinner';
  /** Spin rate while active, revolutions per second. */
  readonly revolutionsPerSecond: number;
}

export interface RocketEffect {
  readonly kind: 'skyBurst';
  /** Nominal rise before the burst; variants scale it with their ascent time. */
  readonly apexHeight: number;
  /** Ascent time is the nominal active duration times a factor in this range. */
  readonly ascentScale: readonly [number, number];
  /** Number of colours per burst, inclusive range. */
  readonly colourCount: readonly [number, number];
  readonly patterns: readonly BurstPattern[];
  /** 0xRRGGBB colours bursts draw from. */
  readonly palette: readonly number[];
  /** Themed subsets of `palette`; each rocket draws its colours from one. */
  readonly palettes: readonly (readonly number[])[];
}

export interface CrackerEffects {
  readonly phuljhari: PhuljhariEffect;
  readonly anar: AnarEffect;
  readonly chakri: ChakriEffect;
  readonly rocket: RocketEffect;
}

export interface CrackerDefinition<T extends CrackerType = CrackerType> {
  readonly type: T;
  /** Number key that selects it (1–4). */
  readonly slot: number;
  readonly label: string;
  /** Held in the hand rather than placed. */
  readonly handheld: boolean;
  /** Fuse burn time before it becomes active, seconds. */
  readonly fuse: number;
  /** Time spent active before finishing (rocket: nominal ascent), seconds. */
  readonly activeDuration: number;
  readonly effect: CrackerEffects[T];
}

export type CrackerDefinitions = { readonly [T in CrackerType]: CrackerDefinition<T> };

export const BURST_PATTERNS: readonly BurstPattern[] = ['peony', 'ring', 'willow', 'crossette', 'palm', 'heart'];

/** Festive rocket colours (0xRRGGBB). */
export const ROCKET_PALETTE: readonly number[] = [
  0xff4f6d, 0xffd34f, 0x4fb6ff, 0x7dff6a, 0xd36bff, 0xffffff, 0xff8a3d, 0x3dffe0,
];

/** Themed colour sets drawn from `ROCKET_PALETTE`, so bursts look curated. */
export const ROCKET_PALETTES: readonly (readonly number[])[] = [
  [0xffd34f, 0xff8a3d, 0xffffff], // gold
  [0xff4f6d, 0xd36bff, 0xffd34f], // festive
  [0x4fb6ff, 0x3dffe0, 0xffffff], // cool
  [0x7dff6a, 0xffd34f, 0x3dffe0], // spring
  [0xff8a3d, 0xffffff, 0x7dff6a], // tiranga
  ROCKET_PALETTE, // anything goes
];

const LABELS: Readonly<Record<CrackerType, string>> = {
  phuljhari: 'Phuljhari',
  anar: 'Anar',
  chakri: 'Chakri',
  rocket: 'Rocket',
};

function effectsFor(tuning: Tuning): CrackerEffects {
  return {
    phuljhari: { kind: 'sparks', sparksPerSecond: 120 },
    anar: { kind: 'fountain', height: 3 },
    chakri: { kind: 'spinner', revolutionsPerSecond: 4 },
    rocket: {
      kind: 'skyBurst',
      apexHeight: tuning.crackers.rocketApexHeight,
      ascentScale: [0.8, 1.2],
      colourCount: [1, 3],
      patterns: BURST_PATTERNS,
      palette: ROCKET_PALETTE,
      palettes: ROCKET_PALETTES,
    },
  };
}

/** Build the four definitions from a tuning (the central one by default). */
export function crackerDefinitions(tuning: Tuning = TUNING): CrackerDefinitions {
  const effects = effectsFor(tuning);
  const define = <T extends CrackerType>(type: T): CrackerDefinition<T> => ({
    type,
    slot: CRACKER_TYPES.indexOf(type) + 1,
    label: LABELS[type],
    handheld: isHandheld(type),
    fuse: tuning.crackers.fuse[type],
    activeDuration: tuning.crackers.activeDuration[type],
    effect: effects[type],
  });
  return {
    phuljhari: define('phuljhari'),
    anar: define('anar'),
    chakri: define('chakri'),
    rocket: define('rocket'),
  };
}

export const CRACKER_DEFINITIONS: CrackerDefinitions = crackerDefinitions();
