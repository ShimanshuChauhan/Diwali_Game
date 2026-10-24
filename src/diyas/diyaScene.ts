import * as THREE from 'three';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { QualityProfile } from '../core/quality';
import type { Vec3 } from '../core/types';
import type { Diyas } from './diyas';
import { clusterDiyas, DIYA_LIGHTS, flicker, nearestWarmClusters, stepGlow, type DiyaCluster } from './glow';

const BOWL = { radiusTop: 0.09, radiusBottom: 0.05, height: 0.06 } as const;
const FLAME = { radius: 0.025, height: 0.09 } as const;
/** Flames are pushed above 1 so they bloom through tone mapping. */
const FLAME_GLOW = 2.4;
const FLAME_COLOUR = new THREE.Color('#ffb347').multiplyScalar(FLAME_GLOW);

/** Warm light per burning diya in a cluster; no shadows. */
const LIGHT_COLOUR = '#ff9a40';
const LIGHT_PER_DIYA = 4;
const LIGHT_DISTANCE = 6;
const LIGHT_LIFT = 0.4;

export interface DiyaSceneStats {
  readonly lit: number;
  /** Point lights currently warming a cluster. */
  readonly activeLights: number;
  readonly lightPool: number;
}

export interface DiyaSceneOptions {
  readonly scene: THREE.Scene;
  readonly diyas: Diyas;
  readonly profile: QualityProfile;
  /** Follows `qualityChanged`. */
  readonly bus?: GameEventBus;
}

/**
 * Draws the diyas: clay bowls and emissive, flickering flames as two
 * instanced meshes, plus a quality-sized pool of point lights that warms
 * the lit clusters nearest the viewer.
 */
export class DiyaScene {
  readonly object = new THREE.Group();
  readonly clusters: readonly DiyaCluster[];

  private readonly diyas: Diyas;
  private readonly bowlGeometry = new THREE.CylinderGeometry(BOWL.radiusTop, BOWL.radiusBottom, BOWL.height, 10);
  private readonly flameGeometry = createFlameGeometry();
  private readonly bowlMaterial = new THREE.MeshStandardMaterial({ color: '#a0522d', roughness: 0.9 });
  private readonly flameMaterial = new THREE.MeshBasicMaterial({ color: FLAME_COLOUR });
  private readonly flames: THREE.InstancedMesh;
  private readonly glow: Float32Array;
  private readonly warmth: Float32Array;
  private readonly phases: Float32Array;
  private readonly nearest: number[] = [];
  private readonly unsubscribe: Unsubscribe[] = [];
  private lights: THREE.PointLight[] = [];
  private time = 0;
  private active = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  constructor(options: DiyaSceneOptions) {
    this.diyas = options.diyas;
    this.object.name = 'diyas';
    const sites = this.diyas.sites;
    this.clusters = clusterDiyas(sites);
    this.glow = new Float32Array(sites.length);
    this.warmth = new Float32Array(this.clusters.length);
    this.phases = Float32Array.from(sites, (_, i) => i * 2.399);
    for (let i = 0; i < sites.length; i++) if (this.diyas.isLit(sites[i]!.id)) this.glow[i] = 1;

    const count = Math.max(1, sites.length);
    const bowls = new THREE.InstancedMesh(this.bowlGeometry, this.bowlMaterial, count);
    bowls.name = 'diyas.bowls';
    bowls.count = sites.length;
    sites.forEach((site, i) => {
      const p = site.position;
      bowls.setMatrixAt(i, this.matrix.makeTranslation(p.x, p.y + BOWL.height / 2, p.z));
    });
    bowls.instanceMatrix.needsUpdate = true;
    bowls.computeBoundingSphere();
    this.object.add(bowls);

    this.flames = new THREE.InstancedMesh(this.flameGeometry, this.flameMaterial, count);
    this.flames.name = 'diyas.flames';
    this.flames.count = sites.length;
    this.flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Flames only ever sit on their bowls, so the bowls' bounds serve.
    this.flames.frustumCulled = false;
    this.object.add(this.flames);

    this.setQuality(options.profile);
    options.scene.add(this.object);
    if (options.bus) {
      this.unsubscribe.push(options.bus.on('qualityChanged', ({ profile }) => this.setQuality(profile)));
    }
  }

  get stats(): DiyaSceneStats {
    return { lit: this.diyas.litCount, activeLights: this.active, lightPool: this.lights.length };
  }

  /** Resize the light pool; changes the light count once, never per frame. */
  setQuality(profile: QualityProfile): void {
    const size = Math.min(DIYA_LIGHTS[profile.level], this.clusters.length);
    if (size === this.lights.length) return;
    for (const light of this.lights) {
      light.removeFromParent();
      light.dispose();
    }
    this.lights = Array.from({ length: size }, (_, i) => {
      const light = new THREE.PointLight(LIGHT_COLOUR, 0, LIGHT_DISTANCE, 2);
      light.name = `diyas.light.${i}`;
      light.castShadow = false;
      this.object.add(light);
      return light;
    });
  }

  /** Advance one fixed simulation step: flames grow in when lit, go out on reset. */
  update(dt: number): void {
    this.time += dt;
    const sites = this.diyas.sites;
    for (let i = 0; i < sites.length; i++) this.glow[i] = stepGlow(this.glow[i]!, this.diyas.isLit(sites[i]!.id), dt);
    for (let c = 0; c < this.clusters.length; c++) {
      const members = this.clusters[c]!.members;
      let sum = 0;
      for (let m = 0; m < members.length; m++) sum += this.glow[members[m]!]!;
      this.warmth[c] = sum;
    }
  }

  /** Per rendered frame: flicker the flames and move the lights to the nearest warm clusters. */
  frame(viewer: Vec3): void {
    const sites = this.diyas.sites;
    for (let i = 0; i < sites.length; i++) {
      const p = sites[i]!.position;
      const g = this.glow[i]!;
      const f = g > 0 ? g * flicker(this.time, this.phases[i]!) : 0;
      this.position.set(p.x, p.y + BOWL.height, p.z);
      this.scale.set(g, f, g);
      this.flames.setMatrixAt(i, this.matrix.compose(this.position, this.rotation, this.scale));
    }
    this.flames.instanceMatrix.needsUpdate = true;

    const nearest = nearestWarmClusters(this.clusters, this.warmth, viewer, this.lights.length, this.nearest);
    this.active = nearest.length;
    for (let l = 0; l < this.lights.length; l++) {
      const light = this.lights[l]!;
      const c = nearest[l];
      // Spare lights stay in the scene at zero intensity: hiding them would
      // change the light count and recompile every lit material.
      if (c === undefined) {
        light.intensity = 0;
        continue;
      }
      const { centre, members } = this.clusters[c]!;
      light.position.set(centre.x, centre.y + LIGHT_LIFT, centre.z);
      // The cluster's light flickers with its first flame, softened.
      const wobble = 1 + (flicker(this.time, this.phases[members[0]!]!) - 1) * 0.5;
      light.intensity = this.warmth[c]! * LIGHT_PER_DIYA * wobble;
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const child of this.object.children) {
      if (child instanceof THREE.InstancedMesh || child instanceof THREE.PointLight) child.dispose();
    }
    this.bowlGeometry.dispose();
    this.flameGeometry.dispose();
    this.bowlMaterial.dispose();
    this.flameMaterial.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }
}

/** A teardrop flame with its base at the origin. */
function createFlameGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(FLAME.radius, FLAME.height, 8);
  geometry.translate(0, FLAME.height / 2, 0);
  return geometry;
}
