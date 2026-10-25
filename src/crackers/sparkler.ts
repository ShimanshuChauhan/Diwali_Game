import * as THREE from 'three';
import type { HeldItem } from '../core/contracts';
import type { LocationId } from '../core/homes';
import type { Vec3 } from '../core/types';
import { crackersAllowed } from './outdoors';

/** Stick length, metres, and the bare handle at its foot. */
const LENGTH = 0.32;
const HANDLE = 0.08;
/** The burning point never reaches the handle. */
const BURN_END = HANDLE / LENGTH;

/** First-person hold: where the hand sits relative to the eye, metres. */
const VIEW_HAND = { right: 0.25, up: -0.28, forward: 0.5 } as const;
/** How far the stick leans back towards the eye from straight up, radians. */
const VIEW_TILT = 0.55;
/** Third-person hold: lean forward and out to the right from vertical, radians. */
const HELD_TILT = 0.5;
const HELD_SPLAY = 0.7;

const WIRE = '#3a3530';
const COATING = '#8d8a80';
const SPENT = '#24180f';
const EMBER = new THREE.Color('#ff8a2a');
const WHITE_HOT = new THREE.Color('#fff4d6');

export interface SparklerState {
  /** Whether a phuljhari is in hand at all. */
  readonly held: boolean;
  readonly lit: boolean;
  /** How much has burnt, 0–1. */
  readonly progress: number;
}

/** What the stick shows for the phuljhari in hand: nothing in a home, where crackers never come. */
export function heldSparklerState(held: HeldItem | null, progress: number, location: LocationId): SparklerState {
  const shown = held !== null && crackersAllowed(location);
  return { held: shown, lit: shown && held.lit, progress };
}

/**
 * Where the hand holds a phuljhari in first person: low and to the right of
 * the eye, so the stick and its sparks stay in view as the player looks
 * round.
 */
export function firstPersonHand(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  const e = camera.matrixWorld.elements;
  // Camera basis: columns are right, up and back.
  return out.set(
    camera.position.x + e[0]! * VIEW_HAND.right + e[4]! * VIEW_HAND.up - e[8]! * VIEW_HAND.forward,
    camera.position.y + e[1]! * VIEW_HAND.right + e[5]! * VIEW_HAND.up - e[9]! * VIEW_HAND.forward,
    camera.position.z + e[2]! * VIEW_HAND.right + e[6]! * VIEW_HAND.up - e[10]! * VIEW_HAND.forward,
  );
}

/** Which way the stick points from the hand in first person: up, leaning away from the eye. */
export function firstPersonStick(camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  const e = camera.matrixWorld.elements;
  const s = Math.sin(VIEW_TILT);
  const c = Math.cos(VIEW_TILT);
  return out.set(e[4]! * c - e[8]! * s, e[5]! * c - e[9]! * s, e[6]! * c - e[10]! * s).normalize();
}

/**
 * Which way the stick points from the hand in third person, for a player
 * facing `yaw`: up, forward and out to the right, so it shows past the body
 * from the usual camera behind.
 */
export function heldStick(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const forward = Math.sin(HELD_TILT);
  const right = Math.sin(HELD_SPLAY);
  // Forward is (-sin, 0, -cos) and right is (cos, 0, -sin), as in `handSocketFor`.
  return out.set(-sin * forward + cos * right, 1, -cos * forward - sin * right).normalize();
}

/**
 * The held phuljhari: a thin wire with a grey coating. Once lit, the
 * burning point creeps down the stick, leaving dark spent wire above a
 * glowing bead, and `burningPoint` tracks it so the sparks follow.
 */
export class Sparkler {
  readonly object = new THREE.Group();
  /** Where the sparks leave the stick this frame (the tip until lit). */
  readonly burningPoint = new THREE.Vector3();

  private readonly handle: THREE.Mesh;
  private readonly coating: THREE.Mesh;
  private readonly spent: THREE.Mesh;
  private readonly bead: THREE.Mesh;
  private readonly beadMaterial: THREE.MeshBasicMaterial;
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.object.name = 'sparkler';
    this.object.visible = false;
    // Unit-length cylinders standing on the origin, scaled along Y per frame.
    const rod = (radius: number, colour: string): THREE.Mesh => {
      const geometry = new THREE.CylinderGeometry(radius, radius, 1, 6).translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8 }));
      this.object.add(mesh);
      return mesh;
    };
    this.handle = rod(0.0022, WIRE);
    this.coating = rod(0.0055, COATING);
    this.spent = rod(0.0028, SPENT);
    this.beadMaterial = new THREE.MeshBasicMaterial({ color: EMBER });
    this.bead = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 8, 6), this.beadMaterial);
    this.object.add(this.bead);
    this.handle.scale.y = HANDLE;
  }

  /**
   * Place the stick with its foot at `hand`, pointing along unit `direction`,
   * burnt `state.progress` of the way down.
   */
  update(hand: Vec3, direction: THREE.Vector3, state: SparklerState): void {
    this.object.visible = state.held;
    const burn = state.lit ? 1 - (1 - BURN_END) * state.progress : 1;
    this.burningPoint.set(hand.x, hand.y, hand.z).addScaledVector(direction, LENGTH * burn);
    if (!state.held) return;

    this.object.position.set(hand.x, hand.y, hand.z);
    this.object.quaternion.setFromUnitVectors(this.up, direction);
    const burnAt = LENGTH * burn;
    this.coating.position.y = HANDLE;
    this.coating.scale.y = Math.max(1e-4, burnAt - HANDLE);
    this.spent.position.y = burnAt;
    this.spent.scale.y = Math.max(1e-4, LENGTH - burnAt);
    this.spent.visible = state.lit && burnAt < LENGTH;
    this.bead.position.y = burnAt;
    this.bead.visible = state.lit;
    // A hot bead flickering between orange and near-white.
    const heat = 0.6 + Math.random() * 0.4;
    this.beadMaterial.color.copy(EMBER).lerp(WHITE_HOT, heat * 0.6).multiplyScalar(1 + heat);
  }

  dispose(): void {
    this.object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }
}
