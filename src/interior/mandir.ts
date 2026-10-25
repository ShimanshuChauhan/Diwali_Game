import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QualityLevel } from '../core/types';
import type { InteriorMaterial, MandirSite } from './layout';

/**
 * The family home's carved wooden mandir, in the style of a sheesham home
 * mandir: a raised base with two drawers, turned pillars at the front
 * corners, a cusped (multifoil) arch with a gilt edge, jali side panels, a
 * golden backboard, and a roof with a central gumbad, corner chhatris and a
 * brass kalash. Inside, on red cloth, sit Ganesh (elephant head, big ears,
 * curled trunk, round belly, four arms, crown, his mouse beside him) and
 * Lakshmi (crowned, four-armed, seated on a pink lotus before a gold halo),
 * with a kalash of mango leaves and a coconut, a brass diya, incense and
 * marigolds. Brass bells hang in the arch and a marigold garland is swagged
 * across it.
 *
 * Everything is original procedural geometry: lathes for turned and round
 * parts, extruded shapes for the arch, jali and drawers, and small composed
 * primitives for the idols. Pieces are merged into one geometry per surface
 * and painted with vertex colours, so the whole mandir is seven draw calls:
 * five materials of its own (wood, metal, matte, glaze, bloom) and the
 * room's flame and lamp glow. The wood grain is a `DataTexture` made from
 * math, so the module builds headless with no DOM or canvas.
 *
 * It is built in two levels of detail: Low uses fewer lathe and sphere
 * segments, plainer jali and no small carving; Medium and High share the
 * full one. Both are built once at boot and cached on the shared assets,
 * like every other interior resource; switching quality only flips which is
 * drawn.
 *
 * Mandir-local coordinates: origin at the centre of the back edge at the
 * foot, x across (the viewer's right is +x), y up, z out of the wall
 * towards the viewer.
 */

export type MandirDetail = 'low' | 'full';
export const MANDIR_DETAILS: readonly MandirDetail[] = ['low', 'full'];

/** Which detail level a quality level draws. */
export function mandirDetail(level: QualityLevel): MandirDetail {
  return level === 'low' ? 'low' : 'full';
}

/** How a merged piece is lit; one material each. */
type Surface = 'wood' | 'metal' | 'matte' | 'glaze' | 'bloom' | 'flame' | 'glow';
const SURFACES: readonly Surface[] = ['wood', 'metal', 'matte', 'glaze', 'bloom', 'flame', 'glow'];

/** Vertex colours, and the surface each goes on. */
const PAINTS = {
  wood: { surface: 'wood', color: '#d89050' },
  woodDark: { surface: 'wood', color: '#8a4620' },
  gold: { surface: 'metal', color: '#ffc850' },
  goldDeep: { surface: 'metal', color: '#c88a28' },
  brass: { surface: 'metal', color: '#e0aa48' },
  red: { surface: 'matte', color: '#c01c2c' },
  saree: { surface: 'matte', color: '#c8183a' },
  saffron: { surface: 'matte', color: '#f08a18' },
  leaf: { surface: 'matte', color: '#3f8a2c' },
  ink: { surface: 'matte', color: '#1a0e0a' },
  coconut: { surface: 'matte', color: '#7a4a26' },
  husk: { surface: 'matte', color: '#4a2c16' },
  mouse: { surface: 'matte', color: '#8c8278' },
  modak: { surface: 'matte', color: '#f8d890' },
  incense: { surface: 'matte', color: '#3a1c12' },
  marble: { surface: 'glaze', color: '#fff6ea' },
  ivory: { surface: 'glaze', color: '#fff0d0' },
  earInner: { surface: 'glaze', color: '#f0a8a0' },
  marigold: { surface: 'bloom', color: '#ff8a10' },
  marigoldYellow: { surface: 'bloom', color: '#ffc818' },
  lotus: { surface: 'bloom', color: '#f06aa0' },
  lotusLight: { surface: 'bloom', color: '#ffb0cc' },
  pod: { surface: 'bloom', color: '#f2c030' },
  flame: { surface: 'flame', color: '#ffffff' },
  glow: { surface: 'glow', color: '#ffffff' },
} as const satisfies Record<string, { readonly surface: Surface; readonly color: string }>;
type Paint = keyof typeof PAINTS;

interface DetailSpec {
  /** Segments around turned pillars, domes and pots. */
  readonly lathe: number;
  /** Segments around and up a sphere, and a small one (eyes, hands, petals). */
  readonly sphere: readonly [number, number];
  readonly smallSphere: readonly [number, number];
  /** Rings in each round end of a limb. */
  readonly capSegments: number;
  /** Segments around limbs, the trunk and rings. */
  readonly radial: number;
  /** Lobes in the cusped arch, and samples per lobe. */
  readonly lobes: number;
  readonly lobeSteps: number;
  /** Jali holes across and up each side panel. */
  readonly jali: readonly [number, number];
  /** Spacing and size of the garland's flower beads. */
  readonly beadStep: number;
  readonly beadRadius: number;
  /** Lotus petals in the outer and inner rings. */
  readonly petals: readonly [number, number];
  /** Small carving: dentils, merlons, extra chhatris, bangles, neck garlands. */
  readonly carving: boolean;
}

const DETAIL: Readonly<Record<MandirDetail, DetailSpec>> = {
  low: {
    lathe: 8,
    sphere: [7, 5],
    smallSphere: [5, 3],
    capSegments: 1,
    radial: 5,
    lobes: 7,
    lobeSteps: 3,
    jali: [2, 6],
    beadStep: 0.04,
    beadRadius: 0.019,
    petals: [8, 6],
    carving: false,
  },
  full: {
    lathe: 14,
    sphere: [9, 7],
    smallSphere: [6, 4],
    capSegments: 2,
    radial: 8,
    lobes: 9,
    lobeSteps: 6,
    jali: [3, 10],
    beadStep: 0.019,
    beadRadius: 0.0135,
    petals: [12, 8],
    carving: true,
  },
};

/** A named piece of the mandir, for tests and debugging. */
export interface MandirPart {
  /** Mandir-local bounds. */
  readonly bounds: THREE.Box3;
  readonly triangles: number;
}

/** One detail level's merged geometry, built once and shared. */
export interface MandirModel {
  readonly detail: MandirDetail;
  readonly geometries: ReadonlyMap<Surface, THREE.BufferGeometry>;
  /** Pillars, arch, dome, kalash, bells, ganesh, lakshmi and the rest. */
  readonly parts: ReadonlyMap<string, MandirPart>;
  readonly triangles: number;
}

/** Wood grain texture repeat, in metres per tile. */
const GRAIN_TILE = 0.32;

/**
 * The mandir's materials, grain texture and merged models, shared by every
 * build. Flames and the backboard light use the room's own materials, so
 * they flicker and glow with the rest of the home.
 */
