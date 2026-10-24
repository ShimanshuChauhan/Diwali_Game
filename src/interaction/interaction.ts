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
import {
  NEIGHBOUR_HOSTS,
  type AartiSnapshot,
  type DoorwaySnapshot,
  type GiftBoxSnapshot,
  type HandItem,
  type HomeId,
  type HouseholdMemberId,
  type HouseholdMemberSnapshot,
  type LocationId,
} from '../core/homes';
import { TUNING, type Tuning } from '../core/tuning';
import type { DiyaId, Vec3 } from '../core/types';
import { returnSpotFor } from '../homes/heldItems';
import { HOME_SPOTS, type HomeSpots } from './homeSpots';
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
  /**
   * Where the player is. Without it they are always outdoors, where only
   * crackers, diyas and street doors are offered.
   */
  readonly location?: () => LocationId;
  /** Every doorway; the ones used from the player's side are offered. */
  readonly doorways?: () => readonly DoorwaySnapshot[];
  /** Puja, tray and gift-box spots inside each home; defaults to `HOME_SPOTS`. */
  readonly spots?: HomeSpots;
  /** Family and neighbour hosts; those in the player's location are offered. */
  readonly members?: () => readonly HouseholdMemberSnapshot[];
  /** What the hands carry; picks the people and return spots worth offering. */
  readonly hands?: () => HandItem | null;
  /** The ceremony: a completed aarti hides the puja, and a participant can only leave. */
  readonly aarti?: () => AartiSnapshot;
  /** Where the gift boxes are; a box resting on its spot can be picked up. */
  readonly gifts?: () => readonly GiftBoxSnapshot[];
  readonly tuning?: Tuning;
}

const NONE: () => readonly never[] = () => [];

const HOSTS: readonly HouseholdMemberId[] = NEIGHBOUR_HOSTS;

/** Return spot ids, built once so the per-frame search allocates nothing. */
const GIFT_SPOT_IDS: Readonly<Record<HomeId, string>> = {
  familyHome: 'giftBox@familyHome',
  neighbourHome: 'giftBox@neighbourHome',
};

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
 * world, cracker, neighbour and homes queries — no renderer.
 *
 * Outdoors that is an unlit cracker, a diya or a home's front door; inside a
 * home, its exit door, the puja corner, the sweets tray, a person and a gift
 * box's return spot. Each kind has its own reach (`TUNING.homes`) and is
 * offered only when it has something to do: family members while the plate
 * is carried, a return spot while its box rests there or is carried, and the
 * puja until aarti completes.
 */
export class Interaction implements InteractionModule {
  readonly rules: PlacementRules;
  private readonly world: WorldModule;
  private readonly crackers: () => readonly CrackerSnapshot[];
  private readonly playerPosition: (() => Vec3) | undefined;
  private readonly isDiyaUsable: ((id: DiyaId) => boolean) | undefined;
  private readonly location: (() => LocationId) | undefined;
  private readonly doorways: () => readonly DoorwaySnapshot[];
  private readonly spots: HomeSpots;
  private readonly members: () => readonly HouseholdMemberSnapshot[];
  private readonly hands: (() => HandItem | null) | undefined;
  private readonly aarti: (() => AartiSnapshot) | undefined;
  private readonly gifts: () => readonly GiftBoxSnapshot[];
  private readonly tuning: Tuning;

  /** Last result, returned again while it is unchanged so polling allocates nothing. */
  private last: Interactable | null = null;

  /** The search's best candidate so far; fields rather than an object so it allocates nothing. */
  private bestKind: Interactable['kind'] | null = null;
  private bestId = '';
  private bestPosition: Vec3 | null = null;
  private bestDistSq = 0;
  /** This search's reach origin and ground-plane view direction. */
  private readonly origin = { x: 0, y: 0, z: 0, fx: 0, fz: 0, fLen: 0 };

