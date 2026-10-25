import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { BANGER_PEAK, BANGER_SECONDS, fillBanger, randomBangerShape } from '../src/audio/blast';
import { fillLaneRoom } from '../src/audio/noise';
import { LADI_LEVELS, ladiPopLevel, SOUNDS } from '../src/audio/sounds';
import {
  compressorMakeup,
  createNoiseBank,
  LADI_LIMITER,
  LADI_ROOM,
  limiterCurve,
  synthesise,
  type LadiPopSound,
} from '../src/audio/synth';
import { createGameEventBus } from '../src/core/events';
import { qualityProfile } from '../src/core/quality';
import { CRACKER_DEFINITIONS, rollLadiChain } from '../src/crackers';
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

const RATE = 44100;
const db = (linear: number) => 20 * Math.log10(linear);

function banger(seed: number): Float32Array {
  const random = seeded(seed);
  const data = new Float32Array(Math.round(RATE * BANGER_SECONDS));
  fillBanger(data, RATE, random, randomBangerShape(random));
  return data;
}

/** Sum of squares over seconds: a bang's energy at unit gain. */
const energy = (data: Float32Array, rate = RATE) => data.reduce((sum, v) => sum + v * v, 0) / rate;

/** The share of `data`'s energy below `cutoff` Hz (two-pole low-pass). */
function lowShare(data: Float32Array, cutoff: number): number {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
  let a = 0;
  let b = 0;
  let low = 0;
  for (const v of data) {
    a += k * (v - a);
    b += k * (a - b);
    low += b * b;
  }
  return low / RATE / energy(data);
}

describe('ladi banger recording', () => {
  it('starts on its shock: a full-scale spike in the first two samples, then a negative swing', () => {
    for (const seed of [1, 2, 3]) {
      const data = banger(seed);
      let at = 0;
      for (let i = 1; i < data.length; i++) if (Math.abs(data[i]!) > Math.abs(data[at]!)) at = i;
      expect(at).toBeLessThanOrEqual(1);
      expect(data[at]).toBeCloseTo(BANGER_PEAK);
      // The rarefaction right behind the front pulls the air below zero.
      expect(Math.min(...data.subarray(2, Math.round(RATE * 0.002)))).toBeLessThan(-0.05);
    }
  });

  it('is a bright, broadband crack with almost nothing in the bass, so no pop thumps like a drum', () => {
    for (const seed of [4, 5, 6, 7]) {
      const data = banger(seed);
      expect(lowShare(data, 300)).toBeLessThan(0.1);
      // Most of it is well up in the kilohertz.
      expect(lowShare(data, 1500)).toBeLessThan(0.5);
    }
  });

  it('is over within a few dozen milliseconds: nothing in it rings', () => {
    for (const seed of [8, 9, 10, 11]) {
      const data = banger(seed);
      // 1 ms RMS envelope: past 30 ms it never comes back within 20 dB of its peak.
      const window = Math.round(RATE * 0.001);
      const rms = (from: number) => Math.sqrt(energy(data.subarray(from, from + window)) * RATE / window);
      const top = rms(0);
      for (let i = Math.round(RATE * 0.03); i + window <= data.length; i += window) expect(rms(i)).toBeLessThan(top / 10);
      // And the last third is silent but for the odd paper tick.
      expect(energy(data.subarray(Math.round(data.length * 0.6)))).toBeLessThan(energy(data) / 1000);
    }
  });

  it('never bangs the same twice', () => {
    const a = banger(12);
    const b = banger(13);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference += (a[i]! - b[i]!) ** 2;
    expect(difference / RATE / energy(a)).toBeGreaterThan(0.3);
  });
});

describe('lane slapback', () => {
  const left = new Float32Array(Math.round(RATE * LADI_ROOM.seconds));
  const right = new Float32Array(left.length);
  fillLaneRoom(left, right, RATE, LADI_ROOM.seconds, seeded(8));
  const peakIn = (data: Float32Array, from: number, to: number) =>
    Math.max(...Array.from(data.subarray(Math.round(from * RATE), Math.round(to * RATE)), Math.abs));

  it('slaps back off the facing houses about 50 ms later, well above the wash', () => {
    const slap = peakIn(left, 0.045, 0.07);
    expect(slap).toBeGreaterThan(0.2);
    expect(slap).toBeGreaterThan(4 * peakIn(left, 0.2, 0.3));
  });

  it('never booms: next to nothing below 300 Hz', () => {
    expect(lowShare(left, 300)).toBeLessThan(0.1);
    expect(lowShare(right, 300)).toBeLessThan(0.1);
  });

  it('comes back from alternating sides', () => {
    expect(peakIn(right, 0.018, 0.032)).toBeGreaterThan(peakIn(left, 0.018, 0.032));
    expect(peakIn(left, 0.045, 0.065)).toBeGreaterThan(peakIn(right, 0.045, 0.065));
  });

  it('dies away by the end, and no echo outdoes the bang itself', () => {
    expect(peakIn(left, LADI_ROOM.seconds * 0.9, LADI_ROOM.seconds)).toBeLessThan(0.002);
    expect(Math.max(peakIn(left, 0, LADI_ROOM.seconds), peakIn(right, 0, LADI_ROOM.seconds))).toBeLessThan(1);
  });
});

