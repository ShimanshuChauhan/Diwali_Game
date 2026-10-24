import { EventBus } from './eventBus';
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
  fuseLit: { readonly id: CrackerId; readonly type: CrackerType; readonly position: Vec3 };
  ignitionRejected: { readonly id: CrackerId; readonly reason: IgnitionRejection };
  crackerActive: {
    readonly id: CrackerId;
    readonly type: CrackerType;
    readonly position: Vec3;
    /** A rocket's path to its burst; absent for other crackers. */
    readonly flight?: RocketFlight;
  };
  /** `reclaimed` means removed by the capacity policy before it ran. */
  crackerFinished: {
    readonly id: CrackerId;
    readonly type: CrackerType;
    readonly reason: 'completed' | 'reclaimed';
  };
  /** Rocket reached apex. Colours are 0xRRGGBB integers. */
  burst: {
    readonly id: CrackerId;
    readonly position: Vec3;
    readonly pattern: BurstPattern;
    readonly colours: readonly number[];
  };

  diyaLit: { readonly id: DiyaId; readonly position: Vec3 };

  neighbourReacted: { readonly id: NeighbourId; readonly reaction: 'watch' | 'cheer' };

  qualityChanged: { readonly profile: QualityProfile };
}

export type GameEventName = keyof GameEvents;

export type GameEventBus = EventBus<GameEvents>;

export function createGameEventBus(): GameEventBus {
  return new EventBus<GameEvents>();
}