export class MandirAssets {
  readonly grain: THREE.DataTexture;
  private readonly materials: ReadonlyMap<Surface, THREE.Material>;
  private readonly own: readonly THREE.Material[];
  private readonly models = new Map<string, MandirModel>();

  constructor(shared: (key: InteriorMaterial) => THREE.Material) {
    this.grain = createWoodGrainTexture();
    const painted = (name: string, params: THREE.MeshStandardMaterialParameters) => {
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, ...params });
      material.name = `interior.mandir.${name}`;
      return material;
    };
    const wood = painted('wood', { map: this.grain, roughness: 0.42, emissive: '#2a1206', emissiveIntensity: 0.6 });
    const metal = painted('metal', { roughness: 0.32, metalness: 0.65, emissive: '#6a4208', emissiveIntensity: 0.75 });
    const matte = painted('matte', { roughness: 0.85, emissive: '#2a1408', emissiveIntensity: 0.5 });
    const glaze = painted('glaze', { roughness: 0.32, emissive: '#5a4430', emissiveIntensity: 0.55 });
    const bloom = painted('bloom', { roughness: 0.8, emissive: '#5a2006', emissiveIntensity: 0.55 });
    this.own = [wood, metal, matte, glaze, bloom];
    this.materials = new Map<Surface, THREE.Material>([
      ['wood', wood],
      ['metal', metal],
      ['matte', matte],
      ['glaze', glaze],
      ['bloom', bloom],
      ['flame', shared('flame')],
      ['glow', shared('lampShade')],
    ]);
  }

  material(surface: Surface): THREE.Material {
    return this.materials.get(surface)!;
  }

  /** The merged model for a site's size at one detail level, built on first use. */
  model(site: MandirSite, detail: MandirDetail): MandirModel {
    const key = `${detail}:${site.width}:${site.depth}:${site.height}`;
    let model = this.models.get(key);
    if (!model) {
      model = buildMandirModel(site, detail);
      this.models.set(key, model);
    }
    return model;
  }

  /** Geometries, the mandir's own materials and the grain texture; the room's are left to `InteriorAssets`. */
  dispose(): void {
    for (const model of this.models.values()) for (const geometry of model.geometries.values()) geometry.dispose();
    this.models.clear();
    for (const material of this.own) material.dispose();
    this.grain.dispose();
  }
}

/** A built mandir in a home: both detail levels, one drawn at a time. */
export interface MandirView {
  readonly root: THREE.Group;
  readonly levels: Readonly<Record<MandirDetail, THREE.Group>>;
  readonly models: Readonly<Record<MandirDetail, MandirModel>>;
  /** The detail level currently drawn. */
  readonly shown: MandirDetail;
  applyQuality(level: QualityLevel): void;
}

/** Places the shared mandir models at a site; creates meshes only, no GPU resources. */
export function buildMandir(site: MandirSite, assets: MandirAssets, prefix = 'interior'): MandirView {
  const root = new THREE.Group();
  root.name = `${prefix}.${site.id}`;
  root.position.set(site.position.x, site.position.y, site.position.z);
  const make = (detail: MandirDetail) => {
    const model = assets.model(site, detail);
    const group = new THREE.Group();
    group.name = `${root.name}.${detail}`;
    for (const [surface, geometry] of model.geometries) {
      const mesh = new THREE.Mesh(geometry, assets.material(surface));
      mesh.name = `${group.name}.${surface}`;
      group.add(mesh);
    }
    root.add(group);
    return { model, group };
  };
  const low = make('low');
  const full = make('full');
  const levels = { low: low.group, full: full.group };
  let shown: MandirDetail = 'full';
  low.group.visible = false;
  return {
    root,
    levels,
    models: { low: low.model, full: full.model },
    get shown() {
      return shown;
    },
    applyQuality(level) {
      shown = mandirDetail(level);
      low.group.visible = shown === 'low';
      full.group.visible = shown === 'full';
    },
  };
}

// ── Wood grain ────────────────────────────────────────────────────────────

/** Integer hash → [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise that repeats every `px` × `py` lattice cells, so the texture tiles. */
function noise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash(x0, y0, seed) + (hash(x1, y0, seed) - hash(x0, y0, seed)) * sx;
  const b = hash(x0, y1, seed) + (hash(x1, y1, seed) - hash(x0, y1, seed)) * sx;
  return a + (b - a) * sy;
}

/**
 * Tileable polished-wood grain from math alone (no canvas): wavy growth
 * lines running along v, fine fibres and a soft tone variation, in warm
 * neutral tones the material's vertex colours tint to honey or dark wood.
 */
export function createWoodGrainTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const light = [255, 240, 222];
  const dark = [150, 104, 70];
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const warp = noise(u * 4, v * 2, 4, 2, 1) * 0.7 + noise(u * 8, v * 6, 8, 6, 2) * 0.2;
      const ring = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 16 + warp * 1.4));
      const lines = ring * ring * ring * ring * ring * ring;
      const fibre = noise(u * 160, v * 5, 160, 5, 3);
      const tone = noise(u * 3, v * 3, 3, 3, 4);
      const t = Math.min(1, 0.32 * lines + 0.22 * fibre * fibre + 0.3 * tone);
      const o = (j * size + i) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(light[c]! + (dark[c]! - light[c]!) * t);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'interior.mandir.grain';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// ── Model building ────────────────────────────────────────────────────────

type V3 = readonly [number, number, number];
type Grain = 'vertical' | 'horizontal';

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const UP = new THREE.Vector3(0, 1, 0);

/** Translation, Euler rotation (XYZ) and scale as one matrix. */
function place(at: V3, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    v3(at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    v3(scale),
  );
}

/**
 * Collects transformed pieces per surface, painted with vertex colours, and
 * records each named part's bounds and triangles.
 */
class Pieces {
  private readonly bySurface = new Map<Surface, THREE.BufferGeometry[]>();
  readonly parts = new Map<string, { bounds: THREE.Box3; triangles: number }>();
  private readonly colour = new THREE.Color();

  add(part: string, paint: Paint, geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, grain: Grain = 'vertical'): void {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    g.clearGroups();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const { surface, color } = PAINTS[paint];
    if (surface === 'wood') projectGrain(g, grain);
    else if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const count = g.getAttribute('position').count;
    const colours = new Float32Array(count * 3);
    this.colour.set(color);
    for (let i = 0; i < count; i++) this.colour.toArray(colours, i * 3);
    g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    const list = this.bySurface.get(surface);
    if (list) list.push(g);
    else this.bySurface.set(surface, [g]);
    g.computeBoundingBox();
    const entry = this.parts.get(part);
    if (entry) {
      entry.bounds.union(g.boundingBox!);
      entry.triangles += count / 3;
    } else {
      this.parts.set(part, { bounds: g.boundingBox!.clone(), triangles: count / 3 });
    }
    // The merged geometry has its own bounds; keep the piece lean until then.
    g.boundingBox = null;
  }

