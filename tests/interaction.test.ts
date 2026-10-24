import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { CameraView, CrackerSnapshot, WorldModule } from '../src/core/contracts';
import { TUNING } from '../src/core/tuning';
import type { Vec3 } from '../src/core/types';
import { Interaction } from '../src/interaction';
import { createPlacementGhost } from '../src/interaction/ghost';
import { createWorld } from '../src/world';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const UP = v(0, 1, 0);
const range = TUNING.interaction.interactRange;

function flatWorld(diyas: { id: string; position: Vec3 }[] = []): WorldModule {
  return {
    bounds: { min: v(-50, -1, -50), max: v(50, 20, 50) },
    spawn: v(0, 0, 0),
    doorways: [],
    diyaSites: diyas,
    neighbourAreas: [],
    surfaceBelow: (p) => ({ point: v(p.x, 0, p.z), normal: UP, supportsPlacement: true }),
    isClear: () => true,
    clearanceAbove: (_p, max) => max,
  };
}

function cracker(id: string, position: Vec3, state: CrackerSnapshot['state'] = 'placed'): CrackerSnapshot {
  return { id, type: 'anar', state, position, stateTime: 0 };
}

/** First-person view from feet at `feet`, looking along `forward` (default -Z). */
function viewFrom(feet: Vec3, forward: Vec3 = v(0, 0, -1)): CameraView {
  return {
    mode: 'firstPerson',
    position: v(feet.x, feet.y + TUNING.player.eyeHeight, feet.z),
    forward,
    yaw: 0,
    pitch: 0,
  };
}

describe('findInteractable', () => {
  it('finds nothing in an empty yard', () => {
    expect(new Interaction({ world: flatWorld() }).findInteractable(viewFrom(v(0, 0, 0)))).toBeNull();
  });

  it('finds a placed cracker within range', () => {
    const interaction = new Interaction({ world: flatWorld(), crackers: () => [cracker('c1', v(0, 0, -1.5))] });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toEqual({
      kind: 'cracker',
      id: 'c1',
      position: v(0, 0, -1.5),
    });
  });

  it('finds a diya within range', () => {
    const interaction = new Interaction({ world: flatWorld([{ id: 'd1', position: v(1, 0.3, -1) }]) });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toMatchObject({ kind: 'diya', id: 'd1' });
  });

  it('ignores objects beyond interact range', () => {
    const interaction = new Interaction({
      world: flatWorld([{ id: 'd1', position: v(0, 0.3, -range - 0.01) }]),
      crackers: () => [cracker('c1', v(0.1, 0, -range - 0.1))],
    });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toBeNull();
  });

  it('picks the nearest of several usable objects', () => {
    const interaction = new Interaction({
      world: flatWorld([{ id: 'far-diya', position: v(0, 0.3, -1.8) }]),
      crackers: () => [cracker('far', v(0.5, 0, -1.6)), cracker('near', v(-0.3, 0, -0.9))],
    });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))?.id).toBe('near');
  });

  it('skips crackers that are already lit or finished', () => {
    const interaction = new Interaction({
      world: flatWorld([{ id: 'd1', position: v(0, 0.3, -1.8) }]),
      crackers: () => [cracker('lit', v(0, 0, -1), 'fuseBurning'), cracker('active', v(0, 0, -1.2), 'active')],
    });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toMatchObject({ kind: 'diya', id: 'd1' });
  });

  it('skips diyas the caller marks unusable', () => {
    const interaction = new Interaction({
      world: flatWorld([{ id: 'd1', position: v(0, 0.3, -1) }]),
      isDiyaUsable: (id) => id !== 'd1',
    });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toBeNull();
  });

  it('ignores objects behind the view, but not ones at the feet', () => {
    const behind = new Interaction({ world: flatWorld(), crackers: () => [cracker('c1', v(0, 0, 1.5))] });
    expect(behind.findInteractable(viewFrom(v(0, 0, 0)))).toBeNull();
    const atFeet = new Interaction({ world: flatWorld(), crackers: () => [cracker('c1', v(0, 0, 0.4))] });
    expect(atFeet.findInteractable(viewFrom(v(0, 0, 0)))?.id).toBe('c1');
  });

  it('ignores objects on another level, such as the rooftop above', () => {
    const interaction = new Interaction({ world: flatWorld(), crackers: () => [cracker('roof', v(0, 4, -1))] });
    expect(interaction.findInteractable(viewFrom(v(0, 0, 0)))).toBeNull();
  });

  it('measures reach from the player, not a third-person camera', () => {
    const feet = v(0, 0, 0);
    const interaction = new Interaction({
      world: flatWorld(),
      crackers: () => [cracker('c1', v(0, 0, -1.5))],
      playerPosition: () => feet,
    });
    const thirdPerson: CameraView = { ...viewFrom(v(0, 0, 3.5)), mode: 'thirdPerson', position: v(0, 1.8, 3.5) };
    expect(interaction.findInteractable(thirdPerson)?.id).toBe('c1');
  });

  it('returns the same object while the result is unchanged', () => {
    const interaction = new Interaction({
      world: flatWorld(),
      // Fresh snapshots every call, as a cracker module might return.
      crackers: () => [cracker('c1', v(0, 0, -1.5))],
    });
    const view = viewFrom(v(0, 0, 0));
    const first = interaction.findInteractable(view);
    expect(interaction.findInteractable(view)).toBe(first);
  });

  it('finds the door diyas of a house in the test lane', () => {
    const world = createWorld();
    const diya = world.diyaSites[0]!;
    const feet = v(diya.position.x, 0, diya.position.z + 1);
    const interaction = new Interaction({ world });
    const found = interaction.findInteractable(viewFrom(feet, v(0, 0, -1)));
    expect(found?.kind).toBe('diya');
  });
});

