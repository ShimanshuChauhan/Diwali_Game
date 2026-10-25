import type { LadiChain, LadiPop } from '../core/ladi';
import type { CrackerDefinition } from './definitions';

/** The fuse reaches the first banger this long after the ladi goes active, seconds. */
const FIRST_POP = 0.04;
/** Smoke and paper settle for this long after the last pop before it finishes, seconds. */
const SETTLE = 0.35;

/** Gaps between pops before scaling to the rolled burn time, seconds. */
const RATTLE = { min: 0.035, max: 0.095 } as const;
const DOUBLET = { min: 0.006, max: 0.018 } as const;
const STUMBLE = { min: 0.14, max: 0.3 } as const;

function within(range: { readonly min: number; readonly max: number }, random: () => number): number {
  return range.min + random() * (range.max - range.min);
}

/**
 * Roll a ladi's pops: a very rapid, slightly uneven rattle along the string,
 * with doublets where two bangers go off almost together, the odd stumble
 * and the odd louder bang. The whole chain is stretched to a burn time
 * rolled around the nominal active duration, so every ladi lasts a little
 * differently but always within a few seconds.
 */
export function rollLadiChain(definition: CrackerDefinition<'ladi'>, random: () => number): LadiChain {
  const { bangers, durationScale, doubletChance, stumbleChance, loudChance } = definition.effect;
  const gaps: number[] = [0];
  let raw = 0;
  for (let i = 1; i < bangers; i++) {
    const roll = random();
    const gap =
      roll < doubletChance
        ? within(DOUBLET, random)
        : roll < doubletChance + stumbleChance
          ? within(STUMBLE, random)
          : within(RATTLE, random);
    gaps.push(gap);
    raw += gap;
  }
  const [minScale, maxScale] = durationScale;
  const burn = definition.activeDuration * (minScale + random() * (maxScale - minScale)) - SETTLE - FIRST_POP;
  const stretch = raw > 0 ? Math.max(0, burn) / raw : 0;
  const pops: LadiPop[] = [];
  let time = FIRST_POP;
  for (let i = 0; i < bangers; i++) {
    time += gaps[i]! * stretch;
    pops.push({ time, banger: i, loud: random() < loudChance });
  }
  return { pops, duration: time + SETTLE };
}