  merge(): Map<Surface, THREE.BufferGeometry> {
    const out = new Map<Surface, THREE.BufferGeometry>();
    for (const surface of SURFACES) {
      const list = this.bySurface.get(surface);
      if (!list?.length) continue;
      const merged = mergeGeometries(list, false);
      for (const piece of list) piece.dispose();
      if (!merged) throw new Error(`mandir: could not merge ${surface}`);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      out.set(surface, merged);
    }
    this.bySurface.clear();
    return out;
  }
}

/**
 * Planar UVs from mandir-local position, picked per face by its normal, so
 * grain has the same scale on every piece: up the pillars and panels
 * (`vertical`), along beams and drawers (`horizontal`).
 */
function projectGrain(g: THREE.BufferGeometry, grain: Grain): void {
  const position = g.getAttribute('position');
  const normal = g.getAttribute('normal');
  const uv = new Float32Array(position.count * 2);
  const k = 1 / GRAIN_TILE;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    let across: number;
    let along: number;
    if (ny >= nx && ny >= nz) [across, along] = grain === 'horizontal' ? [z, x] : [x, z];
    else if (nx >= nz) [across, along] = grain === 'horizontal' ? [y, z] : [z, y];
    else [across, along] = grain === 'horizontal' ? [y, x] : [x, y];
    uv[i * 2] = across * k;
    uv[i * 2 + 1] = along * k;
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
}

/** A tube along `points` whose radius tapers from `r0` to `r1`, capped at the thin end. */
function taperedTube(points: readonly V3[], r0: number, r1: number, segments: number, radial: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(v3));
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const r = r0 + (r1 - r0) * t;
    const n = frames.normals[i]!;
    const b = frames.binormals[i]!;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      positions.push(p.x + r * (c * n.x + s * b.x), p.y + r * (c * n.y + s * b.y), p.z + r * (c * n.z + s * b.z));
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      index.push(a, b, c, b, d, c);
    }
  }
  // Round the tip off with a point just past the end.
  const tip = positions.length / 3;
  curve.getPointAt(1, p);
  const tangent = frames.tangents[segments]!;
  positions.push(p.x + tangent.x * r1, p.y + tangent.y * r1, p.z + tangent.z * r1);
  for (let j = 0; j < radial; j++) index.push(segments * radial + j, segments * radial + ((j + 1) % radial), tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Points along a cusped (multifoil) arch from (-a, spring) over to (a, spring). */
function cuspedArch(a: number, rise: number, spring: number, lobes: number, steps: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const onArch = (k: number) => {
    const theta = Math.PI - (Math.PI * k) / lobes;
    return new THREE.Vector2(a * Math.cos(theta), spring + rise * Math.sin(theta));
  };
  for (let k = 0; k < lobes; k++) {
    const p0 = onArch(k);
    const p1 = onArch(k + 1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const out1 = new THREE.Vector2(mid.x / a, (mid.y - spring) / rise).normalize();
    const control = mid.clone().addScaledVector(out1, 0.6 * p0.distanceTo(p1));
    const lobe = new THREE.QuadraticBezierCurve(p0, control, p1);
    for (let s = k === 0 ? 0 : 1; s <= steps; s++) out.push(lobe.getPoint(s / steps));
  }
  return out;
}

const lathe = (points: readonly (readonly [number, number])[], segments: number) =>
  new THREE.LatheGeometry(
    points.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );

const extrude = (shape: THREE.Shape, depth: number, curveSegments: number, bevel = 0) =>
  new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });

/** A rounded rectangle centred on the origin. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Shared primitive makers at one detail level. */
class Kit {
  constructor(
    readonly d: DetailSpec,
    readonly pieces: Pieces,
  ) {}

  box(part: string, paint: Paint, size: V3, at: V3, grain: Grain = 'horizontal', rotation?: V3): void {
    this.pieces.add(part, paint, new THREE.BoxGeometry(size[0], size[1], size[2]), place(at, rotation), grain);
  }

  /** An ellipsoid with radii `r`; tiny ones get the fewest segments. */
  blob(part: string, paint: Paint, r: V3, at: V3, rotation?: V3): void {
    const small = Math.max(r[0], r[1], r[2]) < 0.016;
    const [w, h] = small ? this.d.smallSphere : this.d.sphere;
    this.pieces.add(part, paint, new THREE.SphereGeometry(1, w, h), place(at, rotation, r));
  }

  /** A turned piece; on Low, long profiles keep only every other point between their ends. */
  turned(part: string, paint: Paint, profile: readonly (readonly [number, number])[], at: V3, scale: V3 = [1, 1, 1], segments = this.d.lathe, rotation?: V3): void {
    const points = this.d.carving || profile.length <= 10 ? profile : profile.filter((_, i) => i % 2 === 0 || i === profile.length - 1);
    this.pieces.add(part, paint, lathe(points, segments), place(at, rotation, scale), 'vertical');
  }

  ring(part: string, paint: Paint, radius: number, tube: number, at: V3, rotation?: V3, scale?: V3): void {
    const g = new THREE.TorusGeometry(radius, tube, this.d.carving ? 4 : 3, this.d.radial * 2);
    this.pieces.add(part, paint, g, place(at, rotation, scale));
  }

  /** A round-ended limb from `a` to `b`. */
  limb(part: string, paint: Paint, a: V3, b: V3, radius: number): void {
    const from = v3(a);
    const dir = v3(b).sub(from);
    const length = dir.length();
    const g = new THREE.CapsuleGeometry(radius, Math.max(0.001, length), this.d.capSegments, this.d.radial);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    const m = new THREE.Matrix4().compose(from.addScaledVector(dir, 0.5), q, new THREE.Vector3(1, 1, 1));
    this.pieces.add(part, paint, g, m);
  }

  /** An arm through shoulder, elbow and hand, ending in a hand. */
  arm(part: string, paint: Paint, shoulder: V3, elbow: V3, hand: V3, radius: number): void {
    this.limb(part, paint, shoulder, elbow, radius);
    this.limb(part, paint, elbow, hand, radius * 0.85);
    this.blob(part, paint, [radius * 1.15, radius * 1.3, radius * 0.8], hand);
  }

  cylinder(part: string, paint: Paint, rTop: number, rBottom: number, height: number, at: V3, rotation?: V3, radial = this.d.radial): void {
    this.pieces.add(part, paint, new THREE.CylinderGeometry(rTop, rBottom, height, radial), place(at, rotation));
  }

  cone(part: string, paint: Paint, radius: number, height: number, at: V3, rotation?: V3, radial = this.d.radial): void {
    this.pieces.add(part, paint, new THREE.ConeGeometry(radius, height, radial), place(at, rotation));
  }

  bead(part: string, paint: Paint, radius: number, at: V3, spin: number): void {
    const g = new THREE.IcosahedronGeometry(radius, 0);
    this.pieces.add(part, paint, g, place(at, [spin, spin * 1.7, spin * 0.6]));
  }
}