describe('Interaction placement', () => {
  it('validates through the shared rules and counts crackers for capacity', () => {
    const crackers: CrackerSnapshot[] = [];
    const interaction = new Interaction({ world: flatWorld(), crackers: () => crackers });
    const request = { type: 'anar' as const, target: v(0, 0, -1), playerPosition: v(0, 0, 0) };
    expect(interaction.validatePlacement(request).ok).toBe(true);
    for (let i = 0; i < TUNING.caps.maxPlacedCrackers; i++) crackers.push(cracker(`c${i}`, v(20, 0, i)));
    expect(interaction.validatePlacement(request)).toEqual({ ok: false, reason: 'capacity' });
    expect(interaction.previewPlacement(request)).toMatchObject({ ok: false, reason: 'capacity' });
  });
});

describe('placement ghost', () => {
  it('is hidden until given a verdict', () => {
    const ghost = createPlacementGhost();
    expect(ghost.root.visible).toBe(false);
    ghost.dispose();
  });

  it('turns green for a valid spot and red for a rejected one', () => {
    const interaction = new Interaction({ world: flatWorld(), crackers: () => [cracker('c1', v(3, 0, 0))] });
    const ghost = createPlacementGhost();
    const mesh = ghost.root as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

    ghost.update(interaction.previewPlacement({ type: 'rocket', target: v(0, 0, -1), playerPosition: v(0, 0, 0) }));
    expect(mesh.visible).toBe(true);
    expect(mesh.position.toArray()).toEqual([0, 0, -1]);
    const green = mesh.material.color.getHex();

    ghost.update(interaction.previewPlacement({ type: 'anar', target: v(3.1, 0, 0), playerPosition: v(2, 0, 0) }));
    const red = mesh.material.color.getHex();
    expect(red).not.toBe(green);
    expect(mesh.position.toArray()).toEqual([3.1, 0, 0]);
    expect(mesh.material.color.r).toBeGreaterThan(mesh.material.color.g);
    ghost.dispose();
  });

  it('hides for the handheld phuljhari and for null', () => {
    const interaction = new Interaction({ world: flatWorld() });
    const ghost = createPlacementGhost();
    ghost.update(interaction.previewPlacement({ type: 'anar', target: v(0, 0, -1), playerPosition: v(0, 0, 0) }));
    ghost.update(interaction.previewPlacement({ type: 'phuljhari', target: v(0, 0, -1), playerPosition: v(0, 0, 0) }));
    expect(ghost.root.visible).toBe(false);
    ghost.update(interaction.previewPlacement({ type: 'anar', target: v(0, 0, -1), playerPosition: v(0, 0, 0) }));
    ghost.update(null);
    expect(ghost.root.visible).toBe(false);
    ghost.dispose();
  });

  it('keeps the same mesh, geometry and material across updates', () => {
    const interaction = new Interaction({ world: flatWorld() });
    const ghost = createPlacementGhost();
    const mesh = ghost.root as THREE.Mesh;
    const { geometry, material } = mesh;
    for (let i = 0; i < 10; i++) {
      ghost.update(interaction.previewPlacement({ type: 'chakri', target: v(i * 0.1, 0, -1), playerPosition: v(0, 0, 0) }));
    }
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    ghost.dispose();
  });
});

describe('interaction rules stay renderer-free', () => {
  const sources = import.meta.glob<string>(['../src/interaction/*.ts', '!../src/interaction/ghost.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it.each(Object.entries(sources))('%s imports neither three nor rapier', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });
});
