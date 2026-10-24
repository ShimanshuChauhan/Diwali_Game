import { describe, expect, it } from 'vitest';
import { CapacityBudget } from '../src/capacity';
import { createGameEventBus } from '../src/core/events';
import { qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import type { QualityLevel } from '../src/core/types';
import { Crackers } from '../src/crackers';
import { Interaction } from '../src/interaction';
import {
  DEFAULT_PLAN,
  FrameStats,
  ResourceSeries,
  ResourceTracker,
  StressRun,
  StressScenario,
  stressLimits,
  stressPlanFromQuery,
  stressSites,
  type StressPlan,
} from '../src/perf';
import { SERIES_BUCKETS } from '../src/perf/resourceTracker';
import { createWorld } from '../src/world';

const STEP = 1 / 60;

describe('FrameStats', () => {
  it('reports fps, mean and percentiles of the recorded frames', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 90; i++) stats.record(1 / 60);
    for (let i = 0; i < 10; i++) stats.record(0.05);
    const s = stats.summary();
    expect(s.frames).toBe(100);
    expect(s.p50Ms).toBeCloseTo(16.75, 1);
    expect(s.p95Ms).toBeCloseTo(50, 0);
    expect(s.worstMs).toBeCloseTo(50, 5);
    expect(s.over33Ms).toBeCloseTo(0.1, 5);
    expect(s.fps).toBeCloseTo(100 / (90 / 60 + 0.5), 5);
  });

  it('counts gaps over a second as stalls, outside the timings', () => {
    const stats = new FrameStats();
    for (let i = 0; i < 60; i++) stats.record(1 / 60);
    expect(stats.record(12)).toBe(false);
    expect(stats.summary()).toMatchObject({ frames: 60, stalls: 1, stalledSeconds: 12 });
    expect(stats.summary().fps).toBeCloseTo(60, 5);
    expect(stats.summary().worstMs).toBeCloseTo(1000 / 60, 5);
  });

  it('ignores bogus deltas and resets to empty', () => {
    const stats = new FrameStats();
    stats.record(0);
    stats.record(-1);
    stats.record(Number.NaN);
    expect(stats.count).toBe(0);
    expect(stats.summary().fps).toBe(0);
    stats.record(0.02);
    stats.reset();
    expect(stats.summary()).toMatchObject({ frames: 0, worstMs: 0 });
  });
});

describe('ResourceSeries and growth', () => {
  it('keeps constant memory over a long run while preserving min, max and mean', () => {
    const series = new ResourceSeries();
    for (let i = 0; i < 100_000; i++) series.record(i % 10);
    expect(series.buckets).toBeLessThanOrEqual(SERIES_BUCKETS);
    expect(series.samples).toBe(100_000);
    expect(series.min).toBe(0);
    expect(series.max).toBe(9);
    expect(series.window(0, 1).mean).toBeCloseTo(4.5, 1);
  });

  it('flags a steadily climbing metric but not a capped, noisy one', () => {
    const tracker = new ResourceTracker({ limits: { particles: 4000 } });
    for (let t = 0; t < 1800; t++) {
      tracker.record({ particles: t % 7 === 0 ? 4000 : 2500 + 1000 * Math.sin(t / 5), leak: t * 0.5 });
    }
    const byMetric = Object.fromEntries(tracker.report().map((r) => [r.metric, r]));
    expect(byMetric.particles).toMatchObject({ growing: false, overLimit: false, max: 4000 });
    expect(byMetric.leak!.growing).toBe(true);
    expect(tracker.bounded).toBe(false);
  });

  it('flags a peak above its budget', () => {
    const tracker = new ResourceTracker({ limits: { lights: 2 } });
    for (let t = 0; t < 100; t++) tracker.record({ lights: t === 50 ? 3 : 1 });
    expect(tracker.report()[0]).toMatchObject({ overLimit: true, growing: false });
  });

  it('skips undefined readings, e.g. heap size outside Chromium', () => {
    const tracker = new ResourceTracker();
    tracker.record({ heapMb: undefined, voices: 3 });
    expect(tracker.metrics).toEqual(['voices']);
  });
});

