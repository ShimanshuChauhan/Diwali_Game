import type {
  CrackerSnapshot,
  NeighbourSnapshot,
  PlacementRequest,
  PlacementResult,
  WorldModule,
} from '../core/contracts';
import { TUNING, type Tuning } from '../core/tuning';
import { isHandheld, type CrackerType, type ExclusionZone, type PlacementRejection, type Vec3 } from '../core/types';

/**
 * How far above the aim point to look for the surface it lies on. An aim
 * point on a floor sits on its surface; one on a wall or a box's side is
 * further above the top below it than this and is refused.
 */
const SURFACE_SNAP = 0.1;

/** Lift on the clearance sphere so it rests on, rather than in, the floor. */
const SPHERE_LIFT = 0.01;

/** Two crackers count as neighbours for spacing only within this height band. */
const SPACING_HEIGHT_BAND = 1;

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The per-frame placement verdict, reused between calls. Unlike the
 * contract's `PlacementResult` it always carries a candidate position (the
 * snapped surface point, or the raw aim point when no surface was found) so
 * the ghost can be drawn red where the player is aiming.
 */
export interface PlacementFeedback {
  readonly type: CrackerType;
  /** True when the placement would be accepted. */
  readonly ok: boolean;
  /** Null exactly when `ok`. */
  readonly reason: PlacementRejection | null;
  readonly position: Vec3;
}

export interface PlacementSources {
  readonly world: WorldModule;
  /** Crackers not yet finished; used for capacity and spacing. */
  readonly crackers?: () => readonly CrackerSnapshot[];
  /**
   * Whether one more cracker fits, e.g. the capacity budget, which may
   * reclaim an old unlit one to make room. Defaults to the placed cap.
   */
  readonly hasRoom?: () => boolean;
  /** Live neighbour positions, kept clear on top of the static areas. */
  readonly neighbours?: () => readonly NeighbourSnapshot[];
  readonly tuning?: Tuning;
}

const NONE: () => readonly never[] = () => [];

/** One shared, frozen result per reason so rejections never allocate. */
const REJECTIONS: Readonly<Record<PlacementRejection, PlacementResult>> = Object.freeze({
  outOfReach: Object.freeze({ ok: false, reason: 'outOfReach' }),
  unsupportedSurface: Object.freeze({ ok: false, reason: 'unsupportedSurface' }),
  blockedByGeometry: Object.freeze({ ok: false, reason: 'blockedByGeometry' }),
  nearDoorway: Object.freeze({ ok: false, reason: 'nearDoorway' }),
  nearNeighbour: Object.freeze({ ok: false, reason: 'nearNeighbour' }),
  noSkyClearance: Object.freeze({ ok: false, reason: 'noSkyClearance' }),
  capacity: Object.freeze({ ok: false, reason: 'capacity' }),
  handheldOnly: Object.freeze({ ok: false, reason: 'handheldOnly' }),
});

function groundDistanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function insideAnyZone(zones: readonly ExclusionZone[], p: Vec3, clearance: number): boolean {
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i]!;
    const r = zone.radius + clearance;
    if (groundDistanceSq(zone.centre, p) < r * r) return true;
  }
  return false;
}

/**
 * Placement validation for ground crackers, as plain rules over a
 * `WorldModule` and the live cracker and neighbour lists. Checks run in a
 * fixed order and the first failure is reported:
 *
 * 1. handheld (`handheldOnly`) — the phuljhari is never placed;
 * 2. capacity (`capacity`) — refused anywhere, so it is reported first;
 * 3. reach (`outOfReach`);
 * 4. supported surface (`unsupportedSurface`) — a placement surface, flat
 *    enough, directly under the aim point;
 * 5. clearance (`blockedByGeometry`) — static geometry and other crackers;
 * 6. doorways (`nearDoorway`);
 * 7. neighbours (`nearNeighbour`) — static areas and live positions;
 * 8. rockets only: open sky above (`noSkyClearance`).
 *
 * `preview()` is the per-frame path and allocates nothing; `validate()`
 * returns a fresh, keepable result for the click that places a cracker.
 */
