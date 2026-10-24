import type { CrackerSnapshot, EffectStats } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { DEFAULT_QUALITY, qualityProfile, type QualityProfile } from '../core/quality';
import { TUNING, type Tuning } from '../core/tuning';
import type { CrackerId, CrackerType, IgnitionRejection, PlacementRejection } from '../core/types';
import type { CrackerAdmission } from '../crackers/crackers';

/**
 * Capacity budget: unlimited supply, finite performance budget
 * (PRD → Simultaneous use).
 *
 * One place that knows every limit — placed props and lit crackers from
 * `TUNING.caps`, effects, particles, lights and voices from the quality
 * profile — and how much of each is in use. It gates new placement and
 * ignition (as the crackers' `CrackerAdmission`), reclaims abandoned unlit
 * props a few at a time, and publishes counters for the perf overlay.
 *
 * Already-accepted sequences are never cancelled: only unlit props are
 * reclaimed, and lowering quality only blocks new ignitions. Finished
 * effects are recycled by the effects engine's pools when their cracker
 * finishes; particles, lights and voices are enforced by their pools, and
 * this module only reports them. Renderer-free.
 */

/** The budgets the manager tracks, in overlay order. */
export const CAPACITY_RESOURCES = [
  'placedProps',
  'litCrackers',
  'activeEffects',
  'particles',
  'dynamicLights',
  'audioVoices',
] as const;
export type CapacityResource = (typeof CAPACITY_RESOURCES)[number];

export interface ResourceCounter {
  readonly used: number;
  readonly limit: number;
}

/** Plain-data counters for the debug/perf overlay. */
export interface CapacityStats {
  readonly resources: Readonly<Record<CapacityResource, ResourceCounter>>;
  /** Unlit props removed by the policy this session. */
  readonly reclaimedProps: number;
  readonly rejectedPlacements: number;
  readonly rejectedIgnitions: number;
}

/** Why the last request was refused, naming the budget that was full. */
export interface CapacityRejection {
  readonly kind: 'placement' | 'ignition';
  readonly type: CrackerType;
  readonly resource: CapacityResource;
  readonly used: number;
  readonly limit: number;
}

/** The slice of the crackers module the budget reads and reclaims through. */
export interface CapacityCrackers {
  /** Ground crackers not yet finished, oldest first. */
  list(): readonly CrackerSnapshot[];
  /** Crackers burning a fuse or active, the held phuljhari included. */
  readonly litCount: number;
  /** Remove an unlit ground cracker; false if unknown or already lit. */
  reclaim(id: CrackerId): boolean;
}

export interface CapacityOptions {
  /** Read lazily, so the crackers module may be built after the budget. */
  readonly crackers: () => CapacityCrackers;
  /** Subscribes to `qualityChanged` and `sessionReset`. */
  readonly bus?: GameEventBus;
  readonly quality?: QualityProfile;
  readonly tuning?: Tuning;
  /** Live effect counters, once the effects module is running. */
  readonly effects?: () => EffectStats;
  /** Audio voices currently playing. */
  readonly voices?: () => number;
}

interface MutableCounter {
  used: number;
  limit: number;
}

interface MutableStats {
  resources: Record<CapacityResource, MutableCounter>;
  reclaimedProps: number;
  rejectedPlacements: number;
  rejectedIgnitions: number;
}

const NO_EFFECTS: EffectStats = Object.freeze({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });

function isUnlit(cracker: CrackerSnapshot): boolean {
  return cracker.state === 'placed';
}

export class CapacityBudget implements CrackerAdmission {
  private readonly crackers: () => CapacityCrackers;
  private readonly tuning: Tuning;
  private readonly effects: () => EffectStats;
  private readonly voices: () => number;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly counters: MutableStats;
  private profile: QualityProfile;
  private rejection: CapacityRejection | null = null;

  constructor(options: CapacityOptions) {
    this.crackers = options.crackers;
    this.tuning = options.tuning ?? TUNING;
    this.effects = options.effects ?? (() => NO_EFFECTS);
    this.voices = options.voices ?? (() => 0);
    this.profile = options.quality ?? qualityProfile(DEFAULT_QUALITY);
    const resources = {} as Record<CapacityResource, MutableCounter>;
    for (const resource of CAPACITY_RESOURCES) resources[resource] = { used: 0, limit: 0 };
    this.counters = { resources, reclaimedProps: 0, rejectedPlacements: 0, rejectedIgnitions: 0 };
    const bus = options.bus;
    if (bus) {
      this.unsubscribes.push(
        bus.on('qualityChanged', ({ profile }) => this.applyQuality(profile)),
        bus.on('sessionReset', () => this.reset()),
      );
    }
  }

