import * as THREE from 'three';
import type { CrackerSnapshot } from '../core/contracts';
import { LADI_STRING, ladiBanger, ladiPoint } from '../core/ladi';
import type { MutableVec3 } from '../core/rocketFlight';
import type { CrackerId, CrackerType } from '../core/types';
import type { SpinnerPose } from '../effects/fireworksEffects';

/** Ground crackers drawn as one model each; the ladi is a string of many. */
type ModelType = Exclude<CrackerType, 'phuljhari' | 'ladi'>;

interface PropStyle {
  readonly geometry: () => THREE.BufferGeometry;
  /** Material colour; white when the geometry carries its own vertex colours. */
  readonly colour: string;
  readonly vertexColours?: boolean;
}

/** Clay, the paper band round its belly, and the fuse-end cap. */
const ANAR_CLAY = '#b4572e';
const ANAR_BAND = '#2f9e4f';
const ANAR_CAP = '#f2c230';

/**
 * An anar: a round-bellied clay pot narrowing to a short neck, with a band
 * of coloured paper round the belly and a paper cap on the mouth.
 */
function anarGeometry(): THREE.BufferGeometry {
  // Profile from the base centre up to the mouth: [radius, height].
  const profile: [number, number][] = [
    [0, 0],
    [0.07, 0],
    [0.1, 0.03],
    [0.115, 0.08],
    [0.11, 0.13],
    [0.085, 0.19],
    [0.045, 0.235],
    [0.04, 0.26],
    [0.03, 0.27],
    [0, 0.27],
  ];
  const pot = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    20,
  );
  const position = pot.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    colour.set(y > 0.255 ? ANAR_CAP : y > 0.07 && y < 0.15 ? ANAR_BAND : ANAR_CLAY);
    colour.toArray(colours, i * 3);
  }
  pot.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  pot.computeVertexNormals();
  return pot;
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

/** A ladi banger's red paper, darker at the crimped ends. */
const LADI_PAPER = '#c4161c';
const LADI_CRIMP = '#6e0b0e';
/** The twine the bangers are tied to, and the grey-green fuse. */
const LADI_CORD = '#cdb98a';
const LADI_FUSE = '#7d8a5c';

function paint(geometry: THREE.BufferGeometry, colourAt: (x: number, y: number, z: number) => string): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    colour.set(colourAt(position.getX(i), position.getY(i), position.getZ(i)));
    colour.toArray(colours, i * 3);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return geometry;
}

/**
 * One ladi banger: a small red paper tube lying on the ground, running from
 * the cord at the origin out along +X, its ends crimped darker.
 */
function ladiBangerGeometry(): THREE.BufferGeometry {
  const { bangerLength: length, bangerRadius: radius } = LADI_STRING;
  const tube = new THREE.CylinderGeometry(radius, radius, length, 6, 1)
    .rotateZ(-Math.PI / 2)
    .translate(length / 2, radius, 0);
  return paint(tube, (x) => (x < length * 0.12 || x > length * 0.88 ? LADI_CRIMP : LADI_PAPER));
}

/**
 * A ladi's cord and fuse, for a heading of 0: the twine runs along -Z
 * through the origin for the string's length and the fuse sticks out of
 * the near (+Z) end, curling up a little at its tip.
 */
function ladiCordGeometry(): THREE.BufferGeometry {
  const { length, fuse } = LADI_STRING;
  const cord = new THREE.CylinderGeometry(0.0028, 0.0028, length, 5, 1)
    .rotateX(Math.PI / 2)
    .translate(0, 0.004, 0);
  const points = [
    new THREE.Vector3(0, 0.004, length / 2),
    new THREE.Vector3(0, 0.005, length / 2 + fuse * 0.6),
    new THREE.Vector3(0.006, 0.014, length / 2 + fuse),
  ];
  const wick = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 6, 0.0018, 4, false);
  return mergeGeometries([paint(cord, () => LADI_CORD), paint(wick, () => LADI_FUSE)]);
}

/** How far the bangers about to go off twitch as the string jumps, metres and radians. */
const LADI_HOP = 0.012;
const LADI_TWITCH = 0.35;
/** Bangers ahead of the burning point that jump with it. */
const LADI_JUMPING = 4;

