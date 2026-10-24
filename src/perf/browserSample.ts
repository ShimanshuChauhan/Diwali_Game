import type * as THREE from 'three';
import type { CapacityStats } from '../capacity';
import type { ResourceSample } from './resourceTracker';

export interface BrowserSampleSources {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Object3D;
  readonly capacity: () => CapacityStats;
  /** Distant sky sparks, which sit outside the capacity budget. */
  readonly distantParticles: () => number;
  /** More counts to sample alongside, e.g. audio sources and bus listeners. */
  readonly extra?: () => ResourceSample;
}

/** Chrome-only `performance.memory`; absent elsewhere. */
interface HeapInfo {
  readonly usedJSHeapSize: number;
}

/**
 * Builds the soak's resource sampler: every capacity budget, plus the
 * things a leak would show up in first — scene objects, GPU geometries,
 * textures and shader programs, and the JS heap (Chromium only).
 */
export function browserSampler(sources: BrowserSampleSources): () => ResourceSample {
  const { renderer, scene } = sources;
  return () => {
    const r = sources.capacity().resources;
    let sceneObjects = 0;
    scene.traverse(() => sceneObjects++);
    const heap = (performance as Performance & { memory?: HeapInfo }).memory;
    return {
      placedProps: r.placedProps.used,
      litCrackers: r.litCrackers.used,
      activeEffects: r.activeEffects.used,
      particles: r.particles.used,
      dynamicLights: r.dynamicLights.used,
      audioVoices: r.audioVoices.used,
      distantParticles: sources.distantParticles(),
      sceneObjects,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length,
      heapMb: heap ? heap.usedJSHeapSize / 2 ** 20 : undefined,
      ...sources.extra?.(),
    };
  };
}
