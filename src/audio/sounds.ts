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
  | 'burst'
  | 'cheer'
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
}

export const SOUNDS: Readonly<Record<SoundKind, SoundSpec>> = {
  burst: { priority: 5, gain: 1, refDistance: 25 },
  rocketWhistle: { priority: 4, gain: 0.45, refDistance: 6 },
  anarRoar: { priority: 3, gain: 0.6, refDistance: 4 },
  chakriWhine: { priority: 3, gain: 0.45, refDistance: 4 },
  phuljhariCrackle: { priority: 3, gain: 0.35, refDistance: 1.5 },
  cheer: { priority: 2, gain: 0.4, refDistance: 5 },
  fuseHiss: { priority: 1, gain: 0.25, refDistance: 1.5 },
  // Crackers elsewhere in town are the first to go when the budget is tight.
  distantShell: { priority: 1, gain: 0.6, refDistance: 1 },
  distantBomb: { priority: 0, gain: 0.5, refDistance: 1 },
  distantLadi: { priority: 0, gain: 0.32, refDistance: 1 },
  distantPop: { priority: 0, gain: 0.25, refDistance: 1 },
  distantWhistle: { priority: 0, gain: 0.2, refDistance: 1 },
  distantFountain: { priority: 0, gain: 0.3, refDistance: 1 },
  distantChakri: { priority: 0, gain: 0.22, refDistance: 1 },
};

/** Sustained sound a cracker makes while active. */
export const ACTIVE_SOUND: Readonly<Record<CrackerType, SoundKind>> = {
  phuljhari: 'phuljhariCrackle',
  anar: 'anarRoar',
  chakri: 'chakriWhine',
  rocket: 'rocketWhistle',
};

/** Length of a burst's boom plus crackle tail, seconds. */
export const BURST_DURATION = 3.2;
export const CHEER_DURATION = 2.2;
export const DISTANT_POP_DURATION = 1.4;
export const DISTANT_BOMB_DURATION = 2.2;
export const DISTANT_SHELL_DURATION = 3;
/** Echo left ringing after a ladi's last pop, seconds. */
export const LADI_TAIL = 1.2;

/** Fade applied when a voice is cut short, seconds. */
export const STOP_FADE = 0.06;
