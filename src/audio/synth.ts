import type { BurstPattern } from '../core/types';
import { BALTI } from '../balti/baltiBlast';
import { FOUNTAIN, surgeFactor } from '../effects/presets';
import { BANGER_SECONDS, fillBanger, fillBlast, randomBangerShape, randomBlastShape } from './blast';
import { fillBrown, fillCrackle, fillLaneImpulse, fillLaneRoom, fillWhite } from './noise';
import { LADI_TAIL, ladiPopLevel, STOP_FADE, type SoundKind } from './sounds';

/**
 * Original synthesised sounds, built from oscillators, filters and the
 * procedural noise buffers in `noise.ts`. No recorded samples are used
 * (PRD → Assets and licensing).
 *
 * Each recipe schedules its nodes on the audio clock from `t0` to `end` and
 * feeds them into the voice's `output` gain, which the engine routes through
 * a panner, which feeds a shared echo of the lane (see `createLaneEcho`).
 */

/** Shared noise buffers, generated once per audio context. */
export interface NoiseBank {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  /** Sparse snaps: burning stars, a fuse's spits. */
  readonly crackle: AudioBuffer;
  /** Dense, tiny clicks: the frying sizzle of a phuljhari. */
  readonly sizzle: AudioBuffer;
  /** Shell bursts, each shaped a little differently; see `blast.ts`. */
  readonly blasts: readonly AudioBuffer[];
  /** A ladi's bangers going off, each shaped a little differently; see `blast.ts`. */
  readonly bangers: readonly AudioBuffer[];
}

/** Burst variants made per context, so no two bursts in a row sound alike. */
const BLAST_VARIANTS = 6;
const BLAST_SECONDS = 3.2;
/** Banger variants made per context, so neighbouring pops differ. */
const BANGER_VARIANTS = 16;

const BANK_SECONDS = 2;

export function createNoiseBank(ctx: BaseAudioContext, random: () => number = Math.random): NoiseBank {
  const make = (fill: (data: Float32Array) => void): AudioBuffer => {
    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * BANK_SECONDS), ctx.sampleRate);
    fill(buffer.getChannelData(0));
    return buffer;
  };
  return {
    white: make((data) => fillWhite(data, random)),
    brown: make((data) => fillBrown(data, random)),
    crackle: make((data) => fillCrackle(data, ctx.sampleRate, 90, random)),
    sizzle: make((data) => fillCrackle(data, ctx.sampleRate, 1400, random, 0.0006)),
    blasts: Array.from({ length: BLAST_VARIANTS }, () => {
      const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * BLAST_SECONDS), ctx.sampleRate);
      fillBlast(buffer.getChannelData(0), ctx.sampleRate, random, randomBlastShape(random));
      return buffer;
    }),
    bangers: Array.from({ length: BANGER_VARIANTS }, () => {
      const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * BANGER_SECONDS), ctx.sampleRate);
      fillBanger(buffer.getChannelData(0), ctx.sampleRate, random, randomBangerShape(random));
      return buffer;
    }),
  };
}

/** Seconds the lane's echo takes to die away. */
const ECHO_SECONDS = 1.4;

/**
 * The lane's echo: a convolver with a street-canyon impulse response. The
 * engine sends the effects through it alongside the dry signal.
 */
export function createLaneEcho(ctx: BaseAudioContext, random: () => number = Math.random): ConvolverNode {
  const length = Math.round(ctx.sampleRate * ECHO_SECONDS);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  fillLaneImpulse(impulse.getChannelData(0), impulse.getChannelData(1), ctx.sampleRate, ECHO_SECONDS, random);
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  return convolver;
}

/**
 * The ladi bus's limiter. Its threshold is low enough that the louder bangs
 * and pile-ups drive into it (that is what makes the rattle sound loud and
 * dense), its attack is instant so no crack slips past, and it lets go
 * within a pop or two.
 */
export const LADI_LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.03 } as const;
/**
 * Soft safety clip after the limiter: linear below `knee`, rounding off to
 * `ceiling` at full scale. A bang's two-sample shock front is too fast for
 * the limiter to catch; this only shaves those tips, never the body.
 */
export const LADI_CLIP = { knee: 0.6, ceiling: 0.86 } as const;

