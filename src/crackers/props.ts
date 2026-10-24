import * as THREE from 'three';
import type { CrackerSnapshot } from '../core/contracts';
import type { CrackerType } from '../core/types';

type GroundType = Exclude<CrackerType, 'phuljhari'>;

interface PropStyle {
  readonly geometry: () => THREE.BufferGeometry;
  readonly colour: string;
}

/** Simple stand-in models, sat on the ground at the origin. */
const STYLES: Readonly<Record<GroundType, PropStyle>> = {
  anar: {
    geometry: () => new THREE.ConeGeometry(0.1, 0.26, 12).translate(0, 0.13, 0),
    colour: '#d8452b',
  },
  chakri: {
    geometry: () => new THREE.TorusGeometry(0.13, 0.035, 8, 20).rotateX(Math.PI / 2).translate(0, 0.04, 0),
    colour: '#e8b23a',
  },
  rocket: {
    geometry: () => {
      const stick = new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6).translate(0, 0.25, 0);
      const body = new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10).translate(0, 0.5, 0);
      const tip = new THREE.ConeGeometry(0.035, 0.08, 10).translate(0, 0.65, 0);
      return mergeGeometries([stick, body, tip]);
    },
    colour: '#3a7bd5',
  },
};

/** Whether a ground cracker's model still sits on the ground in `state`. */
function onGround(cracker: CrackerSnapshot): boolean {
  if (cracker.state === 'placed' || cracker.state === 'fuseBurning') return true;
  // A rocket leaves the ground when it goes active; fountains and spinners stay.
  return cracker.state === 'active' && cracker.type !== 'rocket';
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    const geometry = part.index ? part.toNonIndexed() : part;
    positions.push(...geometry.getAttribute('position').array);
    normals.push(...geometry.getAttribute('normal').array);
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

/**
 * Visible models for placed ground crackers, so the player can see what
 * they placed before lighting it. One instanced mesh per type, refreshed
 * from the crackers' snapshots each frame without allocating.
 */
export class CrackerProps {
  readonly object = new THREE.Group();

  private readonly meshes: Record<GroundType, THREE.InstancedMesh>;
  private readonly matrix = new THREE.Matrix4();

  constructor(capacity: number) {
    this.object.name = 'crackerProps';
    const make = (type: GroundType): THREE.InstancedMesh => {
      const style = STYLES[type];
      const material = new THREE.MeshStandardMaterial({
        color: style.colour,
        roughness: 0.6,
        // A little self-light so props read on the dark lane.
        emissive: style.colour,
        emissiveIntensity: 0.25,
      });
      const mesh = new THREE.InstancedMesh(style.geometry(), material, Math.max(1, capacity));
      mesh.name = `crackerProps.${type}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move between frames; skip culling against stale bounds.
      mesh.frustumCulled = false;
      this.object.add(mesh);
      return mesh;
    };
    this.meshes = { anar: make('anar'), chakri: make('chakri'), rocket: make('rocket') };
  }

  /** Show every ground cracker in `crackers` that still sits on the ground. */
  sync(crackers: readonly CrackerSnapshot[]): void {
    const { anar, chakri, rocket } = this.meshes;
    anar.count = chakri.count = rocket.count = 0;
    for (let i = 0; i < crackers.length; i++) {
      const cracker = crackers[i]!;
      if (cracker.type === 'phuljhari' || !onGround(cracker)) continue;
      const mesh = this.meshes[cracker.type];
      if (mesh.count >= mesh.instanceMatrix.count) continue;
      const p = cracker.position;
      mesh.setMatrixAt(mesh.count++, this.matrix.makeTranslation(p.x, p.y, p.z));
    }
    anar.instanceMatrix.needsUpdate = chakri.instanceMatrix.needsUpdate = rocket.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of Object.values(this.meshes)) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
