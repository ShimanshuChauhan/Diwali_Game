import * as THREE from 'three';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { QualityProfile } from '../core/quality';
import type { WorldLayout } from '../world/layout';
import { atmosphereBudget, MAX_DISTANT_PARTICLES, type AtmosphereBudget } from './budget';
import { KANDIL_HALF, planDecorations, type DecorationPlan, type Rangoli } from './decorations';
import { DistantFireworks, type DistantStats } from './distantFireworks';

/**
 * The evening atmosphere on top of the world scene: fairy lights, akash
 * kandils and rangoli, stars and a warm horizon haze, distant fireworks,
 * and the fog and exposure grade that ties them together. Every cost scales
 * with the quality profile; changing quality rebuilds the decorations once
 * (never per frame).
 */

/** Warm, smoky dusk haze; matches the sky dome's horizon band. */
const FOG_COLOUR = new THREE.Color('#2c1838');
const FOG_NEAR = 28;
const FOG_FAR = 125;
const EXPOSURE = 1.15;

/** Self-lit decorations are pushed above 1 so they bloom through tone mapping. */
const BULB_GLOW = 1.4;
const KANDIL_GLOW = 1.2;
const KANDIL_LIGHT = { intensity: 6, distance: 7 } as const;
const RANGOLI_LIFT = 0.012;

const HORIZON_RADIUS = 185;
const HORIZON_HEIGHT = 40;
const HORIZON_GLOW = new THREE.Color('#ff7a3a').multiplyScalar(0.35);
const STAR_RADIUS = 190;

const SPARK_VERTEX = /* glsl */ `
  attribute vec4 aColour;
  attribute float aSize;
  uniform float uPixelsPerMetre;
  varying vec4 vColour;
  void main() {
    vColour = aColour;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = max(1.0, aSize * uPixelsPerMetre / max(0.1, -mvPosition.z));
  }
`;

