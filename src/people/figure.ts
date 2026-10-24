import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Original, procedurally built festive people shared by the player and the
 * neighbours: proportioned bodies with faces, hair, and kurta-pyjama or saree
 * outfits, jointed at the neck, shoulders, elbows, hips and knees.
 *
 * Each rigid segment (torso, head, upper arm, …) is merged into one mesh with
 * baked vertex colours, and every figure shares one material, so a person
 * costs about a dozen draw calls. Figures stand on their local origin and
 * face -Z.
 */

export type OutfitKind = 'kurta' | 'saree';
export type HairStyle = 'short' | 'bun' | 'braid';

export interface Look {
  readonly outfit: OutfitKind;
  /** Kurta or saree colour. */
  readonly main: string;
  /** Trim, border and pallu edge. */
  readonly trim: string;
  /** Pyjama, or the saree blouse. */
  readonly second: string;
  /** Optional Nehru jacket over a kurta. */
  readonly jacket?: string;
  readonly skin: string;
  readonly hair: string;
  readonly hairStyle: HairStyle;
  readonly moustache?: boolean;
  readonly bindi?: boolean;
  /** Overall size: 1 for an adult, about 0.62 for a child. */
  readonly scale?: number;
}

/** Joint angles in radians; omitted ones stay at rest. */
export interface FigurePose {
  /** Body raised (metres) by a step or a hop. */
  readonly bob?: number;
  /** Lean of the upper body; positive leans forward. */
  readonly lean?: number;
  readonly headPitch?: number;
  readonly headYaw?: number;
  /** Arm swing forward (positive) or back. */
  readonly leftArm?: number;
  readonly rightArm?: number;
  /** Arm raised out to the side, away from the body. */
  readonly leftSpread?: number;
  readonly rightSpread?: number;
  /** Elbow bend; positive brings the forearm forward and up. */
  readonly leftElbow?: number;
  readonly rightElbow?: number;
  /** Leg swing forward (positive) or back. */
  readonly leftLeg?: number;
  readonly rightLeg?: number;
  /** Knee bend; positive folds the shin back. */
  readonly leftKnee?: number;
  readonly rightKnee?: number;
}

/** Adult landmarks above the feet, metres. */
export const BODY = {
  hipY: 0.9,
  hipX: 0.09,
  waistY: 1.04,
  shoulderY: 1.42,
  shoulderX: 0.2,
  neckY: 1.48,
  thigh: 0.42,
  shin: 0.42,
  upperArm: 0.29,
  forearm: 0.25,
} as const;

const GOLD = '#e8b33a';
const DARK = '#1a1210';
const LIP = '#7a3a30';

/** One shared material for every figure: colours come from the vertices. */
let sharedMaterial: THREE.MeshStandardMaterial | null = null;
function figureMaterial(): THREE.MeshStandardMaterial {
  sharedMaterial ??= new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.75,
    // A touch of self-light so people read against the dark lane.
    emissive: '#1c120c',
  });
  return sharedMaterial;
}

/** Collects coloured, placed primitives and merges them into one geometry. */
class Segment {
  private readonly parts: THREE.BufferGeometry[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();

  add(
    geometry: THREE.BufferGeometry,
    colour: string,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
  ): this {
    this.quaternion.setFromEuler(this.euler.set(rx, ry, rz));
    this.matrix.compose(new THREE.Vector3(x, y, z), this.quaternion, new THREE.Vector3(sx, sy, sz));
    geometry.applyMatrix4(this.matrix);
    geometry.deleteAttribute('uv');
    const c = new THREE.Color(colour);
    const count = geometry.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) c.toArray(colours, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    this.parts.push(geometry);
    return this;
  }

  /** Merge into one mesh under `parent`. */
  mesh(parent: THREE.Object3D, name: string): THREE.Mesh {
    const indexed = this.parts.map((part) => (part.index ? part : indexGeometry(part)));
    const merged = mergeGeometries(indexed) ?? new THREE.BufferGeometry();
    for (const part of this.parts) part.dispose();
    const mesh = new THREE.Mesh(merged, figureMaterial());
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  }
}

function indexGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  return geometry;
}

/**
 * A smooth surface of revolution through [radius, height] points, given top
 * to bottom. Three.js wants them bottom to top for outward-facing normals.
 */
function lathe(profile: readonly (readonly [number, number])[], segments = 16): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)).reverse(),
    segments,
  );
}

/** A capsule hanging `length` below its pivot. */
function limb(radiusTop: number, radiusBottom: number, length: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 10).translate(0, -length / 2, 0);
}