/** Simple stand-in models, sat on the ground at the origin. */
const STYLES: Readonly<Record<ModelType, PropStyle>> = {
  anar: { geometry: anarGeometry, colour: '#ffffff', vertexColours: true },
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

const LADI_CORD_STYLE: PropStyle = { geometry: ladiCordGeometry, colour: '#ffffff', vertexColours: true };
const LADI_BANGER_STYLE: PropStyle = { geometry: ladiBangerGeometry, colour: '#ffffff', vertexColours: true };

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
 * they placed before lighting it. One instanced mesh per type (a ladi has
 * two: its cords and every banger), refreshed from the crackers' snapshots
 * each frame without allocating. A ladi's bangers vanish as they pop.
 */
export class CrackerProps {
  readonly object = new THREE.Group();

  private readonly meshes: Record<ModelType, THREE.InstancedMesh>;
  private readonly ladiCords: THREE.InstancedMesh;
  private readonly ladiBangers: THREE.InstancedMesh;
  private readonly point: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(capacity: number) {
    this.object.name = 'crackerProps';
    const make = (type: ModelType | 'ladiCord' | 'ladiBanger', count = capacity): THREE.InstancedMesh => {
      const style = type === 'ladiCord' ? LADI_CORD_STYLE : type === 'ladiBanger' ? LADI_BANGER_STYLE : STYLES[type];
      const material = new THREE.MeshStandardMaterial({
        color: style.colour,
        roughness: 0.6,
        vertexColors: style.vertexColours ?? false,
        // A little self-light so props read on the dark lane.
        emissive: style.vertexColours ? '#3a2410' : style.colour,
        emissiveIntensity: style.vertexColours ? 1 : 0.25,
      });
      const mesh = new THREE.InstancedMesh(style.geometry(), material, Math.max(1, count));
      mesh.name = `crackerProps.${type}`;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move between frames; skip culling against stale bounds.
      mesh.frustumCulled = false;
      this.object.add(mesh);
      return mesh;
    };
    this.meshes = { anar: make('anar'), chakri: make('chakri'), rocket: make('rocket') };
    this.ladiCords = make('ladiCord');
    this.ladiBangers = make('ladiBanger', capacity * LADI_STRING.bangers);
  }

  /**
   * Show every ground cracker in `crackers` that still sits on the ground.
   * `spinnerPose` places a burning chakri where its sparks are and turns it
   * with them.
   */
  sync(crackers: readonly CrackerSnapshot[], spinnerPose?: (id: CrackerId) => SpinnerPose | null): void {
    const { anar, chakri, rocket } = this.meshes;
    anar.count = chakri.count = rocket.count = this.ladiCords.count = this.ladiBangers.count = 0;
    for (let i = 0; i < crackers.length; i++) {
      const cracker = crackers[i]!;
      if (cracker.type === 'phuljhari' || !onGround(cracker)) continue;
      if (cracker.type === 'ladi') {
        this.addLadi(cracker);
        continue;
      }
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
    this.ladiCords.instanceMatrix.needsUpdate = this.ladiBangers.instanceMatrix.needsUpdate = true;
  }

  /** A ladi's cord and fuse, and each banger still to pop; the next few twitch while it burns. */
  private addLadi(cracker: CrackerSnapshot): void {
    const cords = this.ladiCords;
    const bangers = this.ladiBangers;
    if (cords.count >= cords.instanceMatrix.count) return;
    const heading = cracker.heading ?? 0;
    const p = cracker.position;
    this.position.set(p.x, p.y, p.z);
    this.rotation.setFromAxisAngle(this.up, heading);
    cords.setMatrixAt(cords.count++, this.matrix.compose(this.position, this.rotation, this.scale));

    const popped = cracker.state === 'active' ? (cracker.popped ?? 0) : 0;
    const jumping = cracker.state === 'active' ? popped + LADI_JUMPING : 0;
    for (let b = popped; b < LADI_STRING.bangers; b++) {
      if (bangers.count >= bangers.instanceMatrix.count) return;
      const banger = ladiBanger(b);
      const at = ladiPoint(p, heading, banger.along, 0, this.point);
      let turn = heading + banger.turn;
      let lift = 0;
      if (b < jumping) {
        lift = Math.random() * LADI_HOP;
        turn += (Math.random() - 0.5) * LADI_TWITCH;
      }
      this.position.set(at.x, at.y + lift, at.z);
      this.rotation.setFromAxisAngle(this.up, turn);
      bangers.setMatrixAt(bangers.count++, this.matrix.compose(this.position, this.rotation, this.scale));
    }
  }

  dispose(): void {
    for (const mesh of [...Object.values(this.meshes), this.ladiCords, this.ladiBangers]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