  constructor(options: InteractionOptions) {
    this.world = options.world;
    this.crackers = options.crackers ?? NONE;
    this.playerPosition = options.playerPosition;
    this.isDiyaUsable = options.isDiyaUsable;
    this.location = options.location;
    this.doorways = options.doorways ?? NONE;
    this.spots = options.spots ?? HOME_SPOTS;
    this.members = options.members ?? NONE;
    this.hands = options.hands;
    this.aarti = options.aarti;
    this.gifts = options.gifts ?? NONE;
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
   * Nearest usable object within its reach of the player, at roughly the
   * player's level and not behind the view. Crackers win ties with diyas,
   * and both win ties with home objects. While the player takes part in
   * aarti the puja is the only target, wherever they look.
   */
  findInteractable(view: CameraView): Interactable | null {
    const location = this.location?.() ?? 'outdoors';
    const aarti = this.aarti?.();
    const pujaSpot = this.spots.familyHome.puja;
    if (pujaSpot && aarti?.participating) return this.remember('puja', 'familyHome', pujaSpot);

    const feet = this.playerPosition?.();
    const ox = feet ? feet.x : view.position.x;
    const oy = feet ? feet.y : view.position.y - this.tuning.player.eyeHeight;
    const oz = feet ? feet.z : view.position.z;
    const fx = view.forward.x;
    const fz = view.forward.z;
    const fLen = Math.hypot(fx, fz);
    const o = this.origin;
    o.x = ox;
    o.y = oy;
    o.z = oz;
    o.fx = fx;
    o.fz = fz;
    o.fLen = fLen;
    const range = this.tuning.interaction.interactRange;

    let bestDistSq = range * range;
    let bestCracker: CrackerSnapshot | null = null;
    let bestDiya: DiyaSite | null = null;

    // Crackers and diyas are outdoor things; a home has neither.
    if (location === 'outdoors') {
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
    }

    this.bestKind = null;
    this.bestPosition = null;
    if (bestDiya) this.keep('diya', bestDiya.id, bestDiya.position, bestDistSq);
    else if (bestCracker) this.keep('cracker', bestCracker.id, bestCracker.position, bestDistSq);
    else this.bestDistSq = Infinity;

    const homes = this.tuning.homes;
    const doorways = this.doorways();
    for (let i = 0; i < doorways.length; i++) {
      const doorway = doorways[i]!;
      if (doorway.location === location) this.consider('door', doorway.id, doorway.position, homes.doorRange);
    }

    if (location !== 'outdoors') {
      const spots = this.spots[location];
      if (spots.puja && aarti?.state !== 'completed') this.consider('puja', location, spots.puja, homes.pujaRange);
      if (spots.tray) this.consider('tray', location, spots.tray, homes.trayRange);
      if (spots.giftSpot && this.giftSpotInUse(location)) {
        this.consider('returnSpot', GIFT_SPOT_IDS[location], spots.giftSpot, homes.returnSpotRange);
      }
      const carryingPlate = this.hands?.()?.kind === 'sweetsPlate';
      const members = this.members();
      for (let i = 0; i < members.length; i++) {
        const member = members[i]!;
        if (member.home !== location) continue;
        // Family members take sweets from the plate; the neighbours always greet.
        if (!carryingPlate && !HOSTS.includes(member.id)) continue;
        this.consider('person', member.id, member.placement.position, homes.personRange);
      }
    }

    const kind = this.bestKind;
    const position = this.bestPosition;
    if (kind === null || position === null) {
      this.last = null;
      return null;
    }
    return this.remember(kind, this.bestId, position);
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Keep `position` as the best so far if it is within `reach` and nearer. */
  private consider(kind: Interactable['kind'], id: string, position: Vec3, reach: number): void {
    const { x, y, z, fx, fz, fLen } = this.origin;
    const reachSq = reach * reach;
    const d = facingDistanceSq(position, x, y, z, fx, fz, fLen, reachSq);
    if (d <= reachSq && d < this.bestDistSq) this.keep(kind, id, position, d);
  }

  private keep(kind: Interactable['kind'], id: string, position: Vec3, distSq: number): void {
    this.bestKind = kind;
    this.bestId = id;
    this.bestPosition = position;
    this.bestDistSq = distSq;
  }

  /** A home's gift spot matters while a box rests on it or its own box is carried. */
  private giftSpotInUse(home: HomeId): boolean {
    const held = this.hands?.();
    if (held?.kind === 'giftBox' && returnSpotFor(held)?.home === home) return true;
    const boxes = this.gifts();
    for (let i = 0; i < boxes.length; i++) {
      const place = boxes[i]!.place;
      if (place.kind === 'spot' && place.home === home) return true;
    }
    return false;
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
    const next = target(kind, id, position);
    this.last = next;
    return next;
  }
}

/** Build the interactable for a search result; `id` is already unique within `kind`. */
function target(kind: Interactable['kind'], id: string, position: Vec3): Interactable {
  switch (kind) {
    case 'puja':
    case 'tray':
      return { kind, id: id as HomeId, position };
    case 'person':
      return { kind, id: id as HouseholdMemberId, position };
    case 'returnSpot': {
      const home = id.slice(id.indexOf('@') + 1) as HomeId;
      return { kind, id, item: 'giftBox', home, position };
    }
    default:
      return { kind, id, position };
  }
}
