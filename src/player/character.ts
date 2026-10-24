import * as THREE from 'three';
import type { PlayerPose } from '../core/contracts';
import type { CameraMode, Vec3 } from '../core/types';
import { Figure, type Look } from '../people/figure';
import { bodyVisible, gaitPose, HAND_SOCKET, handSocketFor, REST_GAIT, stepGait, type GaitState } from './gait';

/** The player's festive outfit: a rani-pink kurta under a navy Nehru jacket. */
const PLAYER_LOOK: Look = {
  outfit: 'kurta',
  main: '#c2185b',
  trim: '#f4b400',
  second: '#f3e9d2',
  jacket: '#1f3a5f',
  skin: '#b07850',
  hair: '#1b1210',
  hairStyle: 'short',
};

/** Where the right hand holds things, in body space (see `HAND_SOCKET`). */
const HELD_HAND = new THREE.Vector3(HAND_SOCKET.right, HAND_SOCKET.up, -HAND_SOCKET.forward);

/** How far a knee folds as its leg swings back. */
const KNEE_FOLD = 0.9;

export interface PlayerCharacterOptions {
  /** Starting view; the body only shows in third-person. */
  readonly mode?: CameraMode;
}

/**
 * The preset festive character, built with the shared `Figure` and animated
 * by the gait cycle in `gait.ts`. Hidden in first-person. The right arm bends
 * to hold its hand at `handSocket`, where the phuljhari attaches;
 * `handPosition` gives the same point as plain data for the crackers module.
 */
export class PlayerCharacter {
  readonly object = new THREE.Group();
  /** Attach point on the right hand for held items. */
  readonly handSocket = new THREE.Object3D();

  private readonly figure = new Figure(PLAYER_LOOK);
  private gait: GaitState = REST_GAIT;

  constructor(options: PlayerCharacterOptions = {}) {
    this.object.name = 'player.character';
    this.handSocket.name = 'player.handSocket';
    this.object.add(this.figure.root);
    this.figure.rightHand.add(this.handSocket);
    this.pose();
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
    this.pose();
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
    this.pose();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.figure.dispose();
  }

  private pose(): void {
    const { legSwing, armSwing, bob } = gaitPose(this.gait);
    this.figure.setPose({
      bob,
      leftLeg: legSwing,
      rightLeg: -legSwing,
      leftKnee: Math.max(0, -legSwing) * KNEE_FOLD,
      rightKnee: Math.max(0, legSwing) * KNEE_FOLD,
      leftArm: armSwing,
      leftElbow: 0.15 + Math.max(0, armSwing) * 0.4,
    });
    this.figure.reachRight(HELD_HAND);
  }
}
