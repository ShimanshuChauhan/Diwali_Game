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
/**
 * How a figure wears its hair:
 * - `sidePart`: men's short, neat cut parted on the left, with lift at the front;
 * - `receding`: an older man's cut, high at the temples and greying at the sides;
 * - `balding`: a bald crown with a fringe of hair round the sides and back;
 * - `fringe`: a boy's fuller, rounder cut with tufts over the forehead;
 * - `bun`: centre parting, hair pulled back into a plain juda at the back;
 * - `bunGajra`: the same juda, ringed with a white jasmine gajra;
 * - `plait`: centre parting into a long choti down the back, ending in a paranda.
 *
 * `short` and `braid` are older names for `sidePart` and `plait`.
 */
export type HairStyle = 'sidePart' | 'receding' | 'balding' | 'fringe' | 'bun' | 'bunGajra' | 'plait' | 'short' | 'braid';

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
  /** Hip joints above the seat when sitting: the thighs' half-depth. */
  hipAboveSeat: 0.075,
} as const;

/**
 * The seated pose's hip and knee angles: thighs level along the seat, shins
 * straight down to the floor. The lower garment's seated shape is built for them.
 */
export const SEATED = { leg: Math.PI / 2, knee: Math.PI / 2 } as const;

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

/** Moves a vertex and its normal, in place, to where they lie when seated. */
type Drape = (position: THREE.Vector3, normal: THREE.Vector3) => void;

/** Collects coloured, placed primitives and merges them into one geometry. */
class Segment {
  private readonly parts: THREE.BufferGeometry[] = [];
  /** Parts already given a seated shape by `drape`. */
  private draped = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();

  add(
    geometry: THREE.BufferGeometry,
    colour: THREE.ColorRepresentation,
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

  /** Add a part already placed and coloured (it carries its own `color` attribute). */
  addPainted(geometry: THREE.BufferGeometry): this {
    geometry.deleteAttribute('uv');
    this.parts.push(geometry);
    return this;
  }

  /**
   * Like `add`, for a lock of hair: coloured `tone.base`, with a soft sheen
   * baked in where the surface faces `light` and shadow underneath.
   */
  addHair(
    geometry: THREE.BufferGeometry,
    tone: HairTone,
    light: THREE.Vector3,
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
    this.add(geometry, tone.base, x, y, z, rx, ry, rz, sx, sy, sz);
    shadeHair(geometry, tone, light);
    return this;
  }

  /**
   * Give the parts added since the last call a seated shape, as a morph
   * target: `drape` places each vertex. Every part of a draped segment needs one.
   */
  drape(drape: Drape): this {
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const part of this.parts.slice(this.draped)) {
      const position = part.getAttribute('position').clone();
      const normal = part.getAttribute('normal').clone();
      for (let i = 0; i < position.count; i++) {
        drape(p.fromBufferAttribute(position, i), n.fromBufferAttribute(normal, i));
        position.setXYZ(i, p.x, p.y, p.z);
        normal.setXYZ(i, n.x, n.y, n.z);
      }
      part.morphAttributes = { position: [position], normal: [normal] };
    }
    this.draped = this.parts.length;
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
 * `lathe`, with extra rings at the heights `cuts` (top to bottom) set into
 * the profile's straight runs so it can bend there when seated. Shape and
 * shading are as without them: each new ring's normals blend its run's ends.
 * The closed ends' degenerate triangles are left out.
 */
function ringedLathe(profile: readonly (readonly [number, number])[], cuts: readonly number[], segments: number): THREE.BufferGeometry {
  const ringed: [number, number][] = [];
  // Each ringed point as a blend of two original ones: [from, to, fraction].
  const blends: [number, number, number][] = [];
  profile.forEach(([r, y], i) => {
    const [r0, y0] = profile[i - 1] ?? [r, y];
    for (const cut of cuts) {
      if (cut >= y0 || cut <= y) continue;
      const f = (y0 - cut) / (y0 - y);
      ringed.push([r0 + (r - r0) * f, cut]);
      blends.push([i - 1, i, f]);
    }
    ringed.push([r, y]);
    blends.push([i, i, 0]);
  });
  const geometry = lathe(ringed, segments);
  const plain = lathe(profile, segments);
  const normal = geometry.getAttribute('normal');
  const from = plain.getAttribute('normal');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  // Lathe meridians run bottom to top, one per segment edge.
  const m = ringed.length;
  const n = profile.length;
  for (let column = 0; column <= segments; column++) {
    blends.forEach(([i, j, f], k) => {
      a.fromBufferAttribute(from, column * n + n - 1 - i);
      b.fromBufferAttribute(from, column * n + n - 1 - j);
      a.lerp(b, f).normalize();
      normal.setXYZ(column * m + m - 1 - k, a.x, a.y, a.z);
    });
  }
  plain.dispose();
  const position = geometry.getAttribute('position');
  const same = (p: number, q: number) => position.getX(p) === position.getX(q) && position.getY(p) === position.getY(q) && position.getZ(p) === position.getZ(q);
  const index = geometry.getIndex()!;
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [p, q, s] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (!same(p, q) && !same(q, s) && !same(p, s)) kept.push(p, q, s);
  }
  geometry.setIndex(kept);
  return geometry;
}

// ── seated drape ───────────────────────────────────────────────────────

/** Hip and knee joints below the waist, where the lower garment hangs from. */
const DRAPE_HIP = BODY.waistY - BODY.hipY;
const DRAPE_KNEE = DRAPE_HIP + BODY.thigh;
/** Rings the lower garments add where they bend: over the hips, and the saree's at the knees. */
const HIP_RINGS = [-(DRAPE_HIP + 0.02), -(DRAPE_HIP + 0.07)];
const KNEE_RINGS = [-DRAPE_KNEE, -(DRAPE_KNEE + 0.06)];
/** Seated, the cloth hugs the legs: its front and back come in by half, the back no further than this behind them. */
const DRAPE_HUG = 0.5;
const DRAPE_UNDER = 0.06;

/** Turn (y, z) about the x axis through (pivotY, 0), as a joint's `rotation.x` does. */
function turnX(v: THREE.Vector3, angle: number, pivotY = 0): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const y = v.y - pivotY;
  const z = v.z;
  v.y = pivotY + y * c - z * s;
  v.z = y * s + z * c;
}

