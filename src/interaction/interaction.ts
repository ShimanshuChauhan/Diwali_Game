import type {
  CameraView,
  CrackerSnapshot,
  DiyaSite,
  Interactable,
  InteractionModule,
  NeighbourSnapshot,
  PlacementRequest,
  PlacementResult,
  WorldModule,
} from '../core/contracts';
import { TUNING, type Tuning } from '../core/tuning';
import type { DiyaId, Vec3 } from '../core/types';
import { PlacementRules, type PlacementFeedback } from './placement';

/** Usable objects must be within this height of the player's feet. */
const INTERACT_HEIGHT = 2;

/** Objects closer than this count as in front whatever the view direction. */
const AT_FEET = 0.6;

/** Widest angle off the view direction (on the ground plane) still usable. */
const MAX_FACING_ANGLE = (70 * Math.PI) / 180;
const MIN_FACING_DOT = Math.cos(MAX_FACING_ANGLE);

export interface InteractionOptions {
  readonly world: WorldModule;
  /** Crackers not yet finished; unlit ones are E targets. */
  readonly crackers?: () => readonly CrackerSnapshot[];
  /** Whether one more cracker fits; see `PlacementSources.hasRoom`. */
  readonly hasRoom?: () => boolean;
  /** Live neighbour positions for placement exclusion. */
  readonly neighbours?: () => readonly NeighbourSnapshot[];
  /**
   * Player feet. Without it the reach is measured from the view position
   * less the eye height, which is right in first-person only.
   */
  readonly playerPosition?: () => Vec3;
  /** Diyas offered for E; defaults to all. Relighting a lit diya is harmless. */
  readonly isDiyaUsable?: (id: DiyaId) => boolean;
  readonly tuning?: Tuning;
}

const NONE: () => readonly never[] = () => [];

/**
 * Squared ground distance from the origin `o` to `p`, or Infinity when `p`
 * is beyond `maxSq`, off the player's level, or behind the view direction `f`.
 */
function facingDistanceSq(
  p: Vec3,
  ox: number,
  oy: number,
  oz: number,
  fx: number,
  fz: number,
  fLen: number,
  maxSq: number,
): number {
  if (Math.abs(p.y - oy) > INTERACT_HEIGHT) return Infinity;
  const dx = p.x - ox;
  const dz = p.z - oz;
  const distSq = dx * dx + dz * dz;
  if (distSq > maxSq) return Infinity;
  if (distSq > AT_FEET * AT_FEET && fLen > 0) {
    const dot = (dx * fx + dz * fz) / (Math.sqrt(distSq) * fLen);
    if (dot < MIN_FACING_DOT) return Infinity;
  }
  return distSq;
}

/**
 * The interaction and placement module: finds the nearest usable object
 * for the E prompt and validates cracker placement. Pure rules over the
 * world, cracker and neighbour queries — no renderer.
 */
export class Interaction implements InteractionModule {
  readonly rules: PlacementRules;
  private readonly world: WorldModule;
  private readonly crackers: () => readonly CrackerSnapshot[];
  private readonly playerPosition: (() => Vec3) | undefined;
  private readonly isDiyaUsable: ((id: DiyaId) => boolean) | undefined;
  private readonly tuning: Tuning;

  /** Last result, returned again while it is unchanged so polling allocates nothing. */
  private last: Interactable | null = null;

  constructor(options: InteractionOptions) {
    this.world = options.world;
    this.crackers = options.crackers ?? NONE;
    this.playerPosition = options.playerPosition;
    this.isDiyaUsable = options.isDiyaUsable;
    this.tuning = options.tuning ?? TUNING;
    this.rules = new PlacementRules({
      world: options.world,
      crackers: this.crackers,
      hasRoom: options.hasRoom,
      neighbours: options.neighbours,
      tuning: this.tuning,
    });
  }

  validatePlacement(request: PlacementRequest): PlacementResult {
    return this.rules.validate(request);
  }

  /** Per-frame ghost verdict; reused between calls (see `PlacementRules.preview`). */
  previewPlacement(request: PlacementRequest): PlacementFeedback {
    return this.rules.preview(request);
  }

  /**
   * Nearest unlit cracker or diya within interact range of the player,
   * at roughly the player's level and not behind the view. Crackers win
   * ties with diyas.
   */
  findInteractable(view: CameraView): Interactable | null {
    const feet = this.playerPosition?.();
    const ox = feet ? feet.x : view.position.x;
    const oy = feet ? feet.y : view.position.y - this.tuning.player.eyeHeight;
    const oz = feet ? feet.z : view.position.z;
    const fx = view.forward.x;
    const fz = view.forward.z;
    const fLen = Math.hypot(fx, fz);
    const range = this.tuning.interaction.interactRange;

    let bestDistSq = range * range;
    let bestCracker: CrackerSnapshot | null = null;
    let bestDiya: DiyaSite | null = null;

    const crackers = this.crackers();
    for (let i = 0; i < crackers.length; i++) {
      const cracker = crackers[i]!;
      if (cracker.state !== 'placed') continue;
      const d = facingDistanceSq(cracker.position, ox, oy, oz, fx, fz, fLen, bestDistSq);
      if (d <= bestDistSq) {
        bestDistSq = d;
        bestCracker = cracker;
      }
    }
    const diyas = this.world.diyaSites;
    for (let i = 0; i < diyas.length; i++) {
      const diya = diyas[i]!;
      if (this.isDiyaUsable && !this.isDiyaUsable(diya.id)) continue;
      const d = facingDistanceSq(diya.position, ox, oy, oz, fx, fz, fLen, bestDistSq);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestDiya = diya;
        bestCracker = null;
      }
    }

    if (bestDiya) return this.remember('diya', bestDiya.id, bestDiya.position);
    if (bestCracker) return this.remember('cracker', bestCracker.id, bestCracker.position);
    this.last = null;
    return null;
  }

  private remember(kind: Interactable['kind'], id: string, position: Vec3): Interactable {
    const last = this.last;
    if (
      last &&
      last.kind === kind &&
      last.id === id &&
      last.position.x === position.x &&
      last.position.y === position.y &&
      last.position.z === position.z
    ) {
      return last;
    }
    const next: Interactable = { kind, id, position };
    this.last = next;
    return next;
  }
}
