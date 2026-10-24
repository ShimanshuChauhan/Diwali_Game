import * as THREE from 'three';
import type { CameraMode, Vec3 } from '../core/types';

/**
 * The aarti thali in the player's hands (PRD → Aarti state and timing;
 * Controls and layout). The circling motion is plain data and pure
 * functions, so it stays testable without a renderer; the Three.js model
 * below only reads the numbers. It follows the ceremony's `circling` intent
 * and never feeds back into ceremony time.
 */

/** Circles per second while the action is held. */
export const CIRCLE_RATE = 0.45;
/** How quickly the circle grows when held and settles when released, per second. */
const SWEEP_RATE = 5;
/** Below this the thali counts as at rest. */
const REST_SWEEP = 1e-3;

/** Radius of the circle, metres: smaller in first person, where it sits close to the eye. */
export const CIRCLE_RADIUS: Readonly<Record<CameraMode, number>> = { firstPerson: 0.09, thirdPerson: 0.11 };

/** First-person hold: the plate's centre relative to the eye, metres; low and central. */
const VIEW_HOLD = { right: 0.02, up: -0.3, forward: 0.52 } as const;

/**
 * Third-person hold: the plate's centre in the character's frame (x right,
 * y up above the feet, -z forward), out in front of the chest so the right
 * hand can carry it round the whole circle.
 */
export const BODY_HOLD = { right: 0.1, up: 1.15, forward: 0.3 } as const;
/** The palm sits this far under the plate's centre. */
const PALM_DROP = 0.035;

export interface ThaliMotion {
  /** Position round the circle in radians, kept in [0, 2π); 0 is the top. */
  readonly phase: number;
  /** How much of the circle is drawn, 0 (resting) to 1 (full circle). */
  readonly sweep: number;
}

export const THALI_REST: ThaliMotion = { phase: 0, sweep: 0 };

/**
 * Advance the motion by `dt` seconds of rendered, unpaused time. While
 * `circling` the circle eases out to full size; once released it keeps
 * turning as it shrinks, so the thali glides back to rest instead of
 * stopping wherever it was.
 */
export function stepThali(motion: ThaliMotion, circling: boolean, dt: number): ThaliMotion {
  if (!(dt > 0)) return motion;
  const ease = 1 - Math.exp(-SWEEP_RATE * dt);
  const sweep = motion.sweep + ((circling ? 1 : 0) - motion.sweep) * ease;
  if (!circling && sweep < REST_SWEEP) return { phase: motion.phase, sweep: 0 };
  return { phase: wrap(motion.phase + CIRCLE_RATE * 2 * Math.PI * dt), sweep };
}

/**
 * The plate's offset from its rest point in the holder's right/up plane:
 * clockwise as the holder sees it, starting from the top, as aarti is
 * performed.
 */
export function thaliOffset(motion: ThaliMotion, radius: number): { readonly right: number; readonly up: number } {
  const r = radius * motion.sweep;
  return { right: Math.sin(motion.phase) * r, up: Math.cos(motion.phase) * r };
}

/**
 * Where the plate sits in the character's frame for `motion`, metres: the
 * rest hold plus the circle. Third person only.
 */
export function bodyThaliPoint(motion: ThaliMotion): { readonly right: number; readonly up: number; readonly forward: number } {
  const offset = thaliOffset(motion, CIRCLE_RADIUS.thirdPerson);
  return { right: BODY_HOLD.right + offset.right, up: BODY_HOLD.up + offset.up, forward: BODY_HOLD.forward };
}

/**
 * Body-space target for the right palm (x right, y up, -z forward, the
 * frame `Figure.reachRight` takes), just under the plate.
 */
export function thaliPalm(motion: ThaliMotion, out: THREE.Vector3): THREE.Vector3 {
  const point = bodyThaliPoint(motion);
  return out.set(point.right, point.up - PALM_DROP, -point.forward);
}

/** World position of the plate for a character at `feet` facing `yaw` (0 looks down -Z). */
export function heldThali(feet: Vec3, yaw: number, motion: ThaliMotion, bob = 0): Vec3 {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const { right, up, forward } = bodyThaliPoint(motion);
  return {
    x: feet.x + cos * right - sin * forward,
    y: feet.y + up + bob,
    z: feet.z - sin * right - cos * forward,
  };
}

/**
 * Where the plate sits in first person: low in the middle of the view, so
 * it stays in sight as the player looks round, circling in the view plane.
 */