// Turned profiles, as [radius, height] from the foot up.
const PILLAR: readonly (readonly [number, number])[] = [
  [0, 0], [0.026, 0], [0.028, 0.012], [0.02, 0.02], [0.022, 0.03], [0.03, 0.06], [0.032, 0.09], [0.026, 0.12],
  [0.016, 0.15], [0.014, 0.2], [0.019, 0.215], [0.014, 0.23], [0.013, 0.33], [0.018, 0.345], [0.013, 0.36],
  [0.015, 0.4], [0.024, 0.43], [0.026, 0.45], [0.018, 0.48], [0.014, 0.5], [0.02, 0.52], [0.028, 0.56], [0.03, 0.59], [0, 0.59],
];
const DOME: readonly (readonly [number, number])[] = [
  [0, 0], [0.13, 0], [0.136, 0.012], [0.142, 0.04], [0.14, 0.08], [0.126, 0.13], [0.1, 0.18], [0.068, 0.22],
  [0.04, 0.25], [0.022, 0.27], [0.014, 0.285], [0, 0.295],
];
const FINIAL: readonly (readonly [number, number])[] = [
  [0, 0], [0.02, 0], [0.024, 0.01], [0.012, 0.02], [0.028, 0.04], [0.03, 0.055], [0.02, 0.07], [0.008, 0.08],
  [0.012, 0.09], [0.004, 0.11], [0, 0.125],
];
const BELL: readonly (readonly [number, number])[] = [
  [0.012, 0.012], [0.019, 0.002], [0.025, 0], [0.024, 0.003], [0.017, 0.014], [0.014, 0.03], [0.011, 0.044], [0.007, 0.05], [0, 0.05],
];
const POT: readonly (readonly [number, number])[] = [
  [0, 0], [0.022, 0], [0.032, 0.012], [0.04, 0.03], [0.038, 0.048], [0.026, 0.062], [0.016, 0.068], [0.018, 0.074], [0.023, 0.078], [0, 0.076],
];
const DIYA_STAND: readonly (readonly [number, number])[] = [
  [0, 0], [0.03, 0], [0.031, 0.006], [0.009, 0.013], [0.007, 0.05], [0.012, 0.056], [0.03, 0.064], [0.033, 0.072], [0.024, 0.074], [0, 0.07],
];
const FLAME: readonly (readonly [number, number])[] = [[0, 0], [0.007, 0.006], [0.008, 0.014], [0.004, 0.026], [0, 0.036]];
const GANESH_CROWN: readonly (readonly [number, number])[] = [
  [0, 0], [0.036, 0], [0.038, 0.012], [0.031, 0.018], [0.034, 0.03], [0.025, 0.037], [0.027, 0.05], [0.017, 0.056],
  [0.017, 0.068], [0.008, 0.075], [0.006, 0.083], [0, 0.092],
];
const LAKSHMI_CROWN: readonly (readonly [number, number])[] = [
  [0, 0], [0.027, 0], [0.029, 0.01], [0.023, 0.016], [0.025, 0.028], [0.017, 0.034], [0.016, 0.046], [0.008, 0.054], [0.006, 0.062], [0, 0.074],
];
const PEDESTAL: readonly (readonly [number, number])[] = [
  [0, 0], [0.086, 0], [0.089, 0.008], [0.08, 0.012], [0.07, 0.014], [0.072, 0.026], [0.08, 0.03], [0, 0.03],
];
const TORSO: readonly (readonly [number, number])[] = [
  [0, 0], [0.044, 0], [0.037, 0.02], [0.03, 0.045], [0.034, 0.068], [0.038, 0.084], [0.03, 0.1], [0.012, 0.108], [0, 0.108],
];
const LEAF_PLATTER: readonly (readonly [number, number])[] = [[0, 0], [0.104, 0], [0.108, 0.006], [0.098, 0.011], [0, 0.011]];
const KNOB: readonly (readonly [number, number])[] = [[0, 0], [0.012, 0.002], [0.014, 0.01], [0.008, 0.018], [0, 0.02]];

