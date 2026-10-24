import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createLayout } from '../src/world';
import { buildWorldScene, createWorldScene } from '../src/world/scene';

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
