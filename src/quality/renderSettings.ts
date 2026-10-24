import type { QualityProfile } from '../core/quality';

/** What the renderer applies for a profile on a given display. */
export interface RenderSettings {
  /** Passed to `renderer.setPixelRatio`: capped device ratio × render scale. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Bloom post pass; Medium and High only. */
  readonly bloom: boolean;
}

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
  };
}
