import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { PlayerPose } from '../src/core/contracts';
import type { Vec3 } from '../src/core/types';
import {
  bodyVisible,
  forwardFor,
  gaitPose,
  HAND_SOCKET,
  handSocketFor,
  PlayerCharacter,
  REST_GAIT,
  rightFor,
  stepGait,
  type GaitState,
} from '../src/player';
import { IDLE_BOB, MAX_ARM_SWING, MAX_BOB, MAX_LEG_SWING } from '../src/player/gait';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const pose = (position: Vec3, yaw = 0): PlayerPose => ({ position, yaw, grounded: true });

function run(state: GaitState, speed: number, seconds: number, dt = 1 / 60): GaitState {
  for (let t = 0; t < seconds; t += dt) state = stepGait(state, speed, dt);
  return state;
}

function socketWorld(character: PlayerCharacter): Vec3 {
  character.object.updateMatrixWorld(true);
  const p = character.handSocket.getWorldPosition(new THREE.Vector3());
  return v(p.x, p.y, p.z);
}

function expectNear(actual: Vec3, expected: Vec3, digits = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe('gait cycle', () => {
  it('stands still at rest apart from a gentle breath', () => {
    const state = run(REST_GAIT, 0, 3);
    const p = gaitPose(state);
    expect(state.blend).toBe(0);
    expect(p.legSwing).toBeCloseTo(0, 10);
    expect(p.armSwing).toBeCloseTo(0, 10);
    expect(p.bob).toBeGreaterThanOrEqual(0);
    expect(p.bob).toBeLessThanOrEqual(IDLE_BOB);
  });

  it('breathes over time while idle', () => {
    const bobs = new Set<number>();
    let state = REST_GAIT;
    for (let i = 0; i < 120; i++) {
      state = stepGait(state, 0, 1 / 30);
      bobs.add(Math.round(gaitPose(state).bob * 1e5));
    }
    expect(bobs.size).toBeGreaterThan(5);
  });

  it('swings legs and arms in opposition while walking', () => {
    let state = run(REST_GAIT, 2.5, 1);
    let maxLeg = 0;
    for (let i = 0; i < 120; i++) {
      state = stepGait(state, 2.5, 1 / 60);
      const p = gaitPose(state);
      maxLeg = Math.max(maxLeg, Math.abs(p.legSwing));
      if (Math.abs(p.legSwing) > 1e-3) expect(Math.sign(p.armSwing)).toBe(-Math.sign(p.legSwing));
    }
    expect(maxLeg).toBeGreaterThan(0.2);
    expect(maxLeg).toBeLessThanOrEqual(MAX_LEG_SWING);
  });

  it('swings wider and bobs more when running than walking', () => {
    const peak = (speed: number) => {
      let state = run(REST_GAIT, speed, 1);
      let leg = 0;
      let bob = 0;
      for (let i = 0; i < 240; i++) {
        state = stepGait(state, speed, 1 / 120);
        const p = gaitPose(state);
        leg = Math.max(leg, Math.abs(p.legSwing));
        bob = Math.max(bob, p.bob);
      }
      return { leg, bob };
    };
    const walk = peak(2.5);
    const sprint = peak(5);
    expect(sprint.leg).toBeGreaterThan(walk.leg * 1.5);
    expect(sprint.bob).toBeGreaterThan(walk.bob);
    expect(sprint.leg).toBeCloseTo(MAX_LEG_SWING, 1);
    expect(sprint.bob).toBeLessThanOrEqual(MAX_BOB + IDLE_BOB);
  });

  it('cycles faster at higher speeds', () => {
    const walk = stepGait(REST_GAIT, 2.5, 0.1).phase;
    const sprint = stepGait(REST_GAIT, 5, 0.1).phase;
    expect(sprint).toBeCloseTo(walk * 2, 6);
  });

  it('eases back to rest after stopping', () => {
    let state = run(REST_GAIT, 5, 1);
    expect(state.blend).toBeGreaterThan(0.9);
    state = run(state, 0, 2);
    expect(state.blend).toBe(0);
    expect(Math.abs(gaitPose(state).legSwing)).toBeLessThan(1e-9);
  });

  it('ignores bad input', () => {
    const state = run(REST_GAIT, 3, 0.5);
    expect(stepGait(state, 3, 0)).toBe(state);
    expect(stepGait(state, 3, -1)).toBe(state);
    expect(stepGait(state, 3, Number.NaN)).toBe(state);
    const after = stepGait(state, Number.NaN, 1 / 60);
    expect(Number.isFinite(after.phase)).toBe(true);
    expect(after.blend).toBeLessThan(state.blend);
  });

  it('keeps phases bounded', () => {
    const state = run(REST_GAIT, 5, 60, 0.5);
    expect(state.phase).toBeGreaterThanOrEqual(0);
    expect(state.phase).toBeLessThan(2 * Math.PI);
    expect(state.breath).toBeGreaterThanOrEqual(0);
    expect(state.breath).toBeLessThan(2 * Math.PI);
  });

  it('limits the arm swing', () => {
    let state = run(REST_GAIT, 50, 1);
    for (let i = 0; i < 60; i++) {
      state = stepGait(state, 50, 1 / 60);
      expect(Math.abs(gaitPose(state).armSwing)).toBeLessThanOrEqual(MAX_ARM_SWING + 1e-9);
    }
  });
});

describe('visibility by camera mode', () => {
  it('shows the body only in third-person', () => {
    expect(bodyVisible('thirdPerson')).toBe(true);
    expect(bodyVisible('firstPerson')).toBe(false);
  });

  it('starts hidden in the default first-person view', () => {
    expect(new PlayerCharacter().visible).toBe(false);
    expect(new PlayerCharacter({ mode: 'thirdPerson' }).visible).toBe(true);
  });

  it('follows camera switches', () => {
    const character = new PlayerCharacter();
    const at = pose(v(0, 0, 0));
    character.update(at, 0, 'thirdPerson', 1 / 60);
    expect(character.visible).toBe(true);
    character.update(at, 0, 'firstPerson', 1 / 60);
    expect(character.visible).toBe(false);
  });
});

describe('hand socket', () => {
  it('sits forward and to the right of the player, at hand height', () => {
    const feet = v(3, 1, -2);
    for (const yaw of [0, 0.7, Math.PI / 2, -2.4, Math.PI]) {
      const hand = handSocketFor(feet, yaw);
      const offset = v(hand.x - feet.x, hand.y - feet.y, hand.z - feet.z);
      const f = forwardFor(yaw);
      const r = rightFor(yaw);
      expect(offset.x * f.x + offset.z * f.z).toBeCloseTo(HAND_SOCKET.forward, 9);
      expect(offset.x * r.x + offset.z * r.z).toBeCloseTo(HAND_SOCKET.right, 9);
      expect(offset.y).toBeCloseTo(HAND_SOCKET.up, 9);
    }
  });

  it('rises with the body bob', () => {
    expect(handSocketFor(v(0, 0, 0), 0, 0.05).y).toBeCloseTo(HAND_SOCKET.up + 0.05, 9);
  });

  it('matches the hand on the drawn model', () => {
    const character = new PlayerCharacter({ mode: 'thirdPerson' });
    for (const [at, speed] of [
      [pose(v(0, 0, 0), 0), 0],
      [pose(v(4, 2.5, -7), 1.1), 2.5],
      [pose(v(-3, 0, 5), -2.8), 5],
    ] as const) {
      for (let i = 0; i < 17; i++) character.update(at, speed, 'thirdPerson', 1 / 60);
      expectNear(socketWorld(character), character.handPosition(at));
    }
  });

  it('is a child of the model so held items follow it', () => {
    const character = new PlayerCharacter();
    let attached = false;
    character.object.traverse((o) => (attached ||= o === character.handSocket));
    expect(attached).toBe(true);
  });

  it('keeps tracking the hand in first-person, where the body is hidden', () => {
    const character = new PlayerCharacter();
    const at = pose(v(1, 0, 1), 0.3);
    character.update(at, 2.5, 'firstPerson', 1 / 60);
    expect(character.visible).toBe(false);
    expectNear(socketWorld(character), character.handPosition(at));
  });
});

describe('character model', () => {
  it('faces the player yaw and stands on the feet', () => {
    const character = new PlayerCharacter();
    character.update(pose(v(2, 3, 4), 1.2), 0, 'thirdPerson', 1 / 60);
    expect(character.object.position.toArray()).toEqual([2, 3, 4]);
    expect(character.object.rotation.y).toBeCloseTo(1.2, 9);
  });

  it('is built from original procedural meshes in a few festive colours', () => {
    const character = new PlayerCharacter();
    const colours = new Set<string>();
    let meshes = 0;
    character.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      meshes++;
      colours.add((o.material as THREE.MeshStandardMaterial).color.getHexString());
    });
    expect(meshes).toBeGreaterThan(10);
    expect(colours.size).toBeGreaterThanOrEqual(5);
  });

  it('stands about player height', () => {
    const character = new PlayerCharacter();
    character.object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(character.object);
    expect(box.min.y).toBeGreaterThan(-0.1);
    expect(box.max.y).toBeGreaterThan(1.65);
    expect(box.max.y).toBeLessThan(1.9);
  });

  it('returns to rest on reset', () => {
    const character = new PlayerCharacter();
    character.update(pose(v(0, 0, 0)), 5, 'thirdPerson', 0.5);
    expect(character.state.blend).toBeGreaterThan(0);
    character.reset();
    expect(character.state).toEqual(REST_GAIT);
  });

  it('detaches and frees its resources on dispose', () => {
    const scene = new THREE.Scene();
    const character = new PlayerCharacter();
    scene.add(character.object);
    character.dispose();
    expect(character.object.parent).toBeNull();
  });
});
