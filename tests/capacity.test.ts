import { describe, expect, it } from 'vitest';
import { CAPACITY_RESOURCES, CapacityBudget } from '../src/capacity';
import type { EffectStats } from '../src/core/contracts';
import { createGameEventBus, type GameEvents } from '../src/core/events';
import { qualityProfile, type QualityProfile } from '../src/core/quality';
import { TUNING, type Tuning } from '../src/core/tuning';
import type { Vec3 } from '../src/core/types';
import { Crackers } from '../src/crackers';
import { Interaction } from '../src/interaction';
import type { WorldModule } from '../src/core/contracts';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;

function tuningWith(caps: Partial<Tuning['caps']>): Tuning {
  return { ...TUNING, caps: { ...TUNING.caps, ...caps } };
}

interface Setup {
  tuning?: Tuning;
  quality?: QualityProfile;
  effects?: EffectStats;
  voices?: number;
}

function setup(options: Setup = {}) {
  const bus = createGameEventBus();
  const tuning = options.tuning ?? tuningWith({ maxPlacedCrackers: 4, maxLitCrackers: 3 });
  const finished: GameEvents['crackerFinished'][] = [];
  const rejected: { placement: string[]; ignition: string[] } = { placement: [], ignition: [] };
  bus.on('crackerFinished', (e) => finished.push(e));
  bus.on('placementRejected', (e) => rejected.placement.push(e.reason));
  bus.on('ignitionRejected', (e) => rejected.ignition.push(e.reason));
  const capacity = new CapacityBudget({
    crackers: () => crackers,
    bus,
    tuning,
    quality: options.quality ?? qualityProfile('medium'),
    effects: () => options.effects ?? { activeEffects: 0, liveParticles: 0, dynamicLights: 0 },
    voices: () => options.voices ?? 0,
  });
  const crackers = new Crackers({ bus, tuning, admission: capacity, random: () => 0.5, initialSelection: 'anar' });
  let x = 0;
  const place = (type: 'anar' | 'chakri' | 'rocket' = 'anar') => crackers.place({ type, position: v((x += 1), 0, 0) });
  const step = (seconds: number) => {
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      crackers.update(STEP);
      capacity.update(STEP);
    }
  };
  return { bus, tuning, capacity, crackers, place, step, finished, rejected };
}

function placedId(result: ReturnType<Crackers['place']>): string {
  if (!result.ok) throw new Error(`placement refused: ${result.reason}`);
  return result.id;
}

describe('capacity admission', () => {
  it('admits placement up to the cap and rejects the next with a capacity reason', () => {
    const { capacity, place, rejected } = setup();
    for (let i = 0; i < 4; i++) expect(place().ok).toBe(true);
    expect(place()).toEqual({ ok: false, reason: 'capacity' });
    expect(rejected.placement).toEqual(['capacity']);
    expect(capacity.lastRejection).toEqual({
      kind: 'placement',
      type: 'anar',
      resource: 'placedProps',
      used: 4,
      limit: 4,
    });
    expect(capacity.stats.rejectedPlacements).toBe(1);
  });

  it('admits ignition up to the lit cap and rejects the next', () => {
    const { capacity, crackers, place, rejected } = setup();
    const ids = [place(), place(), place(), place()].map(placedId);
    for (const id of ids.slice(0, 3)) expect(crackers.ignite(id)).toEqual({ ok: true });
    expect(crackers.ignite(ids[3]!)).toEqual({ ok: false, reason: 'capacity' });
    expect(rejected.ignition).toEqual(['capacity']);
    expect(capacity.lastRejection).toMatchObject({ kind: 'ignition', resource: 'litCrackers', used: 3, limit: 3 });
    expect(crackers.get(ids[3]!)?.state).toBe('placed');
  });

  it('counts the held phuljhari against the lit cap', () => {
    const { crackers, place } = setup();
    crackers.select('phuljhari');
    expect(crackers.igniteHeld().ok).toBe(true);
    const ids = [place(), place(), place()].map(placedId);
    expect(crackers.ignite(ids[0]!).ok).toBe(true);
    expect(crackers.ignite(ids[1]!).ok).toBe(true);
    expect(crackers.ignite(ids[2]!)).toEqual({ ok: false, reason: 'capacity' });
  });

  it('caps lit crackers at the effect budget and names it when that binds', () => {
    const low: QualityProfile = { ...qualityProfile('low'), maxActiveEffects: 2 };
    const { capacity, crackers, place } = setup({ quality: low });
    expect(capacity.limit('litCrackers')).toBe(2);
    const ids = [place(), place(), place()].map(placedId);
    crackers.ignite(ids[0]!);
    crackers.ignite(ids[1]!);
    expect(crackers.ignite(ids[2]!).ok).toBe(false);
    expect(capacity.lastRejection?.resource).toBe('activeEffects');
  });

  it('admits again once a running cracker finishes', () => {
    const { crackers, place, step } = setup();
    const ids = [place(), place(), place(), place()].map(placedId);
    for (const id of ids.slice(0, 3)) crackers.ignite(id);
    step(TUNING.crackers.fuse.anar + TUNING.crackers.activeDuration.anar + 0.1);
    expect(crackers.ignite(ids[3]!)).toEqual({ ok: true });
  });
});

