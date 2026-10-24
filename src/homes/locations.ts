import type { GameAction } from '../core/actions';
import type { GameEventBus } from '../core/events';
import type {
  CommandResult,
  DoorwayId,
  DoorwaySnapshot,
  HandItem,
  LocationId,
  LocationsModule,
  Placement,
  TransitionRejection,
  TransitionSnapshot,
} from '../core/homes';
import { TUNING, type Tuning } from '../core/tuning';
import { homeDoorways } from './doorways';

/** What the doors need to know about the hands. `HeldItems` satisfies it. */
export interface DoorHands {
  readonly hands: HandItem | null;
}

export interface LocationsOptions {
  readonly bus: GameEventBus;
  /** Without it, nothing in hand ever blocks a door. */
  readonly hands?: DoorHands;
  readonly doorways?: readonly DoorwaySnapshot[];
  readonly tuning?: Tuning;
  /**
   * Move the player to `arrival` at the fade's midpoint, before
   * `locationChanged` is emitted, so its subscribers see the player there.
   */
  readonly onArrive?: (arrival: Placement, location: LocationId) => void;
}

/** Player-facing wording for a refused door. */
export const TRANSITION_REJECTION_TEXT: Readonly<Record<TransitionRejection, string>> = {
  transitionInProgress: 'Just a moment…',
  carryingPlate: 'The plate stays at home — put it back on the sweets table first',
  participatingInAarti: 'Leave aarti and put down the thali first',
  unknownDoorway: 'That door does not open',
  wrongLocation: 'That door is not here',
};

/**
 * While a door fade runs, only these actions get through: look, camera and
 * pause stay live, and move/run and a released click still update the held
 * state (so a key let go mid-fade is not stuck) though the player stands
 * still. Selecting, placing and interacting are dropped.
 */
export function allowedDuringFade(action: GameAction): boolean {
  switch (action.type) {
    case 'move':
    case 'run':
    case 'look':
    case 'toggleCamera':
    case 'pause':
    case 'placeReleased':
      return true;
    case 'select':
    case 'place':
    case 'interact':
      return false;
  }
}

/** Overlay opacity in [0, 1]: up to black over the first half, back down over the second. */
export function fadeOpacity(transition: TransitionSnapshot | null): number {
  if (!transition) return 0;
  const half = transition.duration / 2;
  if (half <= 0) return 0;
  const t = transition.phase === 'fadingOut' ? transition.elapsed / half : 2 - transition.elapsed / half;
  return Math.min(Math.max(t, 0), 1);
}

const OK: CommandResult<TransitionRejection> = Object.freeze({ ok: true });

/**
 * The active location and door fades: idle → fading out → moved → fading
 * in → idle. A request is accepted or refused with a reason; while a fade
 * runs, further requests are refused and movement and interactions are
 * suppressed (`controlsLocked`). The player moves at the midpoint, when
 * `locationChanged` is published exactly once.
 *
 * Only the location changes: crackers, household and ceremony keep their own
 * state and keep advancing on the fixed step wherever the player is. Fades
 * advance on the fixed step too, so pausing freezes them. Renderer-free.
 */
export class Locations implements LocationsModule {
  private readonly bus: GameEventBus;
  private readonly hands: DoorHands | undefined;
  private readonly byId: ReadonlyMap<DoorwayId, DoorwaySnapshot>;
  private readonly fadeDuration: number;
  private readonly onArrive: LocationsOptions['onArrive'];

  private current: LocationId = 'outdoors';
  private fade: TransitionSnapshot | null = null;

  constructor(options: LocationsOptions) {
    this.bus = options.bus;
    this.hands = options.hands;
    const doorways = options.doorways ?? homeDoorways();
    this.byId = new Map(doorways.map((doorway) => [doorway.id, doorway]));
    this.fadeDuration = (options.tuning ?? TUNING).homes.fadeDuration;
    this.onArrive = options.onArrive;
  }

  get location(): LocationId {
    return this.current;
  }

  get transition(): TransitionSnapshot | null {
    return this.fade;
  }

  /** True while a fade runs: the player may look around but not move or interact. */
  get controlsLocked(): boolean {
    return this.fade !== null;
  }

  /** Current fade overlay opacity in [0, 1]. */
  get fadeOpacity(): number {
    return fadeOpacity(this.fade);
  }

  doorways(): readonly DoorwaySnapshot[] {
    return [...this.byId.values()];
  }

  /** The doorway with `id`, if any. */
  doorway(id: DoorwayId): DoorwaySnapshot | undefined {
    return this.byId.get(id);
  }

  /** Doorways usable from the current location. */
  doorwaysHere(): readonly DoorwaySnapshot[] {
    return this.doorways().filter((doorway) => doorway.location === this.current);
  }

  requestTransition(id: DoorwayId): CommandResult<TransitionRejection> {
    if (this.fade) return this.reject(id, 'transitionInProgress');
    const doorway = this.byId.get(id);
    if (!doorway) return this.reject(id, 'unknownDoorway');
    const reason = this.refusal(doorway);
    if (reason) return this.reject(id, reason);
    const { destination: to } = doorway;
    const from = this.current;
    this.fade = { doorway: id, from, to, phase: 'fadingOut', elapsed: 0, duration: this.fadeDuration };
    this.bus.emit('transitionStarted', { doorway: id, from, to, duration: this.fadeDuration });
    return OK;
  }

  update(dt: number): void {
    const fade = this.fade;
    if (!fade || !(dt > 0)) return;
    const elapsed = fade.elapsed + dt;
    // A long step may cross both the midpoint and the end; the move still happens once.
    if (fade.phase === 'fadingOut' && elapsed >= fade.duration / 2) this.arrive(fade);
    if (elapsed >= fade.duration) this.fade = null;
    else this.fade = { ...fade, phase: elapsed >= fade.duration / 2 ? 'fadingIn' : 'fadingOut', elapsed };
  }

  /** Fresh session: back outdoors with no fade running. Silent; the player resets to spawn itself. */
  reset(): void {
    this.current = 'outdoors';
    this.fade = null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private refusal(doorway: DoorwaySnapshot): TransitionRejection | null {
    if (doorway.location !== this.current) return 'wrongLocation';
    const held = this.hands?.hands?.kind;
    // The plate never leaves the family home; gift boxes may cross any door.
    if (held === 'sweetsPlate' && doorway.location === 'familyHome') return 'carryingPlate';
    if (held === 'thali') return 'participatingInAarti';
    return null;
  }

  private reject(doorway: DoorwayId, reason: TransitionRejection): CommandResult<TransitionRejection> {
    this.bus.emit('transitionRejected', { doorway, reason });
    return { ok: false, reason };
  }

  /** The midpoint: the screen is black, so move the player and switch location. */
  private arrive(fade: TransitionSnapshot): void {
    const doorway = this.byId.get(fade.doorway);
    this.current = fade.to;
    if (doorway) this.onArrive?.(doorway.arrival, fade.to);
    this.bus.emit('locationChanged', { doorway: fade.doorway, from: fade.from, to: fade.to });
  }
}