describe('StressRun', () => {
  const plan: StressPlan = {
    levels: ['low', 'high'],
    warmupSeconds: 1,
    measureSeconds: 2,
    soakLevel: 'low',
    soakSeconds: 180,
    sampleInterval: 1,
    viewport: null,
  };

  it('warms up and measures each profile, then soaks and reports once', () => {
    const levels: QualityLevel[] = [];
    const reports: unknown[] = [];
    const run = new StressRun({
      plan,
      setLevel: (level) => levels.push(level),
      sample: () => ({ particles: 100 }),
      limits: { particles: 4000 },
      onDone: (report) => reports.push(report),
    });
    expect(run.phase).toBe('warmup');
    expect(run.level).toBe('low');
    for (let i = 0; i < 60 * 3.5; i++) run.frame(STEP);
    expect(run.level).toBe('high');
    for (let i = 0; i < 60 * 3; i++) run.frame(STEP * 2); // 30 FPS on High
    expect(run.phase).toBe('soak');
    for (let i = 0; i < 60 * 182; i++) run.frame(STEP); // 1 s settle + 180 s soak
    expect(run.phase).toBe('done');
    expect(levels).toEqual(['low', 'high', 'low']);
    expect(reports).toHaveLength(1);

    const report = run.report();
    expect(report.profiles.map((p) => p.level)).toEqual(['low', 'high']);
    expect(report.profiles[0]!.frames.fps).toBeCloseTo(60, 0);
    expect(report.profiles[1]!.frames.fps).toBeCloseTo(30, 0);
    expect(report.soak).toMatchObject({ level: 'low', bounded: true });
    expect(report.soak!.fpsPerMinute).toHaveLength(3);
    expect(report.soak!.resources[0]).toMatchObject({ metric: 'particles', max: 100 });
    // Frames after the end change nothing.
    run.frame(STEP);
    expect(reports).toHaveLength(1);
  });

  it('runs phases on rendered time, so a stall neither ends nor skews a measurement', () => {
    const run = new StressRun({ plan: { ...plan, levels: ['low'] }, setLevel: () => {}, sample: () => ({}) });
    for (let i = 0; i < 60; i++) run.frame(STEP); // warm-up done
    expect(run.phase).toBe('measure');
    run.frame(30); // window hidden for 30 s
    expect(run.phase).toBe('measure');
    for (let i = 0; i < 60 * 2 + 1; i++) run.frame(STEP);
    const low = run.report().profiles[0]!.frames;
    expect(low).toMatchObject({ stalls: 1, stalledSeconds: 30 });
    expect(low.fps).toBeCloseTo(60, 0);
  });

  it('reports the soak so far while it is still running', () => {
    const run = new StressRun({ plan: { ...plan, levels: [] }, setLevel: () => {}, sample: () => ({ x: 1 }) });
    expect(run.phase).toBe('soak');
    for (let i = 0; i < 60 * 10; i++) run.frame(STEP);
    // The first second settles and is not measured.
    expect(run.report().soak?.frames.frames).toBeCloseTo(540, -1);
    expect(run.remaining).toBeCloseTo(171, 0);
  });
});