/**
 * A festive person built from `look`. Call `setPose` each frame to animate;
 * `rightHand` and `leftHand` are the palms, for held items.
 */
export class Figure {
  readonly root = new THREE.Group();
  /** Palm of the right hand. */
  readonly rightHand = new THREE.Object3D();
  /** Palm of the left hand. */
  readonly leftHand = new THREE.Object3D();

  private readonly body = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly shoulders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly elbows: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly hips: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly knees: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly saree: boolean;

  constructor(readonly look: Look) {
    this.saree = look.outfit === 'saree';
    this.root.scale.setScalar(look.scale ?? 1);
    this.root.add(this.body);
    this.body.add(this.chest);
    this.chest.position.y = BODY.waistY;
    this.build();
  }

  setPose(pose: FigurePose): void {
    this.body.position.y = pose.bob ?? 0;
    this.chest.rotation.x = -(pose.lean ?? 0);
    this.head.rotation.set(pose.headPitch ?? 0, pose.headYaw ?? 0, 0, 'YXZ');
    const [leftShoulder, rightShoulder] = this.shoulders;
    leftShoulder.rotation.set(pose.leftArm ?? 0, 0, -(pose.leftSpread ?? 0));
    rightShoulder.rotation.set(pose.rightArm ?? 0, 0, pose.rightSpread ?? 0);
    this.elbows[0].rotation.x = pose.leftElbow ?? 0;
    this.elbows[1].rotation.x = pose.rightElbow ?? 0;
    // Legs swing less inside a saree, so they stay under its skirt.
    const stride = this.saree ? 0.35 : 1;
    this.hips[0].rotation.x = (pose.leftLeg ?? 0) * stride;
    this.hips[1].rotation.x = (pose.rightLeg ?? 0) * stride;
    this.knees[0].rotation.x = -(pose.leftKnee ?? 0) * stride;
    this.knees[1].rotation.x = -(pose.rightKnee ?? 0) * stride;
  }

