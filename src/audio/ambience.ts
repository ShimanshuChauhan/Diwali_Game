/**
 * Timing for distant ambient crackers: irregular pops, sometimes in quick
 * clusters, spread around the horizon. Pure and seeded via `random` so it
 * can be tested headless; the audio engine turns each pop into a voice.
 */
export interface DistantPop {
  /** Direction around the listener in radians about +Y. */
  readonly azimuth: number;
  /** Metres; further pops are quieter and duller. */
  readonly distance: number;
  /** Relative loudness in (0, 1]. */
  readonly intensity: number;
}

export interface AmbienceOptions {
  /** Average seconds between pop clusters. */
  readonly meanInterval: number;
  /** Chance a pop is followed quickly by another. */
  readonly clusterChance: number;
  readonly minDistance: number;
  readonly maxDistance: number;
}

export const AMBIENCE: AmbienceOptions = {
  meanInterval: 1.6,
  clusterChance: 0.35,
  minDistance: 80,
  maxDistance: 250,
};

/** Smallest gap between pops, so a cluster never stacks on one instant. */
const MIN_GAP = 0.08;

export class AmbienceScheduler {
  private untilNext: number;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly options: AmbienceOptions = AMBIENCE,
  ) {
    this.untilNext = this.interval();
  }

  /** Advance by `dt` seconds and return the pops due in that span. */
  update(dt: number): DistantPop[] {
    const pops: DistantPop[] = [];
    this.untilNext -= Math.max(0, dt);
    while (this.untilNext <= 0) {
      pops.push(this.pop());
      const clustered = this.random() < this.options.clusterChance;
      this.untilNext += clustered ? MIN_GAP + this.random() * 0.25 : this.interval();
    }
    return pops;
  }

  reset(): void {
    this.untilNext = this.interval();
  }

  /** Exponentially distributed gap, floored so pops never pile up. */
  private interval(): number {
    const u = Math.min(this.random(), 0.999999);
    return Math.max(MIN_GAP, -Math.log(1 - u) * this.options.meanInterval);
  }

  private pop(): DistantPop {
    const { minDistance, maxDistance } = this.options;
    const distance = minDistance + this.random() * (maxDistance - minDistance);
    return {
      azimuth: this.random() * Math.PI * 2,
      distance,
      intensity: 0.4 + 0.6 * this.random(),
    };
  }
}
