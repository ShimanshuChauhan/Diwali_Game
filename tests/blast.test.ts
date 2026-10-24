import { describe, expect, it } from 'vitest';
import { addShock, fillBlast, randomBlastShape } from '../src/audio/blast';

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATE = 44100;

describe('shock wave', () => {
  it('jumps up, falls through zero after its positive phase, swings negative and recovers', () => {
    const data = new Float32Array(RATE * 0.05);
    const width = 0.002;
    addShock(data, RATE, 0, width, 1);
    const at = (seconds: number) => data[Math.round(seconds * RATE)]!;
    expect(at(0.0005)).toBeGreaterThan(0.4);
    expect(at(width * 0.5)).toBeGreaterThan(0);
    expect(at(width * 1.5)).toBeLessThan(0);
    expect(Math.abs(at(width * 5))).toBeLessThan(0.01);
  });
});

describe('shell burst', () => {
  const blast = (seed: number) => {
    const random = seeded(seed);
    const data = new Float32Array(RATE * 3.2);
    fillBlast(data, RATE, random, randomBlastShape(random));
    return data;
  };
  const window = (data: Float32Array, from: number, to: number) => data.subarray(Math.round(from * RATE), Math.round(to * RATE));
  const energy = (data: Float32Array) => data.reduce((sum, v) => sum + v * v, 0) / data.length;
  const crossings = (data: Float32Array) => {
    let count = 0;
    for (let i = 1; i < data.length; i++) if (data[i]! >= 0 !== data[i - 1]! >= 0) count++;
    return count / (data.length / RATE) / 2;
  };

  it('peaks at the shock, right at the start', () => {
    const data = blast(1);
    let peakAt = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i]!) > Math.abs(data[peakAt]!)) peakAt = i;
    expect(peakAt / RATE).toBeLessThan(0.05);
    expect(Math.abs(data[peakAt]!)).toBeCloseTo(0.9);
  });

  it('rolls on for seconds, dying away rather than stopping', () => {
    const data = blast(2);
    const early = energy(window(data, 0.05, 0.55));
    const middle = energy(window(data, 1, 1.5));
    const late = energy(window(data, 2.6, 3.1));
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(early);
    expect(late).toBeLessThan(middle);
    expect(10 * Math.log10(early / late)).toBeGreaterThan(20);
  });

  it('gets duller as the echoes arrive later', () => {
    const data = blast(3);
    expect(crossings(window(data, 1.5, 2.5))).toBeLessThan(crossings(window(data, 0.02, 0.3)) / 2);
  });

  it('never sounds the same twice', () => {
    const a = blast(4);
    const b = blast(5);
    let difference = 0;
    for (let i = 0; i < RATE; i++) difference += (a[i]! - b[i]!) ** 2;
    expect(difference / energy(a.subarray(0, RATE)) / RATE).toBeGreaterThan(0.5);
  });
});
