import type { CapacityResource } from '../capacity';
import type { PlacementRequest, PlacementResult } from '../core/contracts';
import { qualityProfile } from '../core/quality';
import { TUNING } from '../core/tuning';
import { isQualityLevel } from '../quality/qualitySettings';
import type { QualityLevel } from '../core/types';
import { StressScenario, stressSites, type StressCrackers, type StressCounters } from './stressScenario';
import { DEFAULT_PLAN, StressRun, type StressPlan, type StressReport } from './stressRun';
import type { ResourceSample } from './resourceTracker';

/** Query flag that turns the stress test on, e.g. `?stress&soak=15`. */
export const STRESS_PARAM = 'stress';

/** Lane strip in front of the spawn (which looks down -Z), in view from it. */
const GROUND_AREA = { minX: -3, maxX: 3, minZ: -6, maxZ: 2 } as const;
const ROCKET_AREA = { minX: -3, maxX: 3, minZ: -14, maxZ: -9 } as const;
const ROCKET_SPACING = 2;

const number = (value: string | null, fallback: number): number => {
  const parsed = value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * The run plan from the page's query string, or null when `stress` is
 * absent. `levels=low,medium` picks profiles, `warmup`/`measure` are
 * seconds per profile, `soak` is minutes of sustained play and
 * `soakLevel` its profile. `viewport=1600x900` changes the fixed canvas
 * size (1280×720 by default) and `viewport=window` follows the window.
 */
export function stressPlanFromQuery(search: string): StressPlan | null {
  const params = new URLSearchParams(search);
  if (!params.has(STRESS_PARAM)) return null;
  const levels = params.get('levels');
  const parsedLevels = levels === null ? DEFAULT_PLAN.levels : levels.split(',').filter(isQualityLevel);
  const soakLevel = params.get('soakLevel');
  return {
    levels: parsedLevels,
    warmupSeconds: number(params.get('warmup'), DEFAULT_PLAN.warmupSeconds),
    measureSeconds: number(params.get('measure'), DEFAULT_PLAN.measureSeconds),
    soakLevel: soakLevel !== null && isQualityLevel(soakLevel) ? soakLevel : DEFAULT_PLAN.soakLevel,
    soakSeconds: number(params.get('soak'), DEFAULT_PLAN.soakSeconds / 60) * 60,
    sampleInterval: DEFAULT_PLAN.sampleInterval,
    viewport: viewportFrom(params.get('viewport')),
  };
}

function viewportFrom(value: string | null): StressPlan['viewport'] {
  if (value === 'window') return null;
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return width > 0 && height > 0 ? { width, height } : DEFAULT_PLAN.viewport;
}

/** Budgets the soak's resource peaks are checked against. */
export function stressLimits(level: QualityLevel): Record<CapacityResource, number> {
  const profile = qualityProfile(level);
  return {
    placedProps: TUNING.caps.maxPlacedCrackers,
    litCrackers: TUNING.caps.maxLitCrackers,
    activeEffects: profile.maxActiveEffects,
    particles: profile.maxParticles,
    dynamicLights: profile.maxDynamicLights,
    audioVoices: profile.maxAudioVoices,
  };
}

export interface StressHarnessOptions {
  readonly plan: StressPlan;
  readonly crackers: StressCrackers;
  readonly validatePlacement: (request: PlacementRequest) => PlacementResult;
  readonly setLevel: (level: QualityLevel) => void;
  /** Current resource counts: budgets, heap, GPU objects. */
  readonly sample: () => ResourceSample;
  /** Where the finished report goes; the console by default. */
  readonly onDone?: (report: StressReport) => void;
}

export interface StressHarness {
  readonly scenario: StressScenario;
  readonly run: StressRun;
  /** Per fixed simulation step while the session runs. */
  update(dt: number): void;
  /** Per rendered frame, with its real delta. */
  frame(deltaSeconds: number): void;
  /** Report plus the scenario's counters, as plain JSON-ready data. */
  snapshot(): { report: StressReport; counters: StressCounters };
}

/**
 * Wires the scripted scenario to the stress run. The page exposes
 * `snapshot()` as `window.__stress` so a run can be read from DevTools or
 * browser automation (see docs/performance.md).
 */
export function createStressHarness(options: StressHarnessOptions): StressHarness {
  const { validatePlacement, crackers, plan } = options;
  const scenario = new StressScenario({
    crackers,
    validatePlacement,
    groundSites: stressSites(validatePlacement, 'anar', GROUND_AREA),
    rocketSites: stressSites(validatePlacement, 'rocket', ROCKET_AREA, ROCKET_SPACING),
  });
  const run = new StressRun({
    plan,
    setLevel: options.setLevel,
    sample: options.sample,
    limits: stressLimits(plan.soakLevel),
    tolerances: { heapMb: { relative: 0.2, absolute: 8 } },
    onDone: (report) => (options.onDone ?? logReport)(report),
  });
  return {
    scenario,
    run,
    update: (dt) => {
      if (run.phase !== 'done') scenario.update(dt);
    },
    frame: (delta) => run.frame(delta),
    snapshot: () => ({ report: run.report(), counters: scenario.counters }),
  };
}

function logReport(report: StressReport): void {
  console.info('[stress] done', JSON.stringify(report, null, 2));
}
