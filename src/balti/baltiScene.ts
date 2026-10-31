import * as THREE from 'three';
import type { NeighbourView } from '../neighbours/neighbours';
import { poseFor } from '../neighbours/neighbourScene';
import { Figure, type FigurePose, type Look } from '../people/figure';
import { BALTI, type BaltiBlast, type KidView } from './baltiBlast';

/** The street kids in their Diwali best: three boys in kurtas, one girl in a lehenga. */
export const KID_LOOKS: readonly Look[] = [
  { outfit: 'kurta', main: '#e53935', trim: '#ffd54f', second: '#f3e9d2', skin: '#a0673a', hair: '#1b1410', hairStyle: 'fringe', scale: 0.6 },
  { outfit: 'saree', main: '#8e24aa', trim: '#ffca28', second: '#ff7043', skin: '#c68642', hair: '#160f0c', hairStyle: 'braid', bindi: true, scale: 0.6 },
  { outfit: 'kurta', main: '#1e88e5', trim: '#ffffff', second: '#f3e9d2', jacket: '#ffb300', skin: '#8d5524', hair: '#1b1410', hairStyle: 'short', scale: 0.64 },
  { outfit: 'kurta', main: '#43a047', trim: '#fdd835', second: '#f3e9d2', skin: '#7a4a26', hair: '#2a2a2a', hairStyle: 'sidePart', scale: 0.58 },
];

/** Squatting at the bomb: thighs forward, shins folded back, body lowered onto them. */
const SQUAT = { leg: 1.1, knee: 1.9, drop: -0.35 } as const;