describe('ladi pop levels', () => {
  it('vary from near-duds to the louder bangers', () => {
    const random = seeded(9);
    const normal = Array.from({ length: 400 }, () => ladiPopLevel(false, random));
    const loud = Array.from({ length: 50 }, () => ladiPopLevel(true, random));
    expect(Math.min(...loud)).toBeGreaterThanOrEqual(LADI_LEVELS.loud.min);
    expect(Math.max(...loud)).toBeLessThanOrEqual(1);
    const duds = normal.filter((level) => level <= LADI_LEVELS.dud.max);
    expect(duds.length).toBeGreaterThan(15);
    expect(duds.length).toBeLessThan(80);
    expect(Math.max(...normal)).toBeLessThan(Math.min(...loud));
    expect(new Set(normal.map((l) => l.toFixed(3))).size).toBeGreaterThan(200);
  });
});

describe('ladi voice', () => {
  it('builds two nodes per pop and a fixed few besides, reusing the bank buffers', () => {
    const ctx = new FakeAudioContext();
    const audio = ctx.asAudioContext();
    const bank = createNoiseBank(audio, seeded(1));
    const output = audio.createGain();
    const gainsBefore = ctx.gains.length;
    const buffersBefore = new Set([...bank.bangers, bank.sizzle]);
    const pops: LadiPopSound[] = Array.from({ length: 14 }, (_, i) => ({ at: i * 0.04, level: 0.5 }));
    synthesise(audio, bank, 'ladiPops', output, { t0: 0, duration: 0.8, gain: 1, pops });
    expect(ctx.sources).toHaveLength(pops.length + 1);
    expect(ctx.gains.length - gainsBefore).toBe(pops.length + 1);
    // No buffers made per batch: every source plays one from the bank.
    for (const source of ctx.sources) expect(buffersBefore.has(source.buffer as AudioBuffer)).toBe(true);
  });
});

describe('ladi bus in the engine', () => {
  async function setup() {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({
      bus,
      createContext: () => ctx.asAudioContext(),
      profile: { ...qualityProfile('high'), ambientFireworks: false },
      random: seeded(11),
    });
    await audio.unlock();
    return { bus, ctx, audio };
  }

  /** Every node reachable downstream of `node`, not passing through `blocked`. */
  function downstream(node: unknown, blocked?: unknown): Set<unknown> {
    const seen = new Set<unknown>();
    const stack = [node];
    while (stack.length) {
      const next = stack.pop() as { outputs?: unknown[] };
      for (const out of next.outputs ?? []) {
        if (out !== blocked && !seen.has(out)) {
          seen.add(out);
          stack.push(out);
        }
      }
    }
    return seen;
  }

  function lightLadi(bus: ReturnType<typeof createGameEventBus>, id: string) {
    const chain = rollLadiChain(CRACKER_DEFINITIONS.ladi, seeded(12));
    const position = { x: 0, y: 0, z: -2 };
    bus.emit('crackerActive', { id, type: 'ladi', position, ladi: { chain, heading: 0 } });
    bus.emit('ladiPop', { id, index: 0, banger: 0, position, loud: true });
    return chain;
  }

  it('plays its pops through one shared slapback and limiter, built once', async () => {
    const { bus, ctx } = await setup();
    const compressors = ctx.compressors.length;
    const convolvers = ctx.convolvers.length;
    // The master limiter, the lane echo and the ladi bus's own.
    expect(compressors).toBe(2);
    expect(convolvers).toBe(2);
    lightLadi(bus, 'a');
    lightLadi(bus, 'b');
    expect(ctx.compressors).toHaveLength(compressors);
    expect(ctx.convolvers).toHaveLength(convolvers);

    const limiter = ctx.compressors.find((c) => c.threshold.value === LADI_LIMITER.threshold)!;
    expect(limiter).toBeDefined();
    expect(limiter.knee.value).toBe(0);
    expect(limiter.ratio.value).toBe(LADI_LIMITER.ratio);
    expect(limiter.attack.value).toBeLessThanOrEqual(0.002);
    const room = ctx.convolvers.find((c) => !c.normalize)!;
    expect(room).toBeDefined();

    const ladiPanner = ctx.panners[ctx.panners.length - 1]!;
    const reach = downstream(ladiPanner);
    expect(reach.has(limiter)).toBe(true);
    expect(reach.has(room)).toBe(true);
    expect(reach.has(ctx.destination)).toBe(true);
  });

  it('keeps other crackers off the ladi bus', async () => {
    const { bus, ctx } = await setup();
    bus.emit('crackerActive', { id: 'a', type: 'anar', position: { x: 0, y: 0, z: -2 } });
    const limiter = ctx.compressors.find((c) => c.threshold.value === LADI_LIMITER.threshold)!;
    expect(downstream(ctx.panners[ctx.panners.length - 1]!).has(limiter)).toBe(false);
  });

  it('stays under master volume and mute', async () => {
    const { bus, ctx, audio } = await setup();
    lightLadi(bus, 'a');
    const ladi = downstream(ctx.panners[ctx.panners.length - 1]!);
    audio.setMuted(true);
    const master = ctx.gains.find((g) => g.gain.events.some((e) => e.method === 'setTargetAtTime' && e.args[0] === 0))!;
    expect(master).toBeDefined();
    expect(ladi.has(master)).toBe(true);
    // Every way out to the speakers, dry or through the slapback and lane echo, runs through it.
    expect(downstream(ctx.panners[ctx.panners.length - 1]!, master).has(ctx.destination)).toBe(false);
  });

  it('gives each pop its own varied level', async () => {
    const { bus, ctx } = await setup();
    const chain = lightLadi(bus, 'a');
    const bangs = ctx.sources.filter((s) => !s.loop && (s.buffer as AudioBuffer | null)?.length === Math.round(ctx.sampleRate * BANGER_SECONDS));
    expect(bangs.length).toBeGreaterThan(4);
    const levels = bangs.map((b) => (b.outputs[0] as GainNode).gain.value);
    expect(new Set(levels).size).toBeGreaterThan(3);
    levels.forEach((level, i) => {
      if (chain.pops[i]!.loud) expect(level).toBeGreaterThanOrEqual(LADI_LEVELS.loud.min);
      else expect(level).toBeLessThanOrEqual(LADI_LEVELS.normal.max);
    });
  });
});

