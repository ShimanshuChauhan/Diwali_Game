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
 * positive phase `width` seconds long, onto `data`; its front takes about
 * `rise` seconds.
 */
export function addShock(
  data: Float32Array,
  sampleRate: number,
  at: number,
  width: number,
  amplitude: number,
  rise = RISE,
): void {
  const start = Math.round(at * sampleRate);
  // The negative phase has all but recovered by four widths.
  const length = Math.ceil(width * 4 * sampleRate);
  for (let i = 0; i < length && start + i < data.length; i++) {
    if (start + i < 0) continue;
    const t = i / sampleRate;
    const x = t / width;
    const front = 1 - Math.exp(-t / rise);
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
 * One small banger of a ladi going off at arm's length: a tiny version of
 * the same blast. Its shock is far shorter than a shell's, so it is a hard,
 * broadband crack rather than a boom; the push of its gas is a short
 * low-mid thump (a positive phase of 1.4–3 ms puts its energy around
 * 150–350 Hz); its paper casing tears into a few sharp fragments; and the
 * ground under it rings briefly. No room: the engine adds the lane's.
 */
export interface BangerShape {
  /** Length of the crack's positive phase, seconds (a fraction of a millisecond). */
  readonly crack: number;
  /** Length of the thump's positive phase, seconds. */
  readonly thump: number;
  /** Time constant of the low-mid body's decay, seconds. */
  readonly body: number;
  /** Time constant of the torn paper's spatter, seconds. */
  readonly spatter: number;
}

/** Seconds each banger recording lasts; everything has died away by then. */
export const BANGER_SECONDS = 0.18;
/** Peak of every banger recording. */
export const BANGER_PEAK = 0.9;
/** The crack's front: near-instant, so it cracks rather than thuds. */
const CRACK_RISE = 0.00002;
/** Band of the ground's ring under a banger, Hz. */
const BODY_LOW = 120;
const BODY_HIGH = 380;

/** A random but plausible banger: each in a string bangs a little differently. */
export function randomBangerShape(random: () => number): BangerShape {
  return {
    crack: 0.00022 + random() * 0.00028,
    thump: 0.0014 + random() * 0.0016,
    body: 0.012 + random() * 0.012,
    spatter: 0.008 + random() * 0.01,
  };
}

/** Fill `data` with one banger heard from close by, peak-normalised to `BANGER_PEAK`. */
export function fillBanger(data: Float32Array, sampleRate: number, random: () => number, shape: BangerShape): void {
  data.fill(0);
  // The crack, its bounce off the ground right under it, and the thump of gas.
  addShock(data, sampleRate, 0, shape.crack, 1, CRACK_RISE);
  addShock(data, sampleRate, 0.0008 + random() * 0.0012, shape.crack * 1.4, 0.45, CRACK_RISE);
  addShock(data, sampleRate, 0.0002, shape.thump, 0.85);
  // The casing tearing: a few sharp fragments in the first few milliseconds.
  const fragments = 4 + Math.floor(random() * 8);
  for (let f = 0; f < fragments; f++) {
    const sign = random() < 0.5 ? -1 : 1;
    addShock(data, sampleRate, 0.0005 + random() * 0.004, 0.0001 + random() * 0.0003, sign * (0.08 + random() * 0.22), CRACK_RISE);
  }

  // The ground and air ringing: low-mid noise that swells in a millisecond
  // and dies over a couple of dozen. Band-passed noise, so it thumps without
  // a pitch.
  const body = new Float32Array(data.length);
  const spatter = new Float32Array(data.length);
  const kHigh = 1 - Math.exp((-2 * Math.PI * BODY_HIGH) / sampleRate);
  const kLow = 1 - Math.exp((-2 * Math.PI * BODY_LOW) / sampleRate);
  let lp1 = 0;
  let lp2 = 0;
  let floor = 0;
  let previous = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const noise = random() * 2 - 1;
    lp1 += kHigh * (noise - lp1);
    lp2 += kHigh * (lp1 - lp2);
    floor += kLow * (lp2 - floor);
    body[i] = (lp2 - floor) * (1 - Math.exp(-t / 0.001)) * Math.exp(-t / shape.body);
    // Bits of burning paper flung off: a bright, sparse fizz.
    const spit = random() < 0.3 ? noise - previous : 0;
    spatter[i] = spit * Math.exp(-t / shape.spatter);
    previous = noise;
  }
  const bodyLevel = 0.5 / Math.max(1e-9, peakOf(body));
  const spatterLevel = 0.12 / Math.max(1e-9, peakOf(spatter));
  for (let i = 0; i < data.length; i++) data[i] = data[i]! + body[i]! * bodyLevel + spatter[i]! * spatterLevel;

  const peak = peakOf(data);
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = (data[i]! / peak) * BANGER_PEAK;
}
