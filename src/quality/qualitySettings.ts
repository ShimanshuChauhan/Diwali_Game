import type { QualityModule } from '../core/contracts';
import type { GameEventBus } from '../core/events';
import { DEFAULT_QUALITY, QUALITY_LEVELS, qualityProfile, type QualityProfile } from '../core/quality';
import type { QualityLevel } from '../core/types';

/** `localStorage` key holding the player's last chosen level. */
export const QUALITY_STORAGE_KEY = 'diwali.quality';

/** The slice of `Storage` the setting reads and writes. */
export type QualityStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function isQualityLevel(value: unknown): value is QualityLevel {
  return typeof value === 'string' && (QUALITY_LEVELS as readonly string[]).includes(value);
}

export interface InitialQualitySources {
  /** `location.search`; `?quality=low|medium|high` wins for this visit. */
  readonly search?: string;
  readonly storage?: QualityStorage | null;
}

/**
 * The level to start on: URL override, then the stored choice, then the
 * default. Storage can throw (private windows, blocked site data), so a
 * failed read just falls through.
 */
export function initialQualityLevel(sources: InitialQualitySources = {}): QualityLevel {
  const fromUrl = new URLSearchParams(sources.search ?? '').get('quality');
  if (isQualityLevel(fromUrl)) return fromUrl;
  try {
    const stored = sources.storage?.getItem(QUALITY_STORAGE_KEY);
    if (isQualityLevel(stored)) return stored;
  } catch {
    // Unreadable storage: use the default.
  }
  return DEFAULT_QUALITY;
}

export interface QualitySettingsOptions {
  /** Receives `qualityChanged` on every switch. */
  readonly bus: GameEventBus;
  readonly level?: QualityLevel;
  /** Remembers the choice across visits; optional and best-effort. */
  readonly storage?: QualityStorage | null;
}

/**
 * The central quality profile (PRD → Quality). Owns the current
 * Low/Medium/High profile and announces switches on the bus; renderer,
 * effects, capacity, atmosphere, diyas and audio each follow
 * `qualityChanged` at runtime, so switching never needs a reload.
 */
export class QualitySettings implements QualityModule {
  private readonly bus: GameEventBus;
  private readonly storage: QualityStorage | null;
  private current: QualityProfile;

  constructor(options: QualitySettingsOptions) {
    this.bus = options.bus;
    this.storage = options.storage ?? null;
    this.current = qualityProfile(options.level ?? DEFAULT_QUALITY);
  }

  get profile(): QualityProfile {
    return this.current;
  }

  get level(): QualityLevel {
    return this.current.level;
  }

  /** Switch profiles; a no-op (no event) when the level is unchanged. */
  setLevel(level: QualityLevel): void {
    if (level === this.current.level) return;
    this.current = qualityProfile(level);
    try {
      this.storage?.setItem(QUALITY_STORAGE_KEY, level);
    } catch {
      // Not remembered across visits; the switch itself still applies.
    }
    this.bus.emit('qualityChanged', { profile: this.current });
  }
}
