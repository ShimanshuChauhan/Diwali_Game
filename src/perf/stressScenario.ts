import type { HeldItem, IgniteResult, PlacementRequest, PlacementResult, PlaceResult } from '../core/contracts';
import type { CrackerId, CrackerType, Vec3 } from '../core/types';

/** The slice of the crackers module the scenario drives. */
export interface StressCrackers {
  readonly held: HeldItem | null;
  select(type: CrackerType): void;
  place(preview: { readonly type: CrackerType; readonly position: Vec3 }): PlaceResult;
  ignite(id: CrackerId): IgniteResult;
  igniteHeld(): IgniteResult;
  get(id: CrackerId): { readonly state: string } | undefined;
}

export interface StressScenarioOptions {
  readonly crackers: StressCrackers;
  /** Placement rules, so the scenario only places where a player could. */
  readonly validatePlacement: (request: PlacementRequest) => PlacementResult;
  /** Candidate ground points for anar, chakri and ladi, tried in turn. */
  readonly groundSites: readonly Vec3[];
  /** Candidate launch points for rockets, tried in turn. */
  readonly rocketSites: readonly Vec3[];
  /** Seconds between ground placement attempts. */
  readonly placeInterval?: number;
  /** Seconds between ignition attempts on placed crackers. */
  readonly igniteInterval?: number;
  /** Seconds between rocket launches. */
  readonly rocketInterval?: number;
  /**
   * Seconds a player waits after a capacity refusal before trying that
   * again, which leaves room for the rockets in between.
   */
  readonly capacityBackoff?: number;
  /** Keep a phuljhari lit in hand throughout. */
  readonly holdPhuljhari?: boolean;
}

/** What the scenario attempted and how often the budgets pushed back. */
export interface StressCounters {
  placed: number;
  ignited: number;
  rockets: number;
  sparklers: number;
  placementRejections: Record<string, number>;
  ignitionRejections: Record<string, number>;
}

const GROUND_TYPES: readonly CrackerType[] = ['anar', 'chakri', 'ladi'];

/** Where a player standing next to `site` would be, so reach is satisfied. */
const standingBy = (site: Vec3): Vec3 => ({ x: site.x, y: site.y, z: site.z + 1 });

/**
 * Scripted worst-case play (issue #19): keeps placing ground crackers until
 * the placed cap refuses, lights them until the lit cap refuses, launches a
 * rocket every couple of seconds and keeps a phuljhari burning in hand. It
 * goes through the same placement rules and capacity gates as a player, so
 * caps are exercised rather than bypassed. Renderer-free; call `update` from
 * the fixed simulation step.
 */
export class StressScenario {
  readonly counters: StressCounters = {
    placed: 0,
    ignited: 0,
    rockets: 0,
    sparklers: 0,
    placementRejections: {},
    ignitionRejections: {},
  };

  private readonly options: StressScenarioOptions;
  private readonly placeInterval: number;
  private readonly igniteInterval: number;
  private readonly rocketInterval: number;
  private readonly capacityBackoff: number;
  /** Placed, unlit ground crackers awaiting a light, oldest first. */
  private readonly pending: CrackerId[] = [];
  private placeTimer = 0;
  private igniteTimer = 0;
  private rocketTimer = 0;
  private nextGround = 0;
  private nextRocket = 0;
  private lastRefusal: string | null = null;

  constructor(options: StressScenarioOptions) {
    this.options = options;
    this.placeInterval = options.placeInterval ?? 0.25;
    this.igniteInterval = options.igniteInterval ?? 0.4;
    this.rocketInterval = options.rocketInterval ?? 2;
    this.capacityBackoff = options.capacityBackoff ?? 5;
  }

  update(dt: number): void {
    if (this.options.holdPhuljhari ?? true) this.keepSparklerLit();
    if ((this.placeTimer -= dt) <= 0) {
      this.placeTimer += this.placeInterval;
      this.placeGround();
    }
    if ((this.igniteTimer -= dt) <= 0) {
      this.igniteTimer += this.igniteInterval;
      this.igniteOldest();
    }
    if ((this.rocketTimer -= dt) <= 0) {
      this.rocketTimer += this.rocketInterval;
      this.launchRocket();
    }
  }

  reset(): void {
    this.pending.length = 0;
    this.placeTimer = this.igniteTimer = this.rocketTimer = 0;
  }

  private keepSparklerLit(): void {
    const { crackers } = this.options;
    if (!crackers.held) crackers.select('phuljhari');
    if (crackers.held && !crackers.held.lit && crackers.igniteHeld().ok) this.counters.sparklers++;
  }

  private placeGround(): void {
    const { groundSites } = this.options;
    if (groundSites.length === 0) return;
    const site = groundSites[this.nextGround++ % groundSites.length]!;
    const type = GROUND_TYPES[this.counters.placed % GROUND_TYPES.length]!;
    const id = this.place(type, site);
    if (id) this.pending.push(id);
    else if (this.lastRefusal === 'capacity') this.placeTimer += this.capacityBackoff;
  }

  private igniteOldest(): void {
    const { crackers } = this.options;
    // Drop crackers the capacity policy reclaimed while they waited.
    while (this.pending.length && crackers.get(this.pending[0]!)?.state !== 'placed') this.pending.shift();
    const id = this.pending[0];
    if (id === undefined) return;
    const result = crackers.ignite(id);
    if (result.ok) {
      this.pending.shift();
      this.counters.ignited++;
    } else {
      count(this.counters.ignitionRejections, result.reason);
      if (result.reason === 'capacity') this.igniteTimer += this.capacityBackoff;
    }
  }

  private launchRocket(): void {
    const { rocketSites, crackers } = this.options;
    if (rocketSites.length === 0) return;
    const site = rocketSites[this.nextRocket++ % rocketSites.length]!;
    const id = this.place('rocket', site);
    if (!id) return;
    const result = crackers.ignite(id);
    if (result.ok) this.counters.rockets++;
    else {
      count(this.counters.ignitionRejections, result.reason);
      // Light it later with the ground crackers rather than abandon it.
      this.pending.push(id);
    }
  }

  private place(type: CrackerType, site: Vec3): CrackerId | null {
    this.lastRefusal = null;
    const verdict = this.options.validatePlacement({ type, playerPosition: standingBy(site), target: site });
    if (!verdict.ok) {
      count(this.counters.placementRejections, verdict.reason);
      this.lastRefusal = verdict.reason;
      return null;
    }
    const result = this.options.crackers.place(verdict.preview);
    if (!result.ok) {
      count(this.counters.placementRejections, result.reason);
      this.lastRefusal = result.reason;
      return null;
    }
    this.counters.placed++;
    return result.id;
  }
}

function count(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

/**
 * Grid of candidate points on the lane in front of the spawn, kept where the
 * placement rules accept `type` with nothing else placed. Spacing is wide
 * enough that neighbouring sites never block each other.
 */
export function stressSites(
  validatePlacement: (request: PlacementRequest) => PlacementResult,
  type: CrackerType,
  area: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number },
  spacing = 1.2,
): Vec3[] {
  const sites: Vec3[] = [];
  for (let z = area.maxZ; z >= area.minZ; z -= spacing) {
    for (let x = area.minX; x <= area.maxX; x += spacing) {
      const target = { x, y: 0, z };
      if (validatePlacement({ type, playerPosition: standingBy(target), target }).ok) sites.push(target);
    }
  }
  return sites;
}