/** The soft-clip transfer curve for input in [-1, 1]; input beyond clamps to the ends. */
export function ladiClipCurve(samples = 1025): Float32Array<ArrayBuffer> {
  const { knee, ceiling } = LADI_CLIP;
  const room = ceiling - knee;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/** The lane's slapback against the dry bangs, and how long its wash lasts. */
export const LADI_ROOM = { wet: 0.8, seconds: 0.45 } as const;

/** Level out of a compressor of `limiter`'s settings (hard knee) for a level in, dBFS, before makeup gain. */
export function limiterCurve(db: number, limiter: { readonly threshold: number; readonly ratio: number } = LADI_LIMITER): number {
  return db <= limiter.threshold ? db : limiter.threshold + (db - limiter.threshold) / limiter.ratio;
}

/**
 * The makeup gain a `DynamicsCompressorNode` adds on its own (Web Audio
 * spec: the full-range gain's inverse, to the power 0.6). The ladi bus
 * takes it back out, so quiet pops stay quiet and only the peaks are held.
 */
export function compressorMakeup(limiter: { readonly threshold: number; readonly ratio: number } = LADI_LIMITER): number {
  const fullRange = Math.pow(10, limiterCurve(0, limiter) / 20);
  return Math.pow(1 / fullRange, 0.6);
}

/**
 * Where a near ladi's voices play: the lane's slapback (a convolver with a
 * short, synthesised room, built once) mixed with the dry bangs, then a
 * limiter and a soft safety clip, into `output`. Built once per context and shared by every ladi,
 * so pops never add nodes beyond their own.
 */
export function createLadiBus(ctx: BaseAudioContext, output: AudioNode, random: () => number = Math.random): GainNode {
  const input = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LADI_LIMITER.threshold;
  limiter.knee.value = LADI_LIMITER.knee;
  limiter.ratio.value = LADI_LIMITER.ratio;
  limiter.attack.value = LADI_LIMITER.attack;
  limiter.release.value = LADI_LIMITER.release;
  input.connect(limiter);

  const length = Math.round(ctx.sampleRate * LADI_ROOM.seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  fillLaneRoom(impulse.getChannelData(0), impulse.getChannelData(1), ctx.sampleRate, LADI_ROOM.seconds, random);
  const room = ctx.createConvolver();
  // The impulse's levels are the echo's own; don't let the node rescale them.
  room.normalize = false;
  room.buffer = impulse;
  const wet = ctx.createGain();
  wet.gain.value = LADI_ROOM.wet;
  input.connect(room).connect(wet).connect(limiter);

  const trim = ctx.createGain();
  trim.gain.value = 1 / compressorMakeup();
  const clip = ctx.createWaveShaper();
  clip.curve = ladiClipCurve();
  limiter.connect(trim).connect(clip).connect(output);
  return input;
}

/** A scheduled sound: its sources and the gain that shapes and silences it. */
export interface SynthVoice {
  readonly output: GainNode;
  readonly sources: readonly AudioScheduledSourceNode[];
  readonly end: number;
}

export interface SynthParams {
  readonly t0: number;
  /** Seconds the sound lasts; one-shot recipes ignore it. */
  readonly duration: number;
  /** Peak linear gain. */
  readonly gain: number;
  /** Distant pops: metres away, dulls the sound. */
  readonly distance?: number;
  /** Bursts: the shell's pattern, which shapes its tail. */
  readonly pattern?: BurstPattern;
  /** Ladi pops: seconds after `t0` (ascending) and relative loudness, 0–1. */
  readonly pops?: readonly LadiPopSound[];
  /** The balti: what part of it hits the ground. */
  readonly contact?: BaltiContact;
  /** The balti: how hard it lands, 0–1. */
  readonly strength?: number;
  /** The balti: its tumble end over end, rad/s. */
  readonly spin?: number;
  /** The balti: how fast it rolls away, m/s. */
  readonly speed?: number;
}

/** What part of the balti meets the ground (see `src/balti`). */
export type BaltiContact = 'rim' | 'base' | 'side';

export interface LadiPopSound {
  readonly at: number;
  readonly level: number;
}

type Recipe = (b: VoiceBuilder, p: SynthParams) => void;

/** Build `kind` into `output`. The caller owns routing `output` onward. */
export function synthesise(
  ctx: BaseAudioContext,
  bank: NoiseBank,
  kind: SoundKind,
  output: GainNode,
  params: SynthParams,
): SynthVoice {
  const end = params.t0 + Math.max(0.05, params.duration);
  const builder = new VoiceBuilder(ctx, bank, output, params.t0, end);
  RECIPES[kind](builder, params);
  return { output, sources: builder.sources, end };
}

/** Fade out now and stop every source shortly after. Safe to call twice. */
export function silence(voice: SynthVoice, now: number): void {
  const gain = voice.output.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(0, now + STOP_FADE);
  for (const source of voice.sources) {
    try {
      source.stop(now + STOP_FADE + 0.01);
    } catch {
      // Already stopped: nothing to do.
    }
  }
}

class VoiceBuilder {
  readonly sources: AudioScheduledSourceNode[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    readonly bank: NoiseBank,
    readonly output: GainNode,
    readonly t0: number,
    readonly end: number,
  ) {}

  /** Looping noise from a random offset, so overlapping voices differ. */
  noise(buffer: AudioBuffer, start = this.t0, stop = this.end, rate = 1): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rate;
    source.start(start, Math.random() * buffer.duration);
    // An endless bed (the murmur) has no scheduled stop.
    if (Number.isFinite(stop)) source.stop(stop);
    this.sources.push(source);
    return source;
  }

  /**
   * One shell burst, played once from `at`, pitched by `rate` (around 1)
   * so a reused variant still sounds new.
   */
  blast(at: number, rate: number): AudioBufferSourceNode {
    const blasts = this.bank.blasts;
    const source = this.ctx.createBufferSource();
    source.buffer = blasts[Math.floor(Math.random() * blasts.length)] ?? null;
    source.playbackRate.value = rate;
    source.start(at);
    source.stop(Math.min(this.end, at + BLAST_SECONDS / rate));
    this.sources.push(source);
    return source;
  }

  /**
   * One ladi banger, played once from `at` at `rate` (kept within a few
   * percent of 1: a bang has no pitch to vary).
   */
  banger(at: number, rate: number): AudioBufferSourceNode {
    const bangers = this.bank.bangers;
    const source = this.ctx.createBufferSource();
    source.buffer = bangers[Math.floor(Math.random() * bangers.length)] ?? null;
    source.playbackRate.value = rate;
    source.start(at);
    source.stop(Math.min(this.end, at + BANGER_SECONDS / rate));
    this.sources.push(source);
    return source;
  }

  osc(type: OscillatorType, frequency: number, start = this.t0, stop = this.end): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    osc.start(start);
    if (Number.isFinite(stop)) osc.stop(stop);
    this.sources.push(osc);
    return osc;
  }

  filter(type: BiquadFilterType, frequency: number, q = 1): BiquadFilterNode {
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    return filter;
  }

  gain(value: number): GainNode {
    const gain = this.ctx.createGain();
    gain.gain.value = value;
    return gain;
  }

  /** Connect nodes in series. */
  chain(...nodes: AudioNode[]): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  }

  /** Sine/other LFO of `depth` added onto `param`. */
  lfo(param: AudioParam, rate: number, depth: number, type: OscillatorType = 'sine'): void {
    const lfo = this.osc(type, rate);
    const amount = this.gain(depth);
    lfo.connect(amount);
    amount.connect(param);
  }

  /**
   * Slow, irregular wobble of `depth` added onto `param`: brown noise played
   * far below speed, so it drifts rather than oscillates.
   */
  wander(param: AudioParam, depth: number, rate = 0.04): void {
    const amount = this.gain(depth);
    this.chain(this.noise(this.bank.brown, this.t0, this.end, rate), amount);
    amount.connect(param);
  }

  /** Follow `shape(seconds since t0)` over the whole voice, sampled `rate` times a second. */
  follow(param: AudioParam, shape: (age: number) => number, rate = 30): void {
    const duration = this.end - this.t0;
    const count = Math.max(2, Math.ceil(duration * rate) + 1);
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) values[i] = shape((i / (count - 1)) * duration);
    param.setValueCurveAtTime(values, this.t0, duration);
  }

  /** A run of short hits on `param`, one at each of `times` (ascending). */
  hits(param: AudioParam, times: readonly number[], peak: number, decay: number): void {
    param.setValueAtTime(0.0001, this.t0);
    for (const at of times) {
      param.setValueAtTime(0.0001, at);
      param.exponentialRampToValueAtTime(Math.max(0.0002, peak * (0.6 + 0.4 * Math.random())), at + 0.003);
      param.exponentialRampToValueAtTime(0.0001, at + decay);
    }
  }

  /** `t`, but never past the voice's end. */
  until(t: number): number {
    return Math.min(this.end, t);
  }

  /**
   * The steel balti struck at `at`: its shell's inharmonic modes (see
   * `BALTI_MODES`), the lowest few as close pairs that beat, since a pressed
   * pail is never quite round. `bright` weights the upper modes (around 1;
   * a sharp rim strike rings bright, a flat slap on the base dull), `decay`
   * scales how long it rings. Into `into`, by default the voice's output.
   */
  steel(at: number, peak: number, decay: number, bright: number, into: AudioNode = this.output): void {
    const last = BALTI_MODES.length - 1;
    for (let k = 0; k <= last; k++) {
      const mode = BALTI_MODES[k]!;
      const tilt = 1 + (bright - 1) * (k / last);
      const top = Math.max(0.0002, peak * mode.level * Math.max(0.05, tilt));
      const fade = this.until(at + Math.max(0.03, decay * mode.decay));
      if (fade <= at + 0.004) continue;
      const pair = k < BALTI_SPLIT_MODES ? 2 : 1;
      const level = this.gain(0);
      level.gain.setValueAtTime(0.0001, this.t0);
      level.gain.setValueAtTime(0.0001, at);
      level.gain.exponentialRampToValueAtTime(top / pair, at + 0.002);
      level.gain.exponentialRampToValueAtTime(0.0001, fade);
      level.connect(into);
      const f = mode.frequency * (0.985 + Math.random() * 0.03);
      for (let j = 0; j < pair; j++) {
        // The split pair a few hertz apart, beating as it dies.
        const split = pair === 2 ? (j === 0 ? -1 : 1) * f * BALTI_MODE_SPLIT : 0;
        this.osc('sine', f + split, at, fade).connect(level);
      }
    }
  }

  /**
   * The steel balti landing on stone. A pressed rim is never quite flat,
   * so it comes down at a few points in quick succession (`strikes`, each
   * a time and a weight), and every strike rings the same shell again
   * rather than starting a fresh one. Where it lands sets which modes
   * sound (a strike near a mode's node barely moves it), so no two
   * landings ring alike. The shell's main modes sit `body` lower than the
 * blast's ring (that rings the base; this, the whole pail). Above them sits a crowd of thin,
   * quick ones that make steel sound like steel and not a bell, and a hard
   * hit bends the low modes sharp for a moment before they settle.
   */
  clank(strikes: readonly (readonly [number, number])[], peak: number, decay: number, bright: number, hard: number): void {
    if (strikes.length === 0) return;
    const first = strikes[0]![0];
    const where = Math.random() * Math.PI;
    const modes: { frequency: number; level: number; decay: number }[] = BALTI_MODES.map((mode) => ({ ...mode }));
    for (let k = 0; k < BALTI_CLANK.crowd; k++) {
      const frequency = BALTI_CLANK.crowdFrom * Math.pow(BALTI_CLANK.crowdTo / BALTI_CLANK.crowdFrom, Math.random());
      modes.push({ frequency, level: BALTI_CLANK.crowdLevel * (0.5 + Math.random()), decay: 0.05 + Math.random() * 0.1 });
    }
    const last = modes.length - 1;
    for (let k = 0; k <= last; k++) {
      const mode = modes[k]!;
      const tilt = Math.max(0.05, 1 + (bright - 1) * Math.min(1, mode.frequency / 4200));
      const struck = 0.3 + 0.7 * Math.abs(Math.sin((k + 1) * where));
      const top = peak * mode.level * tilt * struck;
      const fade = Math.max(0.03, decay * mode.decay);
      const stop = this.until(strikes[strikes.length - 1]![0] + fade * 1.5);
      if (top < 0.0003 || stop <= first + 0.004) continue;
      const level = this.gain(0);
      level.gain.setValueAtTime(0, this.t0);
      for (const [at, weight] of strikes) {
        level.gain.setTargetAtTime(top * weight, at, 0.0006);
        level.gain.setTargetAtTime(0, at + 0.003, fade / 4.6);
      }
      level.connect(this.output);
      // A landing rings the whole heavy shell, lower than the blast's quick ring off the base.
      const f = mode.frequency * (k < BALTI_MODES.length ? BALTI_CLANK.body : 1) * (0.985 + Math.random() * 0.03);
      const pair = k < BALTI_SPLIT_MODES ? 2 : 1;
      for (let j = 0; j < pair; j++) {
        const split = pair === 2 ? (j === 0 ? -1 : 1) * f * BALTI_MODE_SPLIT : 0;
        const osc = this.osc('sine', f + split, first, stop);
        if (k < BALTI_SPLIT_MODES && hard > 0.3) {
          osc.frequency.setValueAtTime((f + split) * (1 + BALTI_CLANK.bend * hard), first);
          osc.frequency.exponentialRampToValueAtTime(f + split, this.until(first + 0.08));
        }
        osc.connect(level);
      }
    }
    // The rough edge round the ring: noise caught in the loudest modes.
    for (const k of [1, 2, 3]) {
      const sizzle = this.gain(0);
      sizzle.gain.setValueAtTime(0, this.t0);
      for (const [at, weight] of strikes) {
        sizzle.gain.setTargetAtTime(BALTI_CLANK.sizzle * peak * weight * bright, at, 0.0006);
        sizzle.gain.setTargetAtTime(0, at + 0.003, 0.025);
      }
      const stop = this.until(strikes[strikes.length - 1]![0] + 0.2);
      this.chain(this.noise(this.bank.white, first, stop), this.filter('bandpass', BALTI_MODES[k]!.frequency * BALTI_CLANK.body, 18), sizzle, this.output);
    }
  }

  /** A short burst of filtered noise peaking at `peak` from `at`, gone after `decay`. */
  burst(buffer: AudioBuffer, at: number, peak: number, decay: number, filter: BiquadFilterNode, into: AudioNode = this.output): void {
    const stop = this.until(at + decay + 0.02);
    if (stop <= at) return;
    const level = this.gain(0);
    level.gain.setValueAtTime(0.0001, this.t0);
    this.hit(level.gain, peak, at, Math.max(0.01, Math.min(decay, stop - at)));
    this.chain(this.noise(buffer, at, stop), filter, level, into);
  }

  /**
   * A firecracker's bang heard across town: a sharp broadband crack, then
   * the same crack coming back off buildings a few times, each later echo
   * quieter and duller, over a rolling, unpitched rumble.
   */
  bang(at: number, peak: number, distance: number | undefined, echoes = 4): void {
    const crack = this.gain(0);
    crack.gain.setValueAtTime(0.0001, this.t0);
    crack.gain.setValueAtTime(0.0001, at);
    crack.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    crack.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    this.chain(this.noise(this.bank.white, at, at + 0.12), this.filter('lowpass', muffle(distance, 7000), 0.6), crack, this.output);

    // Reflections: a rolling "crack-k-k" off the buildings around it.
    const echo = this.gain(0);
    echo.gain.setValueAtTime(0.0001, this.t0);
    let when = at;
    for (let k = 1; k <= echoes; k++) {
      when += 0.07 + Math.random() * 0.16;
      const level = peak * 0.55 * Math.pow(0.55, k - 1);
      echo.gain.setValueAtTime(0.0001, when);
      echo.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), when + 0.004);
      echo.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    }
    this.chain(this.noise(this.bank.white, at, when + 0.2), this.filter('lowpass', muffle(distance, 2400), 0.6), echo, this.output);

    // Rumble: broadband and slow to die, never a pitched thump.
    const rumble = this.gain(0);
    rumble.gain.setValueAtTime(0, this.t0);
    rumble.gain.setValueAtTime(0, at);
    rumble.gain.linearRampToValueAtTime(peak * 0.28, at + 0.03);
    rumble.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);
    this.chain(this.noise(this.bank.white, at, at + 1.5), this.filter('lowpass', muffle(distance, 900), 0.5), rumble, this.output);
  }

  /** Attack to `peak`, hold, then release so the voice ends silent at `end`. */
  sustain(param: AudioParam, peak: number, attack: number, release: number): void {
    const releaseAt = Math.max(this.t0 + attack, this.end - release);
    param.setValueAtTime(0, this.t0);
    param.linearRampToValueAtTime(peak, this.t0 + attack);
    param.setValueAtTime(peak, releaseAt);
    param.linearRampToValueAtTime(0, this.end);
  }

  /** Near-instant hit decaying exponentially over `decay`. */
  hit(param: AudioParam, peak: number, at: number, decay: number): void {
    param.setValueAtTime(0.0001, at);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.004);
    param.exponentialRampToValueAtTime(0.0001, at + decay);
  }
}