describe('ladi gain staging', () => {
  /**
   * The ladi bus's peak level out for a peak level in, dBFS: the limiter's
   * curve, its makeup gain added by the node and taken back out by the trim.
   */
  const busOut = (inDb: number) => limiterCurve(inDb);

  it('takes the compressor makeup gain back out, so duds stay quiet', async () => {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({ bus, createContext: () => ctx.asAudioContext() });
    await audio.unlock();
    expect(ctx.gains.some((g) => g.gain.value === 1 / compressorMakeup())).toBe(true);
    // The Web Audio spec's makeup: (1 / full-range gain) ^ 0.6.
    const fullRange = Math.pow(10, (LADI_LIMITER.threshold + -LADI_LIMITER.threshold / LADI_LIMITER.ratio) / 20);
    expect(compressorMakeup()).toBeCloseTo(Math.pow(1 / fullRange, 0.6), 9);
    // A dud straight ahead (equal-power centre: 0.707 a side) passes untouched.
    const dud = db(SOUNDS.ladiPops.gain * LADI_LEVELS.dud.max * BANGER_PEAK * Math.SQRT1_2);
    expect(dud).toBeLessThan(LADI_LIMITER.threshold);
    expect(busOut(dud)).toBeCloseTo(dud, 9);
  });

  it('drives its loudest bangs into the limiter, and holds them below full scale', () => {
    // A loud bang within ref distance, panned hard to one side (gain 1 on that side).
    const loud = db(SOUNDS.ladiPops.gain * 1 * BANGER_PEAK);
    expect(loud).toBeGreaterThan(LADI_LIMITER.threshold);
    expect(busOut(loud)).toBeLessThan(-2.5);
  });

  it('cannot clip however many bangs pile up', () => {
    // Three ladis at once, each mid-doublet, with the slapback adding as much again.
    const pileUp = db(SOUNDS.ladiPops.gain * BANGER_PEAK * 3 * 2 * (1 + LADI_ROOM.wet));
    expect(busOut(pileUp)).toBeLessThan(-0.5);
  });

  it('carries more energy into each bang than the old paper clicks', () => {
    // The old loudest pop: a white-noise crack (variance 1/3) decaying
    // exponentially to -80 dB over 45 ms, at the old gain of 0.7, plus a
    // narrow 850 Hz body worth well under a fifth of that.
    const tau = 0.045 / Math.log(1e4);
    const oldPop = 0.7 ** 2 * 1.2 * (((1 / 3) * tau) / 2);
    expect(SOUNDS.ladiPops.gain).toBeGreaterThan(0.7 * 4);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      expect(SOUNDS.ladiPops.gain ** 2 * energy(banger(seed))).toBeGreaterThan(2 * oldPop);
    }
  });
});
