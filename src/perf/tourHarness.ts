import { atmosphereBudget } from '../atmosphere/budget';
import type { PlacementRequest, PlacementResult } from '../core/contracts';
import type { Placement } from '../core/homes';
import { qualityProfile } from '../core/quality';
import type { QualityLevel } from '../core/types';
import type { InteriorLayout } from '../interior/layout';
import { HomesTour, type TourCeremony, type TourHands, type TourLocations, type TourPlan, type TourReport } from './homesTour';
import type { ResourceSample } from './resourceTracker';
import { createStressScenario, stressLimits } from './stressHarness';
import type { StressCrackers } from './stressScenario';

/** Where the player stands to use the room's puja and sweets tray, from the built layout. */
export function tourStands(layout: InteriorLayout): { puja: Placement; tray: Placement } {
  const stand = (kind: 'puja' | 'tray') => {
    const found = layout.interactions.find((i) => i.target.kind === kind);
    if (!found) throw new Error(`${layout.home} has no ${kind} to stand at`);
    return found.stand;
  };
  return { puja: stand('puja'), tray: stand('tray') };
}

export interface HomesTourHarnessOptions {
  readonly plan: TourPlan;
  readonly crackers: StressCrackers;
  readonly validatePlacement: (request: PlacementRequest) => PlacementResult;
  readonly setLevel: (level: QualityLevel) => void;
  readonly locations: TourLocations;
  readonly ceremony: TourCeremony;
  readonly hands: TourHands;
  /** The family home as built, for the puja and tray stands. */
  readonly layout: InteriorLayout;
  readonly standAt: (placement: Placement) => void;
  /** Current resource counts: budgets, GPU objects, audio sources, listeners, heap. */
  readonly sample: () => ResourceSample;
  readonly drawingBuffer?: () => { readonly width: number; readonly height: number };
  /** Where the finished report goes; the console by default. */
  readonly onDone?: (report: TourReport) => void;
}

/**
 * Wires the family-home tour to the game: the stress test's outdoor
 * fireworks, the room's stands and the plan's quality profile. The page
 * exposes `report()` as `window.__tour` (see docs/performance.md).
 */
export function createHomesTour(options: HomesTourHarnessOptions): HomesTour {
  const { plan } = options;
  options.setLevel(plan.level);
  const sky = atmosphereBudget(qualityProfile(plan.level));
  const distantSparks = sky.maxDistantShells * (sky.particlesPerShell + 1);
  return new HomesTour({
    plan,
    locations: options.locations,
    ceremony: options.ceremony,
    hands: options.hands,
    crackers: options.crackers,
    fireworks: createStressScenario(options.crackers, options.validatePlacement),
    stands: tourStands(options.layout),
    standAt: options.standAt,
    sample: options.sample,
    drawingBuffer: options.drawingBuffer,
    limits: { ...stressLimits(plan.level), distantParticles: distantSparks },
    tolerances: {
      heapMb: { relative: 0.2, absolute: 8 },
      // Whole sky bursts come and go between the few per-trip samples; the
      // budget bounds them, so only breaking it counts.
      distantParticles: { relative: 0, absolute: distantSparks },
    },
    onDone: options.onDone ?? ((report) => console.info('[tour] done', JSON.stringify(report, null, 2))),
  });
}