/** Stars of a crossette split this long after the burst (see its pattern). */
const CROSSETTE_SPLIT = 0.75;
const CROSSETTE_STARS = 12;

const RECIPES: Record<SoundKind, Recipe> = {
  /** An irregular fizz with spits, like a real fuse eating its way in. */
  fuseHiss(b, p) {
    b.sustain(b.output.gain, p.gain, 0.03, 0.08);
    const fizz = b.gain(0.5);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 5200, 0.8), fizz, b.output);
    b.wander(fizz.gain, 0.35, 0.08);
    const spits = b.gain(0.6);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.2), b.filter('bandpass', 3000, 1.1), spits, b.output);
  },

  /** A dense, frying sizzle with brighter pops, close to the ear. */
  phuljhariCrackle(b, p) {
    b.sustain(b.output.gain, p.gain, 0.15, 0.5);
    const sizzle = b.gain(0.55);
    b.chain(b.noise(b.bank.sizzle), b.filter('highpass', 2500, 0.7), sizzle, b.output);
    b.wander(sizzle.gain, 0.25, 0.1);
    const air = b.gain(0.15);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 7000, 0.7), air, b.output);
    const pops = b.gain(0.35);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.8), b.filter('bandpass', 4000, 1), pops, b.output);
  },

  /**
   * A jet-like roar that swells and dips with the fountain (same surge as
   * its sparks), over a low rumble, with sizzle and crackling pops.
   */
  anarRoar(b, p) {
    b.sustain(b.output.gain, p.gain, 0.35, 1);
    const swell = b.gain(1);
    swell.connect(b.output);
    const surge = FOUNTAIN.surge;
    if (surge) b.follow(swell.gain, (age) => Math.pow(surgeFactor(surge, age), 1.6));
    const roar = b.gain(0.7);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 1700, 0.55), roar, swell);
    const rumble = b.gain(0.4);
    b.chain(b.noise(b.bank.brown, b.t0, b.end, 1.3), b.filter('lowpass', 380, 0.7), rumble, swell);
    const sizzle = b.gain(0.18);
    b.chain(b.noise(b.bank.sizzle), b.filter('highpass', 5000, 0.7), sizzle, swell);
    const pops = b.gain(0.35);
    b.chain(b.noise(b.bank.crackle), b.filter('bandpass', 3500, 1), pops, b.output);
  },

  /**
   * A hissing whirr pulsing with the spin (two jets at four turns a second),
   * its brightness sweeping as the jets face towards and away, after a
   * short spin-up.
   */
  chakriWhine(b, p) {
    b.sustain(b.output.gain, p.gain, 0.25, 0.6);
    const pulse = b.gain(0.6);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 3000, 1.2), pulse, b.output);
    const spin = b.osc('sine', 2);
    spin.frequency.setValueAtTime(2, b.t0);
    spin.frequency.linearRampToValueAtTime(8, b.t0 + 0.5);
    const depth = b.gain(0.4);
    b.chain(spin, depth);
    depth.connect(pulse.gain);
    const sweep = b.filter('bandpass', 3000, 1.2);
    b.lfo(sweep.frequency, 4, 900);
    const whirr = b.gain(0.35);
    b.chain(b.noise(b.bank.white), sweep, whirr, b.output);
    const hiss = b.gain(0.22);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 5500), hiss, b.output);
    const pops = b.gain(0.25);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.4), b.filter('bandpass', 3500, 1), pops, b.output);
    // A faint whistle from the spinning nozzle.
    const whistle = b.osc('sine', 2200);
    b.lfo(whistle.frequency, 4, 140);
    b.chain(whistle, b.gain(0.04), b.output);
  },

  /**
   * A whoosh off the ground, then a whistle rising in pitch that fades out
   * with the motor as the rocket slows to its apex (its speed falls off
   * linearly, as in `rocketFlightAt`).
   */
  rocketWhistle(b, p) {
    b.output.gain.value = p.gain;
    const duration = b.end - b.t0;
    const launch = b.gain(0);
    b.hit(launch.gain, 0.9, b.t0, 0.45);
    const lift = b.filter('bandpass', 900, 0.9);
    lift.frequency.setValueAtTime(900, b.t0);
    lift.frequency.exponentialRampToValueAtTime(3200, b.t0 + 0.35);
    b.chain(b.noise(b.bank.white, b.t0, b.t0 + 0.5), lift, launch, b.output);

    // The motor: loud while it pushes, gone by the apex.
    const motor = b.gain(0);
    motor.connect(b.output);
    b.follow(motor.gain, (age) => {
      const u = Math.min(1, age / duration);
      return Math.max(0, 1 - u * u * u) * Math.min(1, age / 0.05);
    });
    const whistle = b.osc('triangle', 1500);
    whistle.frequency.setValueAtTime(1500, b.t0);
    whistle.frequency.exponentialRampToValueAtTime(3400, b.end);
    b.lfo(whistle.frequency, 24, 40);
    b.chain(whistle, b.filter('lowpass', 5000, 0.7), b.gain(0.45), motor);
    const hiss = b.gain(0.4);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 4200, 0.8), hiss, motor);
  },

  /**
   * A sharp crack and deep boom that ring off the lane, then a tail that
   * matches the shell: crossettes crackle as their stars split, willows and
   * palms hiss with glitter, others fizz briefly as their stars burn out.
   */
  burst(b, p) {
    b.output.gain.value = p.gain;
    // The burst itself: a shock wave and its echoes off the lane (see `blast.ts`).
    const body = b.gain(1);
    b.chain(b.blast(b.t0, 0.9 + Math.random() * 0.2), b.filter('lowpass', 11000, 0.5), body, b.output);

    const pattern = p.pattern ?? 'peony';
    if (pattern === 'crossette') {
      // One sharp pop per star as it splits.
      const pops = b.gain(0);
      const times: number[] = [];
      for (let i = 0; i < CROSSETTE_STARS; i++) times.push(b.t0 + CROSSETTE_SPLIT + Math.random() * 0.18);
      times.sort((x, y) => x - y);
      b.hits(pops.gain, times, 0.45, 0.07);
      b.chain(b.noise(b.bank.white, b.t0 + CROSSETTE_SPLIT - 0.05), b.filter('bandpass', 2200, 0.9), pops, b.output);
    } else if (pattern === 'willow' || pattern === 'palm') {
      // Glittering stars hissing as they hang and fall.
      const glitter = b.gain(0);
      const from = b.t0 + 0.4;
      glitter.gain.setValueAtTime(0, from);
      glitter.gain.linearRampToValueAtTime(0.32, from + 0.5);
      glitter.gain.linearRampToValueAtTime(0, b.end);
      b.chain(b.noise(b.bank.sizzle, from), b.filter('bandpass', 5500, 0.8), glitter, b.output);
      const snaps = b.gain(0);
      snaps.gain.setValueAtTime(0, from);
      snaps.gain.linearRampToValueAtTime(0.2, from + 0.5);
      snaps.gain.linearRampToValueAtTime(0, b.end);
      b.chain(b.noise(b.bank.crackle, from), b.filter('bandpass', 3200, 0.9), snaps, b.output);
    } else {
      // A brief fizz as the stars burn out.
      const fizz = b.gain(0);
      const from = b.t0 + 0.3;
      fizz.gain.setValueAtTime(0, from);
      fizz.gain.linearRampToValueAtTime(0.14, from + 0.3);
      fizz.gain.linearRampToValueAtTime(0, from + 1.4);
      b.chain(b.noise(b.bank.crackle, from, from + 1.4), b.filter('bandpass', 3000, 0.8), fizz, b.output);
    }
  },

  /**
   * A batch of a near ladi's bangers going off: each pop one of the banger
   * recordings (an impulse and a few milliseconds of broadband crack), at
   * exactly the time given and as loud as its level, over the faint fizz of
   * the fuse running between them. The ladi bus's slapback smears the
   * rattle into one crackling chatter.
   *
   * Two nodes per pop (its source and level), three for the fizz.
   */
  ladiPops(b, p) {
    b.output.gain.value = p.gain;
    for (const pop of p.pops ?? []) {
      const level = b.gain(pop.level);
      b.chain(b.banger(b.t0 + pop.at, bangerRate()), level, b.output);
    }
    // Last, so the voice lets go of its nodes once the fizz stops at the end.
    const fizz = b.gain(0.06);
    b.chain(b.noise(b.bank.sizzle, b.t0, b.end, 0.8), b.filter('bandpass', 4500, 0.8), fizz, b.output);
  },

  /** A small cracker going off far across town: a short crack with a little echo. */
  distantPop(b, p) {
    b.output.gain.value = p.gain;
    b.bang(b.t0, 0.8, p.distance, 2);
  },

  /** A ground bomb nearby or across town: a hard crack rolling off the houses. */
  distantBomb(b, p) {
    b.output.gain.value = p.gain;
    b.bang(b.t0, 1, p.distance, 5);
  },

  /**
   * A ladi down the street: the same bangers rattling off, bursts of rapid
   * pops with stumbles, the odd doublet and louder one, until it burns out,
   * duller with distance and smeared into a wash off the walls around it.
   */
  distantLadi(b, p) {
    b.output.gain.value = p.gain;
    const burning = Math.max(0.3, b.end - b.t0 - LADI_TAIL);
    // One level for the whole string, stepped at each pop: at this distance
    // a pop's tail taking the next one's level is lost in the smear.
    const snaps = b.gain(0);
    snaps.gain.setValueAtTime(0, b.t0);
    b.chain(snaps, b.filter('lowpass', muffle(p.distance, 5000), 0.6), b.output);
    for (let t = b.t0 + 0.02; t < b.t0 + burning; ) {
      const level = ladiPopLevel(Math.random() < LADI_LOUD_CHANCE, Math.random);
      snaps.gain.setValueAtTime(level, t);
      b.banger(t, bangerRate()).connect(snaps);
      // Mostly a fast rattle, now and then a doublet or a stumble.
      const roll = Math.random();
      t += roll < 0.08 ? 0.006 + Math.random() * 0.012 : roll < 0.2 ? 0.12 + Math.random() * 0.2 : 0.035 + Math.random() * 0.06;
    }
    const wash = b.gain(0);
    wash.gain.setValueAtTime(0, b.t0);
    wash.gain.linearRampToValueAtTime(0.18, b.t0 + 0.3);
    wash.gain.setValueAtTime(0.18, b.t0 + burning);
    wash.gain.linearRampToValueAtTime(0, b.end);
    b.chain(b.noise(b.bank.crackle), b.filter('lowpass', muffle(p.distance, 2500), 0.6), wash, b.output);
  },

  /** A shell bursting over another part of town: the same blast, duller with distance, sometimes a crackle. */
  distantShell(b, p) {
    b.output.gain.value = p.gain;
    const body = b.gain(1);
    b.chain(b.blast(b.t0, 0.85 + Math.random() * 0.25), b.filter('lowpass', muffle(p.distance, 7000), 0.5), body, b.output);
    if (Math.random() < 0.45) {
      const crackle = b.gain(0);
      const from = b.t0 + 0.35;
      crackle.gain.setValueAtTime(0, from);
      crackle.gain.linearRampToValueAtTime(0.3, from + 0.3);
      crackle.gain.linearRampToValueAtTime(0, b.end);
      b.chain(b.noise(b.bank.crackle, from), b.filter('lowpass', muffle(p.distance, 3500), 0.7), crackle, b.output);
    }
  },

  /** A rocket going up elsewhere: a whistle climbing in pitch, fading as it rises away. */
  distantWhistle(b, p) {
    b.output.gain.value = p.gain;
    const motor = b.gain(0);
    motor.gain.setValueAtTime(0, b.t0);
    motor.gain.linearRampToValueAtTime(1, b.t0 + 0.08);
    motor.gain.linearRampToValueAtTime(0, b.end);
    motor.connect(b.output);
    const pitch = 1100 + Math.random() * 500;
    const whistle = b.osc('triangle', pitch);
    whistle.frequency.setValueAtTime(pitch, b.t0);
    whistle.frequency.exponentialRampToValueAtTime(pitch * 2.2, b.end);
    b.lfo(whistle.frequency, 22, 30);
    b.chain(whistle, b.filter('lowpass', muffle(p.distance, 5000), 0.7), b.gain(0.5), motor);
    const hiss = b.gain(0.35);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 3500, 0.8), b.filter('lowpass', muffle(p.distance, 6000), 0.7), hiss, motor);
  },

  /** An anar burning in someone else's courtyard: a muffled, swelling rush. */
  distantFountain(b, p) {
    b.sustain(b.output.gain, p.gain, 0.4, 0.9);
    const rush = b.gain(0.8);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 1500, 0.6), b.filter('lowpass', muffle(p.distance, 3000), 0.6), rush, b.output);
    b.wander(rush.gain, 0.35, 0.15);
    const crackle = b.gain(0.25);
    b.chain(b.noise(b.bank.crackle), b.filter('lowpass', muffle(p.distance, 3500), 0.6), crackle, b.output);
  },

  /** A chakri spinning down the street: a pulsing, hissing whirr. */
  distantChakri(b, p) {
    b.sustain(b.output.gain, p.gain, 0.3, 0.6);
    const whirr = b.gain(0.6);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 2800, 1), b.filter('lowpass', muffle(p.distance, 4500), 0.6), whirr, b.output);
    const spin = b.osc('sine', 8);
    const depth = b.gain(0.45);
    b.chain(spin, depth);
    depth.connect(whirr.gain);
  },

  /**
   * A sutli fuse burning in under the balti: a crackling, spitting fizz
   * with the odd louder sputter and the low rush of its powder core, bright
   * while the burning tip is still out in the open, then duller and quieter
   * as it eats its way in under the rim.
   */
  baltiFuse(b, p) {
    b.sustain(b.output.gain, p.gain, 0.02, 0.05);
    const length = b.end - b.t0;
    const covered = b.t0 + length * BALTI_FUSE_COVERED[0];
    const under = b.t0 + length * BALTI_FUSE_COVERED[1];
    const steel = b.filter('lowpass', 9000, 0.7);
    steel.frequency.setValueAtTime(9000, b.t0);
    steel.frequency.setValueAtTime(9000, covered);
    steel.frequency.exponentialRampToValueAtTime(1300, under);
    const level = b.gain(1);
    level.gain.setValueAtTime(1, b.t0);
    level.gain.setValueAtTime(1, covered);
    level.gain.linearRampToValueAtTime(0.45, under);
    b.chain(steel, level, b.output);

    const fizz = b.gain(0.45);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 5200, 0.8), fizz, steel);
    b.wander(fizz.gain, 0.35, 0.08);
    const spits = b.gain(0.75);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.4), b.filter('bandpass', 3200, 1), spits, steel);
    const core = b.gain(0.18);
    b.chain(b.noise(b.bank.brown, b.t0, b.end, 1.2), b.filter('bandpass', 900, 0.7), core, steel);
    // Now and then it sputters: a louder spit of burning powder.
    const sputter = b.gain(0);
    const times: number[] = [];
    for (let t = b.t0 + 0.15 + Math.random() * 0.4; t < b.end - 0.1; t += 0.25 + Math.random() * 0.6) times.push(t);
    b.hits(sputter.gain, times, 0.6, 0.035);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 2500, 0.7), sputter, steel);
  },

  /**
   * A sutli bomb going off under an upturned steel balti: a deep, punchy
   * thump, the blast itself dulled by the steel over it, the sharp bang of
   * the base struck from inside, the pail's short inharmonic ring swelling
   * and fading as it tumbles away, the street slapping it back, and grit
   * and shreds pattering down after.
   */
  baltiBoom(b, p) {
    b.output.gain.value = p.gain;
    const at = b.t0;
    const far = p.distance;
    // The thump: the gas shoved down against the ground and out under the rim.
    const thump = b.gain(0);
    thump.gain.setValueAtTime(0.0001, b.t0);
    b.hit(thump.gain, 1, at, 0.6);
    const sub = b.osc('sine', 110, at, b.until(at + 0.7));
    sub.frequency.setValueAtTime(110, at);
    sub.frequency.exponentialRampToValueAtTime(34, b.until(at + 0.5));
    b.chain(sub, thump, b.output);
    // The blast. A sutli is wrapped tight in jute, so it cracks hard enough
    // that the pail over it dulls it only a little.
    const body = b.gain(1);
    b.chain(b.blast(at, 0.75 + Math.random() * 0.1), b.filter('lowpass', muffle(far, 2600), 0.7), body, b.output);
    // The crack itself, escaping under the rim before the steel can soak it up.
    b.burst(b.bank.white, at, 0.9, 0.04, b.filter('bandpass', muffle(far, 1600), 0.5));

    // The bang of the steel: the shock hitting the base from inside.
    b.burst(b.bank.white, at + 0.002, 0.5, 0.05, b.filter('bandpass', muffle(far, 2600), 0.8));
    b.burst(b.bank.white, at + 0.001, 0.25, 0.015, b.filter('highpass', 5000, 0.7));

    // Its ring, swelling and fading as the open mouth turns towards and away.
    const ring = b.gain(0.75);
    ring.connect(b.output);
    const turns = Math.abs(p.spin ?? 0) / (Math.PI * 2);
    if (turns > 0.2) b.lfo(ring.gain, Math.min(2.5, turns), 0.35);
    b.steel(at + 0.003, 0.22, 1.1, 1.1, ring);

    // The street answering: the houses opposite slapping the bang back, duller each time.
    const echo = b.gain(0);
    echo.gain.setValueAtTime(0.0001, b.t0);
    let when = at;
    for (let k = 0; k < 3; k++) {
      when += 0.08 + Math.random() * 0.12;
      if (when + 0.14 > b.end) break;
      echo.gain.setValueAtTime(0.0001, when);
      echo.gain.exponentialRampToValueAtTime(0.22 * Math.pow(0.55, k), when + 0.006);
      echo.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
    }
    b.chain(b.noise(b.bank.white, at, b.until(when + 0.16)), b.filter('lowpass', muffle(far, 1500), 0.6), echo, b.output);

    // Grit and shreds of the bomb pattering down after.
    const patterFrom = at + 0.3;
    const patterTo = b.until(at + 1.9);
    if (patterTo > patterFrom + 0.4) {
      const patter = b.gain(0);
      patter.gain.setValueAtTime(0, b.t0);
      patter.gain.setValueAtTime(0, patterFrom);
      patter.gain.linearRampToValueAtTime(0.06, patterFrom + 0.3);
      patter.gain.linearRampToValueAtTime(0, patterTo);
      b.chain(b.noise(b.bank.crackle, patterFrom, patterTo, 0.9), b.filter('bandpass', muffle(far, 2500), 0.8), patter, b.output);
    }
  },

  /**
   * The open pail tumbling through the air: a soft flutter, two puffs a
   * turn, loudest leaving the ground and coming back down, silent at the top.
   */
  baltiWhoosh(b, p) {
    b.output.gain.value = p.gain;
    const length = b.end - b.t0;
    const rise = length / 2;
    const air = b.gain(0);
    air.connect(b.output);
    b.follow(air.gain, (age) => {
      const speed = Math.abs(1 - age / rise);
      return speed * speed * Math.min(1, age / 0.08, (length - age) / 0.05);
    });
    const flutter = b.gain(0.6);
    const rate = Math.min(6, Math.max(1, Math.abs(p.spin ?? 0) / Math.PI));
    b.lfo(flutter.gain, rate, 0.4);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 650, 1.3), flutter, air);
    const edge = b.gain(0.2);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 1900, 2), edge, flutter);
  },

  /**
   * The balti landing: the strike (a hard click of steel on stone), a
   * thud, and the pail's ring. How it lands sets the colour: on its rolled
   * rim it rings bright and long, the far side of the rim slapping down a
   * moment after; flat on its base it slaps dull and short; on its side it
   * clanks, its wire handle clinking. Harder landings ring brighter and longer.
   */
  baltiClang(b, p) {
    b.output.gain.value = p.gain;
    const at = b.t0;
    const s = Math.min(1, Math.max(0, p.strength ?? 1));
    const tone = BALTI_CLANG[p.contact ?? 'rim'];
    const ringFor = Math.max(0.15, b.end - at - 0.04);

    // The rim (or base, or flank) coming down at a few points, the first the hardest.
    const [fewest, most] = tone.strikes;
    const count = s < 0.25 ? 1 : fewest + Math.floor(Math.random() * (most - fewest + 1));
    const strikes: [number, number][] = [];
    let when = at;
    for (let k = 0; k < count; k++) {
      const weight = k === 0 ? 1 : (0.3 + 0.45 * Math.random()) * Math.pow(0.75, k - 1);
      strikes.push([when, weight]);
      when = b.until(when + 0.004 + Math.random() * tone.spread);
    }
    for (const [time, weight] of strikes) {
      // Steel on stone: a hard, bright tick at every point of contact.
      b.burst(b.bank.white, time, tone.click * weight * (0.5 + 0.5 * s), 0.006 + 0.01 * s, b.filter('highpass', tone.clickAt, 0.7));
    }
    b.clank(strikes, 0.24 * (0.6 + 0.4 * s), ringFor * tone.decay * (0.5 + 0.5 * s), tone.bright * (0.7 + 0.3 * s), s);

    // The thud: the pail's weight meeting the ground, low and quick.
    b.burst(b.bank.brown, at, tone.thud * (0.4 + 0.6 * s), 0.05 + 0.05 * s, b.filter('lowpass', 380, 0.7));
    const knock = b.gain(0);
    knock.gain.setValueAtTime(0.0001, b.t0);
    b.hit(knock.gain, tone.thud * 0.9 * s, at, 0.14);
    const low = b.osc('sine', 120, at, b.until(at + 0.18));
    low.frequency.exponentialRampToValueAtTime(55, b.until(at + 0.15));
    b.chain(low, knock, b.output);

    if (tone.handle) {
      // The wire handle clinking against the pail, a beat behind it.
      for (let k = 0; k < 3; k++) {
        const ping = b.gain(0);
        const at2 = at + 0.012 + Math.random() * 0.1;
        ping.gain.setValueAtTime(0.0001, b.t0);
        b.hit(ping.gain, 0.05 * (0.5 + s), at2, 0.05);
        b.chain(b.osc('square', 2600 + Math.random() * 1800, at2, b.until(at2 + 0.06)), b.filter('bandpass', 4200, 2), ping, b.output);
      }
    }
    // A scrape of grit under it.
    b.burst(b.bank.white, at + 0.005, 0.06 * s, 0.07, b.filter('bandpass', 1500, 0.6));
  },

  /**
   * The balti coming to rest. On its rim or base it rocks still like a
   * dropped lid: ticks of steel on stone, quicker and quieter as the sway
   * dies (timed from the same sway as `BaltiFlight`), into a last buzz. On
   * its side it rolls away: a gritty rumble dying with its speed, the
   * handle knocking once a turn.
   */
  baltiRattle(b, p) {
    b.output.gain.value = p.gain;
    const length = b.end - b.t0;
    const ticks = b.gain(0);
    ticks.gain.setValueAtTime(0.0001, b.t0);
    const click = b.gain(0.5);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 3400, 1), click, ticks);
    const ring = b.gain(1);
    ring.connect(ticks);
    for (const k of [1, 2, 4]) b.chain(b.osc('sine', BALTI_MODES[k]!.frequency * (0.98 + Math.random() * 0.04)), b.gain(0.12), ring);
    ticks.connect(b.output);

    const w = BALTI.wobble;
    if (p.contact !== 'side') {
      // The sway it settled with, from how long it takes to die (see `BaltiFlight`).
      let sway = Math.min(w.max, 0.004 * Math.exp(w.decay * length));
      let phase = 0;
      let next = Math.PI / 2;
      const dt = 1 / 400;
      for (let t = 0; t < length - 0.03; t += dt) {
        sway *= Math.exp(-w.decay * dt);
        phase += (w.rate / Math.sqrt(sway / w.max + 0.05)) * dt;
        if (phase < next) continue;
        // Each swing brings the rim down on the other side.
        next += Math.PI;
        const when = b.t0 + t;
        const peak = Math.max(0.0003, 0.5 * Math.pow(sway / w.max, 0.6));
        ticks.gain.setValueAtTime(0.0001, when);
        ticks.gain.exponentialRampToValueAtTime(peak, when + 0.002);
        ticks.gain.exponentialRampToValueAtTime(0.0001, Math.min(b.end, when + 0.03));
      }
      return;
    }
    // Rolling: the handle knocks once a turn, the turns slowing with it.
    const speed0 = Math.max(0.05, p.speed ?? 0.5);
    const circumference = Math.PI * (BALTI.rimRadius + BALTI.baseRadius);
    let travelled = circumference * Math.random();
    for (let t = 0; t < length - 0.04; t += 1 / 400) {
      const speed = speed0 * Math.exp(-BALTI.rollDrag * t);
      travelled += speed / 400;
      if (travelled < circumference) continue;
      travelled -= circumference;
      const when = b.t0 + t;
      ticks.gain.setValueAtTime(0.0001, when);
      ticks.gain.exponentialRampToValueAtTime(Math.max(0.0003, 0.35 * Math.min(1, speed / 1.2)), when + 0.002);
      ticks.gain.exponentialRampToValueAtTime(0.0001, Math.min(b.end, when + 0.04));
    }
    const rumble = b.gain(0);
    rumble.gain.setValueAtTime(0, b.t0);
    rumble.gain.linearRampToValueAtTime(0.5 * Math.min(1, speed0 / 1.2), b.t0 + 0.04);
    rumble.gain.setTargetAtTime(0, b.t0 + 0.04, 1 / BALTI.rollDrag);
    b.chain(b.noise(b.bank.brown, b.t0, b.end, 1.6), b.filter('bandpass', 520, 0.9), rumble, b.output);
    const grit = b.gain(0.25);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.3), b.filter('bandpass', 2400, 1.1), grit, rumble);
  },
};

