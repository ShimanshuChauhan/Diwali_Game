import { describe, expect, it } from 'vitest';
import { fillCrackle, fillLaneImpulse } from '../src/audio/noise';
import { createNoiseBank, synthesise } from '../src/audio/synth';
import type { SoundKind } from '../src/audio/sounds';
import type { BurstPattern } from '../src/core/types';
import { FakeAudioContext } from './fakeAudioContext';

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

interface ParamEvent {
  method: string;
  args: number[];
}

/** Every automation event the sound scheduled on any gain it created. */
function gainEvents(kind: SoundKind, duration: number, pattern?: BurstPattern): ParamEvent[][] {
  const ctx = new FakeAudioContext();
  const audio = ctx.asAudioContext();
  const output = audio.createGain();
  synthesise(audio, createNoiseBank(audio, seeded(1)), kind, output, { t0: 0, duration, gain: 1, pattern });
  return ctx.gains.map((g) => g.gain.events as ParamEvent[]);
}

/** Times of the sharp attacks (exponential ramps up) scheduled on one gain. */
function attacks(events: ParamEvent[]): number[] {
  return events.filter((e, i) => e.method === 'exponentialRampToValueAtTime' && events[i - 1]?.method === 'setValueAtTime').map((e) => e.args[1]!);
}

describe('lane echo', () => {
  const rate = 8000;
  const left = new Float32Array(rate * 1.4);
  const right = new Float32Array(rate * 1.4);
  fillLaneImpulse(left, right, rate, 1.4, seeded(2));

  it('flutters between the walls with echoes about 34 ms apart, alternating sides', () => {
    const strongest = (data: Float32Array, from: number, to: number) => {
      let at = from;
      for (let i = from; i < to; i++) if (Math.abs(data[i]!) > Math.abs(data[at]!)) at = i;
      return at;
    };
    const first = strongest(right, Math.round(0.025 * rate), Math.round(0.045 * rate));
    const second = strongest(left, Math.round(0.06 * rate), Math.round(0.08 * rate));
    expect(first / rate).toBeCloseTo(0.034, 2);
    expect((second - first) / rate).toBeCloseTo(0.034, 2);
    expect(Math.abs(right[first]!)).toBeGreaterThan(Math.abs(left[first]!));
  });

  it('dies away by the end', () => {
    const energy = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += left[i]! ** 2 + right[i]! ** 2;
      return sum;
    };
    const tenth = Math.round(left.length / 10);
    expect(energy(left.length - tenth, left.length)).toBeLessThan(energy(0, tenth) / 100);
  });
});

describe('crackle buffers', () => {
  it('makes sharper clicks with a shorter decay', () => {
    const tail = (decay: number) => {
      const data = new Float32Array(8000);
      fillCrackle(data, 8000, 1, seeded(4), decay);
      // One click: how many samples of it are still audible?
      return data.filter((v) => Math.abs(v) > 0.01).length;
    };
    expect(tail(0.0006)).toBeLessThan(tail(0.0025));
  });
});

describe('cracker sound recipes', () => {
  it('gives a crossette burst a run of pops as its stars split', () => {
    const pops = gainEvents('burst', 3.2, 'crossette')
      .map(attacks)
      .find((times) => times.length >= 10)!;
    expect(pops).toBeDefined();
    for (const t of pops) {
      expect(t).toBeGreaterThan(0.74);
      expect(t).toBeLessThan(1);
    }
  });

  it('gives willows a long glittering tail and peonies only a brief fizz', () => {
    const lastRampOf = (pattern: BurstPattern) =>
      Math.max(
        ...gainEvents('burst', 3.2, pattern).flatMap((events) =>
          events.filter((e) => e.method === 'linearRampToValueAtTime' && e.args[0] === 0).map((e) => e.args[1]!),
        ),
      );
    expect(lastRampOf('willow')).toBeCloseTo(3.2);
    expect(lastRampOf('peony')).toBeLessThan(2);
  });

  it('swells the anar roar along a curve and fades the rocket motor out by the apex', () => {
    const curves = (kind: SoundKind, duration: number) =>
      gainEvents(kind, duration).flat().filter((e) => e.method === 'setValueCurveAtTime');
    expect(curves('anarRoar', 8)).toHaveLength(1);
    expect(curves('anarRoar', 8)[0]!.args).toEqual([0, 8]);
    expect(curves('rocketWhistle', 1.8)[0]!.args).toEqual([0, 1.8]);
  });
});
