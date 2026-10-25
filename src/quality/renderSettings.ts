import type { QualityProfile } from '../core/quality';
import type { QualityLevel } from '../core/types';

/** What the renderer applies for a profile on a given display. */
export interface RenderSettings {
  /** Passed to `renderer.setPixelRatio`: capped device ratio × render scale. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Bloom post pass; Medium and High only. */
  readonly bloom: boolean;
  /** UnrealBloom settings while `bloom` is on. */
  readonly bloomStyle: BloomStyle;
}

export interface BloomStyle {
  readonly strength: number;
  readonly radius: number;
  /** Linear HDR brightness above which pixels glow. */
  readonly threshold: number;
}

/**
 * Bloom catches the HDR flames, decorations and sparks pushed above 1.
 * High spreads it wider and a little stronger, so bursts read as glowing.
 */
export const BLOOM_STYLES: Readonly<Record<QualityLevel, BloomStyle>> = {
  low: { strength: 0, radius: 0, threshold: 1 },
  medium: { strength: 0.6, radius: 0.4, threshold: 0.9 },
  high: { strength: 0.75, radius: 0.6, threshold: 0.88 },
};

/** Never render below a quarter of CSS resolution, whatever the profile says. */
const MIN_PIXEL_RATIO = 0.5;

/** Renderer-facing settings for a profile; pure so it can be tested headless. */
export function renderSettings(profile: QualityProfile, devicePixelRatio: number): RenderSettings {
  const device = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const pixelRatio = Math.max(MIN_PIXEL_RATIO, Math.min(device, profile.maxPixelRatio) * profile.renderScale);
  return {
    pixelRatio,
    shadows: profile.shadows,
    shadowMapSize: profile.shadowMapSize,
    bloom: profile.postEffects,
    bloomStyle: BLOOM_STYLES[profile.level],
  };
}