/**
 * A steel balti's ringing modes: frequency (Hz), level and ring time
 * relative to the lowest. Inharmonic like any struck shell, so it clangs
 * rather than plays a note; the higher modes quieter and much shorter, as
 * thin steel damps them fast.
 */
const BALTI_MODES: readonly { readonly frequency: number; readonly level: number; readonly decay: number }[] = [
  { frequency: 318, level: 1, decay: 1 },
  { frequency: 497, level: 0.85, decay: 0.85 },
  { frequency: 786, level: 0.7, decay: 0.65 },
  { frequency: 1163, level: 0.55, decay: 0.48 },
  { frequency: 1618, level: 0.45, decay: 0.36 },
  { frequency: 2211, level: 0.34, decay: 0.26 },
  { frequency: 3062, level: 0.24, decay: 0.18 },
  { frequency: 4172, level: 0.16, decay: 0.12 },
];
/** The lowest this many modes are split pairs, this fraction of their frequency either side. */
const BALTI_SPLIT_MODES = 3;
const BALTI_MODE_SPLIT = 0.004;

/** How each way of landing sounds: click level and centre, thud, ring brightness and length, and extras. */
const BALTI_CLANG: Readonly<
  Record<
    BaltiContact,
    {
      click: number;
      clickAt: number;
      thud: number;
      bright: number;
      decay: number;
      /** How many points it comes down on, fewest to most, and the most seconds between them. */
      strikes: readonly [number, number];
      spread: number;
      handle?: boolean;
    }
  >
