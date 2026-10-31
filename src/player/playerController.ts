import RAPIER from '@dimforge/rapier3d-compat';
import type { MovementIntent, PlayerModule, PlayerPose } from '../core/contracts';
import { TUNING, type Tuning } from '../core/tuning';
import type { Aabb, Vec3 } from '../core/types';

/** Capsule proportions; the eye sits at `TUNING.player.eyeHeight`. */
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.75;
/** Gap the controller keeps between the capsule and geometry. */
const SKIN = 0.02;
/** How far below the feet the controller looks to stay glued to steps going down. */
const SNAP_DISTANCE = 0.35;
/** Narrowest free ledge the controller will autostep onto. */
const STEP_MIN_WIDTH = 0.15;
/** Cap on fall speed so a long fall stays a few metres per step at most. */
const MAX_FALL_SPEED = 20;
/** Collision normals flatter than this (|y|) count as walls. */
const WALL_NORMAL_MAX_Y = 0.3;
/** Rise lost to collision beyond this (metres per step) means a ceiling stopped the jump. */
const CEILING_TOLERANCE = 1e-4;

const HALF_SEGMENT = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;
/** Feet → capsule centre. */
const CENTRE_OFFSET = PLAYER_HEIGHT / 2 + SKIN;

export interface PlayerControllerOptions {
  /** A Rapier world whose static colliders are already added. */
  readonly physics: RAPIER.World;
  /** Walkable region; the player is clamped inside it as a backstop to the boundary walls. */
  readonly bounds: Aabb;
  /** Feet position at the start of a visit. */
  readonly spawn: Vec3;
  readonly spawnYaw?: number;
  readonly tuning?: Tuning;
}

