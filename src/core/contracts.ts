import type { GameAction } from './actions';
import type { HomeInteractable } from './homes';
import type { QualityProfile } from './quality';
import type {
  Aabb,
  CameraMode,
  CrackerId,
  CrackerType,
  DiyaId,
  ExclusionZone,
  IgnitionRejection,
  NeighbourId,
  PlacementRejection,
  QualityLevel,
  Vec3,
} from './types';

/**
 * Contracts between the PRD modules (PRD → Implementation Decisions →
 * Modules). Each module owns its state and is reached only through its
 * interface here plus the events in `events.ts`.
 *
 * Every type in this file is plain data so rule modules (interaction,
 * crackers, diyas, session, neighbour logic) stay renderer-free and
 * testable in Node. Modules that draw (world, effects, camera view, UI)
 * keep their Three.js objects behind these interfaces.
 */

/** Anything holding session-local state that a fresh visit must clear. */
export interface Resettable {
  reset(): void;
}

/** Anything advanced once per fixed simulation step. */
export interface Steppable {
  /** `dt` is the fixed step in seconds. */
  update(dt: number): void;
}

// ── Session and input ────────────────────────────────────────────────────

export interface SessionModule extends Resettable {
  readonly paused: boolean;
  /** Begin a fresh celebration; emits `sessionStarted`. */
  start(): void;
  /** Pause and release controls; emits `paused`. */
  pause(reason: 'user' | 'focusLost'): void;
  /** Resume after a player gesture; emits `resumed`. */
  resume(): void;
}

export interface InputModule {
  /** Actions gathered since the previous call, oldest first. Empty while paused. */
  drainActions(): readonly GameAction[];
  /** Forget held keys and pointer lock, e.g. on blur or pause. */
  releaseAll(): void;
}

// ── World ────────────────────────────────────────────────────────────────

export interface SurfaceHit {
  readonly point: Vec3;
  /** Unit surface normal. */
  readonly normal: Vec3;
  /** False for surfaces crackers may not sit on (e.g. railings, roofs' edges). */
  readonly supportsPlacement: boolean;
}

export interface DiyaSite {
  readonly id: DiyaId;
  readonly position: Vec3;
}

export interface WorldModule {
  /** Walkable area; the player is kept inside it. */
  readonly bounds: Aabb;
  readonly spawn: Vec3;
  readonly doorways: readonly ExclusionZone[];
  readonly diyaSites: readonly DiyaSite[];
  /** Static areas reserved for neighbours (seating, gatherings). */
  readonly neighbourAreas: readonly ExclusionZone[];
  /** Surface directly below `position`, or null over nothing. */
  surfaceBelow(position: Vec3): SurfaceHit | null;
  /** True when a sphere of `radius` at `position` touches no static geometry. */
  isClear(position: Vec3, radius: number): boolean;
  /** Free vertical distance above `position`, capped at `maxHeight`. */
  clearanceAbove(position: Vec3, maxHeight: number): number;
}

// ── Player movement ──────────────────────────────────────────────────────

export interface MovementIntent {
  /** Axes in [-1, 1] relative to `yaw`. */
  readonly forward: number;
  readonly right: number;
  readonly run: boolean;
  /** Jump pressed since the last step; ignored unless grounded. */
  readonly jump?: boolean;
  /** Facing in radians about +Y; 0 looks down -Z. */
  readonly yaw: number;
}

export interface PlayerPose {
  /** Feet position. */
  readonly position: Vec3;
  readonly yaw: number;
  readonly grounded: boolean;
}

export interface PlayerModule extends Resettable {
  readonly pose: PlayerPose;
  /** Advance by `dt` and return the collision-resolved pose. */
  move(intent: MovementIntent, dt: number): PlayerPose;
}

// ── Camera ───────────────────────────────────────────────────────────────