/** Builds one detail level of a mandir sized to `site`, merged per surface. */
export function buildMandirModel(site: MandirSite, detail: MandirDetail): MandirModel {
  const pieces = new Pieces();
  const kit = new Kit(DETAIL[detail], pieces);
  const d = DETAIL[detail];
  const W = site.width;
  const D = site.depth;
  // Heights scale with the body; the standard body is 1.12 m on the chowki.
  const k = site.height / 1.12;
  const y = {
    plinth: 0.035 * k,
    baseTop: 0.2 * k,
    floor: 0.23 * k,
    spring: 0.7 * k,
    beam: 0.93 * k,
    cornice: 1.0 * k,
    step: 1.03 * k,
    parapet: 1.05 * k,
    top: site.height,
  };
  const cloth = y.floor + 0.006;

  // ── Base: plinth, cabinet with two drawers, moulded lip ──────────────
  kit.box('base', 'woodDark', [W, y.plinth, D], [0, y.plinth / 2, D / 2]);
  const bodyD = D - 0.015;
  kit.box('base', 'wood', [W - 0.03, y.baseTop - y.plinth, bodyD], [0, (y.plinth + y.baseTop) / 2, bodyD / 2]);
  kit.box('base', 'woodDark', [W + 0.02, y.floor - y.baseTop, D + 0.012], [0, (y.baseTop + y.floor) / 2, (D + 0.012) / 2]);
  const drawerW = (W - 0.03 - 0.05 * 3) / 2;
  const drawerH = (y.baseTop - y.plinth) * 0.62;
  const drawerY = y.plinth + (y.baseTop - y.plinth) * 0.42;
  for (const [i, side] of [
    [0, -1],
    [1, 1],
  ] as const) {
    const x = side * (drawerW / 2 + 0.025);
    pieces.add(`drawer.${i}`, 'woodDark', extrude(roundedRect(drawerW, drawerH, 0.012), 0.008, d.carving ? 4 : 2, d.carving ? 0.004 : 0), place([x, drawerY, bodyD]), 'horizontal');
    kit.turned(`drawer.${i}`, 'brass', KNOB, [x, drawerY, bodyD + 0.008], [1, 1, 1], d.radial, [Math.PI / 2, 0, 0]);
  }

  // ── Sanctum: backboard, golden panel, light, red cloth ───────────────
  kit.box('backboard', 'wood', [W, y.beam - y.floor, 0.02], [0, (y.floor + y.beam) / 2, 0.01], 'vertical');
  const panelW = W - 0.3;
  const shoulder = y.spring + 0.03 * k;
  const panel = new THREE.Shape();
  panel.moveTo(-panelW / 2, y.floor + 0.02);
  panel.lineTo(panelW / 2, y.floor + 0.02);
  panel.lineTo(panelW / 2, shoulder);
  panel.absellipse(0, shoulder, panelW / 2, (y.beam - 0.03 - shoulder) * 0.95, 0, Math.PI, false);
  panel.lineTo(-panelW / 2, y.floor + 0.02);
  pieces.add('backboard', 'goldDeep', extrude(panel, 0.004, d.lobeSteps * 2), place([0, 0, 0.02]));
  kit.box('backboard', 'glow', [W - 0.16, 0.01, 0.012], [0, y.beam - 0.012, 0.035]);
  kit.box('cloth', 'red', [W - 0.08, 0.006, D - 0.05], [0, y.floor + 0.003, 0.02 + (D - 0.05) / 2]);
  // The cloth's front flap over the lip, with a zari border.
  const flapH = (y.floor - y.baseTop) + 0.045 * k;
  kit.box('cloth', 'red', [W * 0.6, flapH, 0.004], [0, y.floor + 0.004 - flapH / 2, D + 0.016]);
  kit.box('cloth', 'gold', [W * 0.6, 0.01, 0.005], [0, y.floor + 0.004 - flapH + 0.005, D + 0.017]);
  if (d.carving) {
    for (let i = 0; i < 9; i++) {
      const x = (i / 8 - 0.5) * W * 0.56;
      kit.cone('cloth', 'gold', 0.006, 0.016, [x, y.floor + 0.004 - flapH - 0.008, D + 0.018], [Math.PI, 0, 0], 4);
    }
  }

  // ── Jali side panels ──────────────────────────────────────────────────
  const jaliBack = 0.02;
  const jaliFront = D - 0.07;
  const jaliW = jaliFront - jaliBack;
  const jaliH = y.beam - y.floor;
  const [cols, rows] = d.jali;
  const jali = new THREE.Shape();
  jali.moveTo(0, 0);
  jali.lineTo(jaliW, 0);
  jali.lineTo(jaliW, jaliH);
  jali.lineTo(0, jaliH);
  jali.lineTo(0, 0);
  const frame = 0.03;
  const cellW = (jaliW - 2 * frame) / cols;
  const cellH = (jaliH - 2 * frame) / rows;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cx = frame + (c + 0.5) * cellW;
      const cy = frame + (r + 0.5) * cellH;
      const hx = cellW * 0.36;
      const hy = cellH * 0.36;
      const hole = new THREE.Path();
      hole.moveTo(cx, cy - hy);
      hole.lineTo(cx + hx, cy);
      hole.lineTo(cx, cy + hy);
      hole.lineTo(cx - hx, cy);
      hole.lineTo(cx, cy - hy);
      jali.holes.push(hole);
    }
  }
  for (const [i, side] of [
    [0, -1],
    [1, 1],
  ] as const) {
    // Shape x runs along z and its extrusion inwards from the side face.
    const x = side < 0 ? -W / 2 + 0.018 : W / 2;
    pieces.add(`jali.${i}`, 'wood', extrude(jali, 0.018, 1), place([x, y.floor, jaliBack], [0, -Math.PI / 2, 0]), 'vertical');
  }

  // ── Pillars at the front corners ──────────────────────────────────────
  const pillarX = W / 2 - 0.045;
  const pillarZ = D - 0.035;
  const shaft = y.beam - y.floor - 0.11 * k;
  for (const [i, side] of [
    [0, -1],
    [1, 1],
  ] as const) {
    const x = side * pillarX;
    const part = `pillar.${i}`;
    kit.box(part, 'woodDark', [0.066, 0.05 * k, 0.066], [x, y.floor + 0.025 * k, pillarZ]);
    kit.turned(part, 'wood', PILLAR, [x, y.floor + 0.05 * k, pillarZ], [1, shaft / 0.59, 1]);
    kit.box(part, 'woodDark', [0.07, 0.06 * k, 0.07], [x, y.beam - 0.03 * k, pillarZ]);
    if (d.carving) {
      kit.ring(part, 'brass', 0.019, 0.003, [x, y.floor + 0.05 * k + shaft * (0.215 / 0.59), pillarZ], [Math.PI / 2, 0, 0]);
      kit.ring(part, 'brass', 0.018, 0.003, [x, y.floor + 0.05 * k + shaft * (0.345 / 0.59), pillarZ], [Math.PI / 2, 0, 0]);
    }
  }

  // ── Cusped arch with a gilt edge, bosses in the spandrels ────────────
  const archA = pillarX;
  const archOpen = pillarX - 0.03;
  const rise = (y.beam - y.spring) * 0.68;
  const curve = cuspedArch(archOpen, rise, y.spring, d.lobes, d.lobeSteps);
  const arch = new THREE.Shape();
  arch.moveTo(-archA, y.spring);
  for (const p of curve) arch.lineTo(p.x, p.y);
  arch.lineTo(archA, y.spring);
  arch.lineTo(archA, y.beam);
  arch.lineTo(-archA, y.beam);
  arch.lineTo(-archA, y.spring);
  const archZ = D - 0.055;
  const archDepth = 0.022;
  const archBevel = d.carving ? 0.003 : 0;
  pieces.add('arch', 'woodDark', extrude(arch, archDepth, 1, archBevel), place([0, 0, archZ]), 'horizontal');
  // The gilt edge: the cusped line and the same line pushed out radially.
  const band = new THREE.Shape();
  const bandW = 0.011;
  const pushed = curve.map((p) => {
    const out = new THREE.Vector2(p.x / archOpen, (p.y - y.spring) / rise).normalize();
    return new THREE.Vector2(p.x + out.x * bandW, p.y + out.y * bandW);
  });
  band.moveTo(curve[0]!.x, curve[0]!.y);
  for (const p of curve) band.lineTo(p.x, p.y);
  for (let i = pushed.length - 1; i >= 0; i--) band.lineTo(pushed[i]!.x, pushed[i]!.y);
  band.lineTo(curve[0]!.x, curve[0]!.y);
  const archFront = archZ + archDepth + archBevel;
  pieces.add('arch', 'gold', extrude(band, 0.003, 1), place([0, 0, archFront]));
  const bossY = (y.spring + rise + y.beam) / 2 + 0.01;
  for (const x of [-archOpen * 0.72, 0, archOpen * 0.72]) {
    const r = x === 0 ? 1.2 : 1;
    kit.turned('arch', 'gold', KNOB, [x, x === 0 ? y.beam - 0.03 * k : bossY, archFront], [r, 0.6, r], d.radial, [Math.PI / 2, 0, 0]);
  }

  // ── Beam, cornice and parapet ─────────────────────────────────────────
  kit.box('cornice', 'wood', [W, y.cornice - y.beam, D + 0.01], [0, (y.beam + y.cornice) / 2, (D + 0.01) / 2]);
  kit.box('cornice', 'woodDark', [W + 0.06, y.step - y.cornice, D + 0.04], [0, (y.cornice + y.step) / 2, (D + 0.04) / 2]);
  kit.box('cornice', 'wood', [W + 0.03, y.parapet - y.step, D + 0.022], [0, (y.step + y.parapet) / 2, (D + 0.022) / 2]);
  kit.box('cornice', 'woodDark', [W - 0.04, y.top - y.parapet, D - 0.02], [0, (y.parapet + y.top) / 2, (D - 0.02) / 2]);
  if (d.carving) {
    // Dentils under the cornice and kangura merlons along the parapet.
    for (let i = 0; i < 19; i++) {
      const x = (i / 18 - 0.5) * (W - 0.06);
      kit.box('cornice', 'woodDark', [0.022, 0.018, 0.01], [x, y.cornice - 0.012, D + 0.01]);
    }
    for (let i = 0; i < 13; i++) {
      const x = (i / 12 - 0.5) * (W - 0.1);
      kit.cone('cornice', 'wood', 0.017, 0.035, [x, y.top + 0.0175, D - 0.04], [0, Math.PI / 4, 0], 4);
    }
  }

  // ── Roof: gumbad on a drum, corner chhatris, brass kalash ────────────
  const roofZ = D / 2;
  kit.cylinder('dome', 'woodDark', 0.135, 0.14, 0.04, [0, y.top + 0.02, roofZ], undefined, d.lathe);
  kit.turned('dome', 'wood', DOME, [0, y.top + 0.04, roofZ]);
  kit.ring('dome', 'gold', 0.137, 0.005, [0, y.top + 0.045, roofZ], [Math.PI / 2, 0, 0]);
  kit.turned('kalash.roof', 'gold', FINIAL, [0, y.top + 0.04 + 0.29, roofZ]);
  const chhatris: [number, number][] = [
    [W / 2 - 0.07, 0.4],
    [-(W / 2 - 0.07), 0.4],
  ];
  if (d.carving) chhatris.push([W / 2 - 0.26, 0.3], [-(W / 2 - 0.26), 0.3]);
  chhatris.forEach(([x, s], i) => {
    const part = `dome.corner.${i}`;
    const base = 0.25 * s + 0.04;
    kit.box(part, 'woodDark', [base, 0.025, base], [x, y.top + 0.0125, roofZ]);
    kit.turned(part, 'wood', DOME, [x, y.top + 0.025, roofZ], [s, s, s], Math.max(8, Math.round(d.lathe * 0.6)));
    kit.turned(part, 'gold', FINIAL, [x, y.top + 0.025 + 0.29 * s, roofZ], [s * 0.8, s * 0.8, s * 0.8], Math.max(6, Math.round(d.lathe * 0.4)));
  });

  // ── Bells hanging in the arch ─────────────────────────────────────────
  const intrados = (x: number) => y.spring + rise * Math.sqrt(Math.max(0, 1 - (x / archOpen) ** 2)) - 0.03;
  [-0.62, 0, 0.62].forEach((f, i) => {
    const x = f * archOpen;
    const top = intrados(x);
    const bellTop = top - (i === 1 ? 0.1 : 0.07) * k;
    const z = archZ - 0.02;
    const part = `bell.${i}`;
    kit.cylinder(part, 'brass', 0.0022, 0.0022, top - bellTop, [x, (top + bellTop) / 2, z], undefined, 4);
    kit.turned(part, 'brass', BELL, [x, bellTop - 0.05, z], [1, 1, 1], d.radial);
    kit.blob(part, 'brass', [0.006, 0.006, 0.006], [x, bellTop - 0.052, z]);
  });

  // ── Marigold garland: two swags across the arch, drops down the pillars ─
  const garlandZ = D + 0.012;
  let bead = 0;
  const string = (from: V3, to: V3, sag: number) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]) + sag;
    const n = Math.max(2, Math.round(length / d.beadStep));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const droop = sag * 4 * t * (1 - t);
      const at: V3 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t - droop, from[2] + (to[2] - from[2]) * t + droop * 0.2];
      kit.bead('garland', bead % 3 === 2 ? 'marigoldYellow' : 'marigold', d.beadRadius, at, bead * 0.9);
      bead++;
    }
  };
  const swagTop = y.beam - 0.012;
  string([-pillarX, swagTop, garlandZ], [0, swagTop, garlandZ], 0.07 * k);
  string([0, swagTop, garlandZ], [pillarX, swagTop, garlandZ], 0.07 * k);
  for (const side of [-1, 1] as const) {
    string([side * pillarX, swagTop - d.beadStep, garlandZ + 0.004], [side * pillarX, y.spring - 0.12 * k, garlandZ + 0.004], 0);
    kit.blob('garland', 'red', [0.008, 0.016, 0.008], [side * pillarX, y.spring - 0.12 * k - 0.024, garlandZ + 0.004]);
  }

  // ── Idols, kalash, diya, incense and flowers on the cloth ─────────────
  ganesh(kit, [-0.21 * W / 1.2, cloth, 0.13], d.carving);
  lakshmi(kit, [0.2 * W / 1.2, cloth, 0.12], d);
  kalash(kit, [0, cloth, 0.21]);
  const diyaX = -(W / 2 - 0.1);
  kit.turned('diya', 'brass', DIYA_STAND, [diyaX, cloth, 0.17]);
  kit.turned('diya', 'flame', FLAME, [diyaX, cloth + 0.07, 0.17], [1, 1, 1], 6);
  const incenseX = W / 2 - 0.1;
  kit.turned('incense', 'brass', KNOB, [incenseX, cloth, 0.17], [1.8, 0.8, 1.8], d.radial);
  for (const [dx, lean] of [
    [-0.004, -0.12],
    [0.004, 0.1],
  ] as const) {
    const height = 0.15;
    const base: V3 = [incenseX + dx, cloth + 0.012, 0.17];
    const tip: V3 = [base[0] + Math.sin(lean) * height, base[1] + Math.cos(lean) * height, 0.17];
    kit.cylinder('incense', 'incense', 0.0018, 0.0018, height, [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, 0.17], [0, 0, -lean], 4);
    kit.blob('incense', 'flame', [0.003, 0.004, 0.003], tip);
  }
  const flowers: V3[] = [
    [-0.08, 0, 0.25],
    [0.07, 0, 0.255],
    [-0.36, 0, 0.24],
    [0.34, 0, 0.245],
  ];
  if (d.carving) flowers.push([-0.02, 0, 0.27], [0.13, 0, 0.26], [-0.3, 0, 0.2], [0.42, 0, 0.25]);
  flowers.forEach(([fx, , fz], i) => kit.bead('flowers', i % 2 ? 'marigoldYellow' : 'marigold', 0.012, [fx * W / 1.2, cloth + 0.008, fz], i));

  const geometries = pieces.merge();
  let triangles = 0;
  for (const g of geometries.values()) triangles += g.getAttribute('position').count / 3;
  return { detail, geometries, parts: pieces.parts, triangles };
}