export function firstPersonThali(camera: THREE.Camera, motion: ThaliMotion, out: THREE.Vector3): THREE.Vector3 {
  const offset = thaliOffset(motion, CIRCLE_RADIUS.firstPerson);
  const right = VIEW_HOLD.right + offset.right;
  const up = VIEW_HOLD.up + offset.up;
  const e = camera.matrixWorld.elements;
  // Camera basis: columns are right, up and back.
  return out.set(
    camera.position.x + e[0]! * right + e[4]! * up - e[8]! * VIEW_HOLD.forward,
    camera.position.y + e[1]! * right + e[5]! * up - e[9]! * VIEW_HOLD.forward,
    camera.position.z + e[2]! * right + e[6]! * up - e[10]! * VIEW_HOLD.forward,
  );
}

const BRASS = '#c9962e';
const BRASS_DARK = '#8a6420';
const CLAY = '#a5532a';
const KUMKUM = '#c8102e';
const HALDI = '#f2b705';
const MARIGOLD = '#ff9d1c';
const FLAME = new THREE.Color('#ffb347');
const FLAME_CORE = new THREE.Color('#fff1c4');

/** Plate radius, metres. */
const PLATE = 0.11;

/**
 * A brass aarti thali: a rimmed plate carrying a lit clay diya, kumkum and
 * haldi bowls and marigolds. The flame is an unlit glowing mesh, so it adds
 * no real light to the budget. Kept level whichever way the view pitches.
 */
export class Thali {
  readonly object = new THREE.Group();

  private readonly flame: THREE.Mesh;
  private readonly flameMaterial: THREE.MeshBasicMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private flicker = 0;

  constructor() {
    this.object.name = 'aarti.thali';
    this.object.visible = false;
    const brass = this.material(new THREE.MeshStandardMaterial({ color: BRASS, metalness: 0.75, roughness: 0.35 }));
    const brassDark = this.material(new THREE.MeshStandardMaterial({ color: BRASS_DARK, metalness: 0.6, roughness: 0.5 }));
    const clay = this.material(new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.9 }));
    const kumkum = this.material(new THREE.MeshStandardMaterial({ color: KUMKUM, roughness: 0.9 }));
    const haldi = this.material(new THREE.MeshStandardMaterial({ color: HALDI, roughness: 0.9 }));
    const marigold = this.material(new THREE.MeshStandardMaterial({ color: MARIGOLD, roughness: 0.8 }));

    this.part(new THREE.CylinderGeometry(PLATE, PLATE * 0.92, 0.008, 28), brass);
    this.part(new THREE.TorusGeometry(PLATE, 0.006, 6, 28).rotateX(Math.PI / 2), brassDark, 0, 0.006);
    // The diya sits in the middle with its wick towards the front.
    this.part(new THREE.SphereGeometry(0.026, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), clay, 0, 0.03, 0);
    this.part(new THREE.CylinderGeometry(0.02, 0.02, 0.004, 12), brassDark, 0, 0.029, 0);
    this.flameMaterial = this.material(new THREE.MeshBasicMaterial({ color: FLAME })) as THREE.MeshBasicMaterial;
    this.flame = this.part(new THREE.ConeGeometry(0.008, 0.03, 8).translate(0, 0.015, 0), this.flameMaterial, 0, 0.031, -0.012);
    // Two little bowls of kumkum and haldi, and a few marigolds round the edge.
    for (const [x, z, powder] of [
      [-0.06, 0.03, kumkum],
      [0.06, 0.03, haldi],
    ] as const) {
      this.part(new THREE.CylinderGeometry(0.018, 0.012, 0.012, 12), brassDark, x, 0.01, z);
      this.part(new THREE.SphereGeometry(0.015, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), powder, x, 0.014, z);
    }
    for (let i = 0; i < 5; i++) {
      const angle = Math.PI * 0.2 + (i / 5) * Math.PI * 1.6;
      this.part(new THREE.SphereGeometry(0.014, 8, 6), marigold, Math.sin(angle) * 0.08, 0.012, -Math.cos(angle) * 0.08);
    }
  }

  /**
   * Show the plate (centre at `center`, facing `yaw`) when `held`, with the
   * flame flickering over `dt` seconds of rendered time.
   */
  update(center: Vec3, yaw: number, held: boolean, dt: number): void {
    this.object.visible = held;
    if (!held) return;
    this.object.position.set(center.x, center.y, center.z);
    this.object.rotation.set(0, yaw, 0);
    this.flicker += dt;
    const heat = 0.75 + 0.25 * Math.sin(this.flicker * 23) * Math.sin(this.flicker * 7.3);
    this.flame.scale.set(1, heat, 1);
    this.flameMaterial.color.copy(FLAME).lerp(FLAME_CORE, heat * 0.5);
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private material<M extends THREE.Material>(material: M): M {
    this.materials.push(material);
    return material;
  }

  private part(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.object.add(mesh);
    return mesh;
  }
}

function wrap(angle: number): number {
  const turn = 2 * Math.PI;
  return ((angle % turn) + turn) % turn;
}
