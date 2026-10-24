import * as THREE from 'three';
import type { CrackerSnapshot } from '../core/contracts';
import type { CrackerId, CrackerType } from '../core/types';
import type { SpinnerPose } from '../effects/fireworksEffects';

type GroundType = Exclude<CrackerType, 'phuljhari'>;

interface PropStyle {
  readonly geometry: () => THREE.BufferGeometry;
  /** Material colour; white when the geometry carries its own vertex colours. */
  readonly colour: string;
  readonly vertexColours?: boolean;
}

/** Paper wrapping round a chakri's coil, repeated along it. */
const CHAKRI_STRIPES = ['#d8302a', '#f2c230', '#2f9e4f', '#f2c230'];

/**
 * A chakri: a paper-wrapped tube coiled flat into a spiral round a
 * central hub, with stripes of colour along the coil.
 */
function chakriGeometry(): THREE.BufferGeometry {
  const turns = 2.75;
  const inner = 0.035;
  const outer = 0.13;
  const height = 0.035;
  const points: THREE.Vector3[] = [];
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    const r = inner + (outer - inner) * t;
    points.push(new THREE.Vector3(Math.cos(angle) * r, height, Math.sin(angle) * r));
  }
  const tubular = 120;
  const radial = 6;
  const coil = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), tubular, 0.016, radial, false);
  const colour = new THREE.Color();
  const colours = new Float32Array(coil.getAttribute('position').count * 3);
  const stripeLength = tubular / 14;
  for (let i = 0; i <= tubular; i++) {
    colour.set(CHAKRI_STRIPES[Math.floor(i / stripeLength) % CHAKRI_STRIPES.length]!);
    for (let j = 0; j <= radial; j++) colour.toArray(colours, (i * (radial + 1) + j) * 3);
  }
  coil.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));

  const hub = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12).translate(0, 0.03, 0);
  const hubColours = new Float32Array(hub.getAttribute('position').count * 3);
  colour.set('#5b3a1e');
  for (let i = 0; i < hubColours.length; i += 3) colour.toArray(hubColours, i);
  hub.setAttribute('color', new THREE.Float32BufferAttribute(hubColours, 3));
  return mergeGeometries([coil, hub]);
}

/** Simple stand-in models, sat on the ground at the origin. */
const STYLES: Readonly<Record<GroundType, PropStyle>> = {
  anar: {
    geometry: () => new THREE.ConeGeometry(0.1, 0.26, 12).translate(0, 0.13, 0),
    colour: '#d8452b',
  },
  chakri: { geometry: chakriGeometry, colour: '#ffffff', vertexColours: true },
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
  const colours: number[] = [];
  const withColour = parts.every((part) => part.getAttribute('color') !== undefined);
  for (const part of parts) {
    const geometry = part.index ? part.toNonIndexed() : part;
    positions.push(...geometry.getAttribute('position').array);
    normals.push(...geometry.getAttribute('normal').array);
    if (withColour) colours.push(...geometry.getAttribute('color').array);
    if (geometry !== part) geometry.dispose();
    part.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (withColour) merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
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
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(capacity: number) {
    this.object.name = 'crackerProps';
    const make = (type: GroundType): THREE.InstancedMesh => {
      const style = STYLES[type];
      const material = new THREE.MeshStandardMaterial({
        color: style.colour,
        roughness: 0.6,
        vertexColors: style.vertexColours ?? false,
        // A little self-light so props read on the dark lane.
        emissive: style.vertexColours ? '#3a2410' : style.colour,
        emissiveIntensity: style.vertexColours ? 1 : 0.25,
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

  /**
   * Show every ground cracker in `crackers` that still sits on the ground.
   * `spinnerPose` places a burning chakri where its sparks are and turns it
   * with them.
   */
  sync(crackers: readonly CrackerSnapshot[], spinnerPose?: (id: CrackerId) => SpinnerPose | null): void {
    const { anar, chakri, rocket } = this.meshes;
    anar.count = chakri.count = rocket.count = 0;
    for (let i = 0; i < crackers.length; i++) {
      const cracker = crackers[i]!;
      if (cracker.type === 'phuljhari' || !onGround(cracker)) continue;
      const mesh = this.meshes[cracker.type];
      if (mesh.count >= mesh.instanceMatrix.count) continue;
      const pose = cracker.type === 'chakri' ? (spinnerPose?.(cracker.id) ?? null) : null;
      const p = pose ?? cracker.position;
      this.position.set(p.x, p.y, p.z);
      // The sparks' angle turns +x towards +z; a positive Y rotation turns it towards -z.
      this.rotation.setFromAxisAngle(this.up, pose ? -pose.angle : 0);
      mesh.setMatrixAt(mesh.count++, this.matrix.compose(this.position, this.rotation, this.scale));
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
