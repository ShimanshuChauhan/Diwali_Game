import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import { AartiAudio } from '../src/audio/aarti/aartiAudio';
import type { AartiRecording } from '../src/audio/aarti/recordings';
import { AudioEngine } from '../src/audio/audioEngine';
import { CapacityBudget } from '../src/capacity';
import { createGameEventBus } from '../src/core/events';
import type { TransitionSnapshot } from '../src/core/homes';
import { qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import type { Vec3 } from '../src/core/types';
import { Crackers } from '../src/crackers';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { HeldItems, Locations } from '../src/homes';
import { Household, Households, HouseholdScene, NeighbourHosts } from '../src/household';
import { Interaction } from '../src/interaction';
import {
  buildInteriorScene,
  createFamilyHomeLayout,
  createNeighbourHomeLayout,
  InteriorAssets,
  LocationPresenter,
} from '../src/interior';
import { Neighbours } from '../src/neighbours';
import {
  createHomesTour,
  DEFAULT_TOUR_PLAN,
  drawEverythingOnce,
  TRANSITION_SETTLE_SECONDS,
  TransitionHitches,
  tourPlanFromQuery,
  tourStands,
  type TourPlan,
} from '../src/perf';
import { FAMILY_SWEETS_DIALOGUE, SweetsReactions, SweetsScene } from '../src/sweets';
import { createWorld } from '../src/world';
import { FakeAudioContext } from './fakeAudioContext';

const STEP = 1 / 60;
const { fadeDuration } = TUNING.homes;

const fade = (to: TransitionSnapshot['to'] = 'familyHome'): TransitionSnapshot => ({
  doorway: 'familyHome.enter',
  from: 'outdoors',
  to,
  phase: 'fadingOut',
  elapsed: 0,
  duration: fadeDuration,
});

describe('tourPlanFromQuery', () => {
  it('is off without `tour` and defaults to Low at 1280 × 720', () => {
    expect(tourPlanFromQuery('?stress')).toBeNull();
    expect(tourPlanFromQuery('?tour')).toEqual(DEFAULT_TOUR_PLAN);
    expect(DEFAULT_TOUR_PLAN).toMatchObject({ level: 'low', viewport: { width: 1280, height: 720 } });
    // 20+ transitions by default.
    expect(DEFAULT_TOUR_PLAN.roundTrips * 2).toBeGreaterThanOrEqual(20);
  });

  it('reads the profile, timings, trips and viewport, ignoring bad values', () => {
    expect(tourPlanFromQuery('?tour&level=high&settle=2&measure=30&trips=12&dwell=1.5&song=5&viewport=window')).toEqual({
      level: 'high',
      settleSeconds: 2,
      measureSeconds: 30,
      roundTrips: 12,
      dwellSeconds: 1.5,
      songSeconds: 5,
      viewport: null,
    });
    expect(tourPlanFromQuery('?tour&level=ultra&trips=-3&measure=abc')).toMatchObject({
      level: 'low',
      roundTrips: DEFAULT_TOUR_PLAN.roundTrips,
      measureSeconds: DEFAULT_TOUR_PLAN.measureSeconds,
    });
  });
});

describe('TransitionHitches', () => {
  it('counts frames from the first faded frame until the settle after it as one transition', () => {
    const hitches = new TransitionHitches();
    expect(hitches.frame(STEP, null)).toBe(false);
    for (let i = 0; i < 18; i++) expect(hitches.frame(STEP, fade())).toBe(true);
    // The first frame of the new room is the slow one.
    expect(hitches.frame(0.05, null)).toBe(true);
    let settleFrames = 0;
    while (hitches.frame(STEP, null)) settleFrames++;
    // The rest of the settle window, then the first steady frame.
    expect(settleFrames).toBe(Math.ceil((TRANSITION_SETTLE_SECONDS - 0.05) / STEP));

    const s = hitches.summary();
    expect(s.count).toBe(1);
    expect(s.peaksMs).toEqual([50]);
    expect(s.peakMaxMs).toBeCloseTo(50, 5);
    expect(s.firstArrivalMs).toEqual({ familyHome: 50 });
    expect(s.frames.worstMs).toBeCloseTo(50, 5);
  });

  it('keeps the first arrival per location apart from later ones', () => {
    const hitches = new TransitionHitches();
    const transition = (to: TransitionSnapshot['to'], worst: number) => {
      hitches.frame(worst, fade(to));
      for (let i = 0; i < 40; i++) hitches.frame(STEP, i < 20 ? fade(to) : null);
    };
    transition('familyHome', 0.04);
    transition('outdoors', 0.02);
    transition('familyHome', 0.018);
    const s = hitches.summary();
    expect(s.count).toBe(3);
    expect(s.peaksMs.map(Math.round)).toEqual([40, 20, 18]);
    expect(s.firstArrivalMs).toEqual({ familyHome: 40, outdoors: 20 });
  });

  it('closes a transition early when the next fade starts inside its settle window', () => {
    const hitches = new TransitionHitches();
    hitches.frame(STEP, fade('familyHome'));
    hitches.frame(STEP, null);
    hitches.frame(STEP, fade('outdoors'));
    expect(hitches.summary().count).toBe(1);
    for (let i = 0; i < 30; i++) hitches.frame(STEP, null);
    expect(hitches.summary().count).toBe(2);
  });
});

/** Size of a private bookkeeping map, where a leak would accumulate entries. */
const sizeOf = (owner: object, field: string): number => (owner as unknown as Record<string, Map<unknown, unknown>>)[field]!.size;

/**
 * The family-home slice wired as `main.ts` wires it, scene graph included
 * (Three.js objects need no renderer), and driven by the tour. Rendering is
 * replaced by one frame per fixed step.
 */
async function tourSession(plan: TourPlan) {
  const profile = qualityProfile(plan.level);
  const bus = createGameEventBus();
  const world = createWorld();
  const familyHome = createFamilyHomeLayout();
  const neighbourHome = createNeighbourHomeLayout();
  const ctx = new FakeAudioContext();
  const audio = new AudioEngine({ bus, profile, random: () => 0.5, createContext: () => ctx.asAudioContext() });
  await audio.unlock();
  const decoded = new Set<unknown>();
  const loadBuffer = (recording: AartiRecording) => {
    const buffer = ctx.createBuffer(1, Math.round(recording.durationSeconds * ctx.sampleRate), ctx.sampleRate);
    decoded.add(buffer);
    return Promise.resolve(buffer as unknown as AudioBuffer);
  };

  let player: { position: Vec3; yaw: number } = { position: world.spawn, yaw: world.spawnYaw };
  const hand = (): Vec3 => ({ x: player.position.x, y: 1.1, z: player.position.z });
  const neighbours = new Neighbours({ areas: world.neighbourAreas, bus, random: () => 0.5 });
  const effects = new FireworksEffects(bus, { quality: profile, random: () => 0.5, handPosition: hand });
  const capacity = new CapacityBudget({
    crackers: () => crackers,
    bus,
    quality: profile,
    effects: () => effects.stats,
    voices: () => audio.activeVoices,
  });
  const crackers = new Crackers({ bus, admission: capacity, random: () => 0.5, handPosition: hand });
  const heldItems = new HeldItems({ bus, crackers });
  const locations = new Locations({ bus, hands: heldItems, onArrive: (arrival) => (player = arrival) });
  const aartiAudio = new AartiAudio({
    bus,
    output: () => audio.musicOutput,
    onPlaybackEnded: (id) => ceremony.playbackEnded(id),
    loadBuffer,
  });
  const ceremony = new AartiCeremony({
    bus,
    hands: heldItems,
    location: () => locations.location,
    durationOf: (song) => aartiAudio.durationOf(song),
  });
  bus.on('locationChanged', ({ to }) => {
    if (to === 'familyHome') for (const song of ['omJaiJagdishHare', 'jaiLakshmiMata', 'jaiGaneshDeva'] as const) void aartiAudio.load(song);
  });
  const family = new Household({ bus, layout: familyHome, dialogue: FAMILY_SWEETS_DIALOGUE });
  const hosts = new NeighbourHosts({ bus, layout: neighbourHome, hands: heldItems });
  const household = new Households([family, hosts]);
  const sweetsReactions = new SweetsReactions({ bus, household: family });
  const interaction = new Interaction({
    world,
    crackers: () => crackers.list(),
    hasRoom: () => capacity.hasRoom(),
    neighbours: () => neighbours.positions(),
    location: () => locations.location,
  });

  const scene = new THREE.Scene();
  const street = new THREE.Group();
  scene.add(street);
  const assets = new InteriorAssets();
  const familyHomeScene = buildInteriorScene(familyHome, assets);
  scene.add(familyHomeScene.root);
  const familyScene = new HouseholdScene({ household: family, layout: familyHome, parent: familyHomeScene.root, assets });
  const sweetsScene = new SweetsScene({ layout: familyHome, parent: familyHomeScene.root, assets, bus });
  const neighbourHomeScene = buildInteriorScene(neighbourHome, assets);
  scene.add(neighbourHomeScene.root);
  const presenter = new LocationPresenter({ outdoor: [street], interiors: [familyHomeScene, neighbourHomeScene], profile });

  const counts = () => {
    let objects = 0;
    const geometries = new Set<unknown>();
    const materials = new Set<unknown>();
    scene.traverse((o) => {
      objects++;
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        materials.add(o.material);
      }
    });
    return { objects, geometries: geometries.size, materials: materials.size };
  };
  const sample = () => {
    const r = capacity.stats.resources;
    const scene = counts();
    return {
      sceneObjects: scene.objects,
      geometries: scene.geometries,
      materials: scene.materials,
      assetMaterials: assets.materialCount,
      busListeners: bus.totalListenerCount(),
      aartiSources: aartiAudio.activeSources,
      soundingRecordings: ctx.soundingSources().filter((s) => decoded.has(s.buffer)).length,
      audioVoices: r.audioVoices.used,
      particles: r.particles.used,
      voiceHandles: sizeOf(audio, 'voices'),
      effectHandles: sizeOf(effects, 'byCracker'),
    };
  };

  let maxRecordings = 0;
  const tour = createHomesTour({
    plan,
    crackers,
    validatePlacement: (request) => interaction.validatePlacement(request),
    setLevel: () => undefined,
    locations,
    ceremony,
    hands: heldItems,
    layout: familyHome,
    standAt: (placement) => (player = placement),
    sample,
    onDone: () => undefined,
  });
  const before = { ...counts(), busListeners: bus.totalListenerCount() };

  /** One fixed step and one frame, in `main.ts`'s order. */
  const step = () => {
    ctx.currentTime += STEP;
    tour.update(STEP);
    crackers.update(STEP);
    effects.update(STEP);
    capacity.update(STEP);
    audio.update(STEP);
    neighbours.update(STEP);
    locations.update(STEP);
    ceremony.update(STEP);
    household.update(STEP);
    sweetsReactions.update(STEP);
    aartiAudio.sync(ceremony.snapshot);
    presenter.activate(locations.location);
    if (presenter.active !== 'outdoors') {
      presenter.frame(STEP);
      if (presenter.active === 'familyHome') familyScene.frame(STEP, player.position);
    }
    sweetsScene.frame(STEP, { served: heldItems.trayServed, carrying: heldItems.hands?.kind === 'sweetsPlate' }, {
      center: hand(),
      yaw: player.yaw,
    });
    tour.frame(STEP);
    maxRecordings = Math.max(maxRecordings, ctx.soundingSources().filter((s) => decoded.has(s.buffer)).length);
  };
  // Let the recordings "decode" between steps, as the browser would.
  for (let i = 0; i < 60 * 60 * 30 && tour.phase !== 'done'; i++) {
    step();
    if (i % 60 === 0) await Promise.resolve();
  }
  return { tour, before, after: { ...counts(), busListeners: bus.totalListenerCount() }, locations, maxRecordings, presenter, scene };
}

