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
      // Fingers in ears, hunched and leaning away, bouncing on the toes.
      const jitter = Math.abs(Math.sin(t * 8)) * 0.02;
      return {
        bob: jitter - 0.04,
        lean: -0.12,
        headPitch: -0.05,
        headYaw: Math.sin(t * 3) * 0.1,
        leftLeg: 0.25,
        rightLeg: 0.25,
        leftKnee: 0.5,
        rightKnee: 0.5,
        leftArm: 0.2,
        rightArm: 0.2,
        leftSpread: 1.3,
        rightSpread: 1.3,
        leftElbow: 2.4,
        rightElbow: 2.4,
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
/** The sutli bomb's jute twine and the darker turns between. */
const JUTE = '#a3804a';
const JUTE_DARK = '#6e522c';
const FUSE_COLOUR = '#6f7b52';

/**
 * A steel balti about 30 cm tall, its middle at the origin and mouth up:
 * a tapered pail with a rolled rim and a wire handle.
 */
function baltiGeometry(): { pail: THREE.BufferGeometry; handle: THREE.BufferGeometry } {
  const h = BALTI.restHeight;
  const profile: [number, number][] = [
    [0, -h],
    [0.115, -h],
    [0.125, -h + 0.01],
    [0.16, h - 0.01],
    [0.168, h],
    [0.162, h + 0.005],
  ];
  const pail = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    24,
  );
  pail.computeVertexNormals();
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
    const { pail, handle } = baltiGeometry();
    const pailMesh = new THREE.Mesh(this.ownGeometry(pail), steel);
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

  private own<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  private ownGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    this.geometries.push(geometry);
    return geometry;
  }
}
