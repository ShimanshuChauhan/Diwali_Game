import * as THREE from 'three';
import type { PlayerPose } from '../core/contracts';
import type { CameraMode, Vec3 } from '../core/types';
import { bodyVisible, gaitPose, HAND_SOCKET, handSocketFor, REST_GAIT, stepGait, type GaitState } from './gait';

/** Body landmarks above the feet, metres; the head sits around the eye height. */
const HIP_Y = 0.85;
const SHOULDER_Y = 1.42;
const SHOULDER_X = HAND_SOCKET.right;
const HIP_X = 0.1;
const LEG_LENGTH = HIP_Y - 0.05;
const ARM_LENGTH = 0.55;
const HEAD_Y = 1.62;
const HEAD_RADIUS = 0.12;

/** The held arm reaches straight from the shoulder to the hand socket. */
const HELD_ARM_DROP = SHOULDER_Y - HAND_SOCKET.up;
const HELD_ARM_LENGTH = Math.hypot(HELD_ARM_DROP, HAND_SOCKET.forward);
const HELD_ARM_PITCH = Math.atan2(HAND_SOCKET.forward, HELD_ARM_DROP);

const COLOURS = {
  kurta: '#c2185b',
  trim: '#f4b400',
  pyjama: '#f3e9d2',
  skin: '#b07850',
  hair: '#1b1210',
  mojari: '#7a3b12',
} as const;

export interface PlayerCharacterOptions {
  /** Starting view; the body only shows in third-person. */
  readonly mode?: CameraMode;
}

/**
 * The preset festive character: an original, procedurally built figure in a
 * knee-length kurta with gold trim, cream pyjama and mojari, animated by the
 * gait cycle in `gait.ts`. Hidden in first-person. The right arm is held
 * forward and ends in `handSocket`, where the phuljhari attaches;
 * `handPosition` gives the same point as plain data for the crackers module.
 */
export class PlayerCharacter {
  readonly object = new THREE.Group();
  /** Attach point on the right hand for held items. */
  readonly handSocket = new THREE.Object3D();

  private readonly body = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly freeArm = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private gait: GaitState = REST_GAIT;

  constructor(options: PlayerCharacterOptions = {}) {
    this.object.name = 'player.character';
    this.handSocket.name = 'player.handSocket';
    this.body.name = 'player.body';
    this.object.add(this.body);
    this.build();
    this.object.visible = bodyVisible(options.mode ?? 'firstPerson');
  }

  get visible(): boolean {
    return this.object.visible;
  }

  /** Current gait, for tests and debugging. */
  get state(): GaitState {
    return this.gait;
  }

  /**
   * Advance the animation by `dt` seconds for a player moving at `speed`
   * m/s, and place the body at `pose`. Call once per rendered frame.
   */
  update(pose: PlayerPose, speed: number, mode: CameraMode, dt: number): void {
    this.gait = stepGait(this.gait, speed, dt);
    const { legSwing, armSwing, bob } = gaitPose(this.gait);
    this.leftLeg.rotation.x = legSwing;
    this.rightLeg.rotation.x = -legSwing;
    this.freeArm.rotation.x = armSwing;
    this.body.position.y = bob;
    const { x, y, z } = pose.position;
    this.object.position.set(x, y, z);
    this.object.rotation.y = pose.yaw;
    this.object.visible = bodyVisible(mode);
  }

  /** World position of the hand socket for `pose`, including the current bob. */
  handPosition(pose: PlayerPose): Vec3 {
    return handSocketFor(pose.position, pose.yaw, gaitPose(this.gait).bob);
  }

  /** Back to a standing rest for a fresh visit. */
  reset(): void {
    this.gait = REST_GAIT;
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private build(): void {
    const kurta = this.material(COLOURS.kurta, 0.8);
    const trim = this.material(COLOURS.trim, 0.4, 0.6);
    const pyjama = this.material(COLOURS.pyjama, 0.9);
    const skin = this.material(COLOURS.skin, 0.7);
    const hair = this.material(COLOURS.hair, 0.9);
    const mojari = this.material(COLOURS.mojari, 0.6);

    // Kurta: fitted chest over a skirt flaring to the knee, gold at hem and collar.
    this.part(new THREE.CylinderGeometry(0.17, 0.19, SHOULDER_Y - HIP_Y + 0.05, 14), kurta, 0, (SHOULDER_Y + HIP_Y) / 2);
    this.part(new THREE.CylinderGeometry(0.19, 0.27, 0.42, 14), kurta, 0, HIP_Y - 0.19);
    this.part(new THREE.CylinderGeometry(0.272, 0.272, 0.035, 14), trim, 0, HIP_Y - 0.39);
    this.part(new THREE.CylinderGeometry(0.075, 0.08, 0.05, 10), trim, 0, SHOULDER_Y + 0.04);
    // Placket of gold buttons down the chest.
    for (let i = 0; i < 3; i++) this.part(new THREE.SphereGeometry(0.014, 6, 4), trim, 0, SHOULDER_Y - 0.06 - i * 0.08, -0.172);

    // Head and hair.
    this.part(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 8), skin, 0, SHOULDER_Y + 0.08);
    this.part(new THREE.SphereGeometry(HEAD_RADIUS, 16, 12), skin, 0, HEAD_Y);
    const cap = this.part(
      new THREE.SphereGeometry(HEAD_RADIUS * 1.06, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hair,
      0,
      HEAD_Y + 0.01,
    );
    cap.rotation.x = 0.25;

    // Legs hang from the hips and swing about them.
    for (const [leg, side] of [
      [this.leftLeg, -1],
      [this.rightLeg, 1],
    ] as const) {
      leg.position.set(side * HIP_X, HIP_Y, 0);
      this.body.add(leg);
      this.limb(leg, new THREE.CylinderGeometry(0.06, 0.05, LEG_LENGTH, 8), pyjama, LEG_LENGTH);
      const shoe = this.part(new THREE.BoxGeometry(0.1, 0.06, 0.22), mojari, 0, -LEG_LENGTH - 0.02, -0.04, leg);
      shoe.name = 'player.mojari';
    }

    // Left arm swings freely, opposite the left leg.
    this.freeArm.position.set(-SHOULDER_X, SHOULDER_Y, 0);
    this.body.add(this.freeArm);
    this.limb(this.freeArm, new THREE.CylinderGeometry(0.05, 0.045, ARM_LENGTH, 8), kurta, ARM_LENGTH);
    this.part(new THREE.SphereGeometry(0.045, 8, 6), skin, 0, -ARM_LENGTH, 0, this.freeArm);

    // Right arm is held forward, ending in the hand and its socket.
    const heldArm = new THREE.Group();
    heldArm.position.set(SHOULDER_X, SHOULDER_Y, 0);
    heldArm.rotation.x = HELD_ARM_PITCH;
    this.body.add(heldArm);
    this.limb(heldArm, new THREE.CylinderGeometry(0.05, 0.045, HELD_ARM_LENGTH, 8), kurta, HELD_ARM_LENGTH);
    this.part(new THREE.SphereGeometry(0.045, 8, 6), skin, 0, -HELD_ARM_LENGTH, 0, heldArm);
    this.handSocket.position.set(0, -HELD_ARM_LENGTH, 0);
    heldArm.add(this.handSocket);
  }

  /** A limb segment hanging `length` below its pivot group. */
  private limb(pivot: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, length: number): void {
    this.part(geometry, material, 0, -length / 2, 0, pivot);
  }

  private part(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z = 0,
    parent: THREE.Object3D = this.body,
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  private material(color: string, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.materials.push(material);
    return material;
  }
}
