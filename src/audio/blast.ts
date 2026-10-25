/**
 * Physically shaped explosion recordings, generated rather than sampled.
 *
 * A shell bursting overhead is a single shock wave: pressure jumps almost
 * instantly, falls away, swings briefly negative and recovers (the
 * Friedlander waveform). What makes it sound real is what follows: its
 * reflection off the ground, a slower push of expanding gas felt in the
 * chest, a scatter of small cracks as the casing breaks and the stars
 * catch, and then hundreds of reflections off the buildings around, each
 * arriving later and duller than the last, blurring into a rolling rumble.
 *
 * Pure functions over sample arrays so they run headless.
 */

export interface BlastShape {
  /** Length of the shock's positive phase, seconds (a few milliseconds). */
  readonly pulse: number;
  /** Length of the slower push of expanding gas, seconds. */
  readonly whump: number;
  /** Seconds the reflections take to die away. */
  readonly echo: number;
  /** Reflections in the tail. */
  readonly reflections: number;
}

/** A random but plausible shell burst heard from close by. */
export function randomBlastShape(random: () => number): BlastShape {
  return {
    pulse: 0.0007 + random() * 0.0013,
    whump: 0.008 + random() * 0.008,
    echo: 2.2 + random() * 0.8,
    reflections: 6000 + Math.floor(random() * 3000),
  };
}

/** How sharply the positive phase falls away (the Friedlander decay constant). */
const DECAY = 1.6;
/** Rise time of the shock front, seconds; keeps the edge from aliasing. */
const RISE = 0.00015;

/**
 * Add a Friedlander pulse of `amplitude` starting at `at` seconds, with a
 * positive phase `width` seconds long, onto `data`.
 */
export function addShock(data: Float32Array, sampleRate: number, at: number, width: number, amplitude: number): void {
  const start = Math.round(at * sampleRate);
  // The negative phase has all but recovered by four widths.
  const length = Math.ceil(width * 4 * sampleRate);
  for (let i = 0; i < length && start + i < data.length; i++) {
    if (start + i < 0) continue;
    const t = i / sampleRate;
    const x = t / width;
    const front = 1 - Math.exp(-t / RISE);
    data[start + i] = (data[start + i] ?? 0) + amplitude * front * (1 - x) * Math.exp(-DECAY * x);
  }
}

/**
 * Fill `data` with one shell burst heard from close by, peak-normalised to
 * 0.9. The tail's reflections widen as they arrive later, which is the
 * high frequencies dying off over distance, and its loudness wanders so it
 * rolls like thunder rather than fading smoothly.
 */
export function fillBlast(data: Float32Array, sampleRate: number, random: () => number, shape: BlastShape): void {
  data.fill(0);
  // The shock, its bounce off the ground, and the push of expanding gas.
  addShock(data, sampleRate, 0, shape.pulse, 1);
  addShock(data, sampleRate, 0.003 + random() * 0.004, shape.pulse * 1.3, 0.55);
  addShock(data, sampleRate, 0.001, shape.whump, 0.7);

  // The casing breaking and the stars catching: small cracks in the first 40 ms.
  const cracks = 20 + Math.floor(random() * 30);
  for (let c = 0; c < cracks; c++) {
    const at = 0.002 + random() * 0.04;
    addShock(data, sampleRate, at, 0.0004 + random() * 0.0008, (random() < 0.5 ? -1 : 1) * (0.08 + random() * 0.2));
  }

  // Reflections off the buildings: dense early, sparse late, quieter with
  // time. Each lands as a single spike; a low-pass that closes as time goes
  // on then dulls the later ones, as air and distance would.
  const tail = new Float32Array(data.length);
  const rollPhase = random() * Math.PI * 2;
  for (let r = 0; r < shape.reflections; r++) {
    const t = 0.012 + shape.echo * Math.pow(random(), 1.7);
    const i = Math.round(t * sampleRate);
    if (i >= tail.length) continue;
    const fade = Math.exp((-3.5 * t) / shape.echo);
    const roll = 0.65 + 0.35 * Math.sin(t * 5.3 + rollPhase) * Math.sin(t * 2.1 + rollPhase * 0.7);
    // Reflections build up over the first moments; none outdo the shock itself.
    const build = Math.min(1, t / 0.06);
    tail[i] = (tail[i] ?? 0) + build * fade * roll * (0.3 + 0.5 * random()) * (random() < 0.5 ? -1 : 1);
  }
  dullOverTime(tail, sampleRate);
  // The direct shock is always the loudest moment; echoes never top it.
  const level = Math.min(TAIL_LEVEL, (TAIL_CEILING * peakOf(data)) / Math.max(1e-9, peakOf(tail)));
  for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) + tail[i]! * level;

  const peak = peakOf(data);
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = (data[i]! / peak) * 0.9;
}

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
  return peak;
}

/** Loudness of the reflections against the shock, after dulling. */
const TAIL_LEVEL = 1.4;
/** The echoes' loudest moment, as a fraction of the shock's. */
const TAIL_CEILING = 0.6;
/** Cutoff of the reflections' low-pass: bright at first, closing to `CUTOFF_END` Hz. */
const CUTOFF_START = 7000;
const CUTOFF_END = 250;
const CUTOFF_FALL = 0.5;

/**
 * Two passes of a one-pole low-pass whose cutoff closes exponentially over
 * time, gain-compensated so a single spike keeps roughly its loudness while
 * losing its brightness.
 */
