import type { EffectsModule } from '../core/contracts';
import type { GameEventBus, GameEvents } from '../core/events';
import type { Unsubscribe } from '../core/eventBus';
import { QUALITY_LEVELS, QUALITY_PROFILES, qualityProfile, DEFAULT_QUALITY, type QualityProfile } from '../core/quality';
import { TUNING, type Tuning } from '../core/tuning';
import type { CrackerId, CrackerType, Vec3 } from '../core/types';
import { FireworksEngine, NO_EFFECT, type EffectHandle, type EngineStats } from './fireworksEngine';
import { FOUNTAIN, FUSE, ROCKET_TRAIL, SPARKLER, SPINNER, type EmitterPreset } from './presets';

/**
 * Effects module: turns cracker events into pooled particles, trails and
 * flashes, and enforces the quality profile's effect budgets.
 *
 * Renderer-free; `EffectsRenderer` draws `engine` each frame.
 */

export interface FireworksEffectsOptions {
  readonly tuning?: Tuning;
  readonly quality?: QualityProfile;
  readonly random?: () => number;
  /** Where the held phuljhari is; its fuse and sparks follow it every step. */
  readonly handPosition?: () => Vec3;
}

/** The fuse sparkle sits a little above a ground cracker's base. */
const FUSE_HEIGHT = 0.12;

/** Stream preset started when each ground/held cracker becomes active. */
const ACTIVE_PRESETS: Readonly<Record<CrackerType, EmitterPreset>> = {
  phuljhari: SPARKLER,
  anar: FOUNTAIN,
  chakri: SPINNER,
  rocket: ROCKET_TRAIL,
};

/** Preset counts are authored for Medium; scale by particle budget, within limits. */
export function countScaleFor(profile: QualityProfile): number {
  const scale = profile.maxParticles / QUALITY_PROFILES.medium.maxParticles;
  return Math.min(1.5, Math.max(0.5, scale));
}

function maxOver(key: 'maxParticles' | 'maxActiveEffects' | 'maxDynamicLights'): number {
  return Math.max(...QUALITY_LEVELS.map((level) => QUALITY_PROFILES[level][key]));
}

export class FireworksEffects implements EffectsModule {
  /**
   * Storage is sized for the highest profile once, so switching quality never
   * reallocates; the active profile only lowers the limits.
   */
  readonly engine: FireworksEngine;

  private readonly tuning: Tuning;
  private readonly byCracker = new Map<CrackerId, EffectHandle>();
  /** Effects that track the hand: the held phuljhari's fuse and sparks. */
  private readonly inHand = new Set<CrackerId>();
  private readonly handPosition: (() => Vec3) | null;
  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(bus: GameEventBus | null, options: FireworksEffectsOptions = {}) {
    this.tuning = options.tuning ?? TUNING;
    this.handPosition = options.handPosition ?? null;
    this.engine = new FireworksEngine({
      particleCapacity: maxOver('maxParticles'),
      // Each lit cracker may need a stream and, for rockets, a burst.
      emitterCapacity: maxOver('maxActiveEffects') * 2,
      flashCapacity: maxOver('maxDynamicLights'),
      random: options.random,
    });
    this.applyQuality(options.quality ?? qualityProfile(DEFAULT_QUALITY));
    if (bus) this.subscribe(bus);
  }

  get stats(): EngineStats {
    return this.engine.stats;
  }

  applyQuality(profile: QualityProfile): void {
    this.engine.applyBudget({
      maxParticles: profile.maxParticles,
      maxActiveEffects: profile.maxActiveEffects,
      maxDynamicLights: profile.maxDynamicLights,
      countScale: countScaleFor(profile),
    });
  }

  /** Camera position, so outline bursts turn to face the player. */
  setViewpoint(position: Vec3): void {
    this.engine.setViewpoint(position.x, position.y, position.z);
  }

  update(dt: number): void {
    if (this.handPosition && this.inHand.size > 0) {
      const hand = this.handPosition();
      for (const id of this.inHand) {
        const handle = this.byCracker.get(id);
        if (handle !== undefined) this.engine.moveEmitter(handle, hand.x, hand.y, hand.z);
      }
    }
    this.engine.update(dt);
  }

  reset(): void {
    this.byCracker.clear();
    this.inHand.clear();
    this.engine.reset();
  }

  /** Stream emitter for a cracker, e.g. so a held phuljhari can follow the hand. */
  handleFor(id: CrackerId): EffectHandle {
    const handle = this.byCracker.get(id);
    return handle !== undefined && this.engine.isAlive(handle) ? handle : NO_EFFECT;
  }

  /** Stop listening to the bus. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  // ── event handlers ─────────────────────────────────────────────────────

  onFuseLit({ id, type, position }: GameEvents['fuseLit']): void {
    this.stopCracker(id);
    const lift = type === 'phuljhari' ? 0 : FUSE_HEIGHT;
    const handle = this.engine.startStream(FUSE, position.x, position.y + lift, position.z);
    if (handle === NO_EFFECT) return;
    this.track(id, type, handle);
  }

  onCrackerActive({ id, type, position }: GameEvents['crackerActive']): void {
    this.stopCracker(id);
    const handle = this.engine.startStream(ACTIVE_PRESETS[type], position.x, position.y, position.z);
    if (handle === NO_EFFECT) return;
    this.track(id, type, handle);
    if (type === 'rocket') {
      const { rocketApexHeight, activeDuration } = this.tuning.crackers;
      this.engine.setEmitterVelocity(handle, 0, rocketApexHeight / activeDuration.rocket, 0);
    }
  }

  onBurst({ id, position, pattern, colours }: GameEvents['burst']): void {
    this.stopCracker(id);
    this.engine.burst(position.x, position.y, position.z, pattern, colours);
  }

  onCrackerFinished({ id }: GameEvents['crackerFinished']): void {
    this.stopCracker(id);
  }

  private stopCracker(id: CrackerId): void {
    const handle = this.byCracker.get(id);
    if (handle === undefined) return;
    this.engine.stopEmitter(handle);
    this.byCracker.delete(id);
    this.inHand.delete(id);
  }

  private track(id: CrackerId, type: CrackerType, handle: EffectHandle): void {
    this.byCracker.set(id, handle);
    if (type === 'phuljhari') this.inHand.add(id);
  }

  private subscribe(bus: GameEventBus): void {
    this.unsubscribes.push(
      bus.on('fuseLit', (event) => this.onFuseLit(event)),
      bus.on('crackerActive', (event) => this.onCrackerActive(event)),
      bus.on('burst', (event) => this.onBurst(event)),
      bus.on('crackerFinished', (event) => this.onCrackerFinished(event)),
      bus.on('qualityChanged', ({ profile }) => this.applyQuality(profile)),
      bus.on('sessionReset', () => this.reset()),
    );
  }
}
