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
 * `density` is clicks per second.
 */
export function fillCrackle(data: Float32Array, sampleRate: number, density: number, random: () => number): void {
  data.fill(0);
  const clicks = Math.round((data.length / sampleRate) * density);
  const decay = Math.max(1, Math.round(sampleRate * 0.0025));
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
