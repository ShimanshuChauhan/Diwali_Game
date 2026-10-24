import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { QualityProfile } from '../core/quality';
import type { Aabb } from '../core/types';
import { renderSettings, type RenderSettings } from './renderSettings';

/** Bloom catches the HDR flames, decorations and sparks pushed above 1. */
const BLOOM = { strength: 0.6, radius: 0.4, threshold: 0.9 } as const;

export interface RenderPipelineOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly profile: QualityProfile;
  /** Follows `qualityChanged`. */
  readonly bus?: GameEventBus;
  /** The one light allowed to cast shadows (the moon), when shadows are on. */
  readonly shadowLight?: THREE.DirectionalLight;
  /** World extent the shadow camera must cover. */
  readonly shadowBounds?: Aabb;
  readonly devicePixelRatio?: () => number;
  /** Called after the drawing-buffer size changes, so viewports can follow. */
  readonly onResize?: () => void;
}

/** Renderer counters for the perf overlay, summed over every pass of a frame. */
export interface RenderStats {
  readonly drawCalls: number;
  readonly triangles: number;
}

/**
 * Applies the quality profile to rendering: pixel ratio and render scale,
 * moonlight shadows, and a bloom pass on Medium/High. Switching profiles
 * re-applies in place; the bloom composer is built on first use and kept.
 */
export class RenderPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly shadowLight: THREE.DirectionalLight | null;
  private readonly devicePixelRatio: () => number;
  private readonly onResize: () => void;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly size = new THREE.Vector2();
  private composer: EffectComposer | null = null;
  private current!: RenderSettings;
  private profile: QualityProfile;
  private readonly counters = { drawCalls: 0, triangles: 0 };

  constructor(options: RenderPipelineOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.shadowLight = options.shadowLight ?? null;
    this.devicePixelRatio = options.devicePixelRatio ?? (() => window.devicePixelRatio);
    this.onResize = options.onResize ?? (() => {});
    this.profile = options.profile;
    // Count every pass of a frame, not just the last one.
    this.renderer.info.autoReset = false;
    if (this.shadowLight && options.shadowBounds) fitShadowCamera(this.shadowLight, options.shadowBounds);
    this.apply(options.profile, true);
    if (options.bus) this.unsubscribes.push(options.bus.on('qualityChanged', ({ profile }) => this.apply(profile)));
  }

  get settings(): RenderSettings {
    return this.current;
  }

  get stats(): RenderStats {
    return this.counters;
  }

  apply(profile: QualityProfile, force = false): void {
    this.profile = profile;
    const next = renderSettings(profile, this.devicePixelRatio());
    const previous = force ? null : this.current;
    this.current = next;

    if (previous?.pixelRatio !== next.pixelRatio) {
      this.renderer.setPixelRatio(next.pixelRatio);
      this.composer?.setPixelRatio(next.pixelRatio);
      if (previous) this.onResize();
    }
    if (previous?.shadows !== next.shadows || previous?.shadowMapSize !== next.shadowMapSize) this.applyShadows(next);
    if (next.bloom && !this.composer) this.composer = this.createComposer();
  }

  /** Follow a window resize (also picks up a changed devicePixelRatio). */
  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
    const ratio = renderSettings(this.profile, this.devicePixelRatio()).pixelRatio;
    if (ratio !== this.current.pixelRatio) this.apply(this.profile);
    this.composer?.setSize(width, height);
  }

  render(): void {
    this.renderer.info.reset();
    if (this.current.bloom && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.counters.drawCalls = this.renderer.info.render.calls;
    this.counters.triangles = this.renderer.info.render.triangles;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.composer?.dispose();
    this.composer = null;
  }

  private applyShadows(settings: RenderSettings): void {
    const light = this.shadowLight;
    const enabled = settings.shadows && light !== null;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (light) {
      light.castShadow = enabled;
      light.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
      // A new map size needs a fresh shadow render target.
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
    // Static scenery casts and receives; additive sprites and the sky do neither.
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh && object.name.startsWith('world.')) {
        object.castShadow = enabled;
        object.receiveShadow = enabled;
      }
      const material = (object as Partial<THREE.Mesh>).material;
      if (Array.isArray(material)) for (const m of material) m.needsUpdate = true;
      else if (material) material.needsUpdate = true;
    });
  }

  private createComposer(): EffectComposer {
    const composer = new EffectComposer(this.renderer);
    this.renderer.getSize(this.size);
    composer.setPixelRatio(this.current.pixelRatio);
    composer.setSize(this.size.x, this.size.y);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new UnrealBloomPass(this.size.clone(), BLOOM.strength, BLOOM.radius, BLOOM.threshold));
    composer.addPass(new OutputPass());
    return composer;
  }
}

/** Fit an orthographic shadow camera around the world box from the light's direction. */
function fitShadowCamera(light: THREE.DirectionalLight, bounds: Aabb): void {
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;
  const radius = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) / 2;
  const direction = light.position.clone().sub(light.target.position).normalize();
  light.target.position.set(cx, 0, cz);
  light.position.set(cx, 0, cz).addScaledVector(direction, radius * 2);
  if (!light.target.parent) light.parent?.add(light.target);
  const camera = light.shadow.camera;
  camera.left = -radius;
  camera.right = radius;
  camera.top = radius;
  camera.bottom = -radius;
  camera.near = radius * 0.5;
  camera.far = radius * 3.5;
  camera.updateProjectionMatrix();
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
}