const SPARK_FRAGMENT = /* glsl */ `
  varying vec4 vColour;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    gl_FragColor = vec4(vColour.rgb * exp(-r2 * 3.0) * 2.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface AtmosphereStats {
  readonly level: QualityProfile['level'];
  readonly bulbs: number;
  readonly kandils: number;
  readonly rangolis: number;
  /** Point lights the atmosphere adds to the scene. */
  readonly lights: number;
  readonly stars: number;
  readonly distant: Readonly<DistantStats>;
}

export interface AtmosphereOptions {
  readonly scene: THREE.Scene;
  readonly layout: WorldLayout;
  readonly profile: QualityProfile;
  /** Tone mapping is set here; omit in headless tests. */
  readonly renderer?: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>;
  /** Follows `qualityChanged` and clears the sky on `sessionReset`. */
  readonly bus?: GameEventBus;
  readonly random?: () => number;
}

export class Atmosphere {
  readonly object = new THREE.Group();
  readonly distant: DistantFireworks;

  private budget: AtmosphereBudget;
  private plan: DecorationPlan;
  private readonly layout: WorldLayout;
  private readonly random: () => number;
  private readonly unsubscribe: Unsubscribe[] = [];

  // Shared across rebuilds.
  private readonly bulbGeometry = new THREE.SphereGeometry(0.05, 6, 4);
  private readonly kandilGeometry = createKandilGeometry();
  private readonly glowMaterial = new THREE.MeshBasicMaterial();
  private readonly rangoliMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly starMaterial = new THREE.PointsMaterial({
    color: '#fff4e0',
    size: 1.6,
    sizeAttenuation: false,
    fog: false,
    depthWrite: false,
  });
  private readonly horizon: THREE.Mesh;

  // Rebuilt when quality changes.
  private decor = new THREE.Group();
  private stars: THREE.Points | null = null;

  // Distant fireworks drawing.
  private readonly sparkGeometry = new THREE.BufferGeometry();
  private readonly sparkMaterial: THREE.ShaderMaterial;
  private readonly sparkAttributes: THREE.BufferAttribute[];
  private readonly sparkRanges = [0, 1, 2].map(() => ({ start: 0, count: 0 }));

  constructor(options: AtmosphereOptions) {
    this.layout = options.layout;
    this.random = options.random ?? Math.random;
    this.object.name = 'atmosphere';
    this.budget = atmosphereBudget(options.profile);
    this.plan = planDecorations(this.layout, this.budget);

    const scene = options.scene;
    scene.fog = new THREE.Fog(FOG_COLOUR.clone(), FOG_NEAR, FOG_FAR);
    if (options.renderer) {
      options.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      options.renderer.toneMappingExposure = EXPOSURE;
    }

    this.horizon = createHorizonGlow();
    this.object.add(this.horizon);

    this.distant = new DistantFireworks({ capacity: MAX_DISTANT_PARTICLES, random: this.random });
    const d = this.distant;
    this.sparkAttributes = [
      new THREE.BufferAttribute(d.positions, 3).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(d.colours, 4).setUsage(THREE.DynamicDrawUsage),
      new THREE.BufferAttribute(d.sizes, 1).setUsage(THREE.DynamicDrawUsage),
    ];
    this.sparkGeometry.setAttribute('position', this.sparkAttributes[0]!);
    this.sparkGeometry.setAttribute('aColour', this.sparkAttributes[1]!);
    this.sparkGeometry.setAttribute('aSize', this.sparkAttributes[2]!);
    this.sparkGeometry.setDrawRange(0, 0);
    this.sparkGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.sparkMaterial = new THREE.ShaderMaterial({
      vertexShader: SPARK_VERTEX,
      fragmentShader: SPARK_FRAGMENT,
      uniforms: { uPixelsPerMetre: { value: 600 } },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const sparks = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    sparks.name = 'atmosphere.distantFireworks';
    sparks.frustumCulled = false;
    this.object.add(sparks);

    this.build();
    this.distant.setBudget(this.budget);
    scene.add(this.object);

    if (options.bus) {
      this.unsubscribe.push(
        options.bus.on('qualityChanged', ({ profile }) => this.setQuality(profile)),
        options.bus.on('sessionReset', () => this.distant.reset()),
      );
    }
  }

  get stats(): AtmosphereStats {
    return {
      level: this.budget.level,
      bulbs: this.plan.bulbs.length,
      kandils: this.plan.kandils.length,
      rangolis: this.plan.rangolis.length,
      lights: this.plan.litKandils.length,
      stars: this.stars ? this.stars.geometry.getAttribute('position').count : 0,
      distant: this.distant.stats,
    };
  }

  /** Re-plan decorations and budgets for a new quality profile. */
  setQuality(profile: QualityProfile): void {
    const budget = atmosphereBudget(profile);
    this.budget = budget;
    this.plan = planDecorations(this.layout, budget);
    this.build();
    this.distant.setBudget(budget);
  }

  /** Advance one fixed simulation step. */
  update(dt: number): void {
    this.distant.update(dt);
  }

  /** Per rendered frame: upload the live spark range. */
  frame(): void {
    const count = this.distant.liveParticles;
    this.sparkGeometry.setDrawRange(0, count);
    if (count === 0) return;
    for (let i = 0; i < this.sparkAttributes.length; i++) {
      // Reuse one range per attribute; addUpdateRange() allocates.
      const attr = this.sparkAttributes[i]!;
      const range = this.sparkRanges[i]!;
      range.count = count * attr.itemSize;
      attr.updateRanges.length = 0;
      attr.updateRanges.push(range);
      attr.needsUpdate = true;
    }
  }

  /** Scale spark sizes for the current viewport. Call on resize. */
  setViewport(heightPixels: number, camera: THREE.PerspectiveCamera): void {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    this.sparkMaterial.uniforms.uPixelsPerMetre!.value = heightPixels / (2 * Math.tan(fov / 2));
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clearDecor();
    this.bulbGeometry.dispose();
    this.kandilGeometry.dispose();
    this.glowMaterial.dispose();
    this.rangoliMaterial.dispose();
    this.starMaterial.dispose();
    this.horizon.geometry.dispose();
    (this.horizon.material as THREE.Material).dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }

  private build(): void {
    this.clearDecor();
    const decor = this.decor;
    const { bulbs, kandils, litKandils, rangolis } = this.plan;
    const colour = new THREE.Color();
    const matrix = new THREE.Matrix4();

    const bulbMesh = new THREE.InstancedMesh(this.bulbGeometry, this.glowMaterial, Math.max(1, bulbs.length));
    bulbMesh.name = 'atmosphere.bulbs';
    bulbMesh.count = bulbs.length;
    bulbs.forEach((bulb, i) => {
      bulbMesh.setMatrixAt(i, matrix.makeTranslation(bulb.position.x, bulb.position.y, bulb.position.z));
      bulbMesh.setColorAt(i, colour.setHex(bulb.colour).multiplyScalar(BULB_GLOW));
    });
    finishInstances(bulbMesh);
    decor.add(bulbMesh);

    const kandilMesh = new THREE.InstancedMesh(this.kandilGeometry, this.glowMaterial, Math.max(1, kandils.length));
    kandilMesh.name = 'atmosphere.kandils';
    kandilMesh.count = kandils.length;
    kandils.forEach((k, i) => {
      kandilMesh.setMatrixAt(i, matrix.makeTranslation(k.position.x, k.position.y, k.position.z));
      kandilMesh.setColorAt(i, colour.setHex(k.colour).multiplyScalar(KANDIL_GLOW));
    });
    finishInstances(kandilMesh);
    decor.add(kandilMesh);

    for (const k of litKandils) {
      const light = new THREE.PointLight(k.colour, KANDIL_LIGHT.intensity, KANDIL_LIGHT.distance, 2);
      light.name = `${k.id}.light`;
      light.position.set(k.position.x, k.position.y - KANDIL_HALF.y, k.position.z);
      decor.add(light);
    }

    const rangoli = new THREE.Mesh(buildRangoliGeometry(rangolis, this.budget.rangoliSegments), this.rangoliMaterial);
    rangoli.name = 'atmosphere.rangoli';
    decor.add(rangoli);

    this.stars = createStars(this.budget.stars, this.starMaterial, this.random);
    decor.add(this.stars);

    this.object.add(decor);
  }

  private clearDecor(): void {
    for (const child of this.decor.children) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
      else if (child instanceof THREE.PointLight) child.dispose();
      else if (child instanceof THREE.Mesh || child instanceof THREE.Points) child.geometry.dispose();
    }
    this.decor.clear();
    this.decor.removeFromParent();
    this.decor = new THREE.Group();
    this.decor.name = 'atmosphere.decor';
    this.stars = null;
  }
}

function finishInstances(mesh: THREE.InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

/** A paper akash kandil: a stretched octahedron body with a short tassel. */
function createKandilGeometry(): THREE.BufferGeometry {
  const body = new THREE.OctahedronGeometry(1, 0);
  body.scale(KANDIL_HALF.x, KANDIL_HALF.y * 0.75, KANDIL_HALF.x);
  body.translate(0, KANDIL_HALF.y * 0.25, 0);
  const tassel = new THREE.ConeGeometry(0.05, KANDIL_HALF.y * 0.5, 6);
  tassel.rotateX(Math.PI);
  tassel.translate(0, -KANDIL_HALF.y * 0.75, 0);
  const merged = mergeNonIndexed([body, tassel]);
  body.dispose();
  tassel.dispose();
  return merged;
}

function mergeNonIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const part of parts) {
    const flat = part.index ? part.toNonIndexed() : part;
    positions.push(...(flat.getAttribute('position').array as Float32Array));
    if (flat !== part) flat.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Every rangoli as one flat, vertex-coloured mesh: concentric bands that
 * cycle through the palette with a petal pattern, the outer band scalloped
 * into petals.
 */
export function buildRangoliGeometry(rangolis: readonly Rangoli[], segments: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colours: number[] = [];
  const colour = new THREE.Color();
  const rings = 4;
  for (const r of rangolis) {
    const { x, y, z } = r.centre;
    const radiusAt = (ring: number, angle: number): number => {
      const base = (r.radius * ring) / rings;
      if (ring < rings) return base;
      return base * (0.8 + 0.2 * Math.abs(Math.cos((r.petals * (angle - r.rotation)) / 2)));
    };
    for (let ring = 0; ring < rings; ring++) {
      for (let s = 0; s < segments; s++) {
        const a0 = (s / segments) * Math.PI * 2;
        const a1 = ((s + 1) / segments) * Math.PI * 2;
        const petal = Math.floor((s / segments) * r.petals * 2) % 2;
        colour.setHex(r.colours[(ring + petal * (ring > 0 ? 1 : 0)) % r.colours.length]!);
        const i0 = radiusAt(ring, a0);
        const i1 = radiusAt(ring, a1);
        const o0 = radiusAt(ring + 1, a0);
        const o1 = radiusAt(ring + 1, a1);
        const p = (rad: number, a: number): [number, number, number] => [
          x + Math.cos(a + r.rotation) * rad,
          y + RANGOLI_LIFT,
          z + Math.sin(a + r.rotation) * rad,
        ];
        // Two triangles per band segment, wound to face up; the centre
        // band is a fan, so it needs only the first.
        const quad = [p(i0, a0), p(o1, a1), p(o0, a0)];
        if (ring > 0) quad.push(p(i0, a0), p(i1, a1), p(o1, a1));
        for (const v of quad) {
          positions.push(...v);
          normals.push(0, 1, 0);
          colours.push(colour.r, colour.g, colour.b);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return geometry;
}

/** Warm city-light haze rising from the horizon; additive, fading upwards. */
function createHorizonGlow(): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(HORIZON_RADIUS, HORIZON_RADIUS, HORIZON_HEIGHT, 48, 4, true);
  geometry.translate(0, HORIZON_HEIGHT / 2 - 2, 0);
  const positions = geometry.getAttribute('position');
  const colours: number[] = [];
  const colour = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const t = Math.min(1, Math.max(0, (positions.getY(i) + 2) / HORIZON_HEIGHT));
    colour.copy(HORIZON_GLOW).multiplyScalar((1 - t) ** 2);
    colours.push(colour.r, colour.g, colour.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  mesh.name = 'atmosphere.horizon';
  return mesh;
}

/** Stars scattered over the upper sky, kept clear of the horizon haze. */
function createStars(count: number, material: THREE.PointsMaterial, random: () => number): THREE.Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const azimuth = random() * Math.PI * 2;
    const elevation = Math.asin(0.3 + random() * 0.7);
    positions[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * STAR_RADIUS;
    positions[i * 3 + 1] = Math.sin(elevation) * STAR_RADIUS;
    positions[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * STAR_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(geometry, material);
  stars.name = 'atmosphere.stars';
  stars.frustumCulled = false;
  return stars;
}
