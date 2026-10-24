import type { Resettable, Steppable } from './contracts';
import type { QualityProfile } from './quality';
import type { Vec3 } from './types';

/**
 * Contracts for the Family and Neighbour Homes expansion (issue #51 →
 * Implementation Decisions → Modules). They sit beside `contracts.ts` so the
 * expansion's modules can be built in parallel against fixed interfaces.
 *
 * Like the rest of `core/`, everything here is plain data: the rule modules
 * (locations, aarti ceremony, household, held items, gift exchange) stay
 * renderer-free and testable in Node. Only interior presentation and the
 * recorded aarti audio touch Three.js or Web Audio, behind their interfaces.
 *
 * All timing is unpaused simulation time: rule modules advance through
 * `Steppable.update(dt)` on the fixed step, which the game loop stops while
 * the session is paused, so pause and tab switches freeze everything together.
 */

// ── Identities ───────────────────────────────────────────────────────────

/** Where the player is. The street is `outdoors`; the two homes are enterable. */
export const LOCATION_IDS = ['outdoors', 'familyHome', 'neighbourHome'] as const;
export type LocationId = (typeof LOCATION_IDS)[number];

export type HomeId = Exclude<LocationId, 'outdoors'>;

export type DoorwayId = string;

/** Stable household identities; names and appearances are content choices. */
export const FAMILY_MEMBERS = ['mother', 'father', 'sibling', 'grandmother', 'grandfather'] as const;
export type FamilyMemberId = (typeof FAMILY_MEMBERS)[number];

export const NEIGHBOUR_HOSTS = ['uncle', 'aunty'] as const;
export type NeighbourHostId = (typeof NEIGHBOUR_HOSTS)[number];

export type HouseholdMemberId = FamilyMemberId | NeighbourHostId;

/** The three requested aartis, in mini-player order. */
export const AARTI_SONG_IDS = ['omJaiJagdishHare', 'jaiLakshmiMata', 'jaiGaneshDeva'] as const;
export type AartiSongId = (typeof AARTI_SONG_IDS)[number];

/** `outbound` starts at the family home; `return` is the neighbour's reply. */
export type GiftBoxId = 'outbound' | 'return';

/** Position and facing the player is placed at, e.g. after a door fade. */
export interface Placement {
  readonly position: Vec3;
  /** Radians about +Y; 0 looks down -Z. */
  readonly yaw: number;
}

// ── Rejection reasons ────────────────────────────────────────────────────

/** Why a door transition was refused. */
export type TransitionRejection =
  /** A fade is already running; overlapping requests are blocked. */
  | 'transitionInProgress'
  /** The sharing plate stays in the family home until it is returned. */
  | 'carryingPlate'
  /** Leave aarti (putting down the thali) before using a door. */
  | 'participatingInAarti'
  | 'unknownDoorway'
  /** The doorway is not on the player's side, e.g. an interior door from outdoors. */
  | 'wrongLocation';

/** Why an aarti command was refused. */
export type AartiRejection =
  /** Aarti happens once per session; a completed ceremony cannot be rejoined. */
  | 'ceremonyCompleted'
  /** Return the carried item before joining. */
  | 'handsFull'
  | 'alreadyParticipating'
  /** Leave, song change and thali hold need an active participant. */
  | 'notParticipating'
  | 'unknownSong'
  /** The recording failed to load or its duration is not yet known. */
  | 'songUnavailable'
  | 'wrongLocation';

/** Why a held-item or sweets command was refused. */
export type ItemRejection =
  | 'handsFull'
  | 'carryingPlate'
  | 'carryingGift'
  | 'holdingThali'
  /** A lit phuljhari must burn out or be put away first. */
  | 'sparklerLit'
  /** The family tray is served only after aarti. */
  | 'trayNotServed'
  /** Return or offer needs the item in hand. */
  | 'notHolding'
  /** The item has its own designated return spot elsewhere. */
  | 'wrongReturnSpot'
  | 'outOfReach';

/**
 * Why a cracker action (select, place, ignite, ignite held) is blocked while
 * the hands are busy. The UI turns this into a return-or-deliver prompt.
 */
