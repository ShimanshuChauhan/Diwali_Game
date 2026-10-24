/** Buckets kept per metric; long runs merge pairs rather than grow. */
export const SERIES_BUCKETS = 256;

/** Allowed rise from the early to the late part of a run before it counts as growth. */
export interface GrowthTolerance {
  /** Relative rise, e.g. 0.25 for 25 %. */
  readonly relative: number;
  /** Absolute rise always allowed, in the metric's own unit. */
  readonly absolute: number;
}

export const DEFAULT_TOLERANCE: GrowthTolerance = { relative: 0.25, absolute: 2 };

/**
 * A metric's history at constant memory: up to `SERIES_BUCKETS` buckets of
 * mean and max. When full, neighbouring buckets merge and each bucket then
 * covers twice as many samples, so a 30-minute run costs what a 1-minute
 * one does.
 */
export class ResourceSeries {
  private readonly sums = new Float64Array(SERIES_BUCKETS);
  private readonly counts = new Uint32Array(SERIES_BUCKETS);
  private readonly maxes = new Float64Array(SERIES_BUCKETS);
  private used = 0;
  private perBucket = 1;
  private total = 0;
  private lowest = Infinity;
  private highest = -Infinity;

  record(value: number): void {
    if (!Number.isFinite(value)) return;
    this.total++;
    this.lowest = Math.min(this.lowest, value);
    this.highest = Math.max(this.highest, value);
    let i = this.used - 1;
    if (i < 0 || this.counts[i]! >= this.perBucket) {
      if (this.used === SERIES_BUCKETS) this.halve();
      i = this.used++;
      this.sums[i] = 0;
      this.counts[i] = 0;
      this.maxes[i] = -Infinity;
    }
    this.sums[i]! += value;
    this.counts[i]!++;
    this.maxes[i] = Math.max(this.maxes[i]!, value);
  }

  get samples(): number {
    return this.total;
  }

  get min(): number {
    return this.total ? this.lowest : 0;
  }

  get max(): number {
    return this.total ? this.highest : 0;
  }

  get buckets(): number {
    return this.used;
  }

  /** Mean and peak over buckets [from, to) of the series, as fractions of its length. */
  window(from: number, to: number): { mean: number; max: number } {
    const start = Math.floor(from * this.used);
    const end = Math.max(start + 1, Math.floor(to * this.used));
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    for (let i = start; i < Math.min(end, this.used); i++) {
      sum += this.sums[i]!;
      count += this.counts[i]!;
      max = Math.max(max, this.maxes[i]!);
    }
    return count ? { mean: sum / count, max } : { mean: 0, max: 0 };
  }

  private halve(): void {
    const half = this.used >> 1;
    for (let i = 0; i < half; i++) {
      const a = i * 2;
      const b = a + 1;
      this.sums[i] = this.sums[a]! + this.sums[b]!;
      this.counts[i] = this.counts[a]! + this.counts[b]!;
      this.maxes[i] = Math.max(this.maxes[a]!, this.maxes[b]!);
    }
    this.used = half;
    this.perBucket *= 2;
  }
}

/** How one metric behaved over a run. */
export interface GrowthReport {
  readonly metric: string;
  readonly samples: number;
  readonly min: number;
  readonly max: number;
  /** Mean over the second quarter of the run (the first is warm-up). */
  readonly earlyMean: number;
  /** Mean over the last quarter of the run. */
  readonly lateMean: number;
  readonly limit: number | null;
  /** Peak went above its budget. */
  readonly overLimit: boolean;
  /** Late level and peak both rose beyond tolerance: treat as unbounded. */
  readonly growing: boolean;
}

/** Judge a series: did it plateau, or keep climbing? */
export function growthReport(
  metric: string,
  series: ResourceSeries,
  limit: number | null = null,
  tolerance: GrowthTolerance = DEFAULT_TOLERANCE,
): GrowthReport {
  const early = series.window(0.25, 0.5);
  const late = series.window(0.75, 1);
  const allowed = early.mean * (1 + tolerance.relative) + tolerance.absolute;
  return {
    metric,
    samples: series.samples,
    min: series.min,
    max: series.max,
    earlyMean: early.mean,
    lateMean: late.mean,
    limit,
    overLimit: limit !== null && series.max > limit,
    growing: series.buckets >= 4 && late.mean > allowed && late.max > early.max,
  };
}

/** Reading for one sample: metric name → current value (missing metrics are skipped). */
export type ResourceSample = Readonly<Record<string, number | undefined>>;

export interface ResourceTrackerOptions {
  /** Budgets to check peaks against, by metric. */
  readonly limits?: Readonly<Record<string, number>>;
  /** Per-metric tolerance; `DEFAULT_TOLERANCE` otherwise. */
  readonly tolerances?: Readonly<Record<string, GrowthTolerance>>;
}

/**
 * Tracks resource counts (particles, lights, voices, placed props, heap
 * size, GPU objects…) across a long session and reports any that grow
 * without bound or exceed their budget. Renderer-free.
 */
export class ResourceTracker {
  private readonly series = new Map<string, ResourceSeries>();
  private readonly limits: Readonly<Record<string, number>>;
  private readonly tolerances: Readonly<Record<string, GrowthTolerance>>;

  constructor(options: ResourceTrackerOptions = {}) {
    this.limits = options.limits ?? {};
    this.tolerances = options.tolerances ?? {};
  }

  record(sample: ResourceSample): void {
    for (const metric in sample) {
      const value = sample[metric];
      if (value === undefined) continue;
      let series = this.series.get(metric);
      if (!series) this.series.set(metric, (series = new ResourceSeries()));
      series.record(value);
    }
  }

  get metrics(): readonly string[] {
    return [...this.series.keys()];
  }

  report(): GrowthReport[] {
    return [...this.series].map(([metric, series]) =>
      growthReport(metric, series, this.limits[metric] ?? null, this.tolerances[metric] ?? DEFAULT_TOLERANCE),
    );
  }

  /** True when no metric grew without bound or broke its budget. */
  get bounded(): boolean {
    return this.report().every((r) => !r.growing && !r.overLimit);
  }

  reset(): void {
    this.series.clear();
  }
}
