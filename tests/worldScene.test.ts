import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createLayout } from '../src/world';
import { buildWorldScene, createWorldScene, doorwayGlowMap } from '../src/world/scene';

const layout = createLayout();

describe('world scene', () => {
  const { root, dispose } = buildWorldScene(layout);
  const meshes = root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);

  it('draws every visible solid and decor box exactly once', () => {
    const drawn = meshes.reduce((n, m) => n + m.count, 0);
    expect(drawn).toBe(layout.solids.filter((s) => s.visible).length + layout.decor.length);
  });

  it('shares one geometry and one material per material key', () => {
    expect(new Set(meshes.map((m) => m.geometry)).size).toBe(1);
    const materials = meshes.map((m) => m.material);
    expect(new Set(materials).size).toBe(materials.length);
    expect(meshes.length).toBeLessThan(40);
  });

  it('lights the open doorways brighter than any window, without a light of their own', () => {
    const material = (key: string) => meshes.find((m) => m.name === `world.${key}`)?.material as THREE.MeshStandardMaterial;
    expect(material('doorGlow').emissiveIntensity).toBeGreaterThan(material('window').emissiveIntensity);
    expect(material('marigold')).toBeDefined();
    expect(material('brass')).toBeDefined();
  });

  it('keeps the doorway glow a warm, lamp-lit amber that lamps beside it cannot wash out', () => {
    const glow = meshes.find((m) => m.name === 'world.doorGlow')!.material as THREE.MeshLambertMaterial;
    const window = meshes.find((m) => m.name === 'world.window')!.material as THREE.MeshStandardMaterial;
    const luminance = (c: THREE.Color, k: number) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * k;
    const peak = luminance(glow.emissive, glow.emissiveIntensity);
    // Brighter than a window at its warmest, yet under the bloom threshold (0.9).
    expect(peak).toBeGreaterThan(luminance(window.emissive, window.emissiveIntensity));
    expect(peak).toBeLessThan(0.9);
    // Saffron, not cream: little blue next to red.
    expect(glow.emissive.b).toBeLessThan(glow.emissive.r * 0.2);
    // Ignores the lights: no diffuse colour and no specular highlight.
    expect(glow).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(glow.color.getHex()).toBe(0x000000);
    expect(glow.emissiveMap).toBeInstanceOf(THREE.DataTexture);
  });

  it('shades the doorway glow brightest low and in the middle', () => {
    const map = doorwayGlowMap();
    const { data, width, height } = map.image as { data: Uint8Array; width: number; height: number };
    const at = (col: number, row: number) => data[(row * width + col) * 4]!;
    const mid = Math.floor(width / 2);
    expect(at(mid, 0)).toBeGreaterThan(245);
    expect(at(mid, height - 1)).toBeLessThan(at(mid, 0) * 0.7);
    expect(at(0, 0)).toBeLessThan(at(mid, 0));
    expect(at(0, height - 1)).toBeGreaterThan(64);
    map.dispose();
  });

  it('adds the layout practical lights', () => {
    expect(root.children.filter((c) => c instanceof THREE.PointLight)).toHaveLength(layout.lights.length);
  });

  it('builds an evening scene with sky, fog and ambient light', () => {
    const { scene } = createWorldScene(layout);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    expect(scene.getObjectByName('sky')).toBeDefined();
    expect(scene.children.some((c) => c instanceof THREE.HemisphereLight)).toBe(true);
    expect(scene.getObjectByName('world')).toBeDefined();
  });

  it('disposes without throwing', () => {
    expect(dispose).not.toThrow();
  });
});