export interface CameraView {
  readonly mode: CameraMode;
  readonly position: Vec3;
  /** Unit view direction. */
  readonly forward: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

export interface CameraModule extends Resettable {
  readonly mode: CameraMode;
  /** Switch mode; never moves the player. Emits `cameraModeChanged`. */
  setMode(mode: CameraMode): void;
  toggleMode(): void;
  /** Apply a mouse delta to yaw/pitch. */
  look(dx: number, dy: number): void;
  /** Resolve the active view for this pose, avoiding obstacles in third-person. */
  update(pose: PlayerPose, dt: number): CameraView;
}

// ── Interaction and placement ────────────────────────────────────────────

/** Outdoor crackers and diyas, plus the homes expansion's doors, puja, tray, people and return spots. */
export type Interactable =
  | { readonly kind: 'cracker'; readonly id: CrackerId; readonly position: Vec3 }
  | { readonly kind: 'diya'; readonly id: DiyaId; readonly position: Vec3 }
  | HomeInteractable;

export interface PlacementRequest {
  readonly type: CrackerType;
  readonly playerPosition: Vec3;
  /** Point the player is aiming at. */
  readonly target: Vec3;
}

export interface PlacementPreview {
  readonly type: CrackerType;
  readonly position: Vec3;
  /**
   * Which way the cracker lies, radians about +Y like the player's yaw: a
   * ladi's string runs this way from its fuse. 0 when omitted.
   */
  readonly heading?: number;
}

export type PlacementResult =
  | { readonly ok: true; readonly preview: PlacementPreview }
  | { readonly ok: false; readonly reason: PlacementRejection };

export interface InteractionModule {
  /** Nearest usable object within reach of the view, if any. */
  findInteractable(view: CameraView): Interactable | null;
  /** Validate a candidate placement without creating anything. */
  validatePlacement(request: PlacementRequest): PlacementResult;
}

// ── Crackers ─────────────────────────────────────────────────────────────

export type CrackerState = 'placed' | 'fuseBurning' | 'active' | 'finished';

export interface CrackerSnapshot {
  readonly id: CrackerId;
  readonly type: CrackerType;
  readonly state: CrackerState;
  readonly position: Vec3;
  /** Seconds spent in the current state. */
  readonly stateTime: number;
  /** Which way it lies (see `PlacementPreview.heading`); 0 when omitted. */
  readonly heading?: number;
  /** Ladi only: bangers popped so far, from the fuse end. */
  readonly popped?: number;
}

export type PlaceResult =
  | { readonly ok: true; readonly id: CrackerId }
  | { readonly ok: false; readonly reason: PlacementRejection };

export type IgniteResult = { readonly ok: true } | { readonly ok: false; readonly reason: IgnitionRejection };

export interface HeldItem {
  readonly id: CrackerId;
  readonly type: 'phuljhari';
  readonly lit: boolean;
}

export interface CrackersModule extends Steppable, Resettable {
  readonly selected: CrackerType;
  /** The handheld phuljhari while it is selected, else null. */
  readonly held: HeldItem | null;
  /** Emits `crackerSelected`. */
  select(type: CrackerType): void;
  /**
   * Create a ground cracker from a validated preview. Emits `crackerPlaced`
   * or `placementRejected` (e.g. capacity).
   */
  place(preview: PlacementPreview): PlaceResult;
  /** Light a placed cracker once. Emits `fuseLit` or `ignitionRejected`. */
  ignite(id: CrackerId): IgniteResult;
  /** Light the held phuljhari. */
  igniteHeld(): IgniteResult;
  get(id: CrackerId): CrackerSnapshot | undefined;
  /** Every placed ground cracker not yet finished; the phuljhari is in `held`. */
  list(): readonly CrackerSnapshot[];
}

// ── Fireworks effects ────────────────────────────────────────────────────

export interface EffectStats {
  readonly activeEffects: number;
  readonly liveParticles: number;
  readonly dynamicLights: number;
}

/** Subscribes to cracker events; draws pooled particles, trails and flashes. */
export interface EffectsModule extends Steppable, Resettable {
  readonly stats: EffectStats;
  applyQuality(profile: QualityProfile): void;
}

// ── Diyas ────────────────────────────────────────────────────────────────

export interface DiyasModule extends Resettable {
  /** Light a diya. Returns true only the first time; repeats are harmless. */
  light(id: DiyaId): boolean;
  isLit(id: DiyaId): boolean;
  readonly litCount: number;
}

// ── Ambient neighbours ───────────────────────────────────────────────────

export interface NeighbourSnapshot {
  readonly id: NeighbourId;
  readonly position: Vec3;
}

export interface NeighboursModule extends Steppable, Resettable {
  /** Current positions, used as placement exclusions. */
  positions(): readonly NeighbourSnapshot[];
}

// ── Audio ────────────────────────────────────────────────────────────────

export interface AudioModule extends Resettable {
  /** Start the audio context; must follow a player gesture. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  setMuted(muted: boolean): void;
  /** Master gain in [0, 1]. */
  setMasterGain(gain: number): void;
  setListener(view: CameraView): void;
  readonly activeVoices: number;
  applyQuality(profile: QualityProfile): void;
}

// ── Interface and quality ────────────────────────────────────────────────

export interface UiModule {
  setSelection(type: CrackerType): void;
  /** Contextual prompt such as "E — light anar"; null hides it. */
  showPrompt(text: string | null): void;
  showRejection(reason: PlacementRejection | IgnitionRejection): void;
  setPaused(paused: boolean): void;
}

export interface QualityModule {
  readonly profile: QualityProfile;
  /** Emits `qualityChanged`. */
  setLevel(level: QualityLevel): void;
}