describe('accepted sequences are preserved', () => {
  it('lowering quality below the running count blocks new ignitions but finishes every lit cracker', () => {
    const { bus, crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 8, maxLitCrackers: 6 }),
    });
    const ids = [place(), place(), place(), place(), place(), place(), place()].map(placedId);
    for (const id of ids.slice(0, 6)) expect(crackers.ignite(id).ok).toBe(true);
    bus.emit('qualityChanged', { profile: { ...qualityProfile('low'), maxActiveEffects: 2 } });
    expect(crackers.ignite(ids[6]!)).toEqual({ ok: false, reason: 'capacity' });
    step(TUNING.crackers.fuse.anar + TUNING.crackers.activeDuration.anar + 0.1);
    const lit = new Set(ids.slice(0, 6));
    const done = finished.filter((e) => lit.has(e.id));
    expect(done).toHaveLength(6);
    expect(done.every((e) => e.reason === 'completed')).toBe(true);
  });

  it('never reclaims a lit cracker, even when full and old', () => {
    const { crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 2, maxLitCrackers: 2, reclaimWhenFullAfter: 0, unlitReclaimAfter: 0 }),
    });
    const ids = [place('rocket'), place('rocket')].map(placedId);
    for (const id of ids) crackers.ignite(id);
    step(1);
    expect(place()).toEqual({ ok: false, reason: 'capacity' });
    expect(finished.filter((e) => e.reason === 'reclaimed')).toEqual([]);
    expect(crackers.list().map((c) => c.state)).toEqual(['fuseBurning', 'fuseBurning']);
  });
});

describe('reclamation', () => {
  it('reclaims the oldest unlit prop to make room once it is old enough', () => {
    const { capacity, crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 3, maxLitCrackers: 3, reclaimWhenFullAfter: 5 }),
    });
    const first = placedId(place());
    step(1);
    place();
    place();
    // Full, but nothing is old enough yet.
    expect(capacity.hasRoom()).toBe(false);
    expect(place().ok).toBe(false);
    step(4.5);
    expect(capacity.hasRoom()).toBe(true);
    const fresh = place();
    expect(fresh.ok).toBe(true);
    expect(finished).toEqual([{ id: first, type: 'anar', reason: 'reclaimed' }]);
    expect(crackers.list()).toHaveLength(3);
    expect(capacity.stats.reclaimedProps).toBe(1);
  });

  it('skips lit props when choosing what to reclaim', () => {
    const { crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 2, maxLitCrackers: 2, reclaimWhenFullAfter: 1 }),
    });
    const lit = placedId(place('rocket'));
    const unlit = placedId(place());
    crackers.ignite(lit);
    step(2);
    expect(place().ok).toBe(true);
    expect(finished.map((e) => e.id)).toEqual([unlit]);
    expect(crackers.get(lit)?.state).toBe('fuseBurning');
  });

  it('reclaims abandoned unlit props after the timeout, a bounded number per step', () => {
    const { capacity, crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 6, maxLitCrackers: 3, unlitReclaimAfter: 10, maxReclaimsPerStep: 1 }),
    });
    const ids = [place(), place(), place()].map(placedId);
    crackers.ignite(ids[2]!);
    step(9.9);
    expect(finished).toEqual([]);
    step(10 - 9.9 + STEP / 2);
    // Two are abandoned, but only one goes per step.
    expect(finished.filter((e) => e.reason === 'reclaimed')).toHaveLength(1);
    step(STEP);
    const reclaimed = finished.filter((e) => e.reason === 'reclaimed').map((e) => e.id);
    expect(reclaimed).toEqual([ids[0], ids[1]]);
    expect(capacity.stats.reclaimedProps).toBe(2);
    expect(crackers.list().map((c) => c.id)).not.toContain(ids[0]);
  });

  it('keeps props that were lit before the timeout', () => {
    const { crackers, place, step, finished } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 4, maxLitCrackers: 3, unlitReclaimAfter: 5 }),
    });
    const id = placedId(place());
    step(4);
    crackers.ignite(id);
    step(TUNING.crackers.fuse.anar + TUNING.crackers.activeDuration.anar + 0.1);
    expect(finished).toEqual([{ id, type: 'anar', reason: 'completed' }]);
  });
});

