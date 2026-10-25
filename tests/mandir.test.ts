import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import {
  buildInteriorScene,
  buildMandirModel,
  createFamilyHomeLayout,
  createWoodGrainTexture,
  FAMILY_ROOM,
  InteriorAssets,
  MANDIR_DETAILS,
  mandirDetail,
  type MandirDetail,
} from '../src/interior';
import { PLAYER_RADIUS } from '../src/player';

const home = createFamilyHomeLayout();
const site = home.mandir;
const body = home.solids.find((s) => s.id === site.id)!.box;
const chowki = home.solids.find((s) => s.id === 'puja.chowki')!.box;
const stand = home.interactions.find((i) => i.target.kind === 'puja')!.stand.position;
const northZ = home.bounds.min.z;

/** Triangle budget per detail level: a few thousand on Low, more lathe and sphere segments above. */
const BUDGET: Readonly<Record<MandirDetail, number>> = { low: 8500, full: 21000 };

function setup() {
  const assets = new InteriorAssets();
  const interior = buildInteriorScene(home, assets);
  interior.root.updateMatrixWorld(true);
  return { assets, interior, mandir: interior.mandir! };
}

/** World bounds of everything drawn at one detail level. */
function worldBounds(group: THREE.Object3D): THREE.Box3 {
  const out = new THREE.Box3();
  group.updateWorldMatrix(true, true);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) out.union(o.geometry.boundingBox!.clone().applyMatrix4(o.matrixWorld));
  });
  return out;
}

