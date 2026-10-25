import * as THREE from 'three';
import type { MaterialKey, WorldBox, WorldLayout } from './layout';

interface MaterialSpec {
  readonly color: string;
  readonly roughness?: number;
  /** Self-lit surfaces (windows, bulbs, lanterns) glow without a light. */
  readonly emissive?: string;
  readonly emissiveIntensity?: number;
  /**
   * An open doorway's room light: drawn by its glow alone (a black Lambert
   * surface, so no diffuse or highlight from lamps in front of it) and
   * shaded across the face by `doorwayGlowMap`.
   */
  readonly doorway?: boolean;
}

/** Original, flat-colour palette; no image textures or third-party assets. */
const MATERIALS: Readonly<Record<MaterialKey, MaterialSpec>> = {
  laneStone: { color: '#4a4038', roughness: 0.95 },
  courtyardTile: { color: '#6b4a3a', roughness: 0.9 },
  outerGround: { color: '#1e1a17', roughness: 1 },
  stairStone: { color: '#8a7c6c', roughness: 0.9 },
  roofTerrace: { color: '#9a5a44', roughness: 0.85 },
  compoundWall: { color: '#c9b79a', roughness: 0.9 },
  railing: { color: '#2e2a28', roughness: 0.6 },
  slab: { color: '#e8e0d0', roughness: 0.85 },
  door: { color: '#4a2a18', roughness: 0.7 },
  toran: { color: '#ff8c1a', roughness: 0.8, emissive: '#ff6a00', emissiveIntensity: 0.25 },
  window: { color: '#3a2a18', emissive: '#ffb347', emissiveIntensity: 0.9 },
  lantern: { color: '#ff7a2a', emissive: '#ff8a30', emissiveIntensity: 1.6 },
  bulbWarm: { color: '#ffd27a', emissive: '#ffc04a', emissiveIntensity: 2 },
  bulbPink: { color: '#ff7ab8', emissive: '#ff4fa0', emissiveIntensity: 2 },
  bulbGreen: { color: '#8aff9a', emissive: '#4aff6a', emissiveIntensity: 2 },
  platform: { color: '#d8743a', roughness: 0.9 },
  housePink: { color: '#e0708f' },
  houseTurquoise: { color: '#3fb5b0' },
  houseSaffron: { color: '#f0a03c' },
  houseLime: { color: '#a6c94a' },
  houseLavender: { color: '#9c86d6' },
  plinth: { color: '#5a4a40', roughness: 0.95 },
  windowDark: { color: '#1a1622', roughness: 0.4 },
  tank: { color: '#1c1c1e', roughness: 0.6 },
  metal: { color: '#8a8c90', roughness: 0.5 },
  terracotta: { color: '#b0583a', roughness: 0.9 },
  leaf: { color: '#2f6a2a', roughness: 0.9 },
  pavement: { color: '#5e544a', roughness: 0.95 },
  drain: { color: '#1a1714', roughness: 1 },
  laneStoneDark: { color: '#2e2722', roughness: 1 },
  courtyardTileDark: { color: '#55392c', roughness: 0.9 },
  // A lamp-lit room seen through the open door: saffron, a little brighter
  // than the windows at its warmest so it reads as the way in, but under the
  // bloom threshold so it never becomes a light source. It ignores the
  // lights, so the lit diyas' lamp and a kandil's just in front of a door
  // cannot wash it out to white, and both enterable doors look alike.
  doorGlow: { color: '#000000', emissive: '#ff9a40', emissiveIntensity: 1.3, doorway: true },
  marigold: { color: '#ffb000', roughness: 0.8, emissive: '#ff9a00', emissiveIntensity: 0.45 },
  brass: { color: '#c89a3a', roughness: 0.35, emissive: '#7a5410', emissiveIntensity: 0.5 },
  houseOchre: { color: '#c99a3e' },
  houseCoral: { color: '#e8775a' },
  houseSky: { color: '#5fa0e0' },
};

const GLOW_MAP = { width: 8, height: 16 } as const;

/**
 * A tiny gradient multiplying an open doorway's glow, so it reads as a room
 * lit from a lamp on the floor rather than a flat panel: full strength low
 * and in the middle, fading towards the lintel and the jambs, and a deeper
 * saffron where it is dimmer. The unit box's side faces each span the whole
 * map, bottom to top, so the doorway box shows it once across its front.
 */