describe('family-home tour (headless)', () => {
  const plan: TourPlan = { ...DEFAULT_TOUR_PLAN, settleSeconds: 2, measureSeconds: 8, roundTrips: 25, dwellSeconds: 1, songSeconds: 3 };

  it('runs every scenario through the real module commands without a refusal', async () => {
    const { tour, locations, maxRecordings } = await tourSession(plan);
    const report = tour.report();
    expect(report.phase).toBe('done');
    expect(locations.location).toBe('outdoors');
    expect(report.scenarios.map((s) => s.scenario)).toEqual(['outdoors', 'transitions', 'aarti', 'sweets']);
    for (const { frames } of report.scenarios) expect(frames.frames).toBeGreaterThan(0);
    expect(report.counters).toMatchObject({ aartiJoins: 1, aartiCompleted: true, refusals: {} });
    expect(report.counters.songChanges).toBeGreaterThanOrEqual(2);
    expect(report.counters.eaten).toBeGreaterThan(0);
    expect(report.counters.offers).toBeGreaterThan(0);
    expect(report.counters.platesTaken).toBe(report.counters.platesReturned);
    // At most one recording ever sounds, through every song change.
    expect(maxRecordings).toBe(1);
  }, 60_000);

  it('keeps resources flat across 20+ door transitions', async () => {
    const { tour, before, after, presenter, scene } = await tourSession(plan);
    const report = tour.report();
    // 25 round trips, plus going in for aarti and out after the sweets.
    expect(report.counters.transitions).toBe(plan.roundTrips * 2 + 2);
    expect(report.transitions.count).toBe(report.counters.transitions);
    expect(presenter.stats.switches).toBe(report.counters.transitions);

    expect(report.resources.filter((r) => r.growing || r.overLimit)).toEqual([]);
    const byMetric = Object.fromEntries(report.resources.map((r) => [r.metric, r]));
    expect(byMetric.sceneObjects!.samples).toBe(plan.roundTrips);
    // Nothing is built, subscribed or left playing per visit.
    for (const metric of ['sceneObjects', 'geometries', 'materials', 'assetMaterials', 'busListeners'] as const) {
      expect(byMetric[metric]!.min, metric).toBe(byMetric[metric]!.max);
    }
    expect(byMetric.aartiSources!.max).toBe(0);
    expect(byMetric.soundingRecordings!.max).toBe(0);
    // The whole tour, aarti and sweets included, leaves the scene and the bus as it found them, bar
    // the family's bell: built at boot, it joins the graph in the ringer's hand at the first aarti.
    expect(scene.getObjectByName('household.bell')).toBeDefined();
    expect(after).toEqual({ ...before, objects: before.objects + 1, geometries: before.geometries + 1 });
  }, 60_000);
});