  /** Limit for each budget under the current profile. */
  limit(resource: CapacityResource): number {
    const { caps } = this.tuning;
    const profile = this.profile;
    switch (resource) {
      case 'placedProps':
        return caps.maxPlacedCrackers;
      case 'litCrackers':
        // Every lit cracker holds at most one effect at a time, so capping lit
        // crackers at the effect budget reserves an effect for each one.
        return Math.min(caps.maxLitCrackers, profile.maxActiveEffects);
      case 'activeEffects':
        return profile.maxActiveEffects;
      case 'particles':
        return profile.maxParticles;
      case 'dynamicLights':
        return profile.maxDynamicLights;
      case 'audioVoices':
        return profile.maxAudioVoices;
    }
  }

  /** Current use of each budget, with its limit; refreshed on every read. */
  get stats(): CapacityStats {
    const crackers = this.crackers();
    const effects = this.effects();
    const r = this.counters.resources;
    r.placedProps.used = crackers.list().length;
    r.litCrackers.used = crackers.litCount;
    r.activeEffects.used = effects.activeEffects;
    r.particles.used = effects.liveParticles;
    r.dynamicLights.used = effects.dynamicLights;
    r.audioVoices.used = this.voices();
    for (const resource of CAPACITY_RESOURCES) r[resource].limit = this.limit(resource);
    return this.counters;
  }

  /** The most recent capacity refusal, for feedback naming the full budget. */
  get lastRejection(): CapacityRejection | null {
    return this.rejection;
  }

  /**
   * Whether one more prop fits, counting an old unlit prop that placing
   * would reclaim. Read-only: the placement preview polls it every frame.
   */
  hasRoom(): boolean {
    const placed = this.crackers().list();
    return placed.length < this.limit('placedProps') || this.reclaimableWhenFull(placed) !== null;
  }

  admitPlacement(type: CrackerType): PlacementRejection | null {
    const crackers = this.crackers();
    const placed = crackers.list();
    const limit = this.limit('placedProps');
    if (placed.length < limit) return null;
    const victim = this.reclaimableWhenFull(placed);
    if (victim && this.reclaim(crackers, victim.id)) return null;
    this.counters.rejectedPlacements++;
    this.rejection = { kind: 'placement', type, resource: 'placedProps', used: placed.length, limit };
    return 'capacity';
  }

  admitIgnition(_id: CrackerId, type: CrackerType): IgnitionRejection | null {
    const lit = this.crackers().litCount;
    const limit = this.limit('litCrackers');
    if (lit < limit) return null;
    this.counters.rejectedIgnitions++;
    this.rejection = {
      kind: 'ignition',
      type,
      // Name the budget that actually binds, so tuning knows which to raise.
      resource: limit < this.tuning.caps.maxLitCrackers ? 'activeEffects' : 'litCrackers',
      used: lit,
      limit,
    };
    return 'capacity';
  }

  /** New limits apply to later requests; nothing already running is cut short. */
  applyQuality(profile: QualityProfile): void {
    this.profile = profile;
  }

  /**
   * Reclaim abandoned props: unlit for `unlitReclaimAfter`, oldest first,
   * at most `maxReclaimsPerStep` per call. Run after the crackers step.
   */
  update(_dt: number): void {
    const { unlitReclaimAfter, maxReclaimsPerStep } = this.tuning.caps;
    const crackers = this.crackers();
    const placed = crackers.list();
    let expired: CrackerId[] | null = null;
    for (let i = 0; i < placed.length; i++) {
      const cracker = placed[i]!;
      if (isUnlit(cracker) && cracker.stateTime >= unlitReclaimAfter) (expired ??= []).push(cracker.id);
    }
    if (!expired) return;
    const count = Math.min(expired.length, maxReclaimsPerStep);
    for (let i = 0; i < count; i++) this.reclaim(crackers, expired[i]!);
  }

  /** Fresh session: counters cleared; the crackers module drops its props. */
  reset(): void {
    this.counters.reclaimedProps = 0;
    this.counters.rejectedPlacements = 0;
    this.counters.rejectedIgnitions = 0;
    this.rejection = null;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Oldest unlit prop old enough to give up its slot to a new one. */
  private reclaimableWhenFull(placed: readonly CrackerSnapshot[]): CrackerSnapshot | null {
    const minAge = this.tuning.caps.reclaimWhenFullAfter;
    let oldest: CrackerSnapshot | null = null;
    for (let i = 0; i < placed.length; i++) {
      const cracker = placed[i]!;
      if (!isUnlit(cracker) || cracker.stateTime < minAge) continue;
      if (!oldest || cracker.stateTime > oldest.stateTime) oldest = cracker;
    }
    return oldest;
  }

  private reclaim(crackers: CapacityCrackers, id: CrackerId): boolean {
    if (!crackers.reclaim(id)) return false;
    this.counters.reclaimedProps++;
    return true;
  }
}
