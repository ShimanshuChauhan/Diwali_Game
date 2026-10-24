import type * as THREE from 'three';
import type { HomeId, InteriorPresentationModule, LocationId } from '../core/homes';
import type { QualityProfile } from '../core/quality';
import type { InteriorScene } from './interiorScene';

export interface LocationPresenterOptions {
  /** Street presentation: scenery, sky, lights, diyas, neighbours, effects. Hidden while indoors. */
  readonly outdoor: readonly THREE.Object3D[];
  /** Built interiors, already added to the scene. */
  readonly interiors: readonly InteriorScene[];
  readonly profile: QualityProfile;
  /** Where door-fade opacity goes, e.g. the DOM overlay. */
  readonly fade?: (opacity: number) => void;
}

export interface LocationPresenterStats {
  readonly active: LocationId;
  /** Interiors whose root is drawn: 1 indoors, 0 outdoors. */
  readonly visibleInteriors: number;
  /** Interior point lights switched on in the active home. */
  readonly interiorLights: number;
  /** Times the shown location actually changed. */
  readonly switches: number;
}

/**
 * Draws only the active location (issue #51 → Locations and transitions):
 * the street's objects while outdoors, one home's room while inside. Hiding
 * is by visibility only; nothing is built or disposed on a visit, so repeated
 * visits keep geometry, material and texture counts flat. Logical state
 * (crackers, effects, household) is not touched here and keeps stepping.
 *
 * `activate` is cheap when the location is unchanged, so the frame loop may
 * call it every frame with `Locations.location`; that also covers a session
 * reset, which returns the player outdoors without an event.
 */
export class LocationPresenter implements InteriorPresentationModule {
  private readonly outdoor: readonly THREE.Object3D[];
  private readonly interiors: ReadonlyMap<HomeId, InteriorScene>;
  private readonly fadeSink: ((opacity: number) => void) | undefined;
  private current: LocationId | null = null;
  private switchCount = 0;

  constructor(options: LocationPresenterOptions) {
    this.outdoor = options.outdoor;
    this.interiors = new Map(options.interiors.map((interior) => [interior.home, interior]));
    this.fadeSink = options.fade;
    this.applyQuality(options.profile);
    this.activate('outdoors');
  }

  get active(): LocationId {
    return this.current ?? 'outdoors';
  }

  /** True when `home` has a built interior to show. */
  has(home: HomeId): boolean {
    return this.interiors.has(home);
  }

  get stats(): LocationPresenterStats {
    const shown = this.current && this.current !== 'outdoors' ? this.interiors.get(this.current) : undefined;
    let visibleInteriors = 0;
    for (const interior of this.interiors.values()) if (interior.root.visible) visibleInteriors++;
    return {
      active: this.active,
      visibleInteriors,
      interiorLights: shown?.activeLights ?? 0,
      switches: this.switchCount,
    };
  }

  activate(location: LocationId): void {
    if (location === this.current) return;
    if (this.current !== null) this.switchCount++;
    this.current = location;
    this.show(location);
  }

  /**
   * Show each location in turn, the street first, and hand it to `warm`,
   * e.g. to draw it once before the first visit; then restore the shown
   * location. Not counted as switches.
   */
  preload(warm: (location: LocationId) => void): void {
    const shown = this.active;
    for (const location of ['outdoors', ...this.interiors.keys()] as const) {
      this.show(location);
      warm(location);
    }
    this.show(shown);
  }

  setFade(opacity: number): void {
    this.fadeSink?.(opacity);
  }

  applyQuality(profile: QualityProfile): void {
    for (const interior of this.interiors.values()) interior.applyQuality(profile);
  }

  /** Per-frame presentation for the shown home only; the street's own scenes run their frames themselves. */
  frame(dt: number): void {
    if (this.current === null || this.current === 'outdoors') return;
    this.interiors.get(this.current)?.frame(dt);
  }

  private show(location: LocationId): void {
    const outdoors = location === 'outdoors';
    for (const object of this.outdoor) object.visible = outdoors;
    for (const [home, interior] of this.interiors) interior.root.visible = home === location;
  }
}
