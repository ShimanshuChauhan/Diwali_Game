import type { BurstPattern, RocketFlight } from '../core/types';
import type { CrackerDefinition } from './definitions';

/** Lean of a rocket's climb from vertical, radians: about 4–12 degrees. */
const MIN_LEAN = (4 * Math.PI) / 180;
const MAX_LEAN = (12 * Math.PI) / 180;

/** One rocket's randomised flight, rolled when its fuse is lit. */
export interface RocketVariant extends RocketFlight {
  readonly pattern: BurstPattern;
  /** 0xRRGGBB, distinct, at least one. */
  readonly colours: readonly number[];
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/**
 * Roll a variant: burst shape, a themed palette and colours from it,
 * timing, and a slight lean. Height scales with the ascent time so every
 * rocket climbs at the same average speed, and a longer flight simply
 * bursts higher.
 */
export function rollRocketVariant(definition: CrackerDefinition<'rocket'>, random: () => number): RocketVariant {
  const { patterns, palettes, colourCount, ascentScale, apexHeight } = definition.effect;
  const pattern = pick(patterns, random);
  const palette = pick(palettes, random);

  const [minColours, maxColours] = colourCount;
  const count = Math.min(palette.length, minColours + Math.floor(random() * (maxColours - minColours + 1)));
  const pool = [...palette];
  const colours: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    colours.push(pool.splice(index, 1)[0]!);
  }

  const [minScale, maxScale] = ascentScale;
  const scale = minScale + random() * (maxScale - minScale);
  const height = apexHeight * scale;
  // Rockets lean a little off vertical, each in its own direction.
  const lean = MIN_LEAN + random() * (MAX_LEAN - MIN_LEAN);
  const heading = random() * Math.PI * 2;
  const sideways = height * Math.tan(lean);
  return {
    pattern,
    colours,
    ascent: definition.activeDuration * scale,
    apexHeight: height,
    drift: { x: Math.cos(heading) * sideways, z: Math.sin(heading) * sideways },
  };
}
