import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BODY_HOLD,
  CIRCLE_RADIUS,
  CIRCLE_RATE,
  firstPersonThali,
  heldThali,
  stepThali,
  Thali,
  THALI_REST,
  thaliOffset,
  thaliPalm,
  type ThaliMotion,
} from '../src/aarti/thali';
import { BODY } from '../src/people/figure';
import { PlayerCharacter } from '../src/player';

const FRAME = 1 / 60;

function hold(motion: ThaliMotion, circling: boolean, seconds: number): ThaliMotion {
  for (let i = 0; i < Math.round(seconds / FRAME); i++) motion = stepThali(motion, circling, FRAME);
  return motion;
}

describe('thali motion', () => {
  it('rests still until the action is held', () => {
    expect(hold(THALI_REST, false, 2)).toEqual(THALI_REST);
    const offset = thaliOffset(THALI_REST, 0.12);
    expect(Math.hypot(offset.right, offset.up)).toBe(0);
  });

  it('holding grows to a full circle turning at the circle rate', () => {
    const circling = hold(THALI_REST, true, 2);
    expect(circling.sweep).toBeGreaterThan(0.99);
    const later = stepThali(circling, true, 0.1);
    const turned = (later.phase - circling.phase + 2 * Math.PI) % (2 * Math.PI);
    expect(turned).toBeCloseTo(CIRCLE_RATE * 2 * Math.PI * 0.1, 3);
  });

  it('circles clockwise as the holder sees it, starting from the top', () => {
    const r = 0.1;
    const at = (phase: number) => thaliOffset({ phase, sweep: 1 }, r);
    expect(at(0).up).toBeCloseTo(r);
    expect(at(Math.PI / 2).right).toBeCloseTo(r);
    expect(at(Math.PI).up).toBeCloseTo(-r);
    expect(at((3 * Math.PI) / 2).right).toBeCloseTo(-r);
  });

  it('letting go glides back to rest rather than freezing on the circle', () => {
    const circling = hold(THALI_REST, true, 2);
    const easing = hold(circling, false, 0.2);
    expect(easing.sweep).toBeGreaterThan(0);
    expect(easing.sweep).toBeLessThan(circling.sweep);
    expect(easing.phase).not.toBe(circling.phase);
    const rested = hold(easing, false, 3);
    expect(rested.sweep).toBe(0);
    const offset = thaliOffset(rested, 0.12);
    expect(Math.hypot(offset.right, offset.up)).toBe(0);
  });

  it('freezes on a paused frame', () => {
    const circling = hold(THALI_REST, true, 0.5);
    expect(stepThali(circling, true, 0)).toBe(circling);
    expect(stepThali(circling, false, Number.NaN)).toBe(circling);
  });
});

