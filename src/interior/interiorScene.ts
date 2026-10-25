import * as THREE from 'three';
import type { HomeId } from '../core/homes';
import type { QualityProfile } from '../core/quality';
import { QUALITY_LEVELS } from '../core/quality';
import type { QualityLevel } from '../core/types';
import type { InteriorBox, InteriorLayout, InteriorMaterial } from './layout';
import { buildMandir, MandirAssets, type MandirView } from './mandir';

interface MaterialSpec {
  readonly color: string;
  readonly roughness?: number;
  readonly metalness?: number;
  /** Self-lit surfaces (flames, lamps, the deity frame) glow without a light. */
  readonly emissive?: string;
  readonly emissiveIntensity?: number;
}

/** Original, flat-colour palette; no textures or third-party assets. */
export const INTERIOR_MATERIALS: Readonly<Record<InteriorMaterial, MaterialSpec>> = {
  plaster: { color: '#e8c48e' },
  plasterAccent: { color: '#c8553f' },
  ceiling: { color: '#f2e4c8' },
  floorTile: { color: '#b5835a', roughness: 0.7 },
  skirting: { color: '#5a3420' },
  wood: { color: '#7a4424', roughness: 0.75 },
  woodDark: { color: '#4a2814', roughness: 0.75 },
  doorWood: { color: '#5a3018', roughness: 0.7 },
  fabricRed: { color: '#a3283a', roughness: 1 },
  fabricGold: { color: '#d9a03a', roughness: 0.9 },
  cushion: { color: '#e5782e', roughness: 1 },
  rug: { color: '#7a1f3a', roughness: 1 },
  brass: { color: '#d7a640', roughness: 0.35, metalness: 0.6, emissive: '#5a3a08', emissiveIntensity: 0.6 },
  clay: { color: '#a8522a', roughness: 0.9 },
  flame: { color: '#ffd27a', emissive: '#ffb040', emissiveIntensity: 3 },
  marigold: { color: '#ff9a1a', emissive: '#ff7a00', emissiveIntensity: 0.35 },
  idol: { color: '#f0b54a', emissive: '#c07018', emissiveIntensity: 0.5 },
  frame: { color: '#c9a032', roughness: 0.4, metalness: 0.5, emissive: '#4a3008', emissiveIntensity: 0.5 },
  rangoliPink: { color: '#e2457a', emissive: '#801030', emissiveIntensity: 0.3 },
  rangoliTeal: { color: '#25b5a8', emissive: '#0a5048', emissiveIntensity: 0.3 },
  sweets: { color: '#f5c46a', emissive: '#6a4010', emissiveIntensity: 0.4 },
  sweetsPink: { color: '#f29ab8', emissive: '#6a2038', emissiveIntensity: 0.4 },
  plate: { color: '#e8e4dc', roughness: 0.3, metalness: 0.4, emissive: '#3a3830', emissiveIntensity: 0.5 },
  windowNight: { color: '#141a38', emissive: '#1a2250', emissiveIntensity: 0.6 },
  curtain: { color: '#7a2a62', roughness: 1 },
  lampShade: { color: '#ffd9a0', emissive: '#ffb860', emissiveIntensity: 1.4 },
};

const LEVEL_RANK: Readonly<Record<QualityLevel, number>> = Object.fromEntries(
  QUALITY_LEVELS.map((level, i) => [level, i]),
) as Record<QualityLevel, number>;

/** True when a light with `minLevel` is on at `level`. */
export function lightOnAt(minLevel: QualityLevel, level: QualityLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

/**
 * One unit-box geometry and one material per key, shared by every interior.
 * Built once at boot, so entering a home never creates GPU resources and a
 * second home reuses the same ones.
 */
export class InteriorAssets {
  readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly materials = new Map<InteriorMaterial, THREE.MeshStandardMaterial>();
  private mandirAssets: MandirAssets | null = null;

  /** The carved mandir's grain, materials and merged models, made on first use. */
  get mandir(): MandirAssets {
    this.mandirAssets ??= new MandirAssets((key) => this.material(key));
    return this.mandirAssets;
  }

  material(key: InteriorMaterial): THREE.MeshStandardMaterial {
    let material = this.materials.get(key);
    if (!material) {
      const spec = INTERIOR_MATERIALS[key];
      material = new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: spec.roughness ?? 0.85,
        metalness: spec.metalness ?? 0,
        emissive: spec.emissive ?? '#000000',
        emissiveIntensity: spec.emissiveIntensity ?? 1,
      });
      material.name = `interior.${key}`;
      this.materials.set(key, material);
    }
    return material;
  }

  get materialCount(): number {
    return this.materials.size;
  }

  dispose(): void {
    this.mandirAssets?.dispose();
    this.mandirAssets = null;
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}