export type CrackerHandsRejection = 'carryingPlate' | 'carryingGift' | 'holdingThali';

/** The cracker actions the hands gate, named in `crackerBlocked`. */
export type CrackerAction = 'select' | 'place' | 'ignite' | 'igniteHeld';

/** Why a gift-box command was refused. */
export type GiftRejection =
  | 'notHolding'
  | 'handsFull'
  /** The special exchange happens once per session. */
  | 'alreadyExchanged'
  /** The return box has been acknowledged and is no longer an exchange item. */
  | 'alreadyDelivered'
  | 'wrongLocation'
  | 'outOfReach';

export type CommandResult<R extends string> = { readonly ok: true } | { readonly ok: false; readonly reason: R };

// ── Locations and transitions ────────────────────────────────────────────

export interface DoorwaySnapshot {
  readonly id: DoorwayId;
  /** The side the door is used from. */
  readonly location: LocationId;
  readonly destination: LocationId;
  /** Where the player interacts with the door. */
  readonly position: Vec3;
  /** Walkable pose on the destination side. */
  readonly arrival: Placement;
}

/**
 * A door fade: `fadingOut` to black, the player is moved at the midpoint,
 * then `fadingIn`. Movement and interactions are suppressed throughout.
 */
export interface TransitionSnapshot {
  readonly doorway: DoorwayId;
  readonly from: LocationId;
  readonly to: LocationId;
  readonly phase: 'fadingOut' | 'fadingIn';
  /** Seconds since the transition began. */
  readonly elapsed: number;
  /** Total fade time (out plus in), from `TUNING.homes.fadeDuration`. */
  readonly duration: number;
}

export interface LocationsModule extends Steppable, Resettable {
  readonly location: LocationId;
  /** The running fade, or null when the player has control. */
  readonly transition: TransitionSnapshot | null;
  doorways(): readonly DoorwaySnapshot[];
  /**
   * Start a door fade. Emits `transitionStarted`, then `locationChanged` at
   * the midpoint; or `transitionRejected`. Household and outdoor cracker
   * state is untouched by a transition.
   */
  requestTransition(doorway: DoorwayId): CommandResult<TransitionRejection>;
}

// ── Aarti ceremony ───────────────────────────────────────────────────────

/** `waiting` until the player first joins; `completed` once per session. */
export type AartiState = 'waiting' | 'running' | 'completed';

export interface AartiSnapshot {
  readonly state: AartiState;
  readonly participating: boolean;
  readonly song: AartiSongId;
  /** Seconds of the current song's timeline, advanced while running. */
  readonly elapsed: number;
  /** The selected recording's full duration; completion happens here. */
  readonly duration: number;
  /** True while the hold action circles the thali; never affects timing. */
  readonly circling: boolean;
  /**
   * Bumped whenever playback must restart (join, rejoin, song change, leave,
   * completion, reset). Audio ignores callbacks tagged with an older value.
   */
  readonly playbackId: number;
}

export interface AartiCeremonyModule extends Steppable, Resettable {
  readonly snapshot: AartiSnapshot;
  /**
   * Join (or rejoin at the elapsed position). Reserves the hands for the
   * thali and disables translation. Emits `aartiJoined` or `aartiRejected`.
   */
  join(): CommandResult<AartiRejection>;
  /** Put down the thali and restore movement; time keeps running. Emits `aartiLeft`. */
  leave(): CommandResult<AartiRejection>;
  /** Participants only: restart from zero with the new song's full duration. Emits `aartiSongChanged`. */
  selectSong(song: AartiSongId): CommandResult<AartiRejection>;
  /** Hold to circle the thali, release to rest. Released automatically on pause. */
  setCircling(circling: boolean): CommandResult<AartiRejection>;
}

// ── Recorded aarti audio ─────────────────────────────────────────────────

/** One bundled recording; metadata and playback refer to the same asset. */
export interface AartiRecording {
  readonly id: AartiSongId;
  readonly title: string;
  readonly performer: string;
  /** Where the recording came from, e.g. an archive URL. */
  readonly source: string;
  readonly licence: string;
  readonly attribution: string;
  /** Seconds; known before a song is committed to. */
  readonly duration: number;
  /** Local asset path, bundled with the game. */
  readonly asset: string;
  /** False for development placeholders that must not ship. */
  readonly approved: boolean;
}