> = {
  // On the rolled rim: a quick chatter of strikes round the circle, bright and long.
  rim: { click: 0.55, clickAt: 3800, thud: 0.15, bright: 1.3, decay: 1, strikes: [2, 4], spread: 0.022 },
  // Flat on the base: one slap, maybe a second, dull and choked.
  base: { click: 0.4, clickAt: 1600, thud: 0.65, bright: 0.45, decay: 0.4, strikes: [1, 2], spread: 0.01 },
  // On its flank: rim and base land a moment apart, then the handle.
  side: { click: 0.45, clickAt: 2400, thud: 0.4, bright: 0.85, decay: 0.6, strikes: [2, 3], spread: 0.04, handle: true },
};

/**
 * The landing's extra colour (see `clank`): how many thin, quick modes
 * crowd above the main ones and over what span, how loud they are, how
 * loud the noise round the ring is, and how sharp a hard hit bends the
 * low modes.
 */
const BALTI_CLANK = { body: 0.72, crowd: 10, crowdFrom: 1300, crowdTo: 7500, crowdLevel: 0.22, sizzle: 0.5, bend: 0.012 } as const;

/** Fractions of the fuse: its burning tip goes in under the rim, then is well inside. */
const BALTI_FUSE_COVERED = [0.45, 0.85] as const;

