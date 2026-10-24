import type { BurstPattern } from '../core/types';
import { FOUNTAIN, surgeFactor } from '../effects/presets';
import { fillBrown, fillCrackle, fillLaneImpulse, fillWhite } from './noise';
import { LADI_TAIL, STOP_FADE, type SoundKind } from './sounds';

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
}

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
    // The crack: a very short, bright transient.
    const crack = b.gain(0);
    b.hit(crack.gain, 0.6, b.t0, 0.06);
    b.chain(b.noise(b.bank.white, b.t0, b.t0 + 0.1), b.filter('highpass', 700, 0.7), crack, b.output);
    // The boom: low noise closing down as it decays.
    const boom = b.gain(0);
    b.hit(boom.gain, 0.75, b.t0, 1.3);
    const body = b.filter('lowpass', 1200, 0.8);
    body.frequency.setValueAtTime(1200, b.t0);
    body.frequency.exponentialRampToValueAtTime(180, b.t0 + 0.9);
    b.chain(b.noise(b.bank.brown, b.t0, b.t0 + 1.5), body, boom, b.output);
    // A deep rumble felt in the chest, unpitched so it never sounds like a drum.
    const rumble = b.gain(0);
    rumble.gain.setValueAtTime(0, b.t0);
    rumble.gain.linearRampToValueAtTime(0.45, b.t0 + 0.03);
    rumble.gain.exponentialRampToValueAtTime(0.0001, b.t0 + 1.6);
    b.chain(b.noise(b.bank.white, b.t0, b.t0 + 1.7), b.filter('lowpass', 260, 0.5), rumble, b.output);
    // Echoes off the lane's houses.
    b.bang(b.t0 + 0.12, 0.35, 40, 3);

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

  cheer(b, p) {
    b.sustain(b.output.gain, p.gain, 0.25, 0.9);
    const formantA = b.filter('bandpass', 750, 4);
    const formantB = b.filter('bandpass', 1250, 5);
    const voices = b.gain(0.18);
    b.chain(formantA, voices);
    b.chain(formantB, voices);
    voices.connect(b.output);
    // A handful of rising-then-falling "ayy!" voices.
    for (let i = 0; i < 5; i++) {
      const pitch = 220 + Math.random() * 220;
      const start = b.t0 + Math.random() * 0.25;
      const voice = b.osc('sawtooth', pitch, start);
      voice.frequency.setValueAtTime(pitch, start);
      voice.frequency.linearRampToValueAtTime(pitch * 1.35, start + 0.4);
      voice.frequency.linearRampToValueAtTime(pitch * 0.9, b.end);
      b.lfo(voice.frequency, 5 + Math.random() * 2, pitch * 0.03);
      voice.connect(formantA);
      voice.connect(formantB);
    }
    const breath = b.gain(0.3);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 1100, 0.8), breath, b.output);
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
   * A ladi: a string of chain crackers rattling off, bursts of rapid snaps
   * with stumbles and the odd louder one, until it burns out.
   */
  distantLadi(b, p) {
    b.output.gain.value = p.gain;
    const burning = Math.max(0.3, b.end - b.t0 - LADI_TAIL);
    const times: number[] = [];
    for (let t = b.t0 + 0.02; t < b.t0 + burning; ) {
      times.push(t);
      // Mostly a fast rattle, now and then a stumble.
      t += Math.random() < 0.12 ? 0.12 + Math.random() * 0.2 : 0.025 + Math.random() * 0.07;
    }
    const snaps = b.gain(0);
    b.hits(snaps.gain, times, 0.9, 0.04);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 500, 0.6), b.filter('lowpass', muffle(p.distance, 6000), 0.6), snaps, b.output);
    // The rattle smears into a wash off the walls around it.
    const wash = b.gain(0);
    wash.gain.setValueAtTime(0, b.t0);
    wash.gain.linearRampToValueAtTime(0.18, b.t0 + 0.3);
    wash.gain.setValueAtTime(0.18, b.t0 + burning);
    wash.gain.linearRampToValueAtTime(0, b.end);
    b.chain(b.noise(b.bank.crackle), b.filter('lowpass', muffle(p.distance, 2500), 0.6), wash, b.output);
  },

  /** A shell bursting over another part of town: a crack, a long roll, sometimes a crackle. */
  distantShell(b, p) {
    b.output.gain.value = p.gain;
    b.bang(b.t0, 1, p.distance, 5);
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
};

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