export function doorwayGlowMap(): THREE.DataTexture {
  const { width, height } = GLOW_MAP;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const v = row / (height - 1); // 0 at the threshold, 1 under the lintel
    for (let col = 0; col < width; col++) {
      const u = (col / (width - 1)) * 2 - 1; // -1 and 1 at the jambs
      const k = (1 - 0.5 * v ** 1.5) * (1 - 0.35 * u * u);
      // Warmer as it dims: green and blue fall away a little faster than red.
      const i = (row * width + col) * 4;
      data[i] = Math.round(255 * k);
      data[i + 1] = Math.round(255 * k * (0.75 + 0.25 * k));
      data[i + 2] = Math.round(255 * k * (0.6 + 0.4 * k));
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface WorldScene {
  /** Static scenery and practical lights, to add to the scene. */
  readonly root: THREE.Group;
  /** Release GPU resources. */
  dispose(): void;
}

/**
 * Builds the world's meshes. Boxes are drawn as one `InstancedMesh` per
 * material over a single shared unit-box geometry, so the whole map costs a
 * couple of dozen draw calls.
 */
export function buildWorldScene(layout: WorldLayout): WorldScene {
  const root = new THREE.Group();
  root.name = 'world';

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<MaterialKey, THREE.Material>();
  let glowMap: THREE.DataTexture | null = null;
  const byMaterial = new Map<MaterialKey, WorldBox[]>();

  const visible: WorldBox[] = [...layout.solids.filter((s) => s.visible), ...layout.decor];
  for (const box of visible) {
    const list = byMaterial.get(box.material);
    if (list) list.push(box);
    else byMaterial.set(box.material, [box]);
  }

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (const [key, boxes] of byMaterial) {
    const spec = MATERIALS[key];
    const material = spec.doorway
      ? new THREE.MeshLambertMaterial({
          color: spec.color,
          emissive: spec.emissive ?? '#000000',
          emissiveIntensity: spec.emissiveIntensity ?? 1,
          emissiveMap: (glowMap ??= doorwayGlowMap()),
        })
      : new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: spec.roughness ?? 0.9,
          emissive: spec.emissive ?? '#000000',
          emissiveIntensity: spec.emissiveIntensity ?? 1,
        });
    materials.set(key, material);

    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    mesh.name = `world.${key}`;
    boxes.forEach(({ box }, i) => {
      position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      scale.set(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    root.add(mesh);
  }

  for (const light of layout.lights) {
    const point = new THREE.PointLight(light.colour, light.intensity, light.distance, 2);
    point.name = light.id;
    point.position.set(light.position.x, light.position.y, light.position.z);
    root.add(point);
  }

  return {
    root,
    dispose() {
      geometry.dispose();
      glowMap?.dispose();
      for (const material of materials.values()) material.dispose();
    },
  };
}

/** The evening's sky fill and moonlight; distant scenery bakes the same light. */
export const EVENING_LIGHT = {
  sky: '#4a4290',
  ground: '#2a1a10',
  ambient: 0.7,
  moon: '#9aa8ff',
  moonIntensity: 0.4,
  moonPosition: { x: -20, y: 40, z: 10 },
} as const;

const SKY_ZENITH = new THREE.Color('#0b0a2a');
const SKY_HORIZON = new THREE.Color('#5a2a5e');
const SKY_GLOW = new THREE.Color('#d0603a');

/** A dusk gradient dome: deep indigo overhead to a warm glow at the horizon. */
function createSkyDome(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const colours: number[] = [];
  const colour = new THREE.Color();
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    const h = positions.getY(i) / radius;
    if (h < 0.08) colour.copy(SKY_GLOW).lerp(SKY_HORIZON, Math.max(0, h) / 0.08);
    else colour.copy(SKY_HORIZON).lerp(SKY_ZENITH, Math.min(1, (h - 0.08) / 0.5));
    colours.push(colour.r, colour.g, colour.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  const dome = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.name = 'sky';
  dome.renderOrder = -1;
  return dome;
}

/**
 * Fixed Diwali-evening scene: dusk sky dome, fog, dim moonlight and ambient,
 * plus the world's meshes and warm practical lights.
 */
export function createWorldScene(layout: WorldLayout): { scene: THREE.Scene; world: WorldScene } {
  const scene = new THREE.Scene();
  scene.background = SKY_ZENITH.clone();
  scene.fog = new THREE.Fog(SKY_HORIZON.clone().multiplyScalar(0.5), 30, 110);
  scene.add(createSkyDome(200));

  const light = EVENING_LIGHT;
  scene.add(new THREE.HemisphereLight(light.sky, light.ground, light.ambient));
  const moon = new THREE.DirectionalLight(light.moon, light.moonIntensity);
  moon.position.set(light.moonPosition.x, light.moonPosition.y, light.moonPosition.z);
  scene.add(moon);

  const world = buildWorldScene(layout);
  scene.add(world.root);
  return { scene, world };
}