describe('tourStands', () => {
  it('stands the player at the family puja and sweets tray', () => {
    const layout = createFamilyHomeLayout();
    const stands = tourStands(layout);
    expect(stands.puja).toEqual(layout.interactions.find((i) => i.target.kind === 'puja')!.stand);
    expect(stands.tray).toEqual(layout.interactions.find((i) => i.target.kind === 'tray')!.stand);
    expect(() => tourStands({ ...layout, interactions: [] })).toThrow(/puja/);
  });
});

describe('drawEverythingOnce', () => {
  it('draws hidden props and unculled meshes, keeping lights and other locations as they are', () => {
    const scene = new THREE.Scene();
    const street = new THREE.Group();
    const home = new THREE.Group();
    const away = new THREE.Group();
    const thali = new THREE.Mesh();
    const detail = new THREE.Group();
    const garland = new THREE.Mesh();
    const roomLight = new THREE.PointLight();
    const awayMesh = new THREE.Mesh();
    away.add(awayMesh);
    detail.add(garland);
    home.add(detail, roomLight);
    scene.add(street, home, away, thali);
    street.visible = false;
    away.visible = false;
    thali.visible = false;
    detail.visible = false;
    roomLight.visible = false;
    awayMesh.visible = false;

    let during: Record<string, boolean> = {};
    drawEverythingOnce(scene, new Set([street, home, away]), () => {
      during = {
        thali: thali.visible,
        detail: detail.visible,
        roomLight: roomLight.visible,
        street: street.visible,
        away: away.visible,
        awayMesh: awayMesh.visible,
        culled: garland.frustumCulled || thali.frustumCulled,
      };
    });
    expect(during).toEqual({
      thali: true,
      detail: true,
      roomLight: false,
      street: false,
      away: false,
      awayMesh: false,
      culled: false,
    });
    // Everything back as it was.
    expect([thali.visible, detail.visible, roomLight.visible, street.visible, away.visible]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(garland.frustumCulled && thali.frustumCulled && awayMesh.frustumCulled).toBe(true);
  });

  it('restores the scene even when drawing throws', () => {
    const scene = new THREE.Scene();
    const prop = new THREE.Mesh();
    prop.visible = false;
    scene.add(prop);
    expect(() =>
      drawEverythingOnce(scene, new Set(), () => {
        throw new Error('context lost');
      }),
    ).toThrow('context lost');
    expect(prop.visible).toBe(false);
    expect(prop.frustumCulled).toBe(true);
  });
});