describe('wooden mandir', () => {
  it('builds headless, with no DOM or canvas', () => {
    expect(typeof document).toBe('undefined');
    const { mandir } = setup();
    expect(mandir.root.name).toBe('interior.familyHome.puja.mandir');
    for (const detail of MANDIR_DETAILS) expect(mandir.models[detail].triangles).toBeGreaterThan(1000);
  });

  it('grains its wood with a tiling texture made from math', () => {
    const texture = createWoodGrainTexture(64);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    const data = texture.image.data as Uint8Array;
    expect(data.length).toBe(64 * 64 * 4);
    // Visible grain: a spread of tones, not a flat colour.
    const reds = Array.from({ length: 64 * 64 }, (_, i) => data[i * 4]!);
    expect(Math.max(...reds) - Math.min(...reds)).toBeGreaterThan(40);
    // Seamless: opposite edges differ no more than neighbouring columns do.
    const column = (x: number) => Array.from({ length: 64 }, (_, y) => data[(y * 64 + x) * 4]!);
    const step = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;
    expect(step(column(63), column(0))).toBeLessThan(step(column(31), column(32)) * 3 + 8);
    texture.dispose();
  });

  it('has the recognisable parts of a home mandir at every detail level', () => {
    const { mandir } = setup();
    for (const detail of MANDIR_DETAILS) {
      const { parts } = mandir.models[detail];
      for (const id of [
        'base', 'drawer.0', 'drawer.1', 'pillar.0', 'pillar.1', 'arch', 'jali.0', 'jali.1', 'backboard', 'cloth',
        'cornice', 'dome', 'dome.corner.0', 'dome.corner.1', 'kalash.roof', 'bell.0', 'bell.1', 'bell.2', 'garland',
        'ganesh', 'lakshmi', 'kalash', 'diya', 'incense',
      ]) {
        expect(parts.get(id)?.triangles, `${detail} ${id}`).toBeGreaterThan(0);
      }
      const get = (id: string) => parts.get(id)!.bounds;
      // Pillars stand at the front corners, the arch spans between them, the dome and kalash crown the roof.
      expect(get('pillar.0').max.x).toBeLessThan(get('pillar.1').min.x);
      expect(get('arch').min.x).toBeGreaterThan(get('pillar.0').min.x);
      expect(get('arch').max.x).toBeLessThan(get('pillar.1').max.x);
      expect(get('dome').min.y).toBeGreaterThanOrEqual(site.height - 0.001);
      expect(get('kalash.roof').min.y).toBeGreaterThan(get('dome').min.y);
      // Bells hang inside the arch, under it and above the idols' crowns.
      for (const bell of ['bell.0', 'bell.1', 'bell.2']) {
        expect(get(bell).max.y).toBeLessThan(get('arch').max.y);
        expect(get(bell).min.y).toBeGreaterThan(Math.max(get('ganesh').max.y, get('lakshmi').max.y));
      }
      // Ganesh on the viewer's left, Lakshmi on the right, both on the cloth inside the sanctum.
      const ganesh = get('ganesh');
      const lakshmi = get('lakshmi');
      expect(ganesh.max.x).toBeLessThan(lakshmi.min.x);
      for (const idol of [ganesh, lakshmi]) {
        expect(idol.min.y).toBeGreaterThanOrEqual(get('cloth').max.y - 0.006);
        expect(idol.max.y).toBeLessThan(get('arch').min.y);
        expect(idol.min.x).toBeGreaterThan(get('pillar.0').max.x);
        expect(idol.max.x).toBeLessThan(get('pillar.1').min.x);
        expect(idol.max.y - idol.min.y).toBeGreaterThan(0.3);
      }
    }
  });

  it('stays within its body on the chowki, clear of the wall, the ceiling garland and the aarti stand', () => {
    const { mandir } = setup();
    for (const detail of MANDIR_DETAILS) {
      const b = worldBounds(mandir.levels[detail]);
      // Side to side within the body (the cornice overhangs a few centimetres) and the chowki.
      expect(b.min.x).toBeGreaterThan(body.min.x - 0.05);
      expect(b.max.x).toBeLessThan(body.max.x + 0.05);
      expect(b.min.x).toBeGreaterThan(chowki.min.x);
      expect(b.max.x).toBeLessThan(chowki.max.x);
      // Never into the wall; the cornice and garland stand at most 6 cm proud of the body.
      expect(b.min.z).toBeGreaterThanOrEqual(northZ - 1e-6);
      expect(b.max.z).toBeLessThan(body.max.z + 0.06);
      expect(b.max.z).toBeLessThan(chowki.max.z);
      // On the chowki; only the roof rises above the body, and stays under the wall garland's drops.
      expect(b.min.y).toBeGreaterThanOrEqual(chowki.max.y - 1e-6);
      expect(b.max.y).toBeLessThan(body.max.y + 0.5);
      expect(b.max.y).toBeLessThan(home.bounds.min.y + 1 + FAMILY_ROOM.height - 0.75);
      // Far from where the player stands for aarti, out of reach of their capsule.
      const nearest = b.clampPoint(new THREE.Vector3(stand.x, b.min.y, stand.z), new THREE.Vector3());
      expect(Math.hypot(nearest.x - stand.x, nearest.z - stand.z)).toBeGreaterThan(PLAYER_RADIUS + TUNING.camera.collisionMargin + 0.5);
    }
  });

  it('keeps the triangle count within budget and draws in a handful of calls', () => {
    const { mandir } = setup();
    for (const detail of MANDIR_DETAILS) {
      const model = mandir.models[detail];
      expect(model.triangles, detail).toBeLessThanOrEqual(BUDGET[detail]);
      // One merged mesh per surface.
      expect(mandir.levels[detail].children.length).toBeLessThanOrEqual(7);
      for (const geometry of model.geometries.values()) {
        const position = geometry.getAttribute('position');
        expect(geometry.getAttribute('color').count).toBe(position.count);
        expect(Array.from(position.array as Float32Array).every(Number.isFinite)).toBe(true);
      }
    }
    expect(mandir.models.full.triangles).toBeGreaterThan(mandir.models.low.triangles * 1.5);
  });

  it('draws one detail level at a time, chosen by quality', () => {
    const { interior, mandir } = setup();
    expect(mandirDetail('low')).toBe('low');
    expect(mandirDetail('medium')).toBe('full');
    expect(mandirDetail('high')).toBe('full');
    for (const level of ['low', 'medium', 'high', 'low'] as const) {
      interior.applyQuality(qualityProfile(level));
      const shown = mandirDetail(level);
      expect(mandir.shown).toBe(shown);
      expect(mandir.levels.low.visible).toBe(shown === 'low');
      expect(mandir.levels.full.visible).toBe(shown === 'full');
    }
    // Part of the home: hidden with it while the player is elsewhere.
    expect(mandir.root.parent).toBe(interior.root);
  });

  it('builds its geometry and materials once and shares them between builds', () => {
    const { assets, interior } = setup();
    const materials = assets.materialCount;
    const again = buildInteriorScene(home, assets);
    expect(assets.materialCount).toBe(materials);
    for (const detail of MANDIR_DETAILS) {
      const first = interior.mandir!.levels[detail].children as THREE.Mesh[];
      const second = again.mandir!.levels[detail].children as THREE.Mesh[];
      expect(second.map((m) => m.geometry)).toEqual(first.map((m) => m.geometry));
      expect(second.map((m) => m.material)).toEqual(first.map((m) => m.material));
    }
    // The flames are the room's own, so they flicker with the other diyas.
    const flame = interior.mandir!.levels.full.children.find((m) => m.name.endsWith('.flame')) as THREE.Mesh;
    expect(flame.material).toBe(assets.material('flame'));
  });

  it('disposes its geometries, materials and grain texture with the interior assets', () => {
    const { assets, mandir } = setup();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    mandir.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        materials.add(o.material as THREE.Material);
      }
    });
    const disposed = new Set<unknown>();
    const watch = (resource: THREE.EventDispatcher<{ dispose: object }>) =>
      resource.addEventListener('dispose', () => disposed.add(resource));
    for (const g of geometries) watch(g);
    for (const m of materials) watch(m);
    watch(assets.mandir.grain);
    const grain = assets.mandir.grain;
    assets.dispose();
    for (const g of geometries) expect(disposed.has(g)).toBe(true);
    for (const m of materials) expect(disposed.has(m), m.name).toBe(true);
    expect(disposed.has(grain)).toBe(true);
  });

  it('builds the same model for the same site', () => {
    const a = buildMandirModel(site, 'low');
    const b = buildMandirModel(site, 'low');
    expect(b.triangles).toBe(a.triangles);
    expect([...b.parts.keys()]).toEqual([...a.parts.keys()]);
    for (const g of [...a.geometries.values(), ...b.geometries.values()]) g.dispose();
  });
});