describe('stressPlanFromQuery', () => {
  it('is off without the stress flag', () => {
    expect(stressPlanFromQuery('?perf')).toBeNull();
  });

  it('uses the default plan for a bare flag', () => {
    expect(stressPlanFromQuery('?stress')).toEqual(DEFAULT_PLAN);
  });

  it('reads levels, timings and the soak, ignoring junk', () => {
    expect(stressPlanFromQuery('?stress&levels=low,ultra,high&warmup=5&measure=x&soak=30&soakLevel=medium')).toEqual({
      ...DEFAULT_PLAN,
      levels: ['low', 'high'],
      warmupSeconds: 5,
      soakSeconds: 1800,
      soakLevel: 'medium',
    });
  });

  it('pins the canvas to 1280×720 unless told otherwise', () => {
    expect(stressPlanFromQuery('?stress')!.viewport).toEqual({ width: 1280, height: 720 });
    expect(stressPlanFromQuery('?stress&viewport=1600x900')!.viewport).toEqual({ width: 1600, height: 900 });
    expect(stressPlanFromQuery('?stress&viewport=window')!.viewport).toBeNull();
    expect(stressPlanFromQuery('?stress&viewport=0x5')!.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe('stressLimits', () => {
  it('takes cracker caps from tuning and the rest from the profile', () => {
    expect(stressLimits('low')).toEqual({
      placedProps: TUNING.caps.maxPlacedCrackers,
      litCrackers: TUNING.caps.maxLitCrackers,
      activeEffects: qualityProfile('low').maxActiveEffects,
      particles: qualityProfile('low').maxParticles,
      dynamicLights: qualityProfile('low').maxDynamicLights,
      audioVoices: qualityProfile('low').maxAudioVoices,
    });
  });
});

describe('StressScenario', () => {
  function setup() {
    const bus = createGameEventBus();
    const world = createWorld();
    const capacity = new CapacityBudget({ crackers: () => crackers, bus, quality: qualityProfile('low') });
    const crackers = new Crackers({ bus, admission: capacity, random: () => 0.5 });
    const interaction = new Interaction({ world, crackers: () => crackers.list(), hasRoom: () => capacity.hasRoom() });
    const validate = (r: Parameters<Interaction['validatePlacement']>[0]) => interaction.validatePlacement(r);
    const scenario = new StressScenario({
      crackers,
      validatePlacement: validate,
      groundSites: stressSites(validate, 'anar', { minX: -3, maxX: 3, minZ: -6, maxZ: 2 }),
      rocketSites: stressSites(validate, 'rocket', { minX: -3, maxX: 3, minZ: -14, maxZ: -9 }, 2),
    });
    const step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        scenario.update(STEP);
        crackers.update(STEP);
        capacity.update(STEP);
      }
    };
    return { scenario, crackers, capacity, step, validate };
  }

  it('finds valid ground and rocket sites in view of the spawn', () => {
    const { validate } = setup();
    expect(stressSites(validate, 'anar', { minX: -3, maxX: 3, minZ: -6, maxZ: 2 }).length).toBeGreaterThanOrEqual(
      TUNING.caps.maxPlacedCrackers,
    );
    expect(stressSites(validate, 'rocket', { minX: -3, maxX: 3, minZ: -14, maxZ: -9 }, 2).length).toBeGreaterThan(0);
  });

  it('drives every cap to its limit and gets capacity rejections, never exceeding a cap', () => {
    const { scenario, crackers, capacity, step } = setup();
    let peakPlaced = 0;
    let peakLit = 0;
    for (let s = 0; s < 120; s++) {
      step(1);
      peakPlaced = Math.max(peakPlaced, crackers.list().length);
      peakLit = Math.max(peakLit, crackers.litCount);
    }
    const c = scenario.counters;
    expect(peakPlaced).toBe(TUNING.caps.maxPlacedCrackers);
    expect(peakLit).toBe(TUNING.caps.maxLitCrackers);
    expect(c.placementRejections.capacity).toBeGreaterThan(0);
    expect(c.ignitionRejections.capacity).toBeGreaterThan(0);
    expect(c.rockets).toBeGreaterThan(10);
    expect(c.ignited).toBeGreaterThan(20);
    expect(c.sparklers).toBeGreaterThanOrEqual(4); // a 30 s phuljhari relit throughout
    expect(capacity.stats.resources.placedProps.used).toBeLessThanOrEqual(TUNING.caps.maxPlacedCrackers);
  });

  it('keeps going after a session reset', () => {
    const { scenario, crackers, step } = setup();
    step(10);
    crackers.reset();
    scenario.reset();
    const before = scenario.counters.ignited;
    step(20);
    expect(scenario.counters.ignited).toBeGreaterThan(before);
  });
});
