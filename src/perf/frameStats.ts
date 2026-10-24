/** Width of one frame-time histogram bin, in milliseconds. */
export const BIN_MS = 0.25;
/** Frames slower than this land in the last bin. */
export const MAX_TRACKED_MS = 250;
/**
 * Gaps longer than this are the browser not rendering at all (a hidden or
 * occluded window, a debugger pause), not slow frames; they are counted as
 * stalls and kept out of the timings, as `FrameTimer` does.
 */
export const STALL_SECONDS = 1;

/** One measured window: frame rate and frame-time percentiles. */
export interface FrameSummary {
  readonly frames: number;
  readonly seconds: number;
  /** Frames rendered divided by elapsed time. */
  readonly fps: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly worstMs: number;
  /** Share of frames slower than 33.3 ms (below 30 FPS). */
  readonly over33Ms: number;
  /** Rendering gaps over `STALL_SECONDS`, excluded from everything above. */
  readonly stalls: number;
  readonly stalledSeconds: number;
}

/**
 * Frame-time histogram for a measurement window: constant memory however
 * many frames it sees, with percentiles accurate to one bin (0.25 ms).
 */
export class FrameStats {
  private readonly bins = new Uint32Array(Math.ceil(MAX_TRACKED_MS / BIN_MS) + 1);
  private frames = 0;
  private totalMs = 0;
  private worst = 0;
  private slow = 0;
  private stallCount = 0;
  private stallSeconds = 0;

  /**
   * Feed one rendered frame's real delta in seconds. Returns false when the
   * delta was not timed: invalid, or a stall.
   */
  record(deltaSeconds: number): boolean {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return false;
    if (deltaSeconds > STALL_SECONDS) {
      this.stallCount++;
      this.stallSeconds += deltaSeconds;
      return false;
    }
    const ms = deltaSeconds * 1000;
    this.bins[Math.min(this.bins.length - 1, Math.floor(ms / BIN_MS))]!++;
    this.frames++;
    this.totalMs += ms;
    this.worst = Math.max(this.worst, ms);
    if (ms > 1000 / 30) this.slow++;
    return true;
  }

  get count(): number {
    return this.frames;
  }

  /** Upper edge of the bin holding the `q` quantile (0–1); 0 with no frames. */
  percentile(q: number): number {
    if (this.frames === 0) return 0;
    const target = Math.max(1, Math.ceil(q * this.frames));
    let seen = 0;
    for (let i = 0; i < this.bins.length; i++) {
      seen += this.bins[i]!;
      if (seen >= target) return Math.min(this.worst, (i + 1) * BIN_MS);
    }
    return this.worst;
  }

  summary(): FrameSummary {
    const seconds = this.totalMs / 1000;
    return {
      frames: this.frames,
      seconds,
      fps: seconds > 0 ? this.frames / seconds : 0,
      meanMs: this.frames ? this.totalMs / this.frames : 0,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      worstMs: this.worst,
      over33Ms: this.frames ? this.slow / this.frames : 0,
      stalls: this.stallCount,
      stalledSeconds: this.stallSeconds,
    };
  }

  reset(): void {
    this.bins.fill(0);
    this.frames = 0;
    this.totalMs = 0;
    this.worst = 0;
    this.slow = 0;
    this.stallCount = 0;
    this.stallSeconds = 0;
  }
}
