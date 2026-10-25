import { EventBus } from './eventBus';
import type {
  AartiRejection,
  AartiSongId,
  CrackerAction,
  CrackerHandsRejection,
  DialogueLine,
  DoorwayId,
  FamilyMemberId,
  GiftRejection,
  HandItem,
  ItemAction,
  ItemRejection,
  LocationId,
  NeighbourHostId,
  TransitionRejection,
} from './homes';
import type { LadiChain } from './ladi';
import type { QualityProfile } from './quality';
import type {
  BurstPattern,
  CameraMode,
  CrackerId,
  CrackerType,
  DiyaId,
  IgnitionRejection,
  NeighbourId,
  PlacementRejection,
  RocketFlight,
  Vec3,
} from './types';

/**
 * Every game-wide event and its payload. Rule modules publish; effects,
 * audio, UI and neighbours subscribe. Payloads are plain data.
 */
export interface GameEvents {
  sessionStarted: Record<string, never>;
  /** Fresh celebration: modules drop session-local state. */
  sessionReset: Record<string, never>;
  paused: { readonly reason: 'user' | 'focusLost' };
  resumed: Record<string, never>;

  cameraModeChanged: { readonly mode: CameraMode };

  crackerSelected: { readonly type: CrackerType };
  crackerPlaced: { readonly id: CrackerId; readonly type: CrackerType; readonly position: Vec3 };
  placementRejected: { readonly type: CrackerType; readonly reason: PlacementRejection };
  fuseLit: {
    readonly id: CrackerId;
    readonly type: CrackerType;
    readonly position: Vec3;
    /** Which way a ladi's string runs (see `LADI_STRING`); absent for other crackers. */
    readonly heading?: number;
  };
  ignitionRejected: { readonly id: CrackerId; readonly reason: IgnitionRejection };
  crackerActive: {
    readonly id: CrackerId;
    readonly type: CrackerType;
    readonly position: Vec3;
    /** A rocket's path to its burst; absent for other crackers. */
    readonly flight?: RocketFlight;
    /** A ladi's rolled pops and which way its string runs; absent for other crackers. */
    readonly ladi?: { readonly chain: LadiChain; readonly heading: number };
  };
  /**
   * One banger of an active ladi going off at `position` (its middle).
   * `index` counts pops from 0 in chain order; `loud` marks the odd harder bang.
   */
  ladiPop: {
    readonly id: CrackerId;
    readonly index: number;
    readonly banger: number;
    readonly position: Vec3;
    readonly loud: boolean;
  };
  /** `reclaimed` means removed by the capacity policy before it ran. */
  crackerFinished: {
    readonly id: CrackerId;
    readonly type: CrackerType;
    readonly reason: 'completed' | 'reclaimed';
  };
  /** Rocket reached apex. Colours are 0xRRGGBB integers. */
  /** A rocket launched in another part of town, beyond the map: from `position` up to `apex` in `rise` seconds. */
  distantLaunch: { readonly position: Vec3; readonly apex: Vec3; readonly rise: number };
  /** A shell bursting over another part of town, beyond the map. */
  distantBurst: { readonly position: Vec3 };
  burst: {
    readonly id: CrackerId;
    readonly position: Vec3;
    readonly pattern: BurstPattern;
    readonly colours: readonly number[];
  };

  diyaLit: { readonly id: DiyaId; readonly position: Vec3 };

  neighbourReacted: { readonly id: NeighbourId; readonly reaction: 'watch' | 'cheer' };

  qualityChanged: { readonly profile: QualityProfile };

  // ── Homes expansion (see `homes.ts`) ──

  /** A door fade began; control is suppressed until it ends. */
  transitionStarted: {
    readonly doorway: DoorwayId;
    readonly from: LocationId;
    readonly to: LocationId;
    readonly duration: number;
  };
  /** The player now stands in `to`, at the fade's midpoint. */
  locationChanged: { readonly doorway: DoorwayId; readonly from: LocationId; readonly to: LocationId };
  transitionRejected: { readonly doorway: DoorwayId; readonly reason: TransitionRejection };

  /** Playback starts at `elapsed` (0 on the first join, the offset on rejoin). */
  aartiJoined: { readonly song: AartiSongId; readonly elapsed: number; readonly playbackId: number };
  /** Playback stops; ceremony time continues. */
  aartiLeft: { readonly song: AartiSongId; readonly elapsed: number };
  /** The new song starts from the beginning and sets the full duration. */
  aartiSongChanged: { readonly song: AartiSongId; readonly duration: number; readonly playbackId: number };
  /** Once per session, whether or not the player is participating. */
  aartiCompleted: { readonly song: AartiSongId; readonly participating: boolean };
  aartiRejected: { readonly reason: AartiRejection };
  /** A recording failed to load or decode; playback stays silent, ceremony time is unaffected. */
  aartiAudioFailed: { readonly song: AartiSongId; readonly message: string };

  itemPickedUp: { readonly item: HandItem };
  itemReturned: { readonly item: HandItem };
  itemRejected: { readonly action: ItemAction; readonly reason: ItemRejection };
  /** The carried item was consumed rather than put back, e.g. a gift handed over. */
  itemDelivered: { readonly item: HandItem };
  /** A cracker action was refused because the hands hold something else. */
  crackerBlocked: { readonly action: CrackerAction; readonly reason: CrackerHandsRejection };
  /** A lit phuljhari was put out at a home's door; crackers stay outdoors. */
  phuljhariPutOut: { readonly id: CrackerId };
  sweetsEaten: Record<string, never>;
  sweetsOffered: { readonly member: FamilyMemberId };

  /** The outbound box is in the receiver's hands; the handover has begun. */
  giftReceived: { readonly host: NeighbourHostId };
  /** The once-per-session neighbour exchange; the return box is now in hand. */
  giftExchanged: Record<string, never>;
  /** The return box is on the family table; acknowledgement waits for aarti if pending. */
  giftPlaced: { readonly pendingAcknowledgement: boolean };
  /** The family's one-time reaction to the return box. */
  giftAcknowledged: Record<string, never>;
  giftRejected: { readonly reason: GiftRejection };

  householdReacted: { readonly line: DialogueLine };
}

export type GameEventName = keyof GameEvents;

export type GameEventBus = EventBus<GameEvents>;

export function createGameEventBus(): GameEventBus {
  return new EventBus<GameEvents>();
}
