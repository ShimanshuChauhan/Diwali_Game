import type { BurstPattern } from '../core/types';
import type { CrackerDefinition } from './definitions';

/** One rocket's randomised flight, rolled when its fuse is lit. */
export interface RocketVariant {
  readonly pattern: BurstPattern;
  /** 0xRRGGBB, distinct, at least one. */
  readonly colours: readonly number[];
  /** Seconds from launch to burst. */
  readonly ascent: number;
  /** Metres risen before the burst. */
  readonly apexHeight: number;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

/**
 * Roll a variant: burst shape, a themed palette and colours from it, and timing. Height scales with the
 * ascent time so every rocket climbs at the nominal speed the trail and
 * sound assume, and a longer flight simply bursts higher.
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
  return {
    pattern,
    colours,
    ascent: definition.activeDuration * scale,
    apexHeight: apexHeight * scale,
  };
}
