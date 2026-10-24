import * as THREE from 'three';
import type { HouseholdMemberId } from '../core/homes';
import type { Vec3 } from '../core/types';
import type { InteriorAssets, InteriorLayout } from '../interior';
import { facing } from '../interior/layout';
import { BODY, Figure } from '../people/figure';
import type { HouseholdMemberView } from './household';
import { HOUSEHOLD_LOOKS, HOUSEHOLD_STOOP } from './looks';
import { householdPose } from './poses';

/** Radians per second a figure turns toward the player it is talking to. */
const TURN_SPEED = 5;
/** Furthest a seated member's head turns toward the player. */
const MAX_HEAD_TURN = 0.8;
/** How far below the palm the hand bell hangs, metres. */
const BELL_DROP = 0.07;

/**
 * Top of the furniture under a seat at `position`, or 0 on open floor: the
 * sofa, armchair or moodha the member sits on.
 */
export function seatHeight(layout: InteriorLayout, position: Vec3): number {
  let top = 0;
  for (const { kind, box } of layout.solids) {
    if (kind !== 'furniture' || box.max.y > 0.8) continue;
    if (position.x <= box.min.x || position.x >= box.max.x || position.z <= box.min.z || position.z >= box.max.z) continue;
    top = Math.max(top, box.max.y);
  }
  return top;
}

export interface HouseholdSceneOptions {
  readonly household: { views(): readonly HouseholdMemberView[] };
  /** The home's furniture, for seat heights; members without a seat always stand. */
  readonly layout: InteriorLayout & {
    readonly seats?: Readonly<Partial<Record<HouseholdMemberId, { readonly position: Vec3 }>>>;
  };
  /** The home's interior root, so its household is drawn only while it is shown. */
  readonly parent: THREE.Object3D;
  /** Shared interior materials; the hand bell reuses their brass. */
  readonly assets: InteriorAssets;
}

interface Drawn {
  readonly figure: Figure;
  readonly seatBob: number;
  readonly stoop: number;
  /** Shown facing; turns toward the player while they are being spoken to. */
  yaw: number;
}

/**
 * Draws a household as festive `Figure`s from its views — the family at
 * home, or Uncle and Aunty next door: placed and faced from the snapshot,
 * posed for the activity or the gesture of the line being spoken, with a
 * brass hand bell for whoever rings it during aarti. Nothing here decides
 * behaviour.
 *
 * At most five figures of about a dozen draw calls each, sharing the figures' one
 * material, plus the bell. Nothing is dropped on Low: gestures are whole-arm
 * poses that read from the silhouette.
 */
export class HouseholdScene {
  readonly object = new THREE.Group();

  private readonly household: { views(): readonly HouseholdMemberView[] };
  private readonly drawn: Drawn[] = [];
  private readonly bell: THREE.Mesh;
  private readonly bellGeometry: THREE.BufferGeometry;
  private readonly handQuaternion = new THREE.Quaternion();
  private readonly drop = new THREE.Vector3();
  private time = 0;

  constructor(options: HouseholdSceneOptions) {
    this.household = options.household;
    this.object.name = 'household';
    for (const view of this.household.views()) {
      const id = view.id;
      const look = HOUSEHOLD_LOOKS[id];
      const figure = new Figure(look);
      figure.root.name = `household.${id}`;
      this.object.add(figure.root);
      const scale = look.scale ?? 1;
      // Hips just above the seat, so the thighs rest on it.
      const seat = options.layout.seats?.[id];
      const top = seat ? seatHeight(options.layout, seat.position) : 0;
      const seatBob = top / scale + 0.05 - BODY.hipY;
      this.drawn.push({ figure, seatBob, stoop: HOUSEHOLD_STOOP[id], yaw: view.placement.yaw });
    }
    // A small ghanti: a cone, mouth down, under the ringer's fist.
    this.bellGeometry = new THREE.ConeGeometry(0.045, 0.08, 12);
    this.bell = new THREE.Mesh(this.bellGeometry, options.assets.material('brass'));
    this.bell.name = 'household.bell';
    this.bell.visible = false;
    options.parent.add(this.object);
    this.frame(0);
  }

  /** Per rendered frame while the home is shown; `viewer` is where the player stands. */
  frame(delta: number, viewer?: Vec3): void {
    const dt = delta > 0 ? delta : 0;
    this.time += dt;
    const views = this.household.views();
    let ringer: Figure | null = null;
    for (let i = 0; i < views.length; i++) {
      const view = views[i]!;
      const drawn = this.drawn[i]!;
      const { figure } = drawn;
      const { position, yaw } = view.placement;
      figure.root.position.set(position.x, position.y, position.z);

      const seated = view.activity === 'seated';
      const towardViewer = viewer && view.line && !view.walking ? facing(position, viewer) : null;
      // Standing members turn to the player they are talking to; seated ones turn their head.
      const wantYaw = towardViewer ?? yaw;
      drawn.yaw = view.walking || seated ? yaw : turnToward(drawn.yaw, wantYaw, TURN_SPEED * dt);
      figure.root.rotation.y = drawn.yaw;

      const pose = householdPose(view, this.time + i * 1.3, { seatBob: drawn.seatBob, stoop: drawn.stoop });
      if (seated && towardViewer !== null) {
        const turn = Math.max(-MAX_HEAD_TURN, Math.min(MAX_HEAD_TURN, angleDelta(drawn.yaw, towardViewer)));
        figure.setPose({ ...pose, headYaw: turn });
      } else figure.setPose(pose);
      if (view.activity === 'ringingBell' && !view.line) ringer = figure;
    }
    this.placeBell(ringer);
  }

  dispose(): void {
    for (const { figure } of this.drawn) figure.dispose();
    this.bell.removeFromParent();
    this.bellGeometry.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }

  /** Hang the bell from the ringer's right hand, mouth down whatever the arm does. */
  private placeBell(ringer: Figure | null): void {
    this.bell.visible = ringer !== null;
    if (!ringer) return;
    const hand = ringer.rightHand;
    if (this.bell.parent !== hand) hand.add(this.bell);
    ringer.root.updateMatrixWorld(true);
    hand.getWorldQuaternion(this.handQuaternion).invert();
    // Undo the hand's rotation so the bell hangs level, then swing it as it rings.
    this.bell.quaternion.copy(this.handQuaternion);
    this.bell.rotateX(Math.sin(this.time * 18) * 0.35);
    const scale = ringer.root.scale.x || 1;
    this.drop.set(0, -BELL_DROP / scale, 0).applyQuaternion(this.handQuaternion);
    this.bell.position.copy(this.drop);
  }
}

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}