/**
 * Where a lower-garment vertex lies seated (`SEATED`), in its hanging space
 * (y up from the waist). Above the hips the cloth stays put; below, it bends
 * forward with the thighs, its front lying over them and its back flattened
 * under them onto the seat, then at the knees falls to the floor in front of
 * the shins: the leg's own hip and knee turns, spread over the bend's rings.
 */
function seatVertex(p: THREE.Vector3, n: THREE.Vector3): void {
  const depth = -p.y;
  const hip = smoothstep(DRAPE_HIP - 0.03, DRAPE_HIP + 0.07, depth);
  const knee = smoothstep(DRAPE_KNEE - 0.07, DRAPE_KNEE + 0.05, depth);
  // Drawn in ahead of the bend, so the back stays above the seat as it turns under.
  const hug = smoothstep(DRAPE_HIP - 0.04, DRAPE_HIP + 0.03, depth);
  // z → g(z), so normals scale x and y by g′ (the inverse transpose).
  const under = p.z * DRAPE_HUG > DRAPE_UNDER;
  const z = under ? DRAPE_UNDER : p.z * DRAPE_HUG;
  const slope = 1 + ((under ? 0.1 : DRAPE_HUG) - 1) * hug;
  p.z += (z - p.z) * hug;
  n.set(n.x * slope, n.y * slope, n.z);
  turnX(p, -SEATED.knee * knee, -DRAPE_KNEE);
  turnX(n, -SEATED.knee * knee);
  turnX(p, SEATED.leg * hip, -DRAPE_HIP);
  turnX(n, SEATED.leg * hip);
  n.normalize();
}

/** The saree's front pleats (`buildTorso`): depths of their ends standing, tilted out at the foot. */
const PLEATS = { top: 0.11, bottom: 0.89, tilt: 0.08 } as const;

/** Seated, the pleats fall from the knees to the hem, just proud of the skirt. */
function seatPleat(p: THREE.Vector3, n: THREE.Vector3): void {
  const depth = -p.y;
  const top = DRAPE_KNEE + 0.06;
  const seated = top + ((depth - PLEATS.top) * (PLEATS.bottom - top)) / (PLEATS.bottom - PLEATS.top);
  p.y = -seated;
  p.z -= (seated - depth) * Math.tan(PLEATS.tilt) + 0.02;
  seatVertex(p, n);
}

// ── hair ────────────────────────────────────────────────────────────────

/** A hair colour with its baked highlight and shadow. */
interface HairTone {
  readonly base: THREE.Color;
  /** The soft lamp-lit sheen along the crown and on each lock. */
  readonly sheen: THREE.Color;
  /** Darker strands, the parting and the underside. */
  readonly shadow: THREE.Color;
}