/** Body pose for a kid's activity, `t` seconds into an offset clock. */
export function kidPose(view: KidView, t: number, proxy: { -readonly [K in keyof NeighbourView]: NeighbourView[K] }): FigurePose {
  switch (view.activity) {
    case 'crouch': {
      // Squatting over the bomb, both hands busy at it.
      const busy = Math.sin(t * 5) * 0.12;
      return {
        bob: SQUAT.drop,
        lean: 0.55,
        headPitch: -0.45,
        leftLeg: SQUAT.leg,
        rightLeg: SQUAT.leg,
        leftKnee: SQUAT.knee,
        rightKnee: SQUAT.knee,
        leftArm: 0.9 + busy,
        rightArm: 0.9 - busy,
        leftElbow: 0.5,
        rightElbow: 0.5,
        leftSpread: 0.15,
        rightSpread: 0.15,
      };
    }
    case 'run': {
      const step = Math.sin(t * 11);
      return {
        bob: Math.abs(Math.cos(t * 11)) * 0.05,
        lean: 0.25,
        headPitch: 0,
        leftLeg: step * 0.8,
        rightLeg: -step * 0.8,
        leftKnee: Math.max(0, -step) * 1.2,
        rightKnee: Math.max(0, step) * 1.2,
        leftArm: -step * 0.8,
        rightArm: step * 0.8,
        leftElbow: 1.2,
        rightElbow: 1.2,
        leftSpread: 0.1,
        rightSpread: 0.1,
      };
    }
    case 'brace': {
      // Fingers in ears, bouncing on the toes: at first craning in to watch
      // the fuse, then, as it runs down, hunching lower, leaning away and
      // screwing the head round from it, the jiggle quickening.
      const tension = view.tension;
      const nerves = Math.abs(Math.sin(t * (7 + tension * 6))) * (0.015 + tension * 0.02);
      const hunch = tension * tension;
      return {
        bob: nerves - 0.03 - hunch * 0.12,
        lean: 0.08 - tension * 0.3 + hunch * 0.15,
        headPitch: 0.05 - hunch * 0.45,
        headYaw: Math.sin(t * 3) * 0.1 * (1 - tension) + (view.look % 2 === 0 ? 0.5 : -0.5) * hunch,
        leftLeg: 0.25 + hunch * 0.45,
        rightLeg: 0.25 + hunch * 0.45,
        leftKnee: 0.5 + hunch * 0.8,
        rightKnee: 0.5 + hunch * 0.8,
        leftArm: 0.2,
        rightArm: 0.2,
        leftSpread: 1.3,
        rightSpread: 1.3,
        leftElbow: 2.4,
        rightElbow: 2.4,
      };
    }
    case 'flinch': {
      // The bang: ducking with a start, shoulders up and hands clapped over the
      // head, jerked back from it, then straightening up again.
      const u = Math.min(1, view.activityTime / BALTI.flinchTime);
      const jolt = Math.sin(Math.min(1, u * 3) * Math.PI * 0.5) * Math.sqrt(1 - u);
      return {
        bob: -0.14 * jolt,
        lean: 0.35 * jolt - 0.15 * (1 - jolt),
        headPitch: -0.5 * jolt,
        leftLeg: 0.5 * jolt,
        rightLeg: 0.5 * jolt,
        leftKnee: 1 * jolt,
        rightKnee: 1 * jolt,
        leftArm: 0.6,
        rightArm: 0.6,
        leftSpread: 1.1,
        rightSpread: 1.1,
        leftElbow: 2.3,
        rightElbow: 2.3,
      };
    }
    case 'watch': {
      // Following it up, mouth open: half of them point at it, the others clutch
      // their heads and bob with excitement.
      const pointing = view.look % 2 === 0;
      const bounce = Math.abs(Math.sin(t * 7)) * 0.03;
      const up = Math.min(1, view.lookUp / BALTI.maxLookUp);
      return {
        bob: bounce,
        lean: -0.12 * up,
        headPitch: view.lookUp,
        leftLeg: 0.05,
        rightLeg: 0.05,
        leftKnee: 0.15,
        rightKnee: 0.15,
        // The right arm up along the line of sight; the left loose, or both on the head.
        rightArm: pointing ? 1.3 + view.lookUp * 1.1 : 0.5,
        rightSpread: pointing ? 0.15 : 1.2,
        rightElbow: pointing ? 0.1 : 2.2,
        leftArm: pointing ? 0.15 : 0.5,
        leftSpread: pointing ? 0.25 : 1.2,
        leftElbow: pointing ? 0.4 : 2.2,
      };
    }
    case 'carry': {
      // Walking it back held out in front, both arms round the pail.
      const step = Math.sin(t * 7);
      return {
        bob: Math.abs(Math.cos(t * 7)) * 0.025,
        lean: -0.08,
        headPitch: -0.1,
        leftLeg: step * 0.45,
        rightLeg: -step * 0.45,
        leftKnee: Math.max(0, -step) * 0.7,
        rightKnee: Math.max(0, step) * 0.7,
        leftArm: 1,
        rightArm: 1,
        leftElbow: 0.7,
        rightElbow: 0.7,
        leftSpread: 0.3,
        rightSpread: 0.3,
      };
    }
    default:
      // Huddling, walking and cheering move like the neighbours do.
      proxy.activity = view.activity === 'walk' ? 'wander' : view.activity === 'cheer' ? 'cheer' : 'chat';
      proxy.lookUp = view.lookUp;
      proxy.activityTime = view.activityTime;
      return poseFor(proxy, t);
  }
}

/** Brushed steel, a little worn. */
const STEEL = '#d5d9de';
/** Soot left by the blast inside the base, and round the rim where the smoke got out. */
const SOOT = new THREE.Color('#1d1a17');
/** Vertex colours, multiplying the steel: as made, and fully sooted. */
const CLEAN = new THREE.Color(1, 1, 1);
const STEEL_LINEAR = new THREE.Color(STEEL);
const SOOTED = new THREE.Color(SOOT.r / STEEL_LINEAR.r, SOOT.g / STEEL_LINEAR.g, SOOT.b / STEEL_LINEAR.b);
/** Each blast blackens it this much more, up to `MAX_SOOT`, and bulges the base out this much more, up to `MAX_DENT` metres. */
const SOOT_PER_BLAST = 0.22;
const MAX_SOOT = 0.75;
const DENT_PER_BLAST = 0.006;
const MAX_DENT = 0.02;
/** The base's flat disc out to this radius takes the bulge. */
const BASE_FLAT = 0.115;
/** The sutli bomb's jute twine and the darker turns between. */
const JUTE = '#a3804a';
const JUTE_DARK = '#6e522c';
const FUSE_COLOUR = '#6f7b52';