/**
 * Ganesh seated on a brass pedestal, facing +Z: elephant head with fanned
 * ears, a trunk curling to his left towards the modak, tusks (the right one
 * broken), a tall crown and tilak, a round belly with a gold band, saffron
 * dhoti, four arms (axe and lotus raised, blessing and modak below), and
 * his mouse at his feet. About 34 cm tall.
 */
function ganesh(kit: Kit, at: V3, carving: boolean): void {
  const [ox, oy, oz] = at;
  const p = (x: number, y: number, z: number): V3 => [ox + x, oy + y, oz + z];
  const part = 'ganesh';
  kit.turned(part, 'brass', PEDESTAL, p(0, 0, 0));
  const b = 0.03;
  // Folded legs in the dhoti, feet in front.
  kit.blob(part, 'saffron', [0.08, 0.032, 0.06], p(0, b + 0.03, 0.016));
  kit.blob(part, 'marble', [0.018, 0.012, 0.028], p(-0.035, b + 0.022, 0.066), [0, 0.4, 0]);
  kit.blob(part, 'marble', [0.018, 0.012, 0.028], p(0.035, b + 0.022, 0.066), [0, -0.4, 0]);
  // Belly, waistband, chest and necklace.
  kit.blob(part, 'marble', [0.062, 0.058, 0.055], p(0, b + 0.09, 0.02));
  kit.ring(part, 'gold', 0.057, 0.006, p(0, b + 0.062, 0.017), [Math.PI / 2, 0, 0], [1, 0.92, 1]);
  kit.blob(part, 'marble', [0.05, 0.042, 0.04], p(0, b + 0.15, 0));
  kit.ring(part, 'gold', 0.03, 0.004, p(0, b + 0.172, 0.014), [Math.PI / 2 - 0.55, 0, 0]);
  // Head, ears and crown.
  kit.blob(part, 'marble', [0.05, 0.05, 0.048], p(0, b + 0.215, 0.012));
  for (const side of [-1, 1] as const) {
    kit.blob(part, 'marble', [0.05, 0.054, 0.009], p(side * 0.058, b + 0.208, -0.004), [0, side * 0.45, side * -0.15]);
    kit.blob(part, 'earInner', [0.034, 0.038, 0.004], p(side * 0.056, b + 0.208, 0.002), [0, side * 0.45, side * -0.15]);
    kit.blob(part, 'ink', [0.006, 0.006, 0.004], p(side * 0.02, b + 0.228, 0.056));
  }
  kit.turned(part, 'gold', GANESH_CROWN, p(0, b + 0.252, 0.008));
  kit.blob(part, 'red', [0.005, 0.012, 0.003], p(0, b + 0.246, 0.051));
  // Trunk: down past the belly, curling to his left.
  kit.pieces.add(
    part,
    'marble',
    taperedTube(
      [p(0, b + 0.205, 0.05), p(0, b + 0.17, 0.075), p(0.004, b + 0.128, 0.086), p(0.02, b + 0.1, 0.088), p(0.04, b + 0.104, 0.082), p(0.052, b + 0.124, 0.074)],
      0.019,
      0.007,
      carving ? 18 : 9,
      kit.d.radial,
    ),
  );
  // Tusks, the right one broken.
  kit.cone(part, 'ivory', 0.0055, 0.026, p(0.024, b + 0.186, 0.062), [Math.PI / 2 + 0.5, 0, -0.3], 6);
  kit.cone(part, 'ivory', 0.0055, 0.012, p(-0.023, b + 0.19, 0.058), [Math.PI / 2 + 0.5, 0, 0.3], 6);
  // Four arms: axe and lotus raised, blessing and modak below.
  const r = 0.0115;
  kit.arm(part, 'marble', p(-0.045, b + 0.168, -0.004), p(-0.1, b + 0.186, -0.012), p(-0.116, b + 0.244, -0.008), r);
  kit.arm(part, 'marble', p(0.045, b + 0.168, -0.004), p(0.1, b + 0.186, -0.012), p(0.116, b + 0.244, -0.008), r);
  kit.cylinder(part, 'gold', 0.003, 0.003, 0.075, p(-0.116, b + 0.258, -0.006), [0, 0, 0.1], 4);
  kit.box(part, 'gold', [0.026, 0.018, 0.004], p(-0.128, b + 0.292, -0.006), 'horizontal', [0, 0, 0.1]);
  kit.blob(part, 'lotus', [0.016, 0.02, 0.016], p(0.118, b + 0.27, -0.006));
  kit.arm(part, 'marble', p(-0.046, b + 0.152, 0.008), p(-0.074, b + 0.108, 0.03), p(-0.07, b + 0.142, 0.07), r);
  kit.arm(part, 'marble', p(0.046, b + 0.152, 0.008), p(0.074, b + 0.108, 0.03), p(0.064, b + 0.092, 0.072), r);
  kit.turned(part, 'gold', [[0, 0], [0.016, 0.002], [0.02, 0.012], [0, 0.008]], p(0.064, b + 0.098, 0.074), [1, 1, 1], 8);
  kit.cone(part, 'modak', 0.011, 0.02, p(0.064, b + 0.118, 0.074), undefined, 8);
  if (carving) {
    // A marigold garland at his neck and bangles.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      kit.bead(part, i % 3 === 2 ? 'marigoldYellow' : 'marigold', 0.008, p(Math.cos(a) * 0.04, b + 0.166 - Math.max(0, Math.sin(a)) * 0.03, 0.006 + Math.sin(a) * 0.03), i);
    }
    kit.ring(part, 'gold', 0.011, 0.003, p(-0.072, b + 0.128, 0.056), [0.4, 0, 0]);
    kit.ring(part, 'gold', 0.011, 0.003, p(0.068, b + 0.098, 0.058), [1.2, 0, 0]);
  }
  // The mouse (mooshak) beside the pedestal.
  const m = (x: number, y: number, z: number): V3 => p(0.105 + x, y - b, 0.075 + z);
  kit.blob(part, 'mouse', [0.016, 0.014, 0.026], m(0, b + 0.014, 0));
  kit.blob(part, 'mouse', [0.01, 0.01, 0.013], m(0, b + 0.02, 0.024));
  for (const side of [-1, 1] as const) kit.blob(part, 'mouse', [0.006, 0.006, 0.002], m(side * 0.007, b + 0.03, 0.02));
  kit.blob(part, 'ink', [0.003, 0.003, 0.003], m(0, b + 0.02, 0.037));
  kit.limb(part, 'mouse', m(0, b + 0.008, -0.024), m(-0.012, b + 0.004, -0.05), 0.0025);
}

