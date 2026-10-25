import type { EffectsModule } from '../core/contracts';
import type { GameEventBus, GameEvents } from '../core/events';
import type { Unsubscribe } from '../core/eventBus';
import { ladiFuseTip, ladiPoint } from '../core/ladi';
import { QUALITY_LEVELS, QUALITY_PROFILES, qualityProfile, DEFAULT_QUALITY, type QualityProfile } from '../core/quality';
import { TUNING, type Tuning } from '../core/tuning';
import { rocketFlightAt, type MutableVec3 } from '../core/rocketFlight';
import type { CrackerId, CrackerType, RocketFlight, Vec3 } from '../core/types';
import { FireworksEngine, NO_EFFECT, type EffectHandle, type EngineStats } from './fireworksEngine';
import {
  ANAR_PALETTES,
  BURST_LOOKS,
  CHAKRI_PALETTES,
  FOUNTAIN,
  FUSE,
  LADI_BURN,
  LADI_POP,
  ROCKET_TRAIL,
  SPARKLER,
  SPINNER,
  type EmitterPreset,
} from './presets';

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

/** Where a spinning ground cracker's wheel is and how far it has turned. */
export interface SpinnerPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rotation about +Y, radians. */
  readonly angle: number;
}

/** The fuse sparkle sits at the top of each ground cracker's model. */
const FUSE_HEIGHT: Readonly<Record<CrackerType, number>> = { phuljhari: 0, anar: 0.27, chakri: 0.06, rocket: 0.12, ladi: 0 };

/** The anar's fountain leaves the mouth of its pot, not the ground. */
const ACTIVE_HEIGHT: Readonly<Record<CrackerType, number>> = { phuljhari: 0, anar: 0.26, chakri: 0, rocket: 0, ladi: 0 };

/** Stream preset started when each ground/held cracker becomes active. */
const ACTIVE_PRESETS: Readonly<Record<CrackerType, EmitterPreset>> = {
  phuljhari: SPARKLER,
  anar: FOUNTAIN,
  chakri: SPINNER,
  rocket: ROCKET_TRAIL,
  ladi: LADI_BURN,
};