export class PlacementRules {
  private readonly world: WorldModule;
  private readonly crackers: () => readonly CrackerSnapshot[];
  private readonly hasRoom: (() => boolean) | undefined;
  private readonly neighbours: () => readonly NeighbourSnapshot[];
  private readonly tuning: Tuning;
  private readonly minSurfaceNormalY: number;

  private readonly probe: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly candidate: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly feedback: {
    type: CrackerType;
    ok: boolean;
    reason: PlacementRejection | null;
    position: MutableVec3;
  };

  constructor(sources: PlacementSources) {
    this.world = sources.world;
    this.crackers = sources.crackers ?? NONE;
    this.hasRoom = sources.hasRoom;
    this.neighbours = sources.neighbours ?? NONE;
    this.tuning = sources.tuning ?? TUNING;
    this.minSurfaceNormalY = Math.cos((this.tuning.placement.maxSurfaceSlope * Math.PI) / 180);
    this.feedback = { type: 'anar', ok: false, reason: null, position: this.candidate };
  }

  /**
   * Evaluate a candidate for this frame's ghost. The returned object is
   * reused by the next call; copy anything you need to keep.
   */
  preview(request: PlacementRequest): PlacementFeedback {
    const reason = this.evaluate(request);
    const out = this.feedback;
    out.type = request.type;
    out.ok = reason === null;
    out.reason = reason;
    return out;
  }

  /** Validate a candidate without creating anything; safe to keep. */
  validate(request: PlacementRequest): PlacementResult {
    const reason = this.evaluate(request);
    if (reason !== null) return REJECTIONS[reason];
    const { x, y, z } = this.candidate;
    return { ok: true, preview: { type: request.type, position: { x, y, z } } };
  }

  /** Runs the checks, leaving the candidate position in `this.candidate`. */
  private evaluate(request: PlacementRequest): PlacementRejection | null {
    const { type, playerPosition, target } = request;
    const { placement, caps } = this.tuning;
    const candidate = this.candidate;
    candidate.x = target.x;
    candidate.y = target.y;
    candidate.z = target.z;

    if (isHandheld(type)) return 'handheldOnly';

    const crackers = this.crackers();
    if (this.hasRoom ? !this.hasRoom() : crackers.length >= caps.maxPlacedCrackers) return 'capacity';

    const dx = target.x - playerPosition.x;
    const dy = target.y - playerPosition.y;
    const dz = target.z - playerPosition.z;
    if (dx * dx + dy * dy + dz * dz > placement.reach * placement.reach) return 'outOfReach';

    const probe = this.probe;
    probe.x = target.x;
    probe.y = target.y + SURFACE_SNAP;
    probe.z = target.z;
    const hit = this.world.surfaceBelow(probe);
    if (!hit) return 'unsupportedSurface';
    candidate.y = hit.point.y;
    if (!hit.supportsPlacement) return 'unsupportedSurface';
    if (target.y - hit.point.y > SURFACE_SNAP) return 'unsupportedSurface';
    if (hit.normal.y < this.minSurfaceNormalY) return 'unsupportedSurface';

    const radius = placement.geometryClearance;
    probe.y = candidate.y + radius + SPHERE_LIFT;
    if (!this.world.isClear(probe, radius)) return 'blockedByGeometry';
    const spacingSq = placement.crackerSpacing * placement.crackerSpacing;
    for (let i = 0; i < crackers.length; i++) {
      const other = crackers[i]!.position;
      if (Math.abs(other.y - candidate.y) < SPACING_HEIGHT_BAND && groundDistanceSq(other, candidate) < spacingSq) {
        return 'blockedByGeometry';
      }
    }

    if (insideAnyZone(this.world.doorways, candidate, placement.doorwayClearance)) return 'nearDoorway';

    if (insideAnyZone(this.world.neighbourAreas, candidate, placement.neighbourClearance)) return 'nearNeighbour';
    const neighbours = this.neighbours();
    const neighbourSq = placement.neighbourClearance * placement.neighbourClearance;
    for (let i = 0; i < neighbours.length; i++) {
      if (groundDistanceSq(neighbours[i]!.position, candidate) < neighbourSq) return 'nearNeighbour';
    }

    if (type === 'rocket') {
      const needed = placement.rocketSkyClearance;
      if (this.world.clearanceAbove(candidate, needed) < needed) return 'noSkyClearance';
    }

    return null;
  }
}