/**
 * A steel balti about 30 cm tall, its middle at the origin and mouth up:
 * a tapered pail with a rolled rim and a wire handle. The base has rings
 * out to `BASE_FLAT` so it can bulge, and the pail carries vertex colours
 * so it can blacken (see `BaltiScene.scorch`).
 */
function baltiGeometry(): { pail: THREE.BufferGeometry; handle: THREE.BufferGeometry } {
  const h = BALTI.restHeight;
  const profile: [number, number][] = [
    [0, -h],
    [BASE_FLAT * 0.35, -h],
    [BASE_FLAT * 0.7, -h],
    [BASE_FLAT, -h],
    [BALTI.baseRadius, -h + 0.01],
    [0.16, h - 0.01],
    [BALTI.rimRadius, h],
    [0.162, h + 0.005],
  ];
  const pail = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    24,
  );
  pail.computeVertexNormals();
  pail.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pail.getAttribute('position').count * 3).fill(1), 3));
  const handle = new THREE.TorusGeometry(0.165, 0.005, 5, 18, Math.PI).translate(0, h - 0.04, 0);
  return { pail, handle };
}

/** A round sutli bomb wound in jute, sitting on the ground at the origin. */
function bombGeometry(): THREE.BufferGeometry {
  const r = 0.05;
  const ball = new THREE.SphereGeometry(r, 14, 10).translate(0, r, 0);
  const position = ball.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    // Turns of twine, tilted, so it reads as wound rather than striped.
    const band = Math.floor((position.getY(i) + position.getX(i) * 0.4) / 0.012);
    colour.set(band % 2 === 0 ? JUTE : JUTE_DARK);
    colour.toArray(colours, i * 3);
  }
  ball.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return ball;
}

/**
 * Draws the balti blast: the kids as small festive `Figure`s, the steel
 * balti wherever it is (resting, being lowered, flying or settled), and the
 * sutli bomb with its fuse, which shortens as it burns.
 */
export class BaltiScene {
  readonly object = new THREE.Group();

  private readonly blast: BaltiBlast;
  private readonly figures: Figure[] = [];
  private readonly proxies: { -readonly [K in keyof NeighbourView]: NeighbourView[K] }[] = [];
  private readonly balti = new THREE.Group();
  private readonly bomb = new THREE.Group();
  private readonly fuse: THREE.Mesh;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly pail: THREE.BufferGeometry;
  /** Each pail vertex's untouched height, for bulging the base from. */
  private readonly baseY: Float32Array;
  /** Blasts the balti's soot and dent show; follows `blast.blasts`. */
  private scorched = 0;
  private readonly mixed = new THREE.Color();
  private time = 0;

