import type { CameraMode, Vec3 } from '../core/types';

/**
 * Procedural walk/run cycle for the player character. Plain data and pure
 * functions, so the animation rules stay testable without a renderer; the
 * Three.js model in `character.ts` only reads the numbers.
 */

/** Strides per metre travelled; one stride is half a full cycle. */
const STRIDES_PER_METRE = 0.75;
/** Breaths per second while standing still. */
const IDLE_RATE = 0.35;
/** Speed (m/s) at which the cycle reaches full swing; the run speed by default. */
const FULL_SWING_SPEED = 5;
/** Below this speed the character counts as standing. */
const STILL_SPEED = 0.05;
/** How quickly the swing amplitude follows the speed, per second. */
const BLEND_RATE = 8;

/** Peak leg swing (radians) at full speed. */
export const MAX_LEG_SWING = 0.7;
/** Peak free-arm swing (radians) at full speed. */
export const MAX_ARM_SWING = 0.55;
/** Peak vertical body bob (metres) at full speed. */
export const MAX_BOB = 0.06;
/** Chest rise (metres) while breathing at rest. */
export const IDLE_BOB = 0.012;

/**
 * Right-hand socket in the character's local frame (x right, y up, -z
 * forward), relative to the feet: the arm is bent forward to hold a
 * phuljhari out in front, clear of the body.
 */
export const HAND_SOCKET = { right: 0.22, up: 1.1, forward: 0.42 } as const;

export interface GaitState {
  /** Cycle phase in radians, kept in [0, 2π). */
  readonly phase: number;
  /** Breathing phase in radians, kept in [0, 2π). */
  readonly breath: number;
  /** Swing amplitude in [0, 1], eased towards the current speed. */
  readonly blend: number;
}

export interface GaitPose {
  /** Left leg pitch; the right leg mirrors it. Positive swings the foot forward. */
  readonly legSwing: number;
  /** Free (left) arm pitch, opposite to the left leg. */
  readonly armSwing: number;
  /** Vertical offset of the body above the feet. */
  readonly bob: number;
}

export const REST_GAIT: GaitState = { phase: 0, breath: 0, blend: 0 };

/** Advance the cycle by `dt` seconds at a horizontal `speed` in m/s. */
export function stepGait(state: GaitState, speed: number, dt: number): GaitState {
  if (!(dt > 0)) return state;
  const s = Number.isFinite(speed) ? Math.max(speed, 0) : 0;
  const target = s < STILL_SPEED ? 0 : Math.min(s / FULL_SWING_SPEED, 1);
  const ease = 1 - Math.exp(-BLEND_RATE * dt);
  const blend = state.blend + (target - state.blend) * ease;
  // Phase follows distance travelled, so feet don't slide at any speed.
  const phase = wrap(state.phase + s * STRIDES_PER_METRE * Math.PI * dt);
  const breath = wrap(state.breath + IDLE_RATE * 2 * Math.PI * dt);
  return { phase, breath, blend: blend < 1e-4 ? 0 : blend };
}

/** Limb angles and body bob for a gait state. */
export function gaitPose(state: GaitState): GaitPose {
  const swing = Math.sin(state.phase);
  // Two bobs per cycle: the body is highest as each leg passes under it.
  const stride = Math.abs(Math.cos(state.phase)) * MAX_BOB * state.blend;
  const breathing = (Math.sin(state.breath) * 0.5 + 0.5) * IDLE_BOB * (1 - state.blend);
  return {
    legSwing: swing * MAX_LEG_SWING * state.blend,
    armSwing: -swing * MAX_ARM_SWING * state.blend,
    bob: stride + breathing,
  };
}

/** The body is drawn only in third-person; first-person sees from inside it. */
export function bodyVisible(mode: CameraMode): boolean {
  return mode === 'thirdPerson';
}

/**
 * World position of the right-hand socket for a character standing at
 * `feet`, facing `yaw` (0 looks down -Z), raised by the body `bob`.
 */
export function handSocketFor(feet: Vec3, yaw: number, bob = 0): Vec3 {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const { right, up, forward } = HAND_SOCKET;
  return {
    x: feet.x + cos * right - sin * forward,
    y: feet.y + up + bob,
    z: feet.z - sin * right - cos * forward,
  };
}

function wrap(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}