  /**
   * Bend the right arm so its palm reaches `target` (body space, metres,
   * before scaling), elbow down. Used for the player's held phuljhari.
   */
  reachRight(target: THREE.Vector3): void {
    const shoulder = this.shoulders[1];
    const from = shoulder.position.clone().add(new THREE.Vector3(0, BODY.waistY, 0));
    const toTarget = target.clone().sub(from);
    const a = BODY.upperArm;
    const b = BODY.forearm;
    const reach = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, toTarget.length()));
    const bend = Math.PI - Math.acos((a * a + b * b - reach * reach) / (2 * a * b));
    const lift = Math.acos((a * a + reach * reach - b * b) / (2 * a * reach));
    const aim = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), toTarget.normalize());
    shoulder.quaternion.copy(aim).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lift));
    this.elbows[1].rotation.set(bend, 0, 0);
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.root.removeFromParent();
  }

  // ── building ────────────────────────────────────────────────────────────

  private build(): void {
    this.buildTorso();
    this.buildHead();
    this.buildArms();
    this.buildLegs();
  }

  private keep(segment: Segment, parent: THREE.Object3D, name: string): void {
    this.meshes.push(segment.mesh(parent, name));
  }

  private buildTorso(): void {
    const { look } = this;
    const torso = new Segment();
    const lower = new Segment();
    // Heights inside the chest group are relative to the waist.
    const w = BODY.waistY;
    const top = BODY.shoulderY - w;
    if (this.saree) {
      // Blouse: fitted, ending just above the waist.
      torso.add(lathe([[0, top + 0.03], [0.1, top + 0.02], [0.17, top - 0.04], [0.16, top - 0.2], [0.13, 0.08], [0, 0.08]]), look.second);
      // A little midriff, then the saree's waist.
      torso.add(new THREE.CylinderGeometry(0.128, 0.135, 0.09, 16), look.skin, 0, 0.04);
      // Pallu: a band wrapped diagonally from the left shoulder to the right
      // hip, its edge in gold, with a short drape hugging the back.
      torso.add(new THREE.CylinderGeometry(0.185, 0.19, 0.13, 24, 1, true), look.main, 0, top - 0.24, 0, 0, 0, -0.72);
      torso.add(new THREE.CylinderGeometry(0.192, 0.192, 0.014, 24, 1, true), look.trim, -0.045, top - 0.3, 0, 0, 0, -0.72);
      torso.add(new THREE.CylinderGeometry(0.19, 0.195, 0.42, 10, 1, true, -0.85, 1.1), look.main, 0, top - 0.24, 0);
      torso.add(new THREE.CylinderGeometry(0.197, 0.197, 0.018, 10, 1, true, -0.85, 1.1), look.trim, 0, top - 0.45, 0);
      // Skirt: from the waist to the ankles, flaring a little, with a gold border.
      lower.add(lathe([[0, 0], [0.14, 0], [0.165, -0.12], [0.19, -0.5], [0.225, -w + 0.06], [0.23, -w + 0.04], [0, -w + 0.04]], 20), look.main);
      lower.add(new THREE.CylinderGeometry(0.232, 0.232, 0.07, 20, 1, true), look.trim, 0, -w + 0.075);
      // Pleats gathered at the front: a slightly raised panel with a gold edge.
      lower.add(new THREE.BoxGeometry(0.1, 0.78, 0.02), look.main, 0.03, -0.5, -0.19, 0.08, 0, 0);
      lower.add(new THREE.BoxGeometry(0.012, 0.78, 0.022), look.trim, 0.08, -0.5, -0.19, 0.08, 0, 0);
    } else {
      // Kurta: chest to hips, then a skirt flaring to the knee, gold at collar and hem.
      torso.add(lathe([[0, top + 0.03], [0.1, top + 0.02], [0.185, top - 0.05], [0.175, top - 0.24], [0.15, 0], [0.155, -0.02], [0, -0.02]]), look.main);
      torso.add(new THREE.CylinderGeometry(0.06, 0.068, 0.05, 12), look.trim, 0, top + 0.03);
      for (let i = 0; i < 4; i++) torso.add(new THREE.SphereGeometry(0.011, 6, 4), look.trim, 0, top - 0.06 - i * 0.07, -0.168 + i * 0.005);
      if (look.jacket) {
        // Nehru jacket: sleeveless, open down the front.
        for (const side of [-1, 1]) {
          torso.add(new THREE.BoxGeometry(0.15, top - 0.02, 0.27), look.jacket, side * 0.095, top / 2 - 0.02, 0.012, 0, 0, side * 0.04);
          torso.add(new THREE.BoxGeometry(0.012, top - 0.04, 0.012), look.trim, side * 0.03, top / 2 - 0.02, -0.126);
        }
      }
      lower.add(lathe([[0, 0], [0.155, 0], [0.17, -0.1], [0.21, -0.4], [0.24, -0.5], [0, -0.5]], 20), look.main);
      lower.add(new THREE.CylinderGeometry(0.242, 0.242, 0.04, 20, 1, true), look.trim, 0, -0.48);
    }
    // Neck.
    torso.add(new THREE.CylinderGeometry(0.045, 0.055, 0.1, 10), look.skin, 0, BODY.neckY - w);
    // Shoulders, rounded under the sleeves.
    for (const side of [-1, 1]) torso.add(new THREE.SphereGeometry(0.056, 10, 8), this.sleeve(), side * BODY.shoulderX, top - 0.035);
    this.keep(torso, this.chest, 'figure.torso');
    // The lower garment stays with the hips rather than leaning with the chest.
    const hips = new THREE.Group();
    hips.position.y = w;
    this.body.add(hips);
    this.keep(lower, hips, 'figure.lower');
  }

  private buildHead(): void {
    const { look } = this;
    const head = new Segment();
    const r = 0.1;
    const cy = 0.12;
    // Face: a slightly long oval with ears.
    head.add(new THREE.SphereGeometry(r, 18, 14), look.skin, 0, cy, 0, 0, 0, 0, 0.92, 1.12, 0.98);
    for (const side of [-1, 1]) head.add(new THREE.SphereGeometry(0.022, 8, 6), look.skin, side * 0.092, cy, 0.005, 0, 0, 0, 0.6, 1, 1);
    // Eyes, brows, nose and mouth on the -Z side.
    for (const side of [-1, 1]) {
      head.add(new THREE.SphereGeometry(0.016, 8, 6), '#f4efe6', side * 0.034, cy + 0.015, -0.083, 0, 0, 0, 1, 0.8, 0.5);
      head.add(new THREE.SphereGeometry(0.009, 6, 5), DARK, side * 0.034, cy + 0.015, -0.091);
      head.add(new THREE.BoxGeometry(0.038, 0.007, 0.01), look.hair, side * 0.035, cy + 0.045, -0.088, 0, 0, side * -0.12);
    }
    head.add(new THREE.ConeGeometry(0.014, 0.04, 8), look.skin, 0, cy - 0.01, -0.098, -Math.PI / 2 - 0.25, 0, 0);
    head.add(new THREE.BoxGeometry(0.036, 0.008, 0.01), LIP, 0, cy - 0.052, -0.088);
    if (look.moustache) head.add(new THREE.BoxGeometry(0.05, 0.012, 0.012), look.hair, 0, cy - 0.035, -0.094);
    if (look.bindi) head.add(new THREE.SphereGeometry(0.006, 6, 4), '#c8102e', 0, cy + 0.058, -0.088);
    // Hair: a cap over the top and back, then the style.
    head.add(new THREE.SphereGeometry(r * 1.06, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), look.hair, 0, cy + 0.012, 0.014, 0.42, 0, 0, 0.95, 1.12, 1.02);
    if (look.hairStyle === 'bun') {
      head.add(new THREE.SphereGeometry(0.048, 12, 10), look.hair, 0, cy + 0.02, 0.1);
      head.add(new THREE.TorusGeometry(0.04, 0.008, 6, 14), '#f5f0e0', 0, cy + 0.02, 0.098, 0, 0, 0);
    } else if (look.hairStyle === 'braid') {
      for (let i = 0; i < 6; i++) head.add(new THREE.SphereGeometry(0.03 - i * 0.002, 10, 8), look.hair, 0, cy - 0.04 - i * 0.055, 0.1 + i * 0.006);
      head.add(new THREE.SphereGeometry(0.018, 8, 6), '#f5f0e0', 0, cy - 0.37, 0.13);
    }
    this.head.position.y = BODY.neckY - BODY.waistY + 0.03;
    this.chest.add(this.head);
    this.keep(head, this.head, 'figure.head');
  }

  private buildArms(): void {
    const { look } = this;
    for (const [index, side] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const shoulder = this.shoulders[index];
      const elbow = this.elbows[index];
      shoulder.position.set(side * BODY.shoulderX, BODY.shoulderY - BODY.waistY - 0.03, 0);
      this.chest.add(shoulder);
      const upper = new Segment().add(limb(0.048, 0.042, BODY.upperArm), this.sleeve());
      this.keep(upper, shoulder, 'figure.upperArm');
      elbow.position.y = -BODY.upperArm;
      shoulder.add(elbow);
      const fore = new Segment();
      const cuff = this.saree ? 0.05 : BODY.forearm * 0.75;
      fore.add(limb(0.04, 0.038, cuff), this.saree ? look.skin : look.main);
      fore.add(limb(0.036, 0.032, BODY.forearm - cuff), look.skin, 0, -cuff);
      if (!this.saree) fore.add(new THREE.CylinderGeometry(0.042, 0.042, 0.015, 10), look.trim, 0, -cuff);
      // Hand.
      fore.add(new THREE.SphereGeometry(0.04, 10, 8), look.skin, 0, -BODY.forearm - 0.03, 0, 0, 0, 0, 0.7, 1.15, 0.9);
      if (this.saree) {
        for (let i = 0; i < 3; i++) fore.add(new THREE.TorusGeometry(0.04, 0.006, 6, 12), i === 1 ? '#c8102e' : GOLD, 0, -BODY.forearm + 0.01 + i * 0.014, 0, Math.PI / 2, 0, 0);
      }
      this.keep(fore, elbow, 'figure.forearm');
      const palm = index === 1 ? this.rightHand : this.leftHand;
      palm.position.y = -BODY.forearm;
      elbow.add(palm);
    }
  }

  private buildLegs(): void {
    const { look } = this;
    const leg = this.saree ? look.main : look.second;
    for (const [index, side] of [
      [0, -1],
      [1, 1],
    ] as const) {
      const hip = this.hips[index];
      const knee = this.knees[index];
      hip.position.set(side * BODY.hipX, BODY.hipY, 0);
      this.body.add(hip);
      this.keep(new Segment().add(limb(0.07, 0.055, BODY.thigh), leg), hip, 'figure.thigh');
      knee.position.y = -BODY.thigh;
      hip.add(knee);
      const shin = new Segment();
      shin.add(limb(0.053, 0.042, BODY.shin - 0.04), leg);
      shin.add(new THREE.SphereGeometry(0.036, 8, 6), look.skin, 0, -BODY.shin + 0.035);
      // Mojari: a slipper with a curled, pointed toe.
      shin.add(new THREE.BoxGeometry(0.085, 0.05, 0.2), '#7a3b12', 0, -BODY.shin + 0.025, -0.04);
      shin.add(new THREE.ConeGeometry(0.022, 0.06, 8), GOLD, 0, -BODY.shin + 0.05, -0.155, -Math.PI / 2 + 0.7, 0, 0);
      this.keep(shin, knee, 'figure.shin');
    }
  }

  private sleeve(): string {
    return this.saree ? this.look.second : this.look.main;
  }
}
