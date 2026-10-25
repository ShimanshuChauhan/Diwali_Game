/**
 * Procedural sample generators for the noise buffers the synthesised sounds
 * are built from. Pure functions over sample arrays so they run headless;
 * `random` returns values in [0, 1).
 */

/** Flat-spectrum noise for hiss and sizzle. */
export function fillWhite(data: Float32Array, random: () => number): void {
  for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
}

/** Integrated (brown) noise: deep rumble for roars and booms. */
export function fillBrown(data: Float32Array, random: () => number): void {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
    data[i] = last;
  }
  normalise(data);
}

/**
 * Sparse decaying clicks, the snap-snap of burning star composition.
 * `density` is clicks per second; `decaySeconds` sets how sharp each is.
 */
export function fillCrackle(
  data: Float32Array,
  sampleRate: number,
  density: number,
  random: () => number,
  decaySeconds = 0.0025,
): void {
  data.fill(0);
  const clicks = Math.round((data.length / sampleRate) * density);
  const decay = Math.max(1, Math.round(sampleRate * decaySeconds));
  for (let c = 0; c < clicks; c++) {
    const start = Math.floor(random() * data.length);
    const amplitude = 0.3 + 0.7 * random();
    const sign = random() < 0.5 ? -1 : 1;
    for (let i = 0; i < decay * 4 && start + i < data.length; i++) {
      const value = sign * amplitude * Math.exp(-i / decay) * (random() * 2 - 1);
      data[start + i] = Math.max(-1, Math.min(1, (data[start + i] ?? 0) + value));
    }
  }
}

/** Scale so the loudest sample has magnitude 1 (silence stays silent). */
export function normalise(data: Float32Array): void {
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return;
  for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) / peak;
}

/** Seconds between the lane's facing walls and back: the flutter of a street canyon. */
const FLUTTER_GAP = 0.034;
const FLUTTER_ECHOES = 10;

/**
 * A stereo impulse response for a narrow street at night: a flutter of
 * echoes bouncing between the facing walls, alternating sides, over a
 * diffuse tail that dies away in about `seconds`.
 */
export function fillLaneImpulse(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  seconds: number,
  random: () => number,
): void {
  const length = Math.min(left.length, right.length);
  const tau = seconds / 6.9; // -60 dB at `seconds`
  for (let i = 0; i < length; i++) {
    const envelope = Math.exp(-i / sampleRate / tau) * 0.2;
    left[i] = (random() * 2 - 1) * envelope;
    right[i] = (random() * 2 - 1) * envelope;
  }
  for (let k = 1; k <= FLUTTER_ECHOES; k++) {
    const at = Math.round(k * FLUTTER_GAP * sampleRate * (0.95 + 0.1 * random()));
    if (at >= length) break;
    const strength = Math.pow(0.62, k);
    const near = k % 2 === 0 ? left : right;
    const far = k % 2 === 0 ? right : left;
    near[at] = (near[at] ?? 0) + strength;
    far[at] = (far[at] ?? 0) + strength * 0.3;
  }
}

/**
 * Where a cracker at your feet in the lane comes back from: the house walls
 * beside it, the facing houses across the lane (the slapback), the second
 * trip between them, and a short diffuse wash. Seconds after the bang, and
 * strength against the direct sound.
 */
const ROOM_REFLECTIONS: readonly { readonly at: number; readonly spread: number; readonly strength: number }[] = [
  { at: 0.011, spread: 0.004, strength: 0.42 },
  { at: 0.024, spread: 0.006, strength: 0.32 },
  { at: 0.052, spread: 0.01, strength: 0.5 },
  { at: 0.098, spread: 0.014, strength: 0.26 },
  { at: 0.15, spread: 0.02, strength: 0.13 },
];
/** Loudness of the diffuse wash under the reflections. */
const ROOM_DIFFUSE = 0.035;
/** Taps each reflection scatters into, per side. */
const ROOM_TAPS = 14;
/** The wash is cut below this, Hz, so the lane never booms. */
const ROOM_FLOOR = 300;

/**
 * A stereo impulse response for the slapback and short tail of a narrow
 * lane, heard from a few metres off: a handful of reflections, each a
 * loose scatter of taps (no wall is a perfect mirror) arriving on
 * alternating sides, over a diffuse wash that dies away in about `seconds` and dulls a
 * little as it goes. Nothing in it is periodic or below a few hundred hertz,
 * so it smears a rattle into crackle without ringing at any pitch. Not
 * normalised: its levels are the echo's against the dry bang.
 */
export function fillLaneRoom(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  seconds: number,
  random: () => number,
): void {
  const length = Math.min(left.length, right.length);
  left.fill(0);
  right.fill(0);
  ROOM_REFLECTIONS.forEach((reflection, k) => {
    const near = k % 2 === 0 ? left : right;
    const far = k % 2 === 0 ? right : left;
    const base = reflection.at * (0.93 + 0.14 * random());
    // Rough walls scatter each echo into a loose cluster of taps, a different
    // one on each side: no clean mirror, so the echo never combs into a pitch.
    for (const [side, scale] of [[near, 1], [far, 0.45]] as const) {
      for (let tap = 0; tap < ROOM_TAPS; tap++) {
        const at = base + (tap === 0 ? 0 : random() * reflection.spread * 1.5);
        const i = Math.round(at * sampleRate);
        if (i >= length) continue;
        const sign = tap > 0 && random() < 0.35 ? -1 : 1;
        const weight = (tap === 0 ? 0.55 : 0.12 + 0.22 * random()) * reflection.strength * scale * sign;
        side[i] = (side[i] ?? 0) + weight;
      }
    }
  });
  // The diffuse wash: builds over the first reflections, then decays to -60 dB.
  const tau = seconds / 6.9;
  const kFloor = 1 - Math.exp((-2 * Math.PI * ROOM_FLOOR) / sampleRate);
  let l = 0;
  let r = 0;
  let lFloor = 0;
  let rFloor = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const envelope = ROOM_DIFFUSE * Math.min(1, t / 0.03) * Math.exp(-t / tau);
    // Walls and air soak up some highs: a one-pole low-pass closing from 8 kHz to 2.5 kHz.
    const cutoff = 2500 + 5500 * Math.exp(-t / 0.1);
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    l += k * ((random() * 2 - 1) / Math.sqrt(k) - l);
    r += k * ((random() * 2 - 1) / Math.sqrt(k) - r);
    lFloor += kFloor * (l - lFloor);
    rFloor += kFloor * (r - rFloor);
    left[i] = left[i]! + (l - lFloor) * envelope;
    right[i] = right[i]! + (r - rFloor) * envelope;
  }
}