describe('resource counters', () => {
  it('reports use and limit for every budget', () => {
    const quality = qualityProfile('low');
    const { capacity, crackers, place } = setup({
      quality,
      effects: { activeEffects: 2, liveParticles: 900, dynamicLights: 1 },
      voices: 5,
    });
    const id = placedId(place());
    place();
    crackers.ignite(id);
    const { resources } = capacity.stats;
    expect(Object.keys(resources)).toEqual([...CAPACITY_RESOURCES]);
    expect(resources).toEqual({
      placedProps: { used: 2, limit: 4 },
      litCrackers: { used: 1, limit: 3 },
      activeEffects: { used: 2, limit: quality.maxActiveEffects },
      particles: { used: 900, limit: quality.maxParticles },
      dynamicLights: { used: 1, limit: quality.maxDynamicLights },
      audioVoices: { used: 5, limit: quality.maxAudioVoices },
    });
  });

  it('follows quality changes and clears session counters on reset', () => {
    const { bus, capacity, place } = setup();
    for (let i = 0; i < 5; i++) place();
    expect(capacity.stats.rejectedPlacements).toBe(1);
    bus.emit('qualityChanged', { profile: qualityProfile('high') });
    expect(capacity.stats.resources.particles.limit).toBe(qualityProfile('high').maxParticles);
    bus.emit('sessionReset', {});
    const stats = capacity.stats;
    expect(stats.rejectedPlacements).toBe(0);
    expect(stats.resources.placedProps.used).toBe(0);
    expect(capacity.lastRejection).toBeNull();
  });
});

describe('placement preview', () => {
  const flatWorld: WorldModule = {
    bounds: { min: v(-50, 0, -50), max: v(50, 10, 50) },
    spawn: v(0, 0, 0),
    doorways: [],
    diyaSites: [],
    neighbourAreas: [],
    surfaceBelow: (p) => ({ point: v(p.x, 0, p.z), normal: v(0, 1, 0), supportsPlacement: true }),
    isClear: () => true,
    clearanceAbove: (_p, max) => max,
  };

  it('offers placement at the cap when an old unlit prop can be reclaimed', () => {
    const { capacity, crackers, place, step } = setup({
      tuning: tuningWith({ maxPlacedCrackers: 2, maxLitCrackers: 2, reclaimWhenFullAfter: 3 }),
    });
    const interaction = new Interaction({
      world: flatWorld,
      crackers: () => crackers.list(),
      hasRoom: () => capacity.hasRoom(),
    });
    place();
    place();
    const request = { type: 'anar' as const, playerPosition: v(10, 0, 5), target: v(10, 0, 6) };
    expect(interaction.validatePlacement(request)).toEqual({ ok: false, reason: 'capacity' });
    step(3.1);
    expect(interaction.validatePlacement(request).ok).toBe(true);
  });
});
