import type { QualityLevel } from './types';

/**
 * Central quality profile. The quality module picks one; renderer, effects
 * and audio read their budgets from it. Values are placeholders until
 * measured on the reference laptop (PRD → Performance checks).
 */
export interface QualityProfile {
  readonly level: QualityLevel;
  /** Upper bound on devicePixelRatio passed to the renderer. */
  readonly maxPixelRatio: number;
  /** Multiplier on the drawing-buffer size, in (0, 1]. */
  readonly renderScale: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Total live particles across every effect. */
  readonly maxParticles: number;
  /** Concurrent firework effects (bursts, fountains, trails). */
  readonly maxActiveEffects: number;
  /** Short-lived point lights for flashes, beyond the static scene lights. */
  readonly maxDynamicLights: number;
  readonly maxAudioVoices: number;
  /** Bloom/glow and other supporting post effects. */
  readonly postEffects: boolean;
  /** Distant ambient fireworks in the sky. */
  readonly ambientFireworks: boolean;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = {
  low: {
    level: 'low',
    maxPixelRatio: 1,
    renderScale: 0.75,
    shadows: false,
    shadowMapSize: 512,
    maxParticles: 4000,
    maxActiveEffects: 6,
    maxDynamicLights: 2,
    maxAudioVoices: 12,
    postEffects: false,
    ambientFireworks: true,
  },
  medium: {
    level: 'medium',
    maxPixelRatio: 1.5,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 1024,
    maxParticles: 10000,
    maxActiveEffects: 10,
    maxDynamicLights: 4,
    maxAudioVoices: 20,
    postEffects: true,
    ambientFireworks: true,
  },
  high: {
    level: 'high',
    maxPixelRatio: 2,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 2048,
    maxParticles: 20000,
    maxActiveEffects: 16,
    maxDynamicLights: 8,
    maxAudioVoices: 32,
    postEffects: true,
    ambientFireworks: true,
  },
};

export const DEFAULT_QUALITY: QualityLevel = 'medium';

export function qualityProfile(level: QualityLevel): QualityProfile {
  return QUALITY_PROFILES[level];
}