/** Of a distant ladi's pops, how many are its louder bangers. */
const LADI_LOUD_CHANCE = 0.15;

/**
 * Playback rate for one banger: within 3% of 1, so a reused recording is
 * never sample-identical, but no pop is pitched against another (which
 * would make the string sound like a drum).
 */
export const BANGER_RATE_SPREAD = 0.03;
function bangerRate(): number {
  return 1 + BANGER_RATE_SPREAD * (2 * Math.random() - 1);
}

/** Air dulls a bang with distance: the low-pass cutoff for one `distance` metres away. */
function muffle(distance: number | undefined, nearCutoff: number): number {
  return Math.max(350, nearCutoff * Math.min(1, 60 / Math.max(60, distance ?? 0)));
}


/**
 * The town celebrating all around: a faint, endless crackle of countless
 * far-off crackers, swelling and thinning, under the individual bangs.
 */
export function startTownCrackle(ctx: BaseAudioContext, bank: NoiseBank, output: GainNode, t0: number): SynthVoice {
  const builder = new VoiceBuilder(ctx, bank, output, t0, Number.POSITIVE_INFINITY);
  const crackle = builder.gain(0.55);
  builder.chain(
    builder.noise(bank.crackle, t0, Number.POSITIVE_INFINITY, 0.7),
    builder.filter('bandpass', 1300, 0.6),
    builder.filter('lowpass', 2400, 0.7),
    crackle,
    output,
  );
  builder.wander(crackle.gain, 0.35, 0.03);
  const sizzle = builder.gain(0.06);
  builder.chain(builder.noise(bank.sizzle, t0, Number.POSITIVE_INFINITY, 0.5), builder.filter('lowpass', 1800, 0.7), sizzle, output);
  output.gain.setValueAtTime(0, t0);
  output.gain.linearRampToValueAtTime(1, t0 + 3);
  return { output, sources: builder.sources, end: Number.POSITIVE_INFINITY };
}
