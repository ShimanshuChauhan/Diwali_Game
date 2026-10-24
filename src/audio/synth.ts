import { fillBrown, fillCrackle, fillWhite } from './noise';
import { STOP_FADE, type SoundKind } from './sounds';

/**
 * Original synthesised sounds, built from oscillators, filters and the
 * procedural noise buffers in `noise.ts`. No recorded samples are used
 * (PRD → Assets and licensing).
 *
 * Each recipe schedules its nodes on the audio clock from `t0` to `end` and
 * feeds them into the voice's `output` gain, which the engine routes through
 * a panner. Timbres are placeholders to be refined in the audio review.
 */

/** Shared noise buffers, generated once per audio context. */
export interface NoiseBank {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly crackle: AudioBuffer;
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
  };
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

const RECIPES: Record<SoundKind, Recipe> = {
  fuseHiss(b, p) {
    b.sustain(b.output.gain, p.gain, 0.05, 0.1);
    const hiss = b.gain(0.7);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 2800, 0.7), hiss, b.output);
    b.lfo(hiss.gain, 11, 0.25, 'square');
    const sputter = b.gain(0.5);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.6), b.filter('bandpass', 3500, 1.2), sputter, b.output);
  },

  phuljhariCrackle(b, p) {
    b.sustain(b.output.gain, p.gain, 0.2, 0.6);
    const crackle = b.gain(0.9);
    b.chain(b.noise(b.bank.crackle, b.t0, b.end, 1.3), b.filter('highpass', 1800, 0.8), crackle, b.output);
    const sizzle = b.gain(0.25);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 6500, 0.9), sizzle, b.output);
  },

  anarRoar(b, p) {
    b.sustain(b.output.gain, p.gain, 0.6, 1.2);
    const body = b.filter('lowpass', 600, 2);
    body.frequency.setValueAtTime(500, b.t0);
    body.frequency.linearRampToValueAtTime(1400, b.t0 + 1);
    body.frequency.linearRampToValueAtTime(900, b.end);
    b.chain(b.noise(b.bank.brown, b.t0, b.end, 1.4), body, b.gain(1), b.output);
    const rush = b.gain(0.35);
    b.chain(b.noise(b.bank.white), b.filter('bandpass', 2400, 0.7), rush, b.output);
    b.lfo(rush.gain, 3.3, 0.08);
    const crackle = b.gain(0.3);
    b.chain(b.noise(b.bank.crackle), b.filter('highpass', 2000), crackle, b.output);
  },

  chakriWhine(b, p) {
    b.sustain(b.output.gain, p.gain, 0.3, 0.8);
    const whine = b.osc('sawtooth', 700);
    whine.frequency.setValueAtTime(700, b.t0);
    whine.frequency.linearRampToValueAtTime(1300, b.t0 + Math.min(1.5, (b.end - b.t0) / 2));
    whine.frequency.linearRampToValueAtTime(850, b.end);
    // The wobble of a wheel spinning past the listener.
    b.lfo(whine.frequency, 7, 110);
    const tone = b.gain(0.35);
    b.chain(whine, b.filter('bandpass', 1500, 2.5), tone, b.output);
    b.lfo(tone.gain, 7, 0.15);
    const hiss = b.gain(0.4);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 3000), hiss, b.output);
  },

  rocketWhistle(b, p) {
    b.sustain(b.output.gain, p.gain, 0.05, 0.12);
    const whistle = b.osc('sine', 900);
    whistle.frequency.setValueAtTime(900, b.t0);
    whistle.frequency.exponentialRampToValueAtTime(2800, b.end);
    b.lfo(whistle.frequency, 18, 30);
    b.chain(whistle, b.gain(0.6), b.output);
    const hiss = b.gain(0.5);
    b.chain(b.noise(b.bank.white), b.filter('highpass', 3200, 0.7), hiss, b.output);
  },

  burst(b, p) {
    b.output.gain.value = p.gain;
    // Low thump.
    const thump = b.osc('sine', 90, b.t0, b.t0 + 1);
    thump.frequency.setValueAtTime(90, b.t0);
    thump.frequency.exponentialRampToValueAtTime(35, b.t0 + 0.6);
    const thumpGain = b.gain(0);
    b.hit(thumpGain.gain, 1, b.t0, 0.9);
    b.chain(thump, thumpGain, b.output);
    // Boom body.
    const boom = b.gain(0);
    b.hit(boom.gain, 0.9, b.t0, 1.8);
    b.chain(b.noise(b.bank.brown, b.t0, b.t0 + 2), b.filter('lowpass', 500, 0.8), boom, b.output);
    // Sharp crack at the front.
    const crack = b.gain(0);
    b.hit(crack.gain, 0.5, b.t0, 0.12);
    b.chain(b.noise(b.bank.white, b.t0, b.t0 + 0.2), b.filter('highpass', 1500), crack, b.output);
    // Crackling tail as the stars burn out.
    const tailStart = b.t0 + 0.35;
    const tail = b.gain(0);
    tail.gain.setValueAtTime(0, tailStart);
    tail.gain.linearRampToValueAtTime(0.35, tailStart + 0.3);
    tail.gain.linearRampToValueAtTime(0, b.end);
    b.chain(b.noise(b.bank.crackle, tailStart), b.filter('bandpass', 3000, 0.8), tail, b.output);
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

  distantPop(b, p) {
    b.output.gain.value = p.gain;
    const cutoff = Math.max(220, 1000 - (p.distance ?? 0) * 3);
    const pop = b.gain(0);
    b.hit(pop.gain, 1, b.t0, 0.5);
    // Echo off far-away buildings.
    const echoAt = b.t0 + 0.25 + Math.random() * 0.2;
    pop.gain.setValueAtTime(0.0001, echoAt);
    pop.gain.exponentialRampToValueAtTime(0.3, echoAt + 0.01);
    pop.gain.exponentialRampToValueAtTime(0.0001, b.end);
    b.chain(b.noise(b.bank.brown), b.filter('lowpass', cutoff, 0.7), pop, b.output);
  },
};

/** Endless festive murmur of a celebrating neighbourhood. */
export function startMurmur(ctx: BaseAudioContext, bank: NoiseBank, output: GainNode, t0: number): SynthVoice {
  const builder = new VoiceBuilder(ctx, bank, output, t0, Number.POSITIVE_INFINITY);
  const crowd = builder.gain(0.6);
  const crowdSource = builder.noise(bank.brown, t0, Number.POSITIVE_INFINITY, 0.8);
  builder.chain(crowdSource, builder.filter('bandpass', 450, 0.8), crowd, output);
  builder.lfo(crowd.gain, 0.13, 0.2);
  const chatter = builder.gain(0.12);
  builder.chain(builder.noise(bank.white), builder.filter('bandpass', 1200, 1.5), chatter, output);
  builder.lfo(chatter.gain, 0.31, 0.05);
  output.gain.setValueAtTime(0, t0);
  output.gain.linearRampToValueAtTime(1, t0 + 3);
  return { output, sources: builder.sources, end: Number.POSITIVE_INFINITY };
}
