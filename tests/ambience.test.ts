import { describe, expect, it } from 'vitest';
import { AMBIENCE, AMBIENT_KINDS, AmbienceScheduler } from '../src/audio/ambience';
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
  const run = (seed: number, seconds: number) => {
    const scheduler = new AmbienceScheduler(seeded(seed));
    const events = [];
    for (let i = 0; i < 60 * seconds; i++) events.push(...scheduler.update(1 / 60));
    return events;
  };

  it('sets off every kind at roughly its configured rate', () => {
    const seconds = 1200;
    const events = run(7, seconds);
    for (const kind of AMBIENT_KINDS) {
      const count = events.filter((e) => e.kind === kind).length;
      const { meanInterval, clusterChance } = AMBIENCE[kind];
      // Clusters add quick follow-ups on top of one per mean interval.
      const expected = seconds / meanInterval / (1 - clusterChance);
      expect(count).toBeGreaterThan(expected * 0.6);
      expect(count).toBeLessThan(expected * 1.5);
    }
  });

  it('includes rockets, fountains, chakris and cheers, not just bangs', () => {
    const kinds = new Set(run(9, 600).map((e) => e.kind));
    for (const kind of ['rocket', 'anar', 'chakri', 'cheer'] as const) expect(kinds).toContain(kind);
  });

  it('places each kind within its distance band, all round the listener', () => {
    for (const event of run(3, 120)) {
      const band = AMBIENCE[event.kind];
      expect(event.distance).toBeGreaterThanOrEqual(band.minDistance);
      expect(event.distance).toBeLessThanOrEqual(band.maxDistance);
      expect(event.intensity).toBeGreaterThan(0);
      expect(event.intensity).toBeLessThanOrEqual(1);
      expect(event.azimuth).toBeGreaterThanOrEqual(0);
      expect(event.azimuth).toBeLessThan(Math.PI * 2);
    }
  });

  it('gives rockets a climb, ladis and fountains a burning time, and single bangs none', () => {
    for (const event of run(5, 300)) {
      const { minDuration, maxDuration } = AMBIENCE[event.kind];
      expect(event.duration).toBeGreaterThanOrEqual(minDuration);
      expect(event.duration).toBeLessThanOrEqual(maxDuration);
    }
    expect(AMBIENCE.rocket.minDuration).toBeGreaterThan(1);
    expect(AMBIENCE.bomb.maxDuration).toBe(0);
  });

  it('bombs come nearer than the far-off pops', () => {
    expect(AMBIENCE.bomb.minDistance).toBeLessThan(AMBIENCE.pop.minDistance);
  });

  it('a long stall yields a bounded catch-up rather than a flood', () => {
    const scheduler = new AmbienceScheduler(seeded(11));
    // A minimum gap of 0.08 s per kind caps a 2 s stall at 25 events each.
    expect(scheduler.update(2).length).toBeLessThanOrEqual(25 * AMBIENT_KINDS.length);
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