/** World-space direction for "forward" at `yaw`; yaw 0 looks down -Z. */
export function forwardFor(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** World-space direction for "right" at `yaw`. */
export function rightFor(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/**
 * Player movement on a Rapier kinematic character controller.
 *
 * Each `move` turns the intent into a target horizontal velocity (walk or
 * run, relative to `yaw`), eases the current velocity towards it, adds
 * gravity, and lets the controller resolve collisions: it slides along walls,
 * autosteps stairs, snaps down to the ground and refuses slopes steeper than
 * `maxSlope`. A jump only leaves the ground when grounded, so there is no
 * double jump, and a ceiling overhead ends the rise early.
 *
 * The capsule is a parentless collider moved directly, so its position is
 * current between physics steps and `move` may run any number of times per
 * frame. The world's static colliders must be in the broad phase, i.e. the
 * world has been stepped at least once after adding them.
 */
export class PlayerController implements PlayerModule {
  readonly collider: RAPIER.Collider;
  private readonly physics: RAPIER.World;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly tuning: Tuning;
  private readonly spawnBounds: Aabb;
  private readonly spawn: Vec3;
  private readonly spawnYaw: number;
  /** Walkable region of the current location; the street's until `teleport` says otherwise. */
  private bounds: Aabb;
  /** Where a fall out of the current location lands the player. */
  private recovery: Vec3;
  private velocity = { x: 0, z: 0 };
  /** Vertical speed in m/s, positive upwards. */
  private verticalSpeed = 0;
  private current: PlayerPose;

  constructor(options: PlayerControllerOptions) {
    this.physics = options.physics;
    this.tuning = options.tuning ?? TUNING;
    this.spawnBounds = options.bounds;
    this.bounds = options.bounds;
    this.spawn = options.spawn;
    this.recovery = options.spawn;
    this.spawnYaw = options.spawnYaw ?? 0;

    const { maxStepHeight, maxSlope } = this.tuning.player;
    const slope = (maxSlope * Math.PI) / 180;
    this.controller = this.physics.createCharacterController(SKIN);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(maxStepHeight, STEP_MIN_WIDTH, false);
    this.controller.enableSnapToGround(SNAP_DISTANCE);
    this.controller.setMaxSlopeClimbAngle(slope);
    this.controller.setMinSlopeSlideAngle(slope);
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.collider = this.physics.createCollider(RAPIER.ColliderDesc.capsule(HALF_SEGMENT, PLAYER_RADIUS));
    this.current = this.respawn(this.spawnYaw);
  }

  get pose(): PlayerPose {
    return this.current;
  }

  /** Current horizontal speed in m/s, for animation and tests. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  move(intent: MovementIntent, dt: number): PlayerPose {
    if (dt <= 0) return this.current;
    const { walkSpeed, runSpeed, acceleration, deceleration, jumpSpeed, gravity } = this.tuning.player;

    // Target velocity from the intent, with diagonals no faster than straight.
    let forward = clampAxis(intent.forward);
    let right = clampAxis(intent.right);
    const length = Math.hypot(forward, right);
    if (length > 1) {
      forward /= length;
      right /= length;
    }
    const speed = intent.run ? runSpeed : walkSpeed;
    const f = forwardFor(intent.yaw);
    const r = rightFor(intent.yaw);
    const target = { x: (f.x * forward + r.x * right) * speed, z: (f.z * forward + r.z * right) * speed };

    // Ease towards it: accelerate while input is held, brake once it isn't.
    const rate = length > 0 ? acceleration : deceleration;
    const dx = target.x - this.velocity.x;
    const dz = target.z - this.velocity.z;
    const gap = Math.hypot(dx, dz);
    const step = rate * dt;
    if (gap <= step) {
      this.velocity = target;
    } else {
      this.velocity = { x: this.velocity.x + (dx / gap) * step, z: this.velocity.z + (dz / gap) * step };
    }

    // Gravity only while airborne: on the ground, snap-to-ground keeps the
    // capsule down steps and slopes, and pressing into the floor every step
    // makes the controller stall now and then.
    if (this.current.grounded) {
      if (intent.jump) this.verticalSpeed = jumpSpeed;
    } else {
      this.verticalSpeed = Math.max(this.verticalSpeed - gravity * dt, -MAX_FALL_SPEED);
    }
    // At rest ask for -0, not +0: Rapier reads a +0 rise as moving up and
    // the capsule drifts off the floor indoors.
    const desired = { x: this.velocity.x * dt, y: this.verticalSpeed * dt || -0, z: this.velocity.z * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    const moved = this.controller.computedMovement();
    // Still touching the floor on take-off is not landing.
    const rising = this.verticalSpeed > 0;
    const grounded = !rising && this.controller.computedGrounded();
    if (grounded) this.verticalSpeed = 0;
    else if (rising && moved.y < desired.y - CEILING_TOLERANCE) this.verticalSpeed = 0;
    this.stopAgainstWalls();

    const centre = this.collider.translation();
    const feet = { x: centre.x + moved.x, y: centre.y + moved.y - CENTRE_OFFSET, z: centre.z + moved.z };

    // Backstop: somehow outside the walkable region, or fallen out of the
    // world → return to spawn rather than leave the player stranded.
    if (feet.y < this.bounds.min.y) return (this.current = this.respawn(intent.yaw));
    return (this.current = this.place(this.clampToBounds(feet), intent.yaw, grounded));
  }

  /**
   * Put the player at rest at `placement`, e.g. through a door fade, and
   * keep them inside `bounds` from now on (the room they arrive in). A fall
   * out of that location recovers to `placement`.
   */
  teleport(placement: { readonly position: Vec3; readonly yaw: number }, bounds: Aabb = this.bounds): PlayerPose {
    this.bounds = bounds;
    this.recovery = placement.position;
    this.velocity = { x: 0, z: 0 };
    this.verticalSpeed = 0;
    return (this.current = this.place(placement.position, placement.yaw, true));
  }

  /** Back to spawn, at rest, inside the street's bounds, for a fresh visit. */
  reset(): void {
    this.bounds = this.spawnBounds;
    this.recovery = this.spawn;
    this.current = this.respawn(this.spawnYaw);
  }

  /** Remove the capsule and controller from the physics world. */
  dispose(): void {
    this.physics.removeCollider(this.collider, false);
    this.physics.removeCharacterController(this.controller);
  }

  /**
   * Drop the velocity pressing into any wall hit this step, so pushing into
   * a wall doesn't build up speed that is released on leaving it.
   */
  private stopAgainstWalls(): void {
    for (let i = 0, n = this.controller.numComputedCollisions(); i < n; i++) {
      const normal = this.controller.computedCollision(i)?.normal1;
      if (!normal || Math.abs(normal.y) > WALL_NORMAL_MAX_Y) continue;
      const into = this.velocity.x * normal.x + this.velocity.z * normal.z;
      if (into < 0) this.velocity = { x: this.velocity.x - into * normal.x, z: this.velocity.z - into * normal.z };
    }
  }

  private respawn(yaw: number): PlayerPose {
    this.velocity = { x: 0, z: 0 };
    this.verticalSpeed = 0;
    return this.place(this.recovery, yaw, true);
  }

  private place(feet: Vec3, yaw: number, grounded: boolean): PlayerPose {
    this.collider.setTranslation({ x: feet.x, y: feet.y + CENTRE_OFFSET, z: feet.z });
    return { position: { x: feet.x, y: feet.y, z: feet.z }, yaw, grounded };
  }

  private clampToBounds(p: Vec3): Vec3 {
    const { min, max } = this.bounds;
    const x = Math.min(Math.max(p.x, min.x + PLAYER_RADIUS), max.x - PLAYER_RADIUS);
    const z = Math.min(Math.max(p.z, min.z + PLAYER_RADIUS), max.z - PLAYER_RADIUS);
    return x === p.x && z === p.z ? p : { x, y: p.y, z };
  }
}

function clampAxis(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, -1), 1) : 0;
}
