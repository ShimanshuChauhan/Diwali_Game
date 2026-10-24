import {
  AARTI_SONG_IDS,
  FAMILY_MEMBERS,
  type AartiCeremonyModule,
  type CommandResult,
  type DoorwayId,
  type HeldItemsModule,
  type LocationId,
  type Placement,
  type TransitionRejection,
  type TransitionSnapshot,
} from '../core/homes';
import type { CrackerType, QualityLevel } from '../core/types';
import { doorwayId } from '../homes/doorways';
import { isQualityLevel } from '../quality/qualitySettings';
import { FrameStats, type FrameSummary } from './frameStats';
import { ResourceTracker, type GrowthReport, type ResourceSample, type ResourceTrackerOptions } from './resourceTracker';
import { viewportFrom } from './stressHarness';

/** Query flag that turns the family-home tour on, e.g. `?tour&trips=30`. */
export const TOUR_PARAM = 'tour';

/**
 * Frames after a fade ends that still belong to its transition: the first
 * frames drawn of the new location, where a first-visit upload or compile
 * would land.
 */
export const TRANSITION_SETTLE_SECONDS = 0.25;

/** Per-transition peaks kept for the report; the percentiles cover every one. */
const LISTED_PEAKS = 200;

/** One family-home checkpoint run (issue #64), on one quality profile throughout. */
export interface TourPlan {
  readonly level: QualityLevel;
  /** Seconds of play before each scenario's measurement window. */
  readonly settleSeconds: number;
  readonly measureSeconds: number;
  /** Family home in and out; each trip is two transitions. */
  readonly roundTrips: number;
  /** Seconds spent on each side of the door per trip. */
  readonly dwellSeconds: number;
  /** Seconds between song changes during aarti. */
  readonly songSeconds: number;
  /** Fixed canvas size in CSS pixels; null follows the window. */
  readonly viewport: { readonly width: number; readonly height: number } | null;
}

export const DEFAULT_TOUR_PLAN: TourPlan = {
  level: 'low',
  settleSeconds: 10,
  measureSeconds: 60,
  roundTrips: 25,
  dwellSeconds: 3,
  songSeconds: 10,
  viewport: { width: 1280, height: 720 },
};

/**
 * The tour plan from the page's query string, or null when `tour` is
 * absent. `level` picks the profile (Low by default), `settle`/`measure`
 * are seconds per scenario, `trips` the door round trips, `dwell` seconds
 * either side of the door, `song` seconds between song changes, and
 * `viewport` the canvas size as for the stress test.
 */
export function tourPlanFromQuery(search: string): TourPlan | null {
  const params = new URLSearchParams(search);
  if (!params.has(TOUR_PARAM)) return null;
  const level = params.get('level');
  const d = DEFAULT_TOUR_PLAN;
  return {
    level: level !== null && isQualityLevel(level) ? level : d.level,
    settleSeconds: number(params.get('settle'), d.settleSeconds),
    measureSeconds: number(params.get('measure'), d.measureSeconds),
    roundTrips: Math.round(number(params.get('trips'), d.roundTrips)),
    dwellSeconds: number(params.get('dwell'), d.dwellSeconds),
    songSeconds: Math.max(1, number(params.get('song'), d.songSeconds)),
    viewport: viewportFrom(params.get('viewport')),
  };
}

