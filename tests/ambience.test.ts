import { describe, expect, it } from 'vitest';
import { AMBIENCE, AmbienceScheduler } from '../src/audio/ambience';
import { fillBrown, fillCrackle, fillWhite } from '../src/audio/noise';

/** Small deterministic LCG so tests are repeatable. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('AmbienceScheduler', () => {
  it('produces irregular pops at roughly the configured rate', () => {
    const scheduler = new AmbienceScheduler(seeded(7));
    let pops = 0;
    for (let i = 0; i < 60 * 120; i++) pops += scheduler.update(1 / 60).length;
    // Clusters add extra pops on top of one per mean interval.
    const expected = 120 / AMBIENCE.meanInterval;
    expect(pops).toBeGreaterThan(expected * 0.7);
    expect(pops).toBeLessThan(expected * 2.5);
  });

  it('places pops far away within the configured band', () => {
    const scheduler = new AmbienceScheduler(seeded(3));
    for (let i = 0; i < 600; i++) {
      for (const pop of scheduler.update(0.1)) {
        expect(pop.distance).toBeGreaterThanOrEqual(AMBIENCE.minDistance);
        expect(pop.distance).toBeLessThanOrEqual(AMBIENCE.maxDistance);
        expect(pop.intensity).toBeGreaterThan(0);
        expect(pop.intensity).toBeLessThanOrEqual(1);
        expect(pop.azimuth).toBeGreaterThanOrEqual(0);
        expect(pop.azimuth).toBeLessThan(Math.PI * 2);
      }
    }
  });

  it('a long stall yields a bounded catch-up rather than a flood', () => {
    const scheduler = new AmbienceScheduler(seeded(11));
    // Minimum gap of 0.08 s caps a 2 s stall at 25 pops.
    expect(scheduler.update(2).length).toBeLessThanOrEqual(25);
  });

  it('ignores negative time', () => {
    const scheduler = new AmbienceScheduler(seeded(1));
    expect(scheduler.update(-100)).toEqual([]);
  });
});

describe('noise generators', () => {
  it('keep every sample within [-1, 1]', () => {
    const random = seeded(5);
    for (const fill of [
      (d: Float32Array) => fillWhite(d, random),
      (d: Float32Array) => fillBrown(d, random),
      (d: Float32Array) => fillCrackle(d, 8000, 90, random),
    ]) {
      const data = new Float32Array(8000);
      fill(data);
      for (const value of data) expect(Math.abs(value)).toBeLessThanOrEqual(1);
      expect(data.some((value) => value !== 0)).toBe(true);
    }
  });

  it('crackle is mostly silence between clicks', () => {
    const data = new Float32Array(8000);
    fillCrackle(data, 8000, 90, seeded(9));
    const silent = data.filter((value) => Math.abs(value) < 0.01).length;
    expect(silent / data.length).toBeGreaterThan(0.5);
  });
});