const DARK_SHEEN = new THREE.Color('#c9a98c');
const LIGHT_SHEEN = new THREE.Color('#f4eee4');
/** Black hair is lifted a little so it never reads as a flat hole at night. */
const DARK_LIFT = new THREE.Color('#2e231d');
/** Greying temples on a receding cut. */
const TEMPLE_GREY = new THREE.Color('#b9b4ac');
const SINDOOR = '#d0122c';
const PARANDA_RED = '#c8102e';
const JASMINE = ['#fffdf5', '#f2ead0'] as const;

function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function hairTone(hex: string): HairTone {
  const base = new THREE.Color(hex);
  const dark = luminance(base) < 0.06;
  if (dark) base.lerp(DARK_LIFT, 0.3);
  const sheen = base.clone().lerp(dark ? DARK_SHEEN : LIGHT_SHEEN, dark ? 0.24 : 0.28);
  const shadow = base.clone().multiplyScalar(dark ? 0.6 : 0.55);
  return { base, sheen, shadow };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A repeatable pseudo-random number in [-1, 1] for column `n`. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Colour every vertex of a placed lock from its normal: sheen facing `light`, shadow underneath. */
function shadeHair(geometry: THREE.BufferGeometry, tone: HairTone, light: THREE.Vector3): void {
  const normal = geometry.getAttribute('normal');
  const colour = geometry.getAttribute('color');
  const c = new THREE.Color();
  const n = new THREE.Vector3();
  for (let i = 0; i < colour.count; i++) {
    n.fromBufferAttribute(normal, i).normalize();
    const d = n.dot(light);
    c.copy(tone.base)
      .lerp(tone.shadow, smoothstep(0, -0.7, d) * 0.6)
      .lerp(tone.sheen, smoothstep(0.5, 0.95, d) * 0.75);
    colour.setXYZ(i, c.r, c.g, c.b);
  }
}

/** Piecewise-linear [x, y] keyframes, sorted by x. */
type Keys = readonly (readonly [number, number])[];

function curve(keys: Keys, x: number): number {
  if (x <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [x1, y1] = keys[i]!;
    if (x <= x1) {
      const [x0, y0] = keys[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return keys[keys.length - 1]![1];
}

/**
 * The sculpted hair shell, by polar angle from the crown (0) and azimuth
 * round the head (0 at the forehead, π at the nape). Keyframes are by
 * |azimuth|, so both sides match unless swept.
 */
interface ShellSpec {
  /** Lower edge, the hairline: polar angle by |azimuth|. */
  readonly edge: Keys;
  /** Upper edge of a bald crown's horseshoe; omitted for a full head. */
  readonly top?: Keys;
  /** Lift off the scalp, as a fraction of head size, by |azimuth|. */
  readonly volume: Keys;
  /** Lift at the crown, where every column meets. */
  readonly crown: number;
  /** Azimuth of the parting, or null when combed without one. */
  readonly part: number | null;
  /** Extra lift on the far side of the parting, where the hair is swept over. */
  readonly sweep: number;
  /** Extra stand-off at the forehead, where the hair has thickness. */
  readonly front: number;
  /** Length of the tufts along the lower edge, radians; `fringeTufts` over the forehead. */
  readonly tufts: number;
  readonly fringeTufts?: number;
  /** Lumpiness of the locks, for an irregular silhouette. */
  readonly clump: number;
  /** Greying at the temples and sides. */
  readonly greyTemples?: boolean;
}

/** Ears sit at |azimuth| ≈ 1.4–1.85: the hair clears their tops; men's sideburns run just in front. */
const MEN_EDGE: Keys = [[0, 0.8], [0.45, 0.86], [0.75, 0.97], [1.0, 1.06], [1.15, 1.72], [1.33, 1.72], [1.42, 1.36], [1.85, 1.36], [2.05, 1.62], [2.5, 2.0], [Math.PI, 2.12]];
const RECEDING_EDGE: Keys = [[0, 0.64], [0.3, 0.6], [0.6, 0.42], [0.85, 0.62], [1.1, 1.05], [1.2, 1.6], [1.33, 1.6], [1.42, 1.36], [1.85, 1.36], [2.05, 1.6], [2.5, 1.98], [Math.PI, 2.1]];
const WOMEN_EDGE: Keys = [[0, 0.78], [0.5, 0.84], [0.85, 1.0], [1.15, 1.25], [1.4, 1.42], [1.85, 1.42], [2.1, 1.75], [2.6, 2.1], [Math.PI, 2.2]];

type ShellName = 'sidePart' | 'receding' | 'balding' | 'fringe' | 'sleek';

const SHELLS: Readonly<Record<ShellName, ShellSpec>> = {
  sidePart: {
    edge: MEN_EDGE,
    volume: [[0, 0.14], [1.2, 0.07], [1.8, 0.05], [Math.PI, 0.07]],
    crown: 0.13,
    part: -0.55,
    sweep: 0.06,
    front: 0.04,
    tufts: 0.05,
    clump: 0.035,
  },
  receding: {
    edge: RECEDING_EDGE,
    volume: [[0, 0.06], [1.2, 0.06], [Math.PI, 0.075]],
    crown: 0.07,
    part: null,
    sweep: 0,
    front: 0.015,
    tufts: 0.04,
    clump: 0.03,
    greyTemples: true,
  },
  balding: {
    edge: [[0, 1.0], [0.9, 1.05], [1.15, 1.6], [1.33, 1.6], [1.42, 1.36], [1.85, 1.36], [2.05, 1.6], [2.5, 1.98], [Math.PI, 2.1]],
    top: [[0, 1.0], [0.9, 1.05], [1.2, 0.98], [1.8, 0.88], [2.4, 0.76], [Math.PI, 0.72]],
    volume: [[0, 0], [1.1, 0.07], [Math.PI, 0.09]],
    crown: 0,
    part: null,
    sweep: 0,
    front: 0,
    tufts: 0.05,
    clump: 0.04,
  },
  fringe: {
    edge: [[0, 1.02], [0.7, 1.05], [1.0, 1.12], [1.15, 1.5], [1.33, 1.5], [1.42, 1.34], [1.85, 1.34], [2.05, 1.62], [2.5, 2.0], [Math.PI, 2.12]],
    volume: [[0, 0.17], [1.5, 0.12], [Math.PI, 0.12]],
    crown: 0.2,
    part: null,
    sweep: 0,
    front: 0.06,
    tufts: 0.05,
    fringeTufts: 0.1,
    clump: 0.045,
  },
  sleek: {
    edge: WOMEN_EDGE,
    volume: [[0, 0.055], [0.9, 0.1], [1.4, 0.07], [2.2, 0.05], [Math.PI, 0.06]],
    crown: 0.06,
    part: 0,
    sweep: 0,
    front: 0.01,
    tufts: 0.015,
    clump: 0.012,
  },
};

/** The face's half-size in head space (its sphere of radius 0.1, scaled 0.92 × 1.12 × 0.98). */
const SKULL = new THREE.Vector3(0.092, 0.112, 0.098);
/** Columns round the head and rows from crown to hairline. */
const SHELL_COLUMNS = 32;
const SHELL_ROWS = 6;
/** Half-width of the parting's gap, radians: the scalp shows through it. */
const PART_GAP = 0.05;
/** Hairline stand-off, as a fraction of head size. */
const EDGE_LIFT = 0.035;

/** A point on the skull lifted by `lift`, in head space around (0, cy, 0). */
function skullPoint(theta: number, phi: number, lift: number, cy: number, out: THREE.Vector3): THREE.Vector3 {
  const k = 1 + lift;
  return out.set(
    SKULL.x * Math.sin(theta) * Math.sin(phi) * k,
    cy + SKULL.y * Math.cos(theta) * k,
    -SKULL.z * Math.sin(theta) * Math.cos(phi) * k,
  );
}

/**
 * The hair over the scalp as one sculpted shell: a hairline that dips at the
 * temples and sideburns and rises over the ears, volume on top, tufts along
 * the edge, and a real parting where the two sides lift away from a line of
 * scalp. Vertex colours carry the strands, a broken halo of sheen round the
 * crown and darker roots at the parting. Its edge tucks under into the skin
 * so no gap shows from below.
 */
function hairShell(spec: ShellSpec, tone: HairTone, cy: number): THREE.BufferGeometry {
  const N = SHELL_COLUMNS;
  const rows = SHELL_ROWS + 2; // crown to hairline, then the tuck
  const seam = spec.part ?? Math.PI;
  const gap = spec.part === null ? 0 : PART_GAP;
  const band = spec.top !== undefined;
  const positions = new Float32Array((N + 1) * rows * 3);
  const colours = new Float32Array((N + 1) * rows * 3);
  const widths: number[] = [];
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let j = 0; j <= N; j++) {
    const phi = seam + gap + ((Math.PI * 2 - gap * 2) * j) / N;
    const wrapped = Math.atan2(Math.sin(phi), Math.cos(phi));
    const side = Math.abs(wrapped);
    const top = spec.top ? curve(spec.top, side) : 0;
    const hairline = curve(spec.edge, side);
    let tuft = 0;
    if (j % 2 === 1 && hairline - top > 0.05) {
      tuft = side < 0.95 && spec.fringeTufts !== undefined ? spec.fringeTufts : spec.tufts * (side > 2.3 ? 1.3 : 1);
    }
    const bottom = Math.max(top, hairline + tuft);
    widths.push(bottom - top);
    const atPart = spec.part !== null && (j === 0 || j === N);
    const volume = curve(spec.volume, side) + spec.sweep * Math.max(0, Math.cos(wrapped - 0.35));
    const front = spec.front * Math.max(0, Math.cos(wrapped));
    // Columns 0 and N meet at the seam, so they share their strand.
    const strand = hash(j % N);
    const glint = 0.55 + 0.45 * hash((j % N) + 57);
    for (let i = 0; i < rows; i++) {
      const tuck = i === rows - 1;
      const t = Math.min(i, SHELL_ROWS) / SHELL_ROWS;
      const theta = tuck ? bottom + 0.03 : top + (bottom - top) * t;
      let lift: number;
      if (tuck) lift = -0.03;
      else if (band) lift = 0.01 + (volume + spec.clump * strand) * Math.sin(Math.PI * t);
      else {
        // The crown is shared by every column; volume eases off to hug the skin at the hairline.
        const body = (spec.crown * (1 - t) + volume * t) * (1 - t * t);
        lift = EDGE_LIFT + front * t + body + spec.clump * strand * t * (1 - t) * 4;
        if (atPart && i > 0) lift = Math.min(lift, 0.012);
      }
      skullPoint(theta, phi, lift, cy, p).toArray(positions, (j * rows + i) * 3);
      // Strands, a broken halo of sheen round the crown, darker at the roots of the parting.
      c.copy(tone.base);
      if (strand < 0) c.lerp(tone.shadow, -strand * 0.35);
      if (!tuck) c.lerp(tone.sheen, Math.exp(-(((theta - 0.62) / 0.17) ** 2)) * glint * 0.85);
      if (spec.greyTemples) c.lerp(TEMPLE_GREY, smoothstep(0.75, 1.15, side) * (1 - smoothstep(2.1, 2.7, side)) * smoothstep(0.3, 0.8, t) * 0.7);
      if (atPart || tuck) c.lerp(tone.shadow, 0.5);
      c.toArray(colours, (j * rows + i) * 3);
    }
  }
  const index: number[] = [];
  const v = (i: number, j: number) => j * rows + i;
  for (let j = 0; j < N; j++) {
    if (widths[j]! < 1e-3 && widths[j + 1]! < 1e-3) continue;
    for (let i = 0; i < rows - 1; i++) {
      const a = v(i, j);
      const b = v(i, j + 1);
      const below = v(i + 1, j);
      const d = v(i + 1, j + 1);
      // Every column meets at the crown, so the first row is a fan.
      if (band || i > 0) index.push(a, b, below);
      index.push(b, d, below);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  // Smooth the shading where columns meet: the crown, and a seam without a parting.
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  if (!band) for (let j = 0; j <= N; j++) normal.setXYZ(v(0, j), 0, 1, 0);
  if (spec.part === null) {
    const n = new THREE.Vector3();
    const m = new THREE.Vector3();
    for (let i = band ? 0 : 1; i < rows; i++) {
      n.fromBufferAttribute(normal, v(i, 0)).add(m.fromBufferAttribute(normal, v(i, N))).normalize();
      normal.setXYZ(v(i, 0), n.x, n.y, n.z);
      normal.setXYZ(v(i, N), n.x, n.y, n.z);
    }
  }
  return geometry;
}

/** Hair parts other code (and the tests) can find by name: zero-cost markers. */
type HairAnchors = [name: string, at: THREE.Vector3][];

interface HairBuild {
  readonly anchors: HairAnchors;
  /** The plait, built in the nape pivot's space; null for other styles. */
  readonly plait: { readonly segment: Segment; readonly anchors: HairAnchors } | null;
}

/** Where the plait hangs from, in head space: the nape. */
const PLAIT_NAPE = new THREE.Vector3(0, 0.05, 0.085);
/**
 * How much of the head's turn the plait follows. It hangs from the nape but
 * keeps its lie down the back as the head nods and turns.
 */
const PLAIT_FOLLOW = 0.3;
/**
 * The plait's path, [down, back] in the nape pivot's space: out over the
 * collar and the saree's pallu (which wraps the back at radius ≈ 0.2), then
 * straight down to the waist, clear of the body even with the head thrown back.
 */
const PLAIT_PATH = [
  [0, 0],
  [-0.035, 0.06],
  [-0.075, 0.115],
  [-0.11, 0.14],
  [-0.16, 0.152],
  [-0.4, 0.154],
  [-0.6, 0.157],
] as const;
const PLAIT_LOBES = 13;

/** Light direction for the baked sheen on locks: from above and a little behind. */
const HAIR_LIGHT = new THREE.Vector3(0, 0.8, 0.6).normalize();

type Style = Exclude<HairStyle, 'short' | 'braid'>;

function canonicalStyle(style: HairStyle): Style {
  if (style === 'short') return 'sidePart';
  if (style === 'braid') return 'plait';
  return style;
}

function wornBack(style: Style): boolean {
  return style === 'bun' || style === 'bunGajra' || style === 'plait';
}

/** Add the look's hair to the head segment; the plait comes back separately. */
function buildHair(head: Segment, look: Look, tone: HairTone, cy: number): HairBuild {
  const style = canonicalStyle(look.hairStyle);
  const back = wornBack(style);
  head.addPainted(hairShell(SHELLS[back ? 'sleek' : (style as ShellName)], tone, cy));
  const anchors: HairAnchors = [];
  if (back && look.bindi) {
    // Sindoor in the front of the parting.
    const path = new THREE.CatmullRomCurve3([0.3, 0.5, 0.68].map((theta) => skullPoint(theta, 0, 0.006, cy, new THREE.Vector3())));
    head.add(new THREE.TubeGeometry(path, 4, 0.0028, 3), SINDOOR);
  }
  if (style === 'bun' || style === 'bunGajra') {
    // The juda: a coiled knot low on the back of the head.
    const festive = style === 'bunGajra';
    const radius = festive ? 0.044 : 0.037;
    const at = new THREE.Vector3(0, cy - (festive ? 0.015 : 0.005), festive ? 0.115 : 0.108);
    head.addHair(new THREE.SphereGeometry(radius, 10, 8), tone, HAIR_LIGHT, at.x, at.y, at.z, 0, 0, 0, 1, 0.88, 0.72);
    head.addHair(new THREE.TorusGeometry(radius * 0.7, radius * 0.3, 6, 14), tone, HAIR_LIGHT, at.x, at.y, at.z + radius * 0.36, 0, 0, 0.4, 1, 0.9, 0.8);
    anchors.push(['hair.bun', at]);
    if (festive) {
      // Gajra: jasmine buds strung round the bun, with a short strand hanging at the side.
      const ring = 16;
      for (let k = 0; k < ring; k++) {
        const a = (k / ring) * Math.PI * 2;
        head.add(new THREE.OctahedronGeometry(0.0085), JASMINE[k % 2]!, at.x + Math.cos(a) * radius * 1.08, at.y + Math.sin(a) * radius * 0.98, at.z - 0.002, a, a * 0.5, 0, 1, 1, 0.8);
      }
      for (let k = 0; k < 3; k++) {
        head.add(new THREE.OctahedronGeometry(0.008), JASMINE[k % 2]!, at.x + radius * 1.05 + k * 0.002, at.y - 0.02 - k * 0.016, at.z - 0.006, k, 0, 0, 1, 1.15, 0.8);
      }
      anchors.push(['hair.gajra', at.clone().setZ(at.z - 0.002)]);
    }
  }
  return { anchors, plait: style === 'plait' ? buildPlait(tone, look) : null };
}

/**
 * A choti that reads as a braid: overlapping lobes leaning alternately left
 * and right down a curve, tapering, tied off with a red band and finished
 * with a paranda of three silk tassels on gold beads.
 */
function buildPlait(tone: HairTone, look: Look): { segment: Segment; anchors: HairAnchors } {
  const plait = new Segment();
  const path = new THREE.CatmullRomCurve3(PLAIT_PATH.map(([y, z]) => new THREE.Vector3(0, y, z)));
  const across = new THREE.Vector3(1, 0, 0);
  const lobe = new THREE.SphereGeometry(1, 7, 5);
  const darker: HairTone = { ...tone, base: tone.base.clone().lerp(tone.shadow, 0.35) };
  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const out = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const side = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  for (let i = 0; i < PLAIT_LOBES; i++) {
    const f = i / (PLAIT_LOBES - 1);
    const u = 0.02 + f * 0.9;
    path.getPointAt(u, point);
    path.getTangentAt(u, tangent);
    // Away from the back, then each lobe leans ±0.5 rad off the run of the plait.
    out.crossVectors(tangent, across).normalize();
    const lean = i % 2 === 0 ? 0.5 : -0.5;
    axis.copy(tangent).negate().applyAxisAngle(out, lean);
    side.crossVectors(axis, out).normalize();
    const width = 0.027 - 0.011 * f;
    const shift = (i % 2 === 0 ? -1 : 1) * width * 0.32;
    basis.makeBasis(side.multiplyScalar(width), axis.multiplyScalar(0.034), out.multiplyScalar(width * 0.6));
    basis.setPosition(point.x + shift, point.y, point.z);
    plait.addHair(lobe.clone().applyMatrix4(basis), i % 2 === 0 ? tone : darker, HAIR_LIGHT);
  }
  lobe.dispose();
  const end = path.getPointAt(1);
  // Tie band, a short tail of black thread, then the tassels.
  plait.add(new THREE.CylinderGeometry(0.013, 0.013, 0.016, 8), PARANDA_RED, end.x, end.y + 0.01, end.z);
  plait.add(new THREE.ConeGeometry(0.012, 0.045, 6), '#141010', end.x, end.y - 0.02, end.z, Math.PI, 0, 0);
  const tassels: readonly (readonly [number, THREE.ColorRepresentation])[] = [[-0.013, PARANDA_RED], [0, look.trim], [0.013, PARANDA_RED]];
  for (const [x, colour] of tassels) {
    const drop = x === 0 ? 0.008 : 0;
    plait.add(new THREE.OctahedronGeometry(0.0075), GOLD, end.x + x, end.y - 0.048 - drop, end.z);
    plait.add(new THREE.ConeGeometry(0.0095, 0.04, 6), colour, end.x + x * 1.3, end.y - 0.075 - drop, end.z);
  }
  return {
    segment: plait,
    anchors: [
      ['hair.plait.tie', end.clone().setY(end.y + 0.01)],
      ['hair.plait.paranda', end.clone().setY(end.y - 0.07)],
    ],
  };
}

/** Arched brows and, if worn, a moustache, in the hair's shadow tone. */
function buildBrows(head: Segment, look: Look, tone: HairTone, cy: number): void {
  const back = wornBack(canonicalStyle(look.hairStyle));
  const grey = luminance(tone.base) > 0.2;
  const brow = grey ? tone.base.clone().lerp(tone.shadow, 0.5) : tone.shadow;
  const thick = back ? 0.0055 : grey ? 0.01 : 0.008;
  // On the face's surface, a few millimetres proud, following its curve.
  const surface = (x: number, dy: number) => -SKULL.z * Math.sqrt(Math.max(0, 1 - (x / SKULL.x) ** 2 - (dy / SKULL.y) ** 2)) - 0.005;
  // Inner half rising gently, outer half arched down toward the temple, joined end to end.
  const inner = { x: 0.026, y: 0.046, half: 0.012, tilt: 0.08 };
  const outerHalf = 0.0105;
  const outerTilt = -0.36;
  const joinX = inner.x + inner.half * Math.cos(inner.tilt) - 0.002;
  const joinY = inner.y + inner.half * Math.sin(inner.tilt);
  const outer = { x: joinX + outerHalf * Math.cos(outerTilt), y: joinY + outerHalf * Math.sin(outerTilt) };
  for (const side of [-1, 1]) {
    head.add(new THREE.BoxGeometry(inner.half * 2, thick, 0.008), brow, side * inner.x, cy + inner.y, surface(inner.x, inner.y), 0, side * 0.3, side * inner.tilt);
    head.add(new THREE.BoxGeometry(outerHalf * 2, thick * 0.85, 0.008), brow, side * outer.x, cy + outer.y, surface(outer.x, outer.y), 0, side * 0.55, side * outerTilt);
  }
  if (look.moustache) {
    for (const side of [-1, 1]) {
      head.add(new THREE.BoxGeometry(0.03, 0.012, 0.012), brow, side * 0.014, cy - 0.036, surface(0.014, -0.036) - 0.002, 0, side * 0.25, side * -0.22);
    }
  }
}

/** A named, zero-cost marker at a hair part. */
function hairAnchor(name: string, at: THREE.Vector3): THREE.Object3D {
  const anchor = new THREE.Object3D();
  anchor.name = name;
  anchor.position.copy(at);
  anchor.matrixAutoUpdate = false;
  anchor.updateMatrix();
  return anchor;
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
  /** The skirt or kurta below the waist, with its seated shape as a morph target. */
  private lower!: THREE.Mesh;
  /** Where a plait hangs from the nape; it keeps its lie down the back as the head moves. */
  private plaitPivot: THREE.Group | null = null;

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
    // Undo the nod and most of the turn: Ry(yaw)·Rx(pitch)·Rx(-pitch)·Ry(-yaw·(1-k)) = Ry(k·yaw).
    this.plaitPivot?.rotation.set(-(pose.headPitch ?? 0), -(pose.headYaw ?? 0) * (1 - PLAIT_FOLLOW), 0, 'XYZ');
    const [leftShoulder, rightShoulder] = this.shoulders;
    leftShoulder.rotation.set(pose.leftArm ?? 0, 0, -(pose.leftSpread ?? 0));
    rightShoulder.rotation.set(pose.rightArm ?? 0, 0, pose.rightSpread ?? 0);
    this.elbows[0].rotation.x = pose.leftElbow ?? 0;
    this.elbows[1].rotation.x = pose.rightElbow ?? 0;
    // Sitting (both thighs well forward), the lower garment takes its seated
    // shape and a saree's legs come out to their full angles under it.
    const seated = smoothstep(0.9, 1.4, Math.min(pose.leftLeg ?? 0, pose.rightLeg ?? 0));
    this.lower.morphTargetInfluences![0] = seated;
    // Legs swing less inside a saree, so they stay under its skirt.
    const stride = this.saree ? 0.35 + 0.65 * seated : 1;
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

  private keep(segment: Segment, parent: THREE.Object3D, name: string): THREE.Mesh {
    const mesh = segment.mesh(parent, name);
    this.meshes.push(mesh);
    return mesh;
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
      lower.add(ringedLathe([[0, 0], [0.14, 0], [0.165, -0.12], [0.19, -0.5], [0.225, -w + 0.06], [0.23, -w + 0.04], [0, -w + 0.04]], [...HIP_RINGS, ...KNEE_RINGS], 20), look.main);
      lower.add(new THREE.CylinderGeometry(0.232, 0.232, 0.07, 20, 1, true), look.trim, 0, -w + 0.075);
      lower.drape(seatVertex);
      // Pleats gathered at the front: a slightly raised panel with a gold edge.
      lower.add(new THREE.BoxGeometry(0.1, 0.78, 0.02), look.main, 0.03, -0.5, -0.19, PLEATS.tilt, 0, 0);
      lower.add(new THREE.BoxGeometry(0.012, 0.78, 0.022), look.trim, 0.08, -0.5, -0.19, PLEATS.tilt, 0, 0);
      lower.drape(seatPleat);
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
      lower.add(ringedLathe([[0, 0], [0.155, 0], [0.17, -0.1], [0.21, -0.4], [0.24, -0.5], [0, -0.5]], HIP_RINGS, 20), look.main);
      lower.add(new THREE.CylinderGeometry(0.242, 0.242, 0.04, 20, 1, true), look.trim, 0, -0.48);
      lower.drape(seatVertex);
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
    this.lower = this.keep(lower, hips, 'figure.lower');
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
    }
    head.add(new THREE.ConeGeometry(0.014, 0.04, 8), look.skin, 0, cy - 0.01, -0.098, -Math.PI / 2 - 0.25, 0, 0);
    head.add(new THREE.BoxGeometry(0.036, 0.008, 0.01), LIP, 0, cy - 0.052, -0.088);
    if (look.bindi) head.add(new THREE.SphereGeometry(0.006, 6, 4), '#c8102e', 0, cy + 0.058, -0.088);
    // Brows, moustache and hair, all parented to the head.
    const tone = hairTone(look.hair);
    buildBrows(head, look, tone, cy);
    const hair = buildHair(head, look, tone, cy);
    this.head.position.y = BODY.neckY - BODY.waistY + 0.03;
    this.chest.add(this.head);
    this.keep(head, this.head, 'figure.head');
    for (const [name, at] of hair.anchors) this.head.add(hairAnchor(name, at));
    if (hair.plait) {
      const pivot = new THREE.Group();
      pivot.name = 'hair.plaitPivot';
      pivot.position.copy(PLAIT_NAPE);
      this.head.add(pivot);
      this.plaitPivot = pivot;
      this.keep(hair.plait.segment, pivot, 'hair.plait');
      for (const [name, at] of hair.plait.anchors) pivot.add(hairAnchor(name, at));
    }
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
