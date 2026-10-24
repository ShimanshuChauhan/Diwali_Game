import type { CapacityStats } from '../capacity';
import type { QualityLevel } from '../core/types';

/** Frames kept for the rolling FPS / frame-time window. */
export const FRAME_WINDOW = 120;

/**
 * Rolling frame-time window over a fixed ring buffer: constant memory however
 * long the session runs. Feed it each rendered frame's real delta in seconds.
 */
export class FrameTimer {
  private readonly samples: Float64Array;
  private next = 0;
  private filled = 0;
  private sum = 0;

  constructor(capacity: number = FRAME_WINDOW) {
    this.samples = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  /** Window length; the most frames ever averaged. */
  get capacity(): number {
    return this.samples.length;
  }

  /** Frames currently in the window. */
  get count(): number {
    return this.filled;
  }

  record(deltaSeconds: number): void {
    // Ignore paused tabs' giant gaps and bogus values rather than skew the window.
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > 1) return;
    const ms = deltaSeconds * 1000;
    if (this.filled === this.samples.length) this.sum -= this.samples[this.next]!;
    else this.filled++;
    this.samples[this.next] = ms;
    this.sum += ms;
    this.next = (this.next + 1) % this.samples.length;
  }

  /** Mean frame time in milliseconds over the window; 0 before any frame. */
  get averageMs(): number {
    return this.filled ? this.sum / this.filled : 0;
  }

  /** Slowest frame in the window, in milliseconds. */
  get worstMs(): number {
    let worst = 0;
    for (let i = 0; i < this.filled; i++) worst = Math.max(worst, this.samples[i]!);
    return worst;
  }

  get fps(): number {
    const average = this.averageMs;
    return average > 0 ? 1000 / average : 0;
  }

  reset(): void {
    this.next = 0;
    this.filled = 0;
    this.sum = 0;
  }
}

/** One overlay reading: frame timing, renderer counters and resource budgets. */
export interface PerfSnapshot {
  readonly level: QualityLevel;
  readonly fps: number;
  readonly frameMs: number;
  readonly worstFrameMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly capacity: CapacityStats;
}

const pad = (value: number, width: number): string => String(value).padStart(width);

const ratio = ({ used, limit }: { used: number; limit: number }): string => `${used} / ${limit}`;

/** Overlay text, one counter per line; plain data so it is testable headless. */
export function perfLines(snapshot: PerfSnapshot): string[] {
  const r = snapshot.capacity.resources;
  return [
    `Quality    ${snapshot.level}`,
    `FPS        ${pad(Math.round(snapshot.fps), 3)}`,
    `Frame      ${snapshot.frameMs.toFixed(1)} ms (worst ${snapshot.worstFrameMs.toFixed(1)})`,
    `Draw calls ${snapshot.drawCalls}`,
    `Triangles  ${snapshot.triangles}`,
    `Particles  ${ratio(r.particles)}`,
    `Lights     ${ratio(r.dynamicLights)}`,
    `Voices     ${ratio(r.audioVoices)}`,
    `Effects    ${ratio(r.activeEffects)}`,
    `Placed     ${ratio(r.placedProps)}`,
    `Lit        ${ratio(r.litCrackers)}`,
    `Reclaimed  ${snapshot.capacity.reclaimedProps}`,
  ];
}
