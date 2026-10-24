import RAPIER from '@dimforge/rapier3d-compat';
import type { CameraModule, CameraView, PlayerPose } from '../core/contracts';
import type { GameEventBus } from '../core/events';
import { TUNING, type Tuning } from '../core/tuning';
import type { CameraMode, Vec3 } from '../core/types';

/** Range the look sensitivity may be set to (radians per pixel). */
export const MIN_SENSITIVITY = 0.0005;
export const MAX_SENSITIVITY = 0.01;

/** Boom length regained per second once an obstacle clears; shortening is instant. */
const BOOM_RECOVER_SPEED = 6;

/**
 * Free distance from `origin` along the unit `direction`, capped at
 * `maxDistance`: how far the third-person camera can sit before it would
 * touch geometry.
 */
export type BoomCaster = (origin: Vec3, direction: Vec3, maxDistance: number) => number;

export interface RapierBoomCasterOptions {
  /** Gap kept between the camera and obstacles; the radius of the cast ball. */
  readonly margin: number;
  /** Collider to ignore, normally the player's capsule. */
  readonly exclude?: RAPIER.Collider;
}

/**
 * Boom caster that sweeps a ball through the Rapier world, so the camera
 * keeps `margin` from walls, roofs and stairs rather than only from the
 * single line a ray would test. The world's static colliders must be in the
 * broad phase (stepped at least once after adding them).
 */
export function rapierBoomCaster(physics: RAPIER.World, options: RapierBoomCasterOptions): BoomCaster {
  const ball = new RAPIER.Ball(options.margin);
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  return (origin, direction, maxDistance) => {
    const hit = physics.castShape(
      origin,
      rotation,
      direction,
      ball,
      0,
      maxDistance,
      false,
      undefined,
      undefined,
      options.exclude,
    );
    return hit ? Math.min(Math.max(hit.time_of_impact, 0), maxDistance) : maxDistance;
  };
}

/** Unit view direction for `yaw`/`pitch`; yaw 0 looks down -Z, positive pitch looks up. */
export function viewForward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

export interface CameraRigOptions {
  /** Obstacle query for the third-person boom; without one the boom is never shortened. */
  readonly obstacles?: BoomCaster;
  readonly bus?: GameEventBus;
  readonly spawnYaw?: number;
  readonly mode?: CameraMode;
  readonly tuning?: Tuning;
}

/**
 * The view onto the player. First-person sits at eye height; third-person
 * hangs the camera on a boom behind and above the player's head, along the
 * reverse view direction, and pulls it in to the free distance reported by
 * the obstacle query so it never passes through walls or roofs. The boom
 * shortens immediately and lengthens again gradually, so clearing a corner
 * doesn't snap the view.
 *
 * The rig owns yaw and pitch; movement reads `yaw` to steer the player.
 * Changing mode touches only the view, never the player.
 */
export class CameraRig implements CameraModule {
  private readonly tuning: Tuning;
  private readonly obstacles: BoomCaster | undefined;
  private readonly bus: GameEventBus | undefined;
  private readonly spawnYaw: number;
  private readonly initialMode: CameraMode;
  private currentMode: CameraMode;
  private currentYaw: number;
  private currentPitch = 0;
  private lookSensitivity: number;
  /** Current third-person boom length; negative until first resolved after a switch. */
  private boom = -1;

  constructor(options: CameraRigOptions = {}) {
    this.tuning = options.tuning ?? TUNING;
    this.obstacles = options.obstacles;
    this.bus = options.bus;
    this.spawnYaw = options.spawnYaw ?? 0;
    this.initialMode = options.mode ?? 'firstPerson';
    this.currentMode = this.initialMode;
    this.currentYaw = this.spawnYaw;
    this.lookSensitivity = this.tuning.camera.mouseSensitivity;
  }

  get mode(): CameraMode {
    return this.currentMode;
  }

  get yaw(): number {
    return this.currentYaw;
  }

  get pitch(): number {
    return this.currentPitch;
  }

  /** Radians of turn per pixel of mouse movement. */
  get sensitivity(): number {
    return this.lookSensitivity;
  }

  set sensitivity(value: number) {
    if (!Number.isFinite(value)) return;
    this.lookSensitivity = Math.min(Math.max(value, MIN_SENSITIVITY), MAX_SENSITIVITY);
  }

  setMode(mode: CameraMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.boom = -1;
    this.bus?.emit('cameraModeChanged', { mode });
  }

  toggleMode(): void {
    this.setMode(this.currentMode === 'firstPerson' ? 'thirdPerson' : 'firstPerson');
  }

  look(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const { pitchLimit } = this.tuning.camera;
    this.currentYaw = wrapAngle(this.currentYaw - dx * this.lookSensitivity);
    this.currentPitch = Math.min(Math.max(this.currentPitch - dy * this.lookSensitivity, -pitchLimit), pitchLimit);
  }

  update(pose: PlayerPose, dt: number): CameraView {
    const { eyeHeight } = this.tuning.player;
    const feet = pose.position;
    const eye = { x: feet.x, y: feet.y + eyeHeight, z: feet.z };
    const forward = viewForward(this.currentYaw, this.currentPitch);
    if (this.currentMode === 'firstPerson') return this.view(eye, forward);

    // Aim the boom at the unobstructed camera spot, but sweep it from the
    // eye: that point is inside the player's capsule, so it is always clear.
    const { thirdPersonDistance, thirdPersonHeight } = this.tuning.camera;
    const target = {
      x: feet.x - forward.x * thirdPersonDistance,
      y: feet.y + thirdPersonHeight - forward.y * thirdPersonDistance,
      z: feet.z - forward.z * thirdPersonDistance,
    };
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) return this.view(eye, forward);
    const dir = { x: dx / length, y: dy / length, z: dz / length };
    const free = this.obstacles ? this.obstacles(eye, dir, length) : length;

    if (this.boom < 0 || this.boom > free) this.boom = free;
    else this.boom = Math.min(free, this.boom + BOOM_RECOVER_SPEED * Math.max(dt, 0));

    const position = { x: eye.x + dir.x * this.boom, y: eye.y + dir.y * this.boom, z: eye.z + dir.z * this.boom };
    return this.view(position, forward);
  }

  /**
   * Look along `yaw`, level, e.g. at a door fade's arrival pose. The mode is
   * kept; the third-person boom is re-resolved from scratch at the new spot.
   */
  face(yaw: number): void {
    if (!Number.isFinite(yaw)) return;
    this.currentYaw = wrapAngle(yaw);
    this.currentPitch = 0;
    this.boom = -1;
  }

  /** Back to the default mode and the spawn facing for a fresh visit. */
  reset(): void {
    this.currentYaw = this.spawnYaw;
    this.currentPitch = 0;
    this.setMode(this.initialMode);
    this.boom = -1;
  }

  private view(position: Vec3, forward: Vec3): CameraView {
    return { mode: this.currentMode, position, forward, yaw: this.currentYaw, pitch: this.currentPitch };
  }
}

/** Keep yaw in (-π, π] so it never grows without bound. */
function wrapAngle(angle: number): number {
  const wrapped = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