export type RecordingLoadState = 'unloaded' | 'loading' | 'ready' | 'failed';

/**
 * Plays at most one recording, only while the player participates. Follows
 * ceremony snapshots rather than driving the ceremony clock; integrates with
 * `AudioModule` unlock, mute and master gain.
 */
export interface AartiAudioModule extends Resettable {
  readonly catalogue: readonly AartiRecording[];
  loadState(song: AartiSongId): RecordingLoadState;
  /** Resolve with the duration in seconds; reject on load or decode failure. */
  load(song: AartiSongId): Promise<number>;
  /** Start, seek or stop playback to match the ceremony. */
  sync(snapshot: AartiSnapshot): void;
  /** 0 or 1. */
  readonly activeSources: number;
}

// ── Household behaviour and dialogue ─────────────────────────────────────

export type HouseholdActivity =
  | 'gathered'
  | 'praying'
  | 'clapping'
  | 'ringingBell'
  | 'seated'
  | 'serving'
  | 'greeting'
  | 'idle';

export type Gesture = 'namaste' | 'blessing' | 'hug' | 'tease' | 'wave' | 'clap' | 'offerMithai' | 'cheekPinch';

/** What prompted a household reaction. */
export type ReactionCause =
  | 'invite'
  | 'welcome'
  | 'ateSweets'
  | 'sweetsOffered'
  | 'giftExchanged'
  | 'giftAcknowledged';

/** A short Hinglish line with its gesture, shown for a bounded time. */
export interface DialogueLine {
  readonly member: HouseholdMemberId;
  readonly text: string;
  readonly gesture: Gesture;
  /** Seconds the line stays up; lines never queue or overlap per member. */
  readonly duration: number;
}

export interface HouseholdMemberSnapshot {
  readonly id: HouseholdMemberId;
  readonly home: HomeId;
  readonly activity: HouseholdActivity;
  readonly placement: Placement;
  /** The line currently shown, if any. */
  readonly line: DialogueLine | null;
}

/**
 * Family and neighbour behaviour. Subscribes to ceremony, sweets and gift
 * events; progresses even while its home is not the active location.
 */
export interface HouseholdModule extends Steppable, Resettable {
  members(): readonly HouseholdMemberSnapshot[];
  /**
   * Choose a reaction for `member`. Returns null while that member is on
   * cooldown or already speaking. Emits `householdReacted`.
   */
  react(member: HouseholdMemberId, cause: ReactionCause): DialogueLine | null;
}

// ── Held items and sweets ────────────────────────────────────────────────

/**
 * Non-cracker items occupying the hands. The selected cracker and the held
 * phuljhari remain owned by `CrackersModule`; this module arbitrates them.
 */
export type HandItem =
  | { readonly kind: 'thali' }
  | { readonly kind: 'sweetsPlate' }
  | { readonly kind: 'giftBox'; readonly box: GiftBoxId };

export type HandItemKind = HandItem['kind'];

/** Item commands, named in `itemRejected` so the UI can word the prompt. */
export type ItemAction = 'pickUpPlate' | 'returnPlate' | 'eat' | 'offer' | 'take' | 'returnItem' | 'deliver';

/** A designated place to put a carried item back; the home tells the two gift boxes' spots apart. */
export interface ReturnSpot {
  readonly item: HandItemKind;
  readonly home: HomeId;
}