function dullOverTime(data: Float32Array, sampleRate: number): void {
  let a1 = 0;
  let a2 = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const cutoff = CUTOFF_END + (CUTOFF_START - CUTOFF_END) * Math.exp(-t / CUTOFF_FALL);
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    a1 += k * (data[i]! / Math.sqrt(k) - a1);
    a2 += k * (a1 - a2);
    data[i] = a2;
  }
}

/**
 * One small banger of a ladi going off at arm's length. Flash powder in a
 * paper tube bangs as a near-ideal impulse (Dezelak, Prezelj & Cudina 2009,
 * "Some Statistical Aspects of Firecracker Noise"): the shock front rises
 * in microseconds and its positive peak lasts tens of microseconds, so here
 * it is a two-sample spike; the air then swings shallowly negative for a
 * millisecond or so; and the paper and hot gas crack as a burst of
 * broadband noise lasting a few milliseconds. Nothing in it rings or has a
 * pitch: any tail longer than that is the street's echo, which the engine
 * adds. Now and then a shred of paper ticks off a little later.
 */
export interface BangerShape {
  /** Length of the shock's negative (rarefaction) lobe, seconds. */
  readonly lobe: number;
  /** Depth of that lobe against the spike. */
  readonly depth: number;
  /** Time constant of the crack's noise, seconds. */
  readonly crack: number;
  /** Peak of the crack's noise against the spike. */
  readonly level: number;
  /** Low-pass corner of the crack, Hz: how bright this banger is. */
  readonly brightness: number;
  /** Paper shreds ticking off after the bang. */
  readonly ticks: number;
}

/** Seconds each banger recording lasts; everything has died away by then. */
export const BANGER_SECONDS = 0.12;
/** Peak of every banger recording. */
export const BANGER_PEAK = 0.9;
/** Below this the crack's noise is cut (gently: two one-pole stages), Hz. */
const CRACK_HIGHPASS = 650;
/**
 * The crack's energy leans towards the low kilohertz, where flash powder
 * bangs loudest: most of it is noise softened above this, Hz, with flat
 * noise on top up to the banger's brightness.
 */
const CRACK_TILT = 1800;
/** How much of the crack is that flat, bright noise. */
const CRACK_AIR = 0.18;

/** A random but plausible banger: each in a string bangs a little differently. */
export function randomBangerShape(random: () => number): BangerShape {
  return {
    lobe: 0.0005 + random() * 0.001,
    depth: 0.12 + random() * 0.1,
    crack: 0.0025 + random() * 0.0055,
    level: 0.55 + random() * 0.3,
    brightness: 7000 + random() * 3000,
    ticks: Math.floor(random() * 3.5),
  };
}

/** Fill `data` with one banger heard from close by, peak-normalised to `BANGER_PEAK`. */
export function fillBanger(data: Float32Array, sampleRate: number, random: () => number, shape: BangerShape): void {
  data.fill(0);
  // The crack: white noise, high- and gently low-passed, dying exponentially from the first sample.
  const crack = new Float32Array(data.length);
  const kHigh = 1 - Math.exp((-2 * Math.PI * CRACK_HIGHPASS) / sampleRate);
  const kLow = 1 - Math.exp((-2 * Math.PI * Math.min(shape.brightness, sampleRate * 0.45)) / sampleRate);
  const kTilt = 1 - Math.exp((-2 * Math.PI * CRACK_TILT) / sampleRate);
  let floor1 = 0;
  let floor2 = 0;
  let bright = 0;
  let body = 0;
  for (let i = 0; i < data.length; i++) {
    const noise = random() * 2 - 1;
    floor1 += kHigh * (noise - floor1);
    const high1 = noise - floor1;
    floor2 += kHigh * (high1 - floor2);
    const high = high1 - floor2;
    bright += kLow * (high - bright);
    body += kTilt * (high - body);
    // Gain-matched so both layers have roughly the same loudness per unit of mix.
    const mix = body / Math.sqrt(kTilt) * (1 - CRACK_AIR) + bright * CRACK_AIR;
    crack[i] = mix * Math.exp(-i / sampleRate / shape.crack);
  }
  const crackLevel = shape.level / Math.max(1e-9, peakOf(crack));
  for (let i = 0; i < data.length; i++) data[i] = crack[i]! * crackLevel;

  // The shock: a two-sample spike, then a shallow, smooth negative lobe.
  data[0] = data[0]! + 1;
  if (data.length > 1) data[1] = data[1]! + 0.4;
  const lobe = Math.max(2, Math.round(shape.lobe * sampleRate));
  for (let i = 0; i < lobe && i + 2 < data.length; i++) data[i + 2] = data[i + 2]! - shape.depth * Math.sin((Math.PI * (i + 0.5)) / lobe);

  // Shreds of paper: single ticks, well after the bang and far quieter.
  for (let t = 0; t < shape.ticks; t++) {
    const at = Math.round((0.012 + random() * 0.05) * sampleRate);
    if (at + 1 >= data.length) continue;
    const size = (random() < 0.5 ? -1 : 1) * (0.04 + random() * 0.08);
    data[at] = data[at]! + size;
    data[at + 1] = data[at + 1]! - size * 0.5;
  }

  const peak = peakOf(data);
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = (data[i]! / peak) * BANGER_PEAK;
}