/** Palettes ground crackers pick from, one per cracker. */
const PALETTES: Partial<Record<CrackerType, readonly (readonly number[])[]>> = {
  anar: ANAR_PALETTES,
  chakri: CHAKRI_PALETTES,
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
  private readonly random: () => number;
  private readonly spinners = new Set<CrackerId>();
  /** Rockets in flight: their path, launch point and time since launch. */
  private readonly flights = new Map<CrackerId, { flight: RocketFlight; origin: Vec3; time: number }>();
  /** Ladi fuses burning in from their tip to the string: from, to, seconds burnt. */
  private readonly ladiFuses = new Map<CrackerId, { from: Vec3; to: Vec3; time: number }>();
  private readonly flightNow: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly flightNext: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(bus: GameEventBus | null, options: FireworksEffectsOptions = {}) {
    this.tuning = options.tuning ?? TUNING;
    this.handPosition = options.handPosition ?? null;
    this.random = options.random ?? Math.random;
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
      burst: BURST_LOOKS[profile.level],
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
    this.steerRockets(dt);
    this.burnLadiFuses(dt);
    this.engine.update(dt);
  }

  /** Walk each ladi's fuse sparkle from the tip in to the first banger as it burns. */
  private burnLadiFuses(dt: number): void {
    const fuse = this.tuning.crackers.fuse.ladi;
    for (const [id, burn] of this.ladiFuses) {
      const handle = this.byCracker.get(id);
      if (handle === undefined) continue;
      burn.time += dt;
      const u = fuse > 0 ? Math.min(1, burn.time / fuse) : 1;
      const { from, to } = burn;
      this.engine.moveEmitter(handle, from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u, from.z + (to.z - from.z) * u);
    }
  }

  /**
   * Put each rocket's trail where its flight is now and aim it at where the
   * flight will be after this step; the engine then carries it there, and
   * the sparks it sheds inherit that motion.
   */
  private steerRockets(dt: number): void {
    const now = this.flightNow;
    const next = this.flightNext;
    for (const [id, rocket] of this.flights) {
      const handle = this.byCracker.get(id);
      if (handle === undefined) continue;
      rocketFlightAt(rocket.flight, rocket.time, now);
      rocketFlightAt(rocket.flight, rocket.time + dt, next);
      const { origin } = rocket;
      this.engine.moveEmitter(handle, origin.x + now.x, origin.y + now.y, origin.z + now.z);
      this.engine.setEmitterVelocity(handle, (next.x - now.x) / dt, (next.y - now.y) / dt, (next.z - now.z) / dt);
      rocket.time += dt;
    }
  }

  reset(): void {
    this.byCracker.clear();
    this.inHand.clear();
    this.spinners.clear();
    this.flights.clear();
    this.ladiFuses.clear();
    this.engine.reset();
  }

  /** Stream emitter for a cracker, e.g. so a held phuljhari can follow the hand. */
  handleFor(id: CrackerId): EffectHandle {
    const handle = this.byCracker.get(id);
    return handle !== undefined && this.engine.isAlive(handle) ? handle : NO_EFFECT;
  }

  /**
   * Where a burning chakri's wheel is and its spin, so its model can turn
   * and skid with the sparks; null once it stops or for other crackers.
   */
  spinnerPose(id: CrackerId): SpinnerPose | null {
    if (!this.spinners.has(id)) return null;
    const handle = this.byCracker.get(id);
    if (handle === undefined) return null;
    const position = this.engine.emitterPosition(handle);
    const angle = this.engine.emitterSpin(handle);
    if (!position || angle === null) return null;
    return { x: position.x, y: position.y, z: position.z, angle };
  }

  /** Stop listening to the bus. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  // ── event handlers ─────────────────────────────────────────────────────

  onFuseLit({ id, type, position, heading }: GameEvents['fuseLit']): void {
    this.stopCracker(id);
    // A ladi is lit at the tip of the fuse sticking out of its string.
    const ladi = type === 'ladi' ? ladiFuseTip(position, heading ?? 0, { x: 0, y: 0, z: 0 }) : null;
    const at = ladi ?? { x: position.x, y: position.y + FUSE_HEIGHT[type], z: position.z };
    const handle = this.engine.startStream(FUSE, at.x, at.y, at.z);
    if (handle === NO_EFFECT) return;
    this.track(id, type, handle);
    if (ladi) this.ladiFuses.set(id, { from: ladi, to: ladiPoint(position, heading ?? 0, 0, 0, { x: 0, y: 0, z: 0 }), time: 0 });
  }

  onCrackerActive({ id, type, position, flight, ladi }: GameEvents['crackerActive']): void {
    this.stopCracker(id);
    // Each anar and chakri burns in one of a few palettes.
    const palettes = PALETTES[type];
    const colours = palettes ? palettes[Math.floor(this.random() * palettes.length)] : undefined;
    // A ladi's fire starts where its fuse meets the string.
    const start = ladi ? ladiPoint(position, ladi.heading, 0, 0, { x: 0, y: 0, z: 0 }) : position;
    const y = start.y + ACTIVE_HEIGHT[type];
    const handle = this.engine.startStream(ACTIVE_PRESETS[type], start.x, y, start.z, colours);
    if (handle === NO_EFFECT) return;
    this.track(id, type, handle);
    if (type === 'chakri') this.spinners.add(id);
    if (type === 'rocket') {
      const { rocketApexHeight, activeDuration } = this.tuning.crackers;
      // Without a rolled flight (e.g. the effects demo), climb straight up at the nominal pace.
      const path = flight ?? { ascent: activeDuration.rocket, apexHeight: rocketApexHeight, drift: { x: 0, z: 0 } };
      this.flights.set(id, { flight: path, origin: { x: position.x, y: position.y, z: position.z }, time: 0 });
    }
  }

  /** A banger going off on a burning ladi; nothing if its effect was refused. */
  onLadiPop({ id, position, loud }: GameEvents['ladiPop']): void {
    const handle = this.byCracker.get(id);
    if (handle === undefined) return;
    this.engine.pop(handle, position.x, position.y, position.z, LADI_POP, loud);
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
    this.spinners.delete(id);
    this.flights.delete(id);
    this.ladiFuses.delete(id);
  }

  private track(id: CrackerId, type: CrackerType, handle: EffectHandle): void {
    this.byCracker.set(id, handle);
    if (type === 'phuljhari') this.inHand.add(id);
  }

  private subscribe(bus: GameEventBus): void {
    this.unsubscribes.push(
      bus.on('fuseLit', (event) => this.onFuseLit(event)),
      bus.on('crackerActive', (event) => this.onCrackerActive(event)),
      bus.on('ladiPop', (event) => this.onLadiPop(event)),
      bus.on('burst', (event) => this.onBurst(event)),
      bus.on('crackerFinished', (event) => this.onCrackerFinished(event)),
      bus.on('qualityChanged', ({ profile }) => this.applyQuality(profile)),
      bus.on('sessionReset', () => this.reset()),
    );
  }
}