export interface HeldItemsModule extends Resettable {
  /** One item at a time; null when the hands are free. */
  readonly hands: HandItem | null;
  /** True once aarti has completed this session. */
  readonly trayServed: boolean;
  /**
   * Null when crackers may be used, else why not. Covers selection,
   * placement, ground ignition and held-sparkler ignition.
   */
  crackerBlock(): CrackerHandsRejection | null;
  /**
   * Occupy the hands (used by the ceremony for the thali and by gift
   * exchange for boxes). Puts away the selected cracker. Emits `itemPickedUp`.
   */
  take(item: HandItem): CommandResult<ItemRejection>;
  /** Take the thali for aarti; refused while another item or a lit phuljhari is in hand. */
  reserveThali(): CommandResult<ItemRejection>;
  /** Free the hands of `kind` if held. Emits `itemReturned`. */
  release(kind: HandItemKind): void;
  /** Put the carried item back on `spot`, which must be its designated one. Emits `itemReturned`. */
  returnTo(spot: ReturnSpot): CommandResult<ItemRejection>;
  /**
   * Consume the carried `kind` (a gift handed over or acknowledged). With
   * `next`, that item goes straight into the freed hands in the same step,
   * e.g. the neighbour's return box. Emits `itemDelivered`, then
   * `itemPickedUp` for `next`.
   */
  deliver(kind: HandItemKind, next?: HandItem): CommandResult<ItemRejection>;
  /** Take the sharing plate from the family tray. */
  pickUpPlate(): CommandResult<ItemRejection>;
  /** Put the plate back on the sweets table. */
  returnPlate(): CommandResult<ItemRejection>;
  /** Eat from the tray; unlimited. Emits `sweetsEaten`. */
  eat(): CommandResult<ItemRejection>;
  /** Offer from the carried plate; unlimited. Emits `sweetsOffered`. */
  offer(member: FamilyMemberId): CommandResult<ItemRejection>;
}

// ── Gift exchange ────────────────────────────────────────────────────────

export type GiftBoxPlace =
  /** On its designated return spot in `home`. */
  | { readonly kind: 'spot'; readonly home: HomeId }
  | { readonly kind: 'hands' }
  /** The return box resting on the family sweets table. */
  | { readonly kind: 'table' }
  /** Outbound box handed over, or return box acknowledged. */
  | { readonly kind: 'delivered' };

export interface GiftBoxSnapshot {
  readonly id: GiftBoxId;
  readonly place: GiftBoxPlace;
}

/** `pending` waits for aarti to complete; `done` happens once per session. */
export type GiftAcknowledgement = 'none' | 'pending' | 'done';

export interface GiftExchangeModule extends Resettable {
  boxes(): readonly GiftBoxSnapshot[];
  /** True once the special neighbour exchange has happened. */
  readonly exchanged: boolean;
  readonly acknowledgement: GiftAcknowledgement;
  /** Pick a box up from its spot. */
  pickUp(box: GiftBoxId): CommandResult<GiftRejection>;
  /** Put a carried box back on its designated spot. */
  putBack(box: GiftBoxId): CommandResult<GiftRejection>;
  /**
   * At the neighbour: atomically consume the outbound box, record the
   * exchange and put the return box in the hands. Emits `giftExchanged`.
   */
  exchange(): CommandResult<GiftRejection>;
  /**
   * Set the return box on the family sweets table. Acknowledged at once
   * after aarti, otherwise pending until `aartiCompleted`. Emits
   * `giftPlaced`, then `giftAcknowledged` exactly once.
   */
  placeOnTable(): CommandResult<GiftRejection>;
}

// ── Interior presentation ────────────────────────────────────────────────

/** Things the player can use inside homes, found by the interaction module. */
export type HomeInteractable =
  | { readonly kind: 'door'; readonly id: DoorwayId; readonly position: Vec3 }
  | { readonly kind: 'puja'; readonly position: Vec3 }
  | { readonly kind: 'tray'; readonly position: Vec3 }
  | { readonly kind: 'person'; readonly id: HouseholdMemberId; readonly position: Vec3 }
  | { readonly kind: 'returnSpot'; readonly item: HandItemKind; readonly home: HomeId; readonly position: Vec3 };

/**
 * Builds rooms, furniture, figures and warm light from gameplay snapshots.
 * Only the active location's expensive presentation is drawn.
 */
export interface InteriorPresentationModule {
  readonly active: LocationId;
  /** Show `location` and stop the presentation of the others. */
  activate(location: LocationId): void;
  /** Fade overlay opacity in [0, 1] for the current transition. */
  setFade(opacity: number): void;
  applyQuality(profile: QualityProfile): void;
}