function number(value: string | null, fallback: number): number {
  const parsed = value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** How the door fades rendered, kept apart from steady-state play. */
export interface HitchSummary {
  readonly count: number;
  /** Every frame inside a transition window (fade plus settle). */
  readonly frames: FrameSummary;
  /** Worst frame of each transition, in order (the first `LISTED_PEAKS`). */
  readonly peaksMs: readonly number[];
  /** Percentiles over the per-transition worst frames. */
  readonly peakP50Ms: number;
  readonly peakP95Ms: number;
  readonly peakMaxMs: number;
  /** Worst frame of the first transition into each location, where one-off costs would show. */
  readonly firstArrivalMs: Readonly<Partial<Record<LocationId, number>>>;
}

/**
 * Splits rendered frames into door transitions and the rest. A transition
 * runs from the frame its fade is first seen until `TRANSITION_SETTLE_SECONDS`
 * after the fade ends; its worst frame is its hitch. Constant memory apart
 * from the short list of peaks. Renderer-free.
 */
export class TransitionHitches {
  private readonly frames = new FrameStats();
  private readonly peaks = new FrameStats();
  private readonly listed: number[] = [];
  private readonly firstArrival: Partial<Record<LocationId, number>> = {};
  private open: { to: LocationId; worstMs: number; settled: number; ended: boolean } | null = null;
  private count = 0;

  /**
   * Feed each rendered frame's delta with the fade running at that frame,
   * or null. Returns true when the frame belongs to a transition.
   */
  frame(deltaSeconds: number, fade: TransitionSnapshot | null): boolean {
    let open = this.open;
    if (open?.ended && fade) {
      // A new fade inside the settle window: the old transition is over.
      this.close();
      open = null;
    }
    if (!open) {
      if (!fade) return false;
      open = this.open = { to: fade.to, worstMs: 0, settled: 0, ended: false };
    }
    if (!fade) open.ended = true;
    if (this.frames.record(deltaSeconds)) open.worstMs = Math.max(open.worstMs, deltaSeconds * 1000);
    // Float sums of frame deltas land a hair under the window.
    if (open.ended && (open.settled += Math.max(0, deltaSeconds)) >= TRANSITION_SETTLE_SECONDS - 1e-6) this.close();
    return true;
  }

  summary(): HitchSummary {
    const peaks = this.peaks.summary();
    return {
      count: this.count,
      frames: this.frames.summary(),
      peaksMs: [...this.listed],
      peakP50Ms: peaks.p50Ms,
      peakP95Ms: peaks.p95Ms,
      peakMaxMs: peaks.worstMs,
      firstArrivalMs: { ...this.firstArrival },
    };
  }

  private close(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    this.count++;
    if (open.worstMs > 0) this.peaks.record(open.worstMs / 1000);
    if (this.listed.length < LISTED_PEAKS) this.listed.push(open.worstMs);
    this.firstArrival[open.to] ??= open.worstMs;
  }
}

/** The slice of `Locations` the tour drives. */
export interface TourLocations {
  readonly location: LocationId;
  readonly transition: TransitionSnapshot | null;
  requestTransition(id: DoorwayId): CommandResult<TransitionRejection>;
}

export type TourCeremony = Pick<AartiCeremonyModule, 'snapshot' | 'join' | 'selectSong' | 'setCircling'>;
export type TourHands = Pick<HeldItemsModule, 'hands' | 'eat' | 'pickUpPlate' | 'offer' | 'returnPlate'>;

export type TourScenario = 'outdoors' | 'transitions' | 'aarti' | 'sweets';
export type TourPhase = TourScenario | 'done';

export interface TourOptions extends ResourceTrackerOptions {
  readonly plan?: TourPlan;
  readonly locations: TourLocations;
  readonly ceremony: TourCeremony;
  readonly hands: TourHands;
  /** Selecting a ground cracker puts the phuljhari away before aarti. */
  readonly crackers: { select(type: CrackerType): void };
  /** Outdoor fireworks at their caps (the stress scenario), stepped until aarti. */
  readonly fireworks: { update(dt: number): void };
  /** Where the player stands to join aarti and at the sweets table. */
  readonly stands: { readonly puja: Placement; readonly tray: Placement };
  /** Put the player at `placement` in the current location. */
  readonly standAt: (placement: Placement) => void;
  /** Current resource counts, sampled outdoors after every round trip. */
  readonly sample: () => ResourceSample;
  /** Actual drawing-buffer size, for the report. */
  readonly drawingBuffer?: () => { readonly width: number; readonly height: number };
  readonly onDone?: (report: TourReport) => void;
}

export interface TourCounters {
  transitions: number;
  aartiJoins: number;
  songChanges: number;
  aartiCompleted: boolean;
  eaten: number;
  platesTaken: number;
  offers: number;
  platesReturned: number;
  /** Refused commands as `action:reason`; a clean run has none. */
  refusals: Record<string, number>;
}

export interface TourReport {
  readonly phase: TourPhase;
  readonly level: QualityLevel;
  readonly viewport: TourPlan['viewport'];
  readonly drawingBuffer: { readonly width: number; readonly height: number } | null;
  /** Steady-state frames per scenario, transitions excluded. */
  readonly scenarios: readonly { readonly scenario: TourScenario; readonly frames: FrameSummary }[];
  readonly transitions: HitchSummary;
  /** Resources sampled outdoors after each round trip. */
  readonly resources: readonly GrowthReport[];
  /** No sampled resource grew across the round trips or broke its budget. */
  readonly bounded: boolean;
  readonly counters: TourCounters;
}

const ENTER = doorwayId('familyHome', 'enter');
const EXIT = doorwayId('familyHome', 'exit');
/** Circle the thali this long, then rest for `AARTI_REST`; seconds. */
const AARTI_CIRCLE = 2.5;
const AARTI_REST = 1;
/** Seconds between sweets actions. */
const SWEETS_ACTION = 0.75;
type SweetsAction = 'eat' | 'pickUpPlate' | 'returnPlate' | (typeof FAMILY_MEMBERS)[number];
/** One round at the sweets table: eat, take a plate, offer it to everyone, put it back. */
const SWEETS_ROUND: readonly SweetsAction[] = ['eat', 'eat', 'pickUpPlate', ...FAMILY_MEMBERS, 'returnPlate'];

type Script = Generator<void, void, number>;

/**
 * Scripted family-home checkpoint (issue #64): outdoor fireworks at their
 * caps, repeated door round trips with the fireworks still going, aarti with
 * the thali circling and the song changing, then the sweets table: eating,
 * taking the plate and offering it round. It goes through the same module
 * commands a player's E and click reach, on one quality profile.
 *
 * Steady-state frames are measured per scenario after a settle period;
 * frames during door fades are kept apart as transition hitches. Resources
 * are sampled outdoors after every round trip to show repeated visits do not
 * grow them. Renderer-free: call `update` from the fixed simulation step and
 * `frame` from the render loop.
 */
export class HomesTour {
  readonly plan: TourPlan;
  readonly counters: TourCounters = {
    transitions: 0,
    aartiJoins: 0,
    songChanges: 0,
    aartiCompleted: false,
    eaten: 0,
    platesTaken: 0,
    offers: 0,
    platesReturned: 0,
    refusals: {},
  };

  private readonly options: TourOptions;
  private readonly tracker: ResourceTracker;
  private readonly hitches = new TransitionHitches();
  private readonly steady = new FrameStats();
  private readonly results: { scenario: TourScenario; frames: FrameSummary }[] = [];
  private readonly script: Script;
  private current: TourPhase = 'outdoors';
  private measuring = false;
  private fireworksOn = true;

  constructor(options: TourOptions) {
    this.options = options;
    this.plan = options.plan ?? DEFAULT_TOUR_PLAN;
    this.tracker = new ResourceTracker(options);
    this.script = this.run();
    this.script.next(); // to the first wait
  }

  get phase(): TourPhase {
    return this.current;
  }

  update(dt: number): void {
    if (this.current === 'done' || !(dt > 0)) return;
    if (this.fireworksOn) this.options.fireworks.update(dt);
    this.script.next(dt);
  }

  frame(deltaSeconds: number): void {
    if (this.current === 'done') return;
    const transition = this.hitches.frame(deltaSeconds, this.options.locations.transition);
    if (this.measuring && !transition) this.steady.record(deltaSeconds);
  }

  report(): TourReport {
    const resources = this.tracker.report();
    return {
      phase: this.current,
      level: this.plan.level,
      viewport: this.plan.viewport,
      drawingBuffer: this.options.drawingBuffer?.() ?? null,
      scenarios: [...this.results],
      transitions: this.hitches.summary(),
      resources,
      bounded: resources.every((r) => !r.growing && !r.overLimit),
      counters: { ...this.counters, refusals: { ...this.counters.refusals } },
    };
  }

  // ── the script ─────────────────────────────────────────────────────────

  private *run(): Script {
    const { plan, options } = this;
    const { ceremony, hands } = options;

    // Outdoor fireworks at the existing caps.
    yield* this.measure('outdoors');

    // Repeated door transitions, the fireworks still going outside.
    this.current = 'transitions';
    this.startMeasuring();
    for (let trip = 0; trip < plan.roundTrips; trip++) {
      yield* this.go(ENTER);
      yield* this.wait(plan.dwellSeconds);
      yield* this.go(EXIT);
      yield* this.wait(plan.dwellSeconds);
      this.tracker.record(options.sample());
    }
    this.stopMeasuring('transitions');

    // Aarti: put the phuljhari away, go in and join at the puja corner.
    this.current = 'aarti';
    this.fireworksOn = false;
    options.crackers.select('anar');
    yield* this.go(ENTER);
    options.standAt(options.stands.puja);
    if (this.check('join', ceremony.join())) this.counters.aartiJoins++;
    let nextSong = plan.songSeconds;
    let song = AARTI_SONG_IDS.indexOf(ceremony.snapshot.song);
    yield* this.measure('aarti', (t) => {
      ceremony.setCircling(t % (AARTI_CIRCLE + AARTI_REST) < AARTI_CIRCLE);
      if (t < nextSong) return;
      nextSong += plan.songSeconds;
      song = (song + 1) % AARTI_SONG_IDS.length;
      if (this.check('selectSong', ceremony.selectSong(AARTI_SONG_IDS[song]!))) this.counters.songChanges++;
    });
    // Circle on to the end of the current song, which serves the tray.
    ceremony.setCircling(true);
    const left = ceremony.snapshot.duration - ceremony.snapshot.elapsed;
    yield* this.until(() => ceremony.snapshot.state === 'completed', left + 5);
    ceremony.setCircling(false);
    this.counters.aartiCompleted = ceremony.snapshot.state === 'completed';

    // Sweets: eat from the tray and offer the plate round, over and over.
    this.current = 'sweets';
    options.standAt(options.stands.tray);
    let action = 0;
    let nextAction = 0;
    yield* this.measure('sweets', (t) => {
      if (t < nextAction) return;
      nextAction += SWEETS_ACTION;
      this.sweets(SWEETS_ROUND[action++ % SWEETS_ROUND.length]!);
    });
    if (hands.hands?.kind === 'sweetsPlate') this.sweets('returnPlate');
    yield* this.go(EXIT);
    // Let the last transition's settle frames in before the report closes.
    yield* this.wait(2 * TRANSITION_SETTLE_SECONDS);

    this.current = 'done';
    this.measuring = false;
    options.onDone?.(this.report());
  }

  private sweets(action: SweetsAction): void {
    const { hands, counters } = this;
    if (action === 'eat') {
      if (this.check('eat', hands.eat())) counters.eaten++;
    } else if (action === 'pickUpPlate') {
      if (this.check('pickUpPlate', hands.pickUpPlate())) counters.platesTaken++;
    } else if (action === 'returnPlate') {
      if (this.check('returnPlate', hands.returnPlate())) counters.platesReturned++;
    } else if (this.check('offer', hands.offer(action))) {
      counters.offers++;
    }
  }

  private get hands(): TourHands {
    return this.options.hands;
  }

  /** Settle, then measure steady-state frames for `scenario`; `each` runs every step with the time since the start. */
  private *measure(scenario: TourScenario, each?: (t: number) => void): Script {
    this.current = scenario;
    const { settleSeconds, measureSeconds } = this.plan;
    yield* this.wait(settleSeconds, each);
    this.startMeasuring();
    yield* this.wait(measureSeconds, each && ((t) => each(settleSeconds + t)));
    this.stopMeasuring(scenario);
  }

  private startMeasuring(): void {
    this.steady.reset();
    this.measuring = true;
  }

  private stopMeasuring(scenario: TourScenario): void {
    this.measuring = false;
    this.results.push({ scenario, frames: this.steady.summary() });
  }

  /** Use a door, retrying a refusal shortly, and wait out the fade. */
  private *go(doorway: DoorwayId): Script {
    const { locations } = this.options;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.check('door', locations.requestTransition(doorway))) {
        this.counters.transitions++;
        break;
      }
      yield* this.wait(0.25);
    }
    yield* this.until(() => locations.transition === null, 10);
  }

  /** Simulation time; `each` runs every step with the seconds waited so far. */
  private *wait(seconds: number, each?: (t: number) => void): Script {
    let t = 0;
    while (t < seconds) {
      t += yield;
      each?.(t);
    }
  }

  private *until(done: () => boolean, timeout: number): Script {
    let t = 0;
    while (!done() && t < timeout) t += yield;
  }

  private check(action: string, result: CommandResult<string>): boolean {
    if (!result.ok) {
      const key = `${action}:${result.reason}`;
      this.counters.refusals[key] = (this.counters.refusals[key] ?? 0) + 1;
    }
    return result.ok;
  }
}