  constructor(options: { readonly scene: THREE.Object3D; readonly blast: BaltiBlast }) {
    this.blast = options.blast;
    this.object.name = 'baltiBlast';
    for (const view of this.blast.views()) {
      const figure = new Figure(KID_LOOKS[view.look % KID_LOOKS.length]!);
      figure.root.name = view.id;
      this.object.add(figure.root);
      this.figures.push(figure);
      this.proxies.push({
        id: view.id,
        position: view.position,
        yaw: 0,
        lookUp: 0,
        activity: 'chat',
        activityTime: 0,
        outfit: 0,
      });
    }

    const steel = this.own(new THREE.MeshStandardMaterial({ color: STEEL, metalness: 0.35, roughness: 0.4, side: THREE.DoubleSide }));
    const sooty = this.own(steel.clone());
    sooty.vertexColors = true;
    const { pail, handle } = baltiGeometry();
    this.pail = pail;
    this.baseY = Float32Array.from(pail.getAttribute('position').array as ArrayLike<number>);
    const pailMesh = new THREE.Mesh(this.ownGeometry(pail), sooty);
    pailMesh.castShadow = true;
    this.balti.add(pailMesh, new THREE.Mesh(this.ownGeometry(handle), steel));
    this.balti.name = 'balti';
    this.object.add(this.balti);

    const jute = this.own(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    const fuseMaterial = this.own(new THREE.MeshStandardMaterial({ color: FUSE_COLOUR, roughness: 0.9 }));
    this.bomb.add(new THREE.Mesh(this.ownGeometry(bombGeometry()), jute));
    // Unit length along +X from the bomb out to under the rim; scaled as it burns.
    const fuseGeometry = new THREE.CylinderGeometry(0.004, 0.004, 1, 5).rotateZ(Math.PI / 2).translate(0.5, 0, 0);
    this.fuse = new THREE.Mesh(this.ownGeometry(fuseGeometry), fuseMaterial);
    this.fuse.position.set(0.04, 0.012, 0);
    this.bomb.add(this.fuse);
    this.bomb.name = 'sutliBomb';
    this.bomb.position.set(this.blast.spot.x, this.blast.spot.y, this.blast.spot.z);
    this.object.add(this.bomb);

    options.scene.add(this.object);
  }

  /** Per rendered frame: place the kids, the balti and the bomb. */
  frame(delta: number): void {
    this.time += delta;
    const views = this.blast.views();
    for (let i = 0; i < views.length; i++) {
      const figure = this.figures[i]!;
      const view = views[i]!;
      figure.root.position.set(view.position.x, view.position.y, view.position.z);
      figure.root.rotation.y = view.yaw;
      figure.setPose(kidPose(view, this.time + i * 1.3, this.proxies[i]!));
    }

    const pose = this.blast.balti;
    this.balti.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.balti.rotation.set(pose.tilt, pose.yaw, 0, 'YXZ');

    if (this.blast.blasts !== this.scorched) this.scorch(this.blast.blasts);

    this.bomb.visible = this.blast.bombDown;
    const length = (BALTI.fuseReach - 0.04) * (1 - this.blast.fuseProgress);
    this.fuse.visible = length > 0.005;
    this.fuse.scale.x = Math.max(0.001, length);
  }

  dispose(): void {
    for (const figure of this.figures) figure.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }

  /**
   * Blacken and dent the balti for `blasts` bangs under it (none after a
   * session reset): soot over the inside of the base fading up the wall,
   * a band of it round the rim, and the base bulged out a little more each
   * time. Rewrites the pail's attributes once per blast, never per frame.
   */
  private scorch(blasts: number): void {
    this.scorched = blasts;
    const soot = Math.min(MAX_SOOT, blasts * SOOT_PER_BLAST);
    const dent = Math.min(MAX_DENT, blasts * DENT_PER_BLAST);
    const h = BALTI.restHeight;
    const position = this.pail.getAttribute('position') as THREE.BufferAttribute;
    const colour = this.pail.getAttribute('color') as THREE.BufferAttribute;
    const clean = CLEAN;
    const black = SOOTED;
    const mixed = this.mixed;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const r = Math.hypot(x, z);
      const y0 = this.baseY[i * 3 + 1]!;
      // Bulged out (down, mouth up) most at the middle of the base.
      const onBase = y0 <= -h + 1e-6 && r <= BASE_FLAT + 1e-6;
      position.setY(i, onBase ? y0 - dent * (1 - (r / BASE_FLAT) ** 2) : y0);
      // Darkest on the base, fading up the wall, and again at the rim.
      const up = (y0 + h) / (2 * h);
      const weight = Math.max(onBase ? 1 : Math.max(0, 1 - up * 1.6), Math.max(0, (up - 0.9) * 6) * 0.6);
      mixed.copy(clean).lerp(black, soot * weight);
      colour.setXYZ(i, mixed.r, mixed.g, mixed.b);
    }
    position.needsUpdate = true;
    colour.needsUpdate = true;
    this.pail.computeVertexNormals();
  }

  private own<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  private ownGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    this.geometries.push(geometry);
    return geometry;
  }
}
