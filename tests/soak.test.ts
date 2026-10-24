import { describe, expect, it } from 'vitest';
import { atmosphereBudget, DistantFireworks } from '../src/atmosphere';
import { AudioEngine } from '../src/audio/audioEngine';
import { CapacityBudget } from '../src/capacity';
import { createGameEventBus } from '../src/core/events';
import { qualityProfile } from '../src/core/quality';
import type { QualityLevel, Vec3 } from '../src/core/types';
import { Crackers } from '../src/crackers';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { Interaction } from '../src/interaction';
import { Neighbours } from '../src/neighbours';
import { ResourceTracker, StressScenario, stressLimits, stressSites } from '../src/perf';
import { createWorld } from '../src/world';
import { FakeAudioContext } from './fakeAudioContext';

const STEP = 1 / 60;

/** Deterministic PRNG (mulberry32) so the soak is repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Size of a private bookkeeping map, where a leak would accumulate entries. */
const sizeOf = (owner: object, field: string): number => (owner as unknown as Record<string, Map<unknown, unknown>>)[field]!.size;

/**
 * Every renderer-free gameplay module wired as in `main.ts`, driven by the
 * stress scenario: the headless half of issue #19's sustained session.
 */
async function soak(level: QualityLevel, minutes: number) {
  const random = seeded(19);
  const profile = qualityProfile(level);
  const bus = createGameEventBus();
  const world = createWorld();
  const hand: Vec3 = { x: 0, y: 1.1, z: 4.5 };
  const ctx = new FakeAudioContext();
  const audio = new AudioEngine({ bus, profile, random, createContext: () => ctx.asAudioContext() });
  await audio.unlock();
  const neighbours = new Neighbours({ areas: world.neighbourAreas, bus, random });
  const effects = new FireworksEffects(bus, { quality: profile, random, handPosition: () => hand });
  const distant = new DistantFireworks({ capacity: 4000, random });
  distant.setBudget(atmosphereBudget(profile));
  const capacity = new CapacityBudget({
    crackers: () => crackers,
    bus,
    quality: profile,
    effects: () => effects.stats,
    voices: () => audio.activeVoices,
  });
  const crackers = new Crackers({ bus, admission: capacity, random, handPosition: () => hand });
  const interaction = new Interaction({
    world,
    crackers: () => crackers.list(),
    hasRoom: () => capacity.hasRoom(),
    neighbours: () => neighbours.positions(),
  });
  const validate = (r: Parameters<Interaction['validatePlacement']>[0]) => interaction.validatePlacement(r);
  const scenario = new StressScenario({
    crackers,
    validatePlacement: validate,
    groundSites: stressSites(validate, 'anar', { minX: -3, maxX: 3, minZ: -6, maxZ: 2 }),
    rocketSites: stressSites(validate, 'rocket', { minX: -3, maxX: 3, minZ: -14, maxZ: -9 }, 2),
  });
  audio.setListener({ mode: 'firstPerson', position: { x: 0, y: 1.6, z: 5 }, forward: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0 });

  const tracker = new ResourceTracker({ limits: stressLimits(level) });
  const stepsPerSecond = Math.round(1 / STEP);
  for (let second = 0; second < minutes * 60; second++) {
    for (let i = 0; i < stepsPerSecond; i++) {
      scenario.update(STEP);
      crackers.update(STEP);
      effects.update(STEP);
      capacity.update(STEP);
      ctx.currentTime += STEP;
      audio.update(STEP);
      distant.update(STEP);
      neighbours.update(STEP);
    }
    const r = capacity.stats.resources;
    tracker.record({
      placedProps: r.placedProps.used,
      litCrackers: r.litCrackers.used,
      activeEffects: r.activeEffects.used,
      particles: r.particles.used,
      dynamicLights: r.dynamicLights.used,
      audioVoices: r.audioVoices.used,
      distantParticles: distant.liveParticles,
      effectHandles: sizeOf(effects, 'byCracker'),
      voiceHandles: sizeOf(audio, 'voices'),
      crackerVoiceLists: sizeOf(audio, 'crackerVoices'),
    });
  }
  return { tracker, scenario, capacity };
}

describe('sustained stress session (headless)', () => {
  it.each<[QualityLevel, number]>([
    ['low', 30],
    ['high', 15],
  ])('keeps every resource bounded on %s over %i simulated minutes', async (level, minutes) => {
    const { tracker, scenario, capacity } = await soak(level, minutes);
    const report = tracker.report();
    const problems = report.filter((r) => r.growing || r.overLimit);
    expect(problems).toEqual([]);

    // The run really was a stress test: caps were hit and rockets kept flying.
    const byMetric = Object.fromEntries(report.map((r) => [r.metric, r]));
    expect(byMetric.placedProps!.max).toBe(stressLimits(level).placedProps);
    expect(byMetric.litCrackers!.max).toBe(stressLimits(level).litCrackers);
    // The lit-cracker cap binds before the particle budget does.
    expect(byMetric.particles!.max).toBeGreaterThan(500);
    expect(byMetric.audioVoices!.max).toBeGreaterThan(0);
    expect(scenario.counters.rockets).toBeGreaterThan(minutes * 10);
    expect(scenario.counters.placementRejections.capacity).toBeGreaterThan(0);
    expect(capacity.stats.rejectedIgnitions).toBeGreaterThan(0);
    // Bookkeeping maps stay at most a few entries per lit cracker.
    expect(byMetric.effectHandles!.max).toBeLessThanOrEqual(stressLimits(level).litCrackers * 2);
    expect(byMetric.voiceHandles!.max).toBeLessThanOrEqual(stressLimits(level).audioVoices);
  }, 120_000);
});
