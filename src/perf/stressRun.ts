import type { QualityLevel } from '../core/types';
import { FrameStats, STALL_SECONDS, type FrameSummary } from './frameStats';
import { ResourceTracker, type GrowthReport, type ResourceSample, type ResourceTrackerOptions } from './resourceTracker';

/** One stress run: a timed measurement per profile, then a long soak. */
export interface StressPlan {
  /** Profiles measured in turn. */
  readonly levels: readonly QualityLevel[];
  /** Seconds of play before measuring each profile, so caps are already full. */
  readonly warmupSeconds: number;
  readonly measureSeconds: number;
  /**
   * Profile held for the sustained session, after its own warm-up; none
   * when `soakSeconds` is 0.
   */
  readonly soakLevel: QualityLevel;
  readonly soakSeconds: number;
  /** Seconds between resource samples during the soak. */
  readonly sampleInterval: number;
  /** Fixed canvas size in CSS pixels; null follows the window. */
  readonly viewport: { readonly width: number; readonly height: number } | null;
}

export const DEFAULT_PLAN: StressPlan = {
  levels: ['low', 'medium', 'high'],
  warmupSeconds: 15,
  measureSeconds: 60,
  soakLevel: 'low',
  soakSeconds: 15 * 60,
  sampleInterval: 1,
  viewport: { width: 1280, height: 720 },
};

export type StressPhase = 'warmup' | 'measure' | 'soak' | 'done';

export interface ProfileResult {
  readonly level: QualityLevel;
  readonly frames: FrameSummary;
}

export interface SoakResult {
  readonly level: QualityLevel;
  readonly frames: FrameSummary;
  /** Mean FPS of each whole minute of rendering, to show the rate holds over time. */
  readonly fpsPerMinute: readonly number[];
  readonly resources: readonly GrowthReport[];
  /** No resource grew without bound or exceeded its budget. */
  readonly bounded: boolean;
}

export interface StressReport {
  readonly phase: StressPhase;
  readonly profiles: readonly ProfileResult[];
  readonly soak: SoakResult | null;
}

export interface StressRunOptions extends ResourceTrackerOptions {
  readonly plan?: StressPlan;
  /** Switch the game's quality profile. */
  readonly setLevel: (level: QualityLevel) => void;
  /** Current resource counts, sampled during the soak. */
  readonly sample: () => ResourceSample;
  /** Called once when the run finishes. */
  readonly onDone?: (report: StressReport) => void;
}

/**
 * Drives a stress run from the render loop: switches profiles, measures
 * frame times after a warm-up, then holds one profile for the sustained
 * session while sampling resources for unbounded growth. Renderer-free;
 * feed `frame` each rendered frame's real delta in seconds.
 */
export class StressRun {
  readonly plan: StressPlan;

  private readonly options: StressRunOptions;
  private readonly frames = new FrameStats();
  private readonly minute = new FrameStats();
  private readonly tracker: ResourceTracker;
  private readonly profiles: ProfileResult[] = [];
  private readonly fpsPerMinute: number[] = [];
  private soak: SoakResult | null = null;
  private current: StressPhase = 'warmup';
  private levelIndex = 0;
  private phaseTime = 0;
  private sampleTimer = 0;

  constructor(options: StressRunOptions) {
    this.options = options;
    this.plan = options.plan ?? DEFAULT_PLAN;
    this.tracker = new ResourceTracker(options);
    if (this.plan.levels.length) options.setLevel(this.plan.levels[0]!);
    else this.startSoak();
  }

  get phase(): StressPhase {
    return this.current;
  }

  /** Profile currently being measured or soaked; null once done. */
  get level(): QualityLevel | null {
    if (this.current === 'done') return null;
    return this.current === 'soak' ? this.plan.soakLevel : this.plan.levels[this.levelIndex]!;
  }

  /** Seconds left in the current phase. */
  get remaining(): number {
    const { warmupSeconds, measureSeconds, soakSeconds } = this.plan;
    const length = { warmup: warmupSeconds, measure: measureSeconds, soak: warmupSeconds + soakSeconds, done: 0 }[this.current];
    return Math.max(0, length - this.phaseTime);
  }

  frame(deltaSeconds: number): void {
    if (this.current === 'done' || !(deltaSeconds > 0)) return;
    // Phases run on rendered time: a stall is logged but does not use up
    // a profile's measurement window or the soak.
    if (deltaSeconds > STALL_SECONDS) {
      this.frames.record(deltaSeconds);
      return;
    }
    this.phaseTime += deltaSeconds;
    if (this.current === 'warmup') {
      if (this.phaseTime >= this.plan.warmupSeconds) this.enter('measure');
    } else if (this.current === 'measure') {
      this.frames.record(deltaSeconds);
      if (this.phaseTime >= this.plan.measureSeconds) this.finishProfile();
    } else {
      this.soakFrame(deltaSeconds);
    }
  }

  report(): StressReport {
    return { phase: this.current, profiles: [...this.profiles], soak: this.soak ?? this.soakSoFar() };
  }

  private soakFrame(deltaSeconds: number): void {
    // Settle first: effects started under the previous profile run out
    // under its limits, so they must not count against the soak's.
    if (this.phaseTime <= this.plan.warmupSeconds) return;
    this.frames.record(deltaSeconds);
    this.minute.record(deltaSeconds);
    // Float sums of frame deltas land a hair under a whole minute.
    if (this.minute.summary().seconds >= 60 - 1e-6) {
      this.fpsPerMinute.push(this.minute.summary().fps);
      this.minute.reset();
    }
    if ((this.sampleTimer -= deltaSeconds) <= 0) {
      this.sampleTimer += this.plan.sampleInterval;
      this.tracker.record(this.options.sample());
    }
    if (this.phaseTime >= this.plan.warmupSeconds + this.plan.soakSeconds) {
      this.soak = this.soakSoFar();
      this.enter('done');
      this.options.onDone?.(this.report());
    }
  }

  private finishProfile(): void {
    this.profiles.push({ level: this.plan.levels[this.levelIndex]!, frames: this.frames.summary() });
    this.levelIndex++;
    if (this.levelIndex < this.plan.levels.length) {
      this.options.setLevel(this.plan.levels[this.levelIndex]!);
      this.enter('warmup');
    } else {
      this.startSoak();
    }
  }

  private startSoak(): void {
    if (this.plan.soakSeconds <= 0) {
      this.enter('done');
      this.options.onDone?.(this.report());
      return;
    }
    this.options.setLevel(this.plan.soakLevel);
    this.sampleTimer = 0;
    this.enter('soak');
  }

  private soakSoFar(): SoakResult | null {
    if (this.current !== 'soak' && this.soak === null) return null;
    const resources = this.tracker.report();
    return {
      level: this.plan.soakLevel,
      frames: this.frames.summary(),
      fpsPerMinute: [...this.fpsPerMinute],
      resources,
      bounded: resources.every((r) => !r.growing && !r.overLimit),
    };
  }

  private enter(phase: StressPhase): void {
    this.current = phase;
    this.phaseTime = 0;
    if (phase !== 'done') this.frames.reset();
    this.minute.reset();
  }
}
