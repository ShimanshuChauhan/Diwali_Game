import type { CrackerType } from '../core/types';

/**
 * Catalogue of the synthesised sounds and their mix settings. Gains, ranges
 * and priorities are placeholder tuning (PRD → Further Notes: audio mix is a
 * tuning decision).
 */
export type SoundKind =
  | 'fuseHiss'
  | 'phuljhariCrackle'
  | 'anarRoar'
  | 'chakriWhine'
  | 'rocketWhistle'
  | 'ladiPops'
  | 'burst'
  | 'distantPop'
  | 'distantBomb'
  | 'distantLadi'
  | 'distantShell'
  | 'distantWhistle'
  | 'distantFountain'
  | 'distantChakri';

export interface SoundSpec {
  /** Voice-stealing rank; see `VoicePool`. */
  readonly priority: number;
  /** Linear gain before master. */
  readonly gain: number;
  /** Panner distance at which the sound plays at `gain`; larger carries further. */
  readonly refDistance: number;
  /**
   * `'ladi'` plays through the ladi bus (its lane slapback and limiter; see
   * `createLadiBus`) instead of straight into the effects.
   */
  readonly bus?: 'ladi';
}

export const SOUNDS: Readonly<Record<SoundKind, SoundSpec>> = {
  burst: { priority: 5, gain: 1, refDistance: 25 },
  rocketWhistle: { priority: 4, gain: 0.45, refDistance: 6 },
  anarRoar: { priority: 3, gain: 0.6, refDistance: 4 },
  chakriWhine: { priority: 3, gain: 0.45, refDistance: 4 },
  // The loudest small cracker: driven into its own limiter, so it bangs
  // hard without clipping however many pops pile up.
  ladiPops: { priority: 3, gain: 10, refDistance: 6, bus: 'ladi' },
  phuljhariCrackle: { priority: 3, gain: 0.35, refDistance: 1.5 },
  fuseHiss: { priority: 1, gain: 0.25, refDistance: 1.5 },
  // Crackers elsewhere in town are the first to go when the budget is tight.
  distantShell: { priority: 1, gain: 0.6, refDistance: 1 },
  distantBomb: { priority: 0, gain: 0.5, refDistance: 1 },
  distantLadi: { priority: 0, gain: 0.5, refDistance: 1 },
  distantPop: { priority: 0, gain: 0.25, refDistance: 1 },
  distantWhistle: { priority: 0, gain: 0.2, refDistance: 1 },
  distantFountain: { priority: 0, gain: 0.3, refDistance: 1 },
  distantChakri: { priority: 0, gain: 0.22, refDistance: 1 },
};

/** Sustained sound a cracker makes while active; a ladi has none, only its pops. */
export const ACTIVE_SOUND: Readonly<Record<CrackerType, SoundKind | null>> = {
  phuljhari: 'phuljhariCrackle',
  anar: 'anarRoar',
  chakri: 'chakriWhine',
  rocket: 'rocketWhistle',
  ladi: null,
};

/**
 * A ladi's pops are played in batches: each `ladiPops` voice carries the
 * pops due within this many seconds of its first, so a ladi holds a voice
 * or two rather than one per banger, and each batch starts on its first
 * pop's event to stay in step with the bangs on screen.
 */
export const LADI_BATCH = 0.6;
/** The last pop of a batch rings this long before its voice ends, seconds. */
export const LADI_RING = 0.25;

/**
 * How loud each banger goes off, 0–1: the louder ones the chain rolled bang
 * hardest, most land somewhere in the middle, and now and then one is
 * nearly a dud.
 */
export const LADI_LEVELS = {
  loud: { min: 0.9, max: 1 },
  normal: { min: 0.4, max: 0.8 },
  // Scaled for the ladi's hot gain, so a dud still slips under its limiter.
  dud: { min: 0.03, max: 0.08 },
  dudChance: 0.1,
} as const;

export function ladiPopLevel(loud: boolean, random: () => number): number {
  const pick = (range: { readonly min: number; readonly max: number }) => range.min + random() * (range.max - range.min);
  if (loud) return pick(LADI_LEVELS.loud);
  return random() < LADI_LEVELS.dudChance ? pick(LADI_LEVELS.dud) : pick(LADI_LEVELS.normal);
}

/** Length of a burst's boom plus crackle tail, seconds. */
export const BURST_DURATION = 3.2;
export const DISTANT_POP_DURATION = 1.4;
export const DISTANT_BOMB_DURATION = 2.2;
export const DISTANT_SHELL_DURATION = 3;
/** Echo left ringing after a ladi's last pop, seconds. */
export const LADI_TAIL = 1.2;

/** Fade applied when a voice is cut short, seconds. */
export const STOP_FADE = 0.06;