/**
 * Lakshmi seated on a pink lotus, facing +Z: red saree, gold crown, a halo
 * and disc behind her head, earrings and bindi, four arms (lotus buds
 * raised, blessing, and gold coins pouring from her left hand). About 37 cm
 * tall with the lotus.
 */
function lakshmi(kit: Kit, at: V3, d: DetailSpec): void {
  const [ox, oy, oz] = at;
  const p = (x: number, y: number, z: number): V3 => [ox + x, oy + y, oz + z];
  const part = 'lakshmi';
  // The lotus: a leaf platter, two rings of petals and a golden seed pod.
  kit.turned(part, 'leaf', LEAF_PLATTER, p(0, 0, 0));
  const petal = (n: number, radius: number, height: number, tilt: number, size: V3, paint: Paint, offset: number) => {
    for (let i = 0; i < n; i++) {
      const phi = ((i + offset) / n) * Math.PI * 2;
      const m = new THREE.Matrix4()
        .makeTranslation(ox + Math.sin(phi) * radius, oy + height, oz + Math.cos(phi) * radius)
        .multiply(new THREE.Matrix4().makeRotationY(phi))
        .multiply(new THREE.Matrix4().makeRotationX(tilt))
        .multiply(new THREE.Matrix4().makeScale(size[0], size[1], size[2]));
      kit.pieces.add(part, paint, new THREE.SphereGeometry(1, d.smallSphere[0], d.smallSphere[1] + (d.carving ? 1 : 0)), m);
    }
  };
  const [outer, inner] = d.petals;
  petal(outer, 0.062, 0.042, 1.0, [0.03, 0.056, 0.01], 'lotus', 0);
  petal(inner, 0.04, 0.056, 0.5, [0.025, 0.046, 0.009], 'lotusLight', 0.5);
  kit.cylinder(part, 'pod', 0.046, 0.042, 0.016, p(0, 0.072, 0));
  const s = 0.08;
  // Lap and torso in the saree, a gold belt and necklace.
  kit.blob(part, 'saree', [0.07, 0.027, 0.052], p(0, s + 0.02, 0.012));
  kit.turned(part, 'saree', TORSO, p(0, s + 0.024, 0), [1, 1, 0.78]);
  kit.ring(part, 'gold', 0.031, 0.004, p(0, s + 0.064, 0.002), [Math.PI / 2, 0, 0], [1, 0.8, 1]);
  kit.ring(part, 'gold', 0.022, 0.0035, p(0, s + 0.112, 0.012), [Math.PI / 2 - 0.6, 0, 0]);
  // Neck, head, hair and crown before a halo.
  kit.cylinder(part, 'marble', 0.011, 0.012, 0.024, p(0, s + 0.138, 0));
  kit.blob(part, 'marble', [0.028, 0.031, 0.027], p(0, s + 0.166, 0.004));
  kit.blob(part, 'ink', [0.03, 0.033, 0.027], p(0, s + 0.17, -0.007));
  kit.turned(part, 'gold', LAKSHMI_CROWN, p(0, s + 0.188, 0.001));
  kit.cylinder(part, 'goldDeep', 0.06, 0.06, 0.003, p(0, s + 0.176, -0.036), [Math.PI / 2, 0, 0], kit.d.lathe);
  kit.ring(part, 'gold', 0.061, 0.005, p(0, s + 0.176, -0.033));
  for (const side of [-1, 1] as const) {
    kit.blob(part, 'ink', [0.004, 0.004, 0.003], p(side * 0.01, s + 0.17, 0.028));
    kit.blob(part, 'gold', [0.005, 0.005, 0.005], p(side * 0.028, s + 0.153, 0.004));
  }
  kit.blob(part, 'red', [0.003, 0.003, 0.002], p(0, s + 0.182, 0.029));
  // Four arms: lotus buds raised, blessing, and coins from her left hand.
  const r = 0.0095;
  kit.arm(part, 'marble', p(-0.036, s + 0.12, -0.004), p(-0.07, s + 0.13, -0.01), p(-0.076, s + 0.172, 0), r);
  kit.arm(part, 'marble', p(0.036, s + 0.12, -0.004), p(0.07, s + 0.13, -0.01), p(0.076, s + 0.172, 0), r);
  for (const side of [-1, 1] as const) {
    kit.limb(part, 'leaf', p(side * 0.076, s + 0.165, 0.002), p(side * 0.08, s + 0.2, 0.004), 0.002);
    kit.blob(part, 'lotus', [0.013, 0.02, 0.013], p(side * 0.08, s + 0.21, 0.004));
  }
  kit.arm(part, 'marble', p(-0.037, s + 0.112, 0.004), p(-0.058, s + 0.07, 0.022), p(-0.052, s + 0.102, 0.056), r);
  kit.arm(part, 'marble', p(0.037, s + 0.112, 0.004), p(0.058, s + 0.07, 0.025), p(0.054, s + 0.05, 0.062), r);
  for (const [i, [cx, cy, cz]] of ([
    [0.056, s + 0.034, 0.066],
    [0.06, s + 0.016, 0.07],
    [0.064, 0.074, 0.072],
    [0.074, 0.07, 0.078],
  ] as const).entries()) {
    kit.cylinder(part, 'gold', 0.007, 0.007, 0.002, p(cx, cy, cz), [i * 0.7, 0, i * 0.4], 8);
  }
  if (d.carving) {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      kit.bead(part, i % 3 === 2 ? 'marigoldYellow' : 'marigold', 0.0065, p(Math.cos(a) * 0.028, s + 0.124 - Math.max(0, Math.sin(a)) * 0.024, 0.004 + Math.sin(a) * 0.024), i);
    }
    kit.ring(part, 'gold', 0.009, 0.0025, p(-0.054, s + 0.09, 0.046), [0.5, 0, 0]);
    kit.ring(part, 'gold', 0.009, 0.0025, p(0.056, s + 0.06, 0.05), [1.2, 0, 0]);
  }
}