/** Flame flicker: a few incommensurate sines, so it never visibly loops. */
export function flicker(t: number): number {
  return 1 + 0.08 * Math.sin(t * 9.1) + 0.05 * Math.sin(t * 23.7 + 1.3) + 0.03 * Math.sin(t * 41.3 + 0.7);
}

export interface InteriorScene {
  readonly home: HomeId;
  /** Everything for this home; hidden whole while the home is not active. */
  readonly root: THREE.Group;
  /** Optional dressing, hidden on Low. */
  readonly detail: THREE.Group;
  /** The carved wooden mandir, if the home has one. */
  readonly mandir: MandirView | null;
  /** Lights currently switched on for the quality level. */
  readonly activeLights: number;
  applyQuality(profile: QualityProfile): void;
  /** Animate the cheap flame glow; call only while the home is shown. */
  frame(dt: number): void;
}

/**
 * Builds a home's meshes from its layout: one `InstancedMesh` per material
 * over the shared unit box, split into always-drawn boxes and Low-dropped
 * dressing, so a whole room costs a few dozen draw calls; a mandir, if the
 * home has one, adds its own merged model (`mandir.ts`). Lighting is a warm
 * hemisphere fill plus at most three point lights, chosen by quality level;
 * flames, lamps and the deity frame glow through emissive materials rather
 * than lights of their own.
 */
export function buildInteriorScene(layout: InteriorLayout, assets: InteriorAssets): InteriorScene {
  const root = new THREE.Group();
  root.name = `interior.${layout.home}`;
  const detail = new THREE.Group();
  detail.name = `interior.${layout.home}.detail`;
  root.add(detail);

  const core: InteriorBox[] = [...layout.solids.filter((s) => !s.hidden), ...layout.decor.filter((d) => !d.detail)];
  const dressing = layout.decor.filter((d) => d.detail);
  addInstanced(root, core, assets, `interior.${layout.home}`);
  addInstanced(detail, dressing, assets, `interior.${layout.home}.detail`);
  const mandir = layout.mandir ? buildMandir(layout.mandir, assets.mandir, `interior.${layout.home}`) : null;
  if (mandir) root.add(mandir.root);

  const { sky, ground, intensity } = layout.ambient;
  const fill = new THREE.HemisphereLight(sky, ground, intensity);
  fill.name = `interior.${layout.home}.fill`;
  root.add(fill);

  const lights = layout.lights.map((spec) => {
    const light = new THREE.PointLight(spec.colour, spec.intensity, spec.distance, 2);
    light.name = `interior.${layout.home}.${spec.id}`;
    light.position.set(spec.position.x, spec.position.y, spec.position.z);
    root.add(light);
    return { light, spec };
  });
  const flame = assets.material('flame');
  const flameBase = INTERIOR_MATERIALS.flame.emissiveIntensity ?? 1;
  let clock = 0;

  return {
    home: layout.home,
    root,
    detail,
    mandir,
    get activeLights() {
      return lights.filter(({ light }) => light.visible).length;
    },
    applyQuality(profile) {
      detail.visible = profile.level !== 'low';
      mandir?.applyQuality(profile.level);
      for (const { light, spec } of lights) light.visible = lightOnAt(spec.minLevel, profile.level);
    },
    frame(dt) {
      if (!(dt > 0)) return;
      clock += dt;
      const k = flicker(clock);
      flame.emissiveIntensity = flameBase * k;
      for (const { light, spec } of lights) light.intensity = spec.intensity * (0.96 + 0.04 * k);
    },
  };
}

function addInstanced(parent: THREE.Group, boxes: readonly InteriorBox[], assets: InteriorAssets, prefix: string): void {
  const byMaterial = new Map<InteriorMaterial, InteriorBox[]>();
  for (const entry of boxes) {
    const list = byMaterial.get(entry.material);
    if (list) list.push(entry);
    else byMaterial.set(entry.material, [entry]);
  }
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (const [key, list] of byMaterial) {
    const mesh = new THREE.InstancedMesh(assets.geometry, assets.material(key), list.length);
    mesh.name = `${prefix}.${key}`;
    list.forEach(({ box }, i) => {
      position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      scale.set(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    parent.add(mesh);
  }
}
