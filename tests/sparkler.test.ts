import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_PROFILES } from '../src/core/quality';
import { firstPersonHand, firstPersonStick, heldStick, Sparkler } from '../src/crackers/sparkler';
import { FireworksEffects } from '../src/effects/fireworksEffects';

const UP = new THREE.Vector3(0, 1, 0);
const hand = { x: 1, y: 1, z: 2 };

describe('held phuljhari stick', () => {
  it('is hidden unless held, and sparks from its tip until lit', () => {
    const sparkler = new Sparkler();
    sparkler.update(hand, UP, { held: false, lit: false, progress: 0 });
    expect(sparkler.object.visible).toBe(false);
    sparkler.update(hand, UP, { held: true, lit: false, progress: 0 });
    expect(sparkler.object.visible).toBe(true);
    const tip = sparkler.burningPoint.y - hand.y;
    expect(tip).toBeGreaterThan(0.25);
    sparkler.dispose();
  });

  it('burns down the stick as it burns, stopping short of the handle', () => {
    const sparkler = new Sparkler();
    const heights = [0, 0.5, 1].map((progress) => {
      sparkler.update(hand, UP, { held: true, lit: true, progress });
      return sparkler.burningPoint.y - hand.y;
    });
    expect(heights[0]).toBeGreaterThan(heights[1]!);
    expect(heights[1]).toBeGreaterThan(heights[2]!);
    expect(heights[2]).toBeGreaterThan(0.05);
    sparkler.dispose();
  });

  it('holds the stick up, forward and out to the right in third person', () => {
    const d = heldStick(0, new THREE.Vector3());
    expect(d.length()).toBeCloseTo(1);
    expect(d.y).toBeGreaterThan(0.5);
    expect(d.z).toBeLessThan(0); // facing -Z at yaw 0
    expect(d.x).toBeGreaterThan(0); // the player's right
  });

  it('keeps the hand low and to the right of the view in first person', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.6, -1);
    camera.updateMatrixWorld();
    const at = firstPersonHand(camera, new THREE.Vector3());
    expect(at.x).toBeGreaterThan(0);
    expect(at.y).toBeLessThan(1.6);
    expect(at.z).toBeLessThan(0);
    const stick = firstPersonStick(camera, new THREE.Vector3());
    expect(stick.y).toBeGreaterThan(0.5);
    expect(stick.z).toBeLessThan(0); // leaning away from the eye
  });
});

describe('phuljhari sparks', () => {
  it('stay close to the stick and keep a light on while it burns', () => {
    const bus = createGameEventBus();
    const point = { x: 0, y: 1.2, z: 0 };
    const effects = new FireworksEffects(bus, { quality: QUALITY_PROFILES.medium, handPosition: () => point });
    bus.emit('crackerActive', { id: 'p', type: 'phuljhari', position: point });
    for (let t = 0; t < 1; t += 1 / 60) effects.update(1 / 60);
    const p = effects.engine.particles.positions;
    let farthest = 0;
    for (let i = 0; i < effects.engine.particles.count; i++) {
      farthest = Math.max(farthest, Math.hypot(p[i * 3]! - point.x, p[i * 3 + 1]! - point.y, p[i * 3 + 2]! - point.z));
    }
    expect(effects.engine.particles.count).toBeGreaterThan(50);
    expect(farthest).toBeLessThan(0.9);
    expect(effects.engine.flashes.activeCount).toBeGreaterThan(0);
  });
});