/** A brass kalash with a red thread, mango leaves and a coconut. */
function kalash(kit: Kit, at: V3): void {
  const [ox, oy, oz] = at;
  const p = (x: number, y: number, z: number): V3 => [ox + x, oy + y, oz + z];
  const part = 'kalash';
  kit.turned(part, 'brass', POT, p(0, 0, 0));
  kit.ring(part, 'red', 0.017, 0.0025, p(0, 0.066, 0), [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 7; i++) {
    const phi = (i / 7) * Math.PI * 2;
    const m = new THREE.Matrix4()
      .makeTranslation(ox + Math.sin(phi) * 0.03, oy + 0.084, oz + Math.cos(phi) * 0.03)
      .multiply(new THREE.Matrix4().makeRotationY(phi))
      .multiply(new THREE.Matrix4().makeRotationX(-0.45))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.022))
      .multiply(new THREE.Matrix4().makeScale(0.012, 0.003, 0.034));
    kit.pieces.add(part, 'leaf', new THREE.SphereGeometry(1, kit.d.smallSphere[0], kit.d.smallSphere[1]), m);
  }
  kit.blob(part, 'coconut', [0.03, 0.036, 0.03], p(0, 0.112, 0));
  kit.cone(part, 'husk', 0.008, 0.022, p(0, 0.152, 0), undefined, 6);
}