describe('thali presentation — third person', () => {
  const shoulder = new THREE.Vector3(BODY.shoulderX, BODY.shoulderY, 0);

  it('the right hand can carry it all the way round the circle', () => {
    let motion = hold(THALI_REST, true, 2);
    const palm = new THREE.Vector3();
    for (let i = 0; i < 120; i++) {
      motion = stepThali(motion, true, FRAME);
      expect(thaliPalm(motion, palm).distanceTo(shoulder)).toBeLessThan(BODY.upperArm + BODY.forearm);
    }
  });

  it('rests in front of the chest, under the palm, facing the way the player faces', () => {
    const feet = { x: 2, y: 0, z: -1 };
    const ahead = heldThali(feet, 0, THALI_REST);
    expect(ahead.x).toBeCloseTo(feet.x + BODY_HOLD.right);
    expect(ahead.y).toBeCloseTo(BODY_HOLD.up);
    expect(ahead.z).toBeCloseTo(feet.z - BODY_HOLD.forward);
    expect(thaliPalm(THALI_REST, new THREE.Vector3()).y).toBeLessThan(BODY_HOLD.up);
    // Turned to face +X (yaw -π/2), it is in front along +X.
    const turned = heldThali(feet, -Math.PI / 2, THALI_REST);
    expect(turned.x).toBeCloseTo(feet.x + BODY_HOLD.forward);
  });

  it("the drawn character's right palm stays just under the plate as it circles", () => {
    const character = new PlayerCharacter({ mode: 'thirdPerson' });
    const at = { position: { x: 3, y: 0.2, z: -4 }, yaw: 0.9, grounded: true };
    const palm = new THREE.Vector3();
    const hand = new THREE.Vector3();
    let motion = hold(THALI_REST, true, 1);
    for (let i = 0; i < 90; i++) {
      motion = stepThali(motion, true, FRAME);
      character.holdAt(thaliPalm(motion, palm));
      character.update(at, 0, 'thirdPerson', FRAME);
      character.object.updateMatrixWorld(true);
      character.handSocket.getWorldPosition(hand);
      const plate = heldThali(at.position, at.yaw, motion, character.bob);
      expect(Math.hypot(hand.x - plate.x, hand.z - plate.z)).toBeLessThan(1e-3);
      expect(plate.y - hand.y).toBeGreaterThan(0.02);
      expect(plate.y - hand.y).toBeLessThan(0.05);
    }
    // Put down, the hand goes back to the phuljhari hold.
    character.holdAt(null);
    character.update(at, 0, 'thirdPerson', FRAME);
    character.object.updateMatrixWorld(true);
    const socket = character.handSocket.getWorldPosition(hand);
    const expected = character.handPosition(at);
    expect(socket.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z))).toBeLessThan(1e-6);
  });

  it('rides up and down with the body', () => {
    const feet = { x: 0, y: 0, z: 0 };
    expect(heldThali(feet, 0, THALI_REST, 0.01).y - heldThali(feet, 0, THALI_REST).y).toBeCloseTo(0.01);
  });
});

describe('thali presentation — first person', () => {
  function camera(yaw: number, pitch: number) {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1.6, 0);
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    cam.updateMatrixWorld();
    return cam;
  }

  it('sits low and ahead in view, and stays there as the player looks round', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [1.4, 0.3],
      [-2.5, -0.4],
    ] as const) {
      const cam = camera(yaw, pitch);
      const point = firstPersonThali(cam, THALI_REST, new THREE.Vector3());
      const local = cam.worldToLocal(point.clone());
      expect(local.z).toBeLessThan(-0.3); // in front of the eye
      expect(local.y).toBeLessThan(0); // below the centre of view
      expect(Math.abs(local.x)).toBeLessThan(0.1);
    }
  });

  it('circles in the view plane at the first-person radius', () => {
    const cam = camera(0.7, 0.1);
    const rest = cam.worldToLocal(firstPersonThali(cam, THALI_REST, new THREE.Vector3()));
    const top = cam.worldToLocal(firstPersonThali(cam, { phase: 0, sweep: 1 }, new THREE.Vector3()));
    expect(top.y - rest.y).toBeCloseTo(CIRCLE_RADIUS.firstPerson);
    expect(top.z).toBeCloseTo(rest.z);
  });
});

describe('Thali model', () => {
  it('shows only while held, level and facing the given yaw', () => {
    const thali = new Thali();
    expect(thali.object.visible).toBe(false);
    thali.update({ x: 1, y: 1.1, z: 2 }, 0.8, true, FRAME);
    expect(thali.object.visible).toBe(true);
    expect(thali.object.position.toArray()).toEqual([1, 1.1, 2]);
    expect(thali.object.rotation.x).toBe(0);
    expect(thali.object.rotation.y).toBeCloseTo(0.8);
    thali.update({ x: 0, y: 0, z: 0 }, 0, false, FRAME);
    expect(thali.object.visible).toBe(false);
  });

  it('lights its diya with an unlit glowing flame, adding no real light', () => {
    const thali = new Thali();
    const lights: THREE.Object3D[] = [];
    thali.object.traverse((child) => {
      if (child instanceof THREE.Light) lights.push(child);
    });
    expect(lights).toEqual([]);
  });

  it('disposes everything it built and leaves the scene', () => {
    const scene = new THREE.Scene();
    const thali = new Thali();
    scene.add(thali.object);
    let disposed = 0;
    thali.object.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.addEventListener('dispose', () => disposed++);
    });
    thali.dispose();
    expect(disposed).toBeGreaterThan(0);
    expect(thali.object.parent).toBeNull();
  });
});
