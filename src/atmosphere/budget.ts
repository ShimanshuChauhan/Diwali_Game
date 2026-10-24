import type { QualityProfile } from '../core/quality';
import type { QualityLevel } from '../core/types';

/**
 * What the evening atmosphere may spend at each quality level. Derived from
 * the central `QualityProfile` so one setting drives everything; values are
 * placeholders until measured on the reference laptop.
 */
export interface AtmosphereBudget {
  readonly level: QualityLevel;
  /** Metres between bulbs on a string of fairy lights. */
  readonly bulbSpacing: number;
  /** Strings along house rooflines as well as balconies. */
  readonly rooflineLights: boolean;
  /** Akash kandils that also get a real point light; the rest only glow. */
  readonly lanternLights: number;
  /** Angular segments per rangoli ring. */
  readonly rangoliSegments: number;
  /** Stars on the sky dome. */
  readonly stars: number;
  /** Distant shells in the air at once; 0 turns distant fireworks off. */
  readonly maxDistantShells: number;
  readonly particlesPerShell: number;
  /** Mean seconds between distant launches. */
  readonly distantInterval: number;
}

const BUDGETS: Readonly<Record<QualityLevel, Omit<AtmosphereBudget, 'level'>>> = {
  low: {
    bulbSpacing: 0.7,
    rooflineLights: true,
    lanternLights: 0,
    rangoliSegments: 24,
    stars: 150,
    maxDistantShells: 2,
    particlesPerShell: 40,
    distantInterval: 2.5,
  },
  medium: {
    bulbSpacing: 0.45,
    rooflineLights: true,
    lanternLights: 2,
    rangoliSegments: 48,
    stars: 400,
    maxDistantShells: 4,
    particlesPerShell: 70,
    distantInterval: 1.5,
  },
  high: {
    bulbSpacing: 0.3,
    rooflineLights: true,
    lanternLights: 4,
    rangoliSegments: 64,
    stars: 1000,
    maxDistantShells: 6,
    particlesPerShell: 110,
    distantInterval: 1,
  },
};

/** Largest distant-firework particle count any budget can ask for. */
export const MAX_DISTANT_PARTICLES = Math.max(
  ...Object.values(BUDGETS).map((b) => b.maxDistantShells * (b.particlesPerShell + 1)),
);

export function atmosphereBudget(profile: QualityProfile): AtmosphereBudget {
  const budget = { level: profile.level, ...BUDGETS[profile.level] };
  return profile.ambientFireworks ? budget : { ...budget, maxDistantShells: 0 };
}
