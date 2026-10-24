import type { NeighbourSnapshot, NeighboursModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { TUNING, type Tuning } from '../core/tuning';
import type { ExclusionZone, NeighbourId, Vec3 } from '../core/types';

/**
 * What a neighbour is doing. `idle` and `chat` stand in place, `wander`
 * strolls inside the home area, `watch` and `cheer` are reactions to a
 * nearby firework. Nothing here is ever alarmed or hurt.
 */
export type NeighbourActivity = 'idle' | 'chat' | 'wander' | 'watch' | 'cheer';

/** Everything the scene needs to pose one neighbour. */
export interface NeighbourView extends NeighbourSnapshot {
  /** Facing in radians about +Y; 0 looks down -Z. */
  readonly yaw: number;
  /** Head tilt in radians; positive looks up. */
  readonly lookUp: number;
  readonly activity: NeighbourActivity;
  /** Seconds spent in the current activity. */
  readonly activityTime: number;
  /** Index into the scene's festive outfit palette. */
  readonly outfit: number;
}

/** Most neighbours in one gathering area, and in the whole street. */
export const MAX_PER_AREA = 3;
export const MAX_NEIGHBOURS = 8;

/** Placeholder behaviour tuning; times in seconds, distances in metres. */
export const NEIGHBOUR_BEHAVIOUR = {
  walkSpeed: 0.8,
  /** Radians per second a neighbour turns toward where it wants to face. */
  turnSpeed: 3,
  /** Range of time spent idling or chatting before choosing again. */
  idleTime: [3, 8] as const,
  /** Chance that a finished idle turns into a short wander. */
  wanderChance: 0.35,
  /** Wander targets stay within this fraction of the area's radius. */
  wanderReach: 0.7,
  watchTime: 3.5,
  cheerTime: 2.2,
  /** Chance that a reaction is a cheer rather than quiet watching. */
  cheerChance: 0.35,
  /** Minimum gap between any two cheers on the street, so cheers stay occasional. */
  cheerGap: 1.5,
  /** Highest head tilt when watching a burst overhead. */
  maxLookUp: 0.9,
} as const;

export interface NeighbourSpec {
  readonly id: NeighbourId;
  /** The gathering area the neighbour stays in. */
  readonly area: ExclusionZone;
  /** Starting spot; defaults to a place on a ring around the area's centre. */
  readonly start?: Vec3;
  readonly outfit?: number;
}

export interface NeighboursOptions {
  /** Static gathering areas; a roster is derived from them unless `roster` is given. */
  readonly areas: readonly ExclusionZone[];
  readonly roster?: readonly NeighbourSpec[];
  /** Reacts to `burst` and ground crackers' `crackerActive`, publishes `neighbourReacted`, resets on `sessionReset`. */
  readonly bus?: GameEventBus;
  readonly tuning?: Tuning;
  readonly random?: () => number;
}

type MutableView = { -readonly [K in keyof NeighbourView]: NeighbourView[K] };

interface Neighbour {
  readonly spec: NeighbourSpec;
  readonly start: Vec3;
  readonly position: { x: number; y: number; z: number };
  yaw: number;
  /** Yaw the neighbour is turning toward. */
  wantYaw: number;
  lookUp: number;
  wantLookUp: number;
  activity: NeighbourActivity;
  activityTime: number;
  /** How long the current activity lasts; wanders end on arrival instead. */
  activityLength: number;
  target: { x: number; z: number };
  /** Seconds until this neighbour may react again. */
  cooldown: number;
}

/**
 * One neighbour per metre of area radius (rounded, 1..`MAX_PER_AREA`),
 * capped at `MAX_NEIGHBOURS` overall, spread on a ring facing the centre.
 */
export function defaultRoster(areas: readonly ExclusionZone[]): NeighbourSpec[] {
  const roster: NeighbourSpec[] = [];
  for (const area of areas) {
    const count = Math.min(MAX_PER_AREA, Math.max(1, Math.round(area.radius)));
    const ring = count === 1 ? 0 : area.radius * 0.45;
    for (let i = 0; i < count && roster.length < MAX_NEIGHBOURS; i++) {
      const angle = (i / count) * Math.PI * 2 + area.radius;
      roster.push({
        id: `${area.id}.${i}`,
        area,
        start: { x: area.centre.x + Math.sin(angle) * ring, y: area.centre.y, z: area.centre.z + Math.cos(angle) * ring },
        outfit: roster.length,
      });
    }
  }
  return roster;
}

/** Yaw that faces from `from` toward `to` on the ground plane (0 looks down -Z). */
export function yawToward(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function approach(value: number, goal: number, step: number): number {
  if (Math.abs(goal - value) <= step) return goal;
  return value + Math.sign(goal - value) * step;
}

/**
 * The ambient neighbours module: a handful of simple celebrants who idle,
 * chat, take short wanders inside their gathering area, and turn to watch
 * (sometimes cheer at) fireworks within `tuning.neighbours.reactionRadius`.
 *
 * Reactions are bounded twice over: each neighbour waits
 * `reactionCooldown` between reactions, and the whole street cheers at most
 * once per `NEIGHBOUR_BEHAVIOUR.cheerGap` (a blocked cheer becomes a watch).
 * Positions are published through `positions()` for placement exclusion.
 * Renderer-free and deterministic for a given `random`.
 */
export class Neighbours implements NeighboursModule {
  private readonly neighbours: Neighbour[];
  private readonly byId = new Map<NeighbourId, Neighbour>();
  private readonly tuning: Tuning;
  private readonly random: () => number;
  private readonly bus: GameEventBus | undefined;
  private readonly unsubscribe: Unsubscribe[] = [];
  private readonly snapshots: NeighbourSnapshot[];
  private readonly viewCache: MutableView[];
  private cheerWait = 0;

  constructor(options: NeighboursOptions) {
    this.tuning = options.tuning ?? TUNING;
    this.random = options.random ?? Math.random;
    this.bus = options.bus;
    const roster = (options.roster ?? defaultRoster(options.areas)).slice(0, MAX_NEIGHBOURS);
    this.neighbours = roster.map((spec, i) => {
      const start = spec.start ?? spec.area.centre;
      const neighbour: Neighbour = {
        spec: spec.outfit === undefined ? { ...spec, outfit: i } : spec,
        start,
        position: { ...start },
        yaw: 0,
        wantYaw: 0,
        lookUp: 0,
        wantLookUp: 0,
        activity: 'idle',
        activityTime: 0,
        activityLength: 0,
        target: { x: start.x, z: start.z },
        cooldown: 0,
      };
      this.byId.set(spec.id, neighbour);
      return neighbour;
    });
    // Positions are mutated in place, so the snapshot list is built once.
    this.snapshots = this.neighbours.map((n) => ({ id: n.spec.id, position: n.position }));
    this.viewCache = this.neighbours.map((n) => ({
      id: n.spec.id,
      position: n.position,
      yaw: 0,
      lookUp: 0,
      activity: 'idle',
      activityTime: 0,
      outfit: n.spec.outfit ?? 0,
    }));

    const bus = options.bus;
    if (bus) {
      this.unsubscribe.push(
        bus.on('sessionReset', () => this.reset()),
        bus.on('burst', ({ position }) => this.react(position)),
        bus.on('crackerActive', ({ type, position }) => {
          // Fountains and wheels draw a crowd; a rocket's launch waits for its burst
          // and the handheld phuljhari is the player's own.
          if (type === 'anar' || type === 'chakri') this.react(position);
        }),
      );
    }
    this.reset();
  }

  /** Current positions, used as placement exclusions. Live objects; do not keep. */
  positions(): readonly NeighbourSnapshot[] {
    return this.snapshots;
  }

  /** Pose data for every neighbour, for the scene. Refreshed in place by each call; do not keep. */
  views(): readonly NeighbourView[] {
    for (let i = 0; i < this.neighbours.length; i++) {
      const n = this.neighbours[i]!;
      const out = this.viewCache[i]!;
      out.yaw = n.yaw;
      out.lookUp = n.lookUp;
      out.activity = n.activity;
      out.activityTime = n.activityTime;
    }
    return this.viewCache;
  }

  /** A keepable copy of one neighbour's pose. */
  get(id: NeighbourId): NeighbourView | undefined {
    const n = this.byId.get(id);
    if (!n) return undefined;
    return {
      id: n.spec.id,
      position: { ...n.position },
      yaw: n.yaw,
      lookUp: n.lookUp,
      activity: n.activity,
      activityTime: n.activityTime,
      outfit: n.spec.outfit ?? 0,
    };
  }

  /** Where a neighbour stands, e.g. so the audio engine can place a cheer. */
  positionOf(id: NeighbourId): Vec3 | undefined {
    return this.byId.get(id)?.position;
  }

  /**
   * A firework went off at `source`. Neighbours within the reaction radius
   * (measured on the ground, so overhead bursts count) and off cooldown turn
   * to watch, and occasionally cheer. Returns how many reacted.
   */
  react(source: Vec3): number {
    const { reactionRadius, reactionCooldown } = this.tuning.neighbours;
    const b = NEIGHBOUR_BEHAVIOUR;
    let reacted = 0;
    for (const n of this.neighbours) {
      if (n.cooldown > 0) continue;
      const dx = source.x - n.position.x;
      const dz = source.z - n.position.z;
      const ground = Math.hypot(dx, dz);
      if (ground > reactionRadius) continue;

      const cheer = this.cheerWait <= 0 && this.random() < b.cheerChance;
      if (cheer) this.cheerWait = b.cheerGap;
      n.cooldown = reactionCooldown;
      n.wantYaw = ground > 1e-6 ? yawToward(n.position, source) : n.yaw;
      n.wantLookUp = Math.min(b.maxLookUp, Math.max(0, Math.atan2(source.y - n.position.y - 1.5, ground)));
      this.begin(n, cheer ? 'cheer' : 'watch', cheer ? b.cheerTime : b.watchTime);
      reacted++;
      this.bus?.emit('neighbourReacted', { id: n.spec.id, reaction: cheer ? 'cheer' : 'watch' });
    }
    return reacted;
  }

  update(dt: number): void {
    const b = NEIGHBOUR_BEHAVIOUR;
    this.cheerWait = Math.max(0, this.cheerWait - dt);
    for (const n of this.neighbours) {
      n.cooldown = Math.max(0, n.cooldown - dt);
      n.activityTime += dt;

      if (n.activity === 'wander') {
        const dx = n.target.x - n.position.x;
        const dz = n.target.z - n.position.z;
        const distance = Math.hypot(dx, dz);
        const step = b.walkSpeed * dt;
        if (distance <= step) {
          n.position.x = n.target.x;
          n.position.z = n.target.z;
          this.settle(n);
        } else {
          n.position.x += (dx / distance) * step;
          n.position.z += (dz / distance) * step;
          n.wantYaw = yawToward(n.position, n.target);
        }
      } else if (n.activityTime >= n.activityLength) {
        if ((n.activity === 'idle' || n.activity === 'chat') && this.random() < b.wanderChance) this.wander(n);
        else this.settle(n);
      }

      n.yaw += approach(0, angleDelta(n.yaw, n.wantYaw), b.turnSpeed * dt);
      n.lookUp = approach(n.lookUp, n.wantLookUp, b.turnSpeed * 0.5 * dt);
    }
  }

  /** Fresh session: everyone back at their starting spot, no reactions pending. */
  reset(): void {
    this.cheerWait = 0;
    for (const n of this.neighbours) {
      n.position.x = n.start.x;
      n.position.y = n.start.y;
      n.position.z = n.start.z;
      n.target.x = n.start.x;
      n.target.z = n.start.z;
      n.yaw = n.wantYaw = this.homeYaw(n);
      n.lookUp = n.wantLookUp = 0;
      n.cooldown = 0;
      this.settle(n);
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  /** Stand and idle, or chat facing the group when sharing the area. */
  private settle(n: Neighbour): void {
    const [min, max] = NEIGHBOUR_BEHAVIOUR.idleTime;
    const company = this.neighbours.some((o) => o !== n && o.spec.area.id === n.spec.area.id);
    n.wantLookUp = 0;
    if (company) n.wantYaw = this.homeYaw(n);
    this.begin(n, company ? 'chat' : 'idle', min + this.random() * (max - min));
  }

  /** A short stroll to a random spot inside the home area. */
  private wander(n: Neighbour): void {
    const { area } = n.spec;
    const angle = this.random() * Math.PI * 2;
    const reach = Math.sqrt(this.random()) * area.radius * NEIGHBOUR_BEHAVIOUR.wanderReach;
    n.target.x = area.centre.x + Math.sin(angle) * reach;
    n.target.z = area.centre.z + Math.cos(angle) * reach;
    n.wantLookUp = 0;
    this.begin(n, 'wander', Infinity);
  }

  private begin(n: Neighbour, activity: NeighbourActivity, length: number): void {
    n.activity = activity;
    n.activityTime = 0;
    n.activityLength = length;
  }

  /** Face the area's centre, or keep facing when standing on it. */
  private homeYaw(n: Neighbour): number {
    const c = n.spec.area.centre;
    if (Math.hypot(c.x - n.position.x, c.z - n.position.z) < 1e-3) return n.yaw;
    return yawToward(n.position, c);
  }
}
