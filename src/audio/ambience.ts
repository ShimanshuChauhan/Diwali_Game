/**
 * Timing for the celebration going on elsewhere in town: rockets whistling
 * up and bursting, single bombs, ladis (long strings of chain crackers
 * rattling off), small far-away pops, anars roaring, chakris whirring and
 * the odd cheer, near and far around the listener at irregular times. Pure
 * and seeded via `random` so it can be tested headless; the audio engine
 * turns each event into sound. Rockets the player can see on the horizon
 * are not scheduled here: their sound follows the distant fireworks.
 */

export type AmbientKind = 'rocket' | 'bomb' | 'ladi' | 'pop' | 'anar' | 'chakri' | 'cheer';

export interface AmbientEvent {
  readonly kind: AmbientKind;
  /** Direction around the listener in radians about +Y. */
  readonly azimuth: number;
  /** Metres; further events are quieter and duller. */
  readonly distance: number;
  /** Relative loudness in (0, 1]. */
  readonly intensity: number;
  /**
   * Seconds the event lasts: a rocket's climb before it bursts, a ladi's
   * string, an anar or chakri burning; 0 for single bangs and cheers.
   */
  readonly duration: number;
}

interface KindOptions {
  /** Average seconds between events of this kind. */
  readonly meanInterval: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Range of `AmbientEvent.duration`; zero for single bangs. */
  readonly minDuration: number;
  readonly maxDuration: number;
  /** Chance an event is followed quickly by another of its kind. */
  readonly clusterChance: number;
}

export type AmbienceOptions = Readonly<Record<AmbientKind, KindOptions>>;

const single = { minDuration: 0, maxDuration: 0 } as const;

export const AMBIENCE: AmbienceOptions = {
  rocket: { meanInterval: 7, minDistance: 50, maxDistance: 320, minDuration: 1.4, maxDuration: 2.4, clusterChance: 0.25 },
  bomb: { meanInterval: 6, minDistance: 45, maxDistance: 240, ...single, clusterChance: 0.15 },
  ladi: { meanInterval: 16, minDistance: 70, maxDistance: 280, minDuration: 1.5, maxDuration: 5, clusterChance: 0 },
  pop: { meanInterval: 1.8, minDistance: 150, maxDistance: 420, ...single, clusterChance: 0.35 },
  anar: { meanInterval: 22, minDistance: 35, maxDistance: 150, minDuration: 4, maxDuration: 8, clusterChance: 0 },
  chakri: { meanInterval: 26, minDistance: 30, maxDistance: 120, minDuration: 3, maxDuration: 6, clusterChance: 0.2 },
  cheer: { meanInterval: 30, minDistance: 25, maxDistance: 110, ...single, clusterChance: 0 },
};

export const AMBIENT_KINDS = Object.keys(AMBIENCE) as AmbientKind[];

/** Smallest gap between events of one kind, so they never stack on one instant. */
const MIN_GAP = 0.08;

export class AmbienceScheduler {
  private readonly untilNext: Record<AmbientKind, number>;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly options: AmbienceOptions = AMBIENCE,
  ) {
    this.untilNext = { rocket: 0, bomb: 0, ladi: 0, pop: 0, anar: 0, chakri: 0, cheer: 0 };
    this.reset();
  }

  /** Advance by `dt` seconds and return the events due in that span. */
  update(dt: number): AmbientEvent[] {
    const events: AmbientEvent[] = [];
    const step = Math.max(0, dt);
    for (const kind of AMBIENT_KINDS) {
      this.untilNext[kind] -= step;
      while (this.untilNext[kind] <= 0) {
        events.push(this.event(kind));
        const clustered = this.random() < this.options[kind].clusterChance;
        this.untilNext[kind] += clustered ? MIN_GAP + this.random() * 0.25 : this.interval(kind);
      }
    }
    return events;
  }

  reset(): void {
    for (const kind of AMBIENT_KINDS) this.untilNext[kind] = this.interval(kind);
  }

  /** Exponentially distributed gap, floored so events never pile up. */
  private interval(kind: AmbientKind): number {
    const u = Math.min(this.random(), 0.999999);
    return Math.max(MIN_GAP, -Math.log(1 - u) * this.options[kind].meanInterval);
  }

  private event(kind: AmbientKind): AmbientEvent {
    const { minDistance, maxDistance, minDuration, maxDuration } = this.options[kind];
    return {
      kind,
      azimuth: this.random() * Math.PI * 2,
      distance: minDistance + this.random() * (maxDistance - minDistance),
      intensity: 0.4 + 0.6 * this.random(),
      duration: minDuration + this.random() * (maxDuration - minDuration),
    };
  }
}
