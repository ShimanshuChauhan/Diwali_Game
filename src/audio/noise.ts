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
