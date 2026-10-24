import * as THREE from 'three';
import type { NeighbourView, Neighbours } from './neighbours';

/** Festive outfit colours (kurta / saree, then a trim or dupatta). */
export const OUTFITS: readonly (readonly [string, string])[] = [
  ['#c2185b', '#ffd54f'],
  ['#ff8f00', '#7b1fa2'],
  ['#2e7d32', '#ffca28'],
  ['#6a1b9a', '#f48fb1'],
  ['#d84315', '#fff176'],
  ['#00838f', '#ffb74d'],
  ['#ad1457', '#81d4fa'],
  ['#f9a825', '#c62828'],
];
const SKIN = ['#8d5524', '#a0673a', '#c68642', '#7a4a26'] as const;
const HAIR = '#1b1410';

const BODY = { radiusTop: 0.17, radiusBottom: 0.27, height: 1.05 } as const;
const HEAD_RADIUS = 0.13;
const SHOULDER_Y = 1.32;
const ARM = { width: 0.08, length: 0.55 } as const;

interface Figure {
  readonly root: THREE.Group;
  readonly head: THREE.Group;
  readonly leftArm: THREE.Object3D;
  readonly rightArm: THREE.Object3D;
}

/**
 * Draws the neighbours as simple original stylised figures: a flared
 * festive tunic, a trim sash, a head with hair, and two arms that rise for
 * a cheer. Geometry is shared; one material per outfit colour.
 */
export class NeighbourScene {
  readonly object = new THREE.Group();

  private readonly neighbours: Neighbours;
  private readonly figures: Figure[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private time = 0;

  constructor(options: { readonly scene: THREE.Scene; readonly neighbours: Neighbours }) {
    this.neighbours = options.neighbours;
    this.object.name = 'neighbours';
    const body = this.geometry(new THREE.CylinderGeometry(BODY.radiusTop, BODY.radiusBottom, BODY.height, 12));
    body.translate(0, BODY.height / 2 + 0.25, 0);
    const legs = this.geometry(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8));
    legs.translate(0, 0.15, 0);
    const sash = this.geometry(new THREE.BoxGeometry(0.06, 0.75, 0.4));
    sash.rotateX(0.5);
    sash.translate(0, 0.95, 0);
    const head = this.geometry(new THREE.SphereGeometry(HEAD_RADIUS, 14, 10));
    head.translate(0, HEAD_RADIUS, 0);
    const hair = this.geometry(new THREE.SphereGeometry(HEAD_RADIUS * 1.06, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2));
    hair.translate(0, HEAD_RADIUS + 0.015, 0.012);
    const arm = this.geometry(new THREE.BoxGeometry(ARM.width, ARM.length, ARM.width));
    arm.translate(0, -ARM.length / 2, 0);

    for (const view of this.neighbours.views()) {
      const [tunic, trim] = OUTFITS[view.outfit % OUTFITS.length]!;
      const skin = this.material(SKIN[view.outfit % SKIN.length]!);
      const root = new THREE.Group();
      root.name = `neighbour.${view.id}`;
      root.add(new THREE.Mesh(body, this.material(tunic)));
      root.add(new THREE.Mesh(legs, this.material(trim)));
      root.add(new THREE.Mesh(sash, this.material(trim)));
      const headGroup = new THREE.Group();
      headGroup.position.y = SHOULDER_Y + 0.04;
      headGroup.add(new THREE.Mesh(head, skin), new THREE.Mesh(hair, this.material(HAIR)));
      root.add(headGroup);
      const arms = [-1, 1].map((side) => {
        const pivot = new THREE.Group();
        pivot.position.set(side * (BODY.radiusTop + ARM.width / 2), SHOULDER_Y, 0);
        pivot.add(new THREE.Mesh(arm, this.material(tunic)));
        root.add(pivot);
        return pivot;
      });
      this.object.add(root);
      this.figures.push({ root, head: headGroup, leftArm: arms[0]!, rightArm: arms[1]! });
    }
    options.scene.add(this.object);
  }

  /** Per rendered frame: place each figure and animate its current activity. */
  frame(delta: number): void {
    this.time += delta;
    const views = this.neighbours.views();
    for (let i = 0; i < views.length; i++) pose(this.figures[i]!, views[i]!, this.time + i * 1.7);
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }

  private geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private material(colour: string): THREE.MeshStandardMaterial {
    let material = this.materials.get(colour);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.75 });
      this.materials.set(colour, material);
    }
    return material;
  }
}

function pose(figure: Figure, view: NeighbourView, t: number): void {
  const { root, head, leftArm, rightArm } = figure;
  const p = view.position;
  let bob = 0;
  let left = 0.1;
  let right = -0.1;
  let swing = 0;
  switch (view.activity) {
    case 'wander':
      bob = Math.abs(Math.sin(t * 7)) * 0.03;
      swing = Math.sin(t * 7) * 0.4;
      break;
    case 'chat':
      // An occasional hand gesture while talking.
      right = -0.1 - Math.max(0, Math.sin(t * 1.3)) * 0.9;
      break;
    case 'watch':
      left = 0.15;
      right = -0.15;
      break;
    case 'cheer': {
      const wave = Math.sin(t * 9) * 0.25;
      left = 2.6 + wave;
      right = -2.6 + wave;
      bob = Math.abs(Math.sin(t * 6)) * 0.08;
      break;
    }
    case 'idle':
      bob = Math.sin(t * 1.5) * 0.005;
      break;
  }
  root.position.set(p.x, p.y + bob, p.z);
  root.rotation.y = view.yaw;
  head.rotation.x = view.lookUp;
  leftArm.rotation.set(swing, 0, -left);
  rightArm.rotation.set(-swing, 0, -right);
}
