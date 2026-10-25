import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { BANGER_SECONDS } from '../src/audio/blast';
import { LADI_BATCH } from '../src/audio/sounds';
import { BANGER_RATE_SPREAD, createNoiseBank, synthesise } from '../src/audio/synth';
import { CapacityBudget } from '../src/capacity';
import { crackerForSlot } from '../src/core/actions';
import type { CameraView, Interactable, InteractionModule, PlacementResult, WorldModule } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEvents } from '../src/core/events';
import { FixedStep } from '../src/core/fixedStep';
import { LADI_STRING, ladiBanger } from '../src/core/ladi';
import { QUALITY_PROFILES, qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, isHandheld, type Vec3 } from '../src/core/types';
import { applyCrackerAction, CRACKER_DEFINITIONS, Crackers, headingOf, rollLadiChain } from '../src/crackers';
import { CrackerProps } from '../src/crackers/props';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { FireworksEngine } from '../src/effects/fireworksEngine';
import { LADI_BURN, LADI_POP } from '../src/effects/presets';
import { PlacementRules } from '../src/interaction';
import { bindingFor } from '../src/session/bindings';
import { Session } from '../src/session/session';
import { createHud } from '../src/ui/hud';
import { HudModel, promptLines } from '../src/ui/hudModel';
import { FakeAudioContext, type FakeSource } from './fakeAudioContext';
import * as THREE from 'three';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const { fuse, activeDuration } = TUNING.crackers;
const ladi = CRACKER_DEFINITIONS.ladi;

/** Deterministic PRNG (mulberry32). */
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

/** Crackers with every ladi event logged, stamped with the time it fired. */
function setup(random: () => number = seeded(3)) {
  const bus = createGameEventBus();
  const crackers = new Crackers({ bus, random, initialSelection: 'anar' });
  let time = 0;
  const pops: (GameEvents['ladiPop'] & { at: number })[] = [];
  const active: GameEvents['crackerActive'][] = [];
  const lit: GameEvents['fuseLit'][] = [];
  const finished: (GameEvents['crackerFinished'] & { at: number })[] = [];
  bus.on('ladiPop', (e) => pops.push({ ...e, at: time }));
  bus.on('crackerActive', (e) => active.push(e));
  bus.on('fuseLit', (e) => lit.push(e));
  bus.on('crackerFinished', (e) => finished.push({ ...e, at: time }));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      time += STEP;
      crackers.update(STEP);
    }
  };
  const light = (position = v(2, 0, 3), heading = 0) => {
    const placed = crackers.place({ type: 'ladi', position, heading });
    if (!placed.ok) throw new Error(placed.reason);
    expect(crackers.ignite(placed.id)).toEqual({ ok: true });
    return placed.id;
  };
  return { bus, crackers, pops, active, lit, finished, run, light, now: () => time };
}

describe('ladi definition', () => {
  it('is the fifth cracker, a ground cracker selected with key 5', () => {
    expect(CRACKER_TYPES[4]).toBe('ladi');
    expect(ladi).toMatchObject({ type: 'ladi', slot: 5, label: 'Ladi', handheld: false });
    expect(isHandheld('ladi')).toBe(false);
    expect(ladi.fuse).toBe(fuse.ladi);
    expect(ladi.activeDuration).toBe(activeDuration.ladi);
    expect(ladi.effect).toMatchObject({ kind: 'chain', bangers: LADI_STRING.bangers, length: LADI_STRING.length });
    expect(crackerForSlot(5)).toBe('ladi');
    expect(bindingFor('Digit5')).toEqual({ kind: 'press', action: { type: 'select', slot: 5 } });
  });

  it('a string of bangers about 0.6–1 m long, tied on in pairs along the cord', () => {
    expect(LADI_STRING.length).toBeGreaterThanOrEqual(0.6);
    expect(LADI_STRING.length).toBeLessThanOrEqual(1);
    const along = Array.from({ length: LADI_STRING.bangers }, (_, i) => ladiBanger(i).along);
    for (let i = 1; i < along.length; i++) expect(along[i]).toBeGreaterThanOrEqual(along[i - 1]!);
    expect(along[0]).toBeGreaterThan(0);
    expect(along[along.length - 1]).toBeLessThan(LADI_STRING.length);
    expect(ladiBanger(0).side).toBe(-ladiBanger(1).side);
  });

  it('is selected with 5 and puts the held phuljhari down', () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus });
    const selected: string[] = [];
    bus.on('crackerSelected', ({ type }) => selected.push(type));
    expect(crackers.held).not.toBeNull();
    const binding = bindingFor('Digit5');
    if (binding?.kind !== 'press') throw new Error('Digit5 is not a press');
    const ctx = controls(crackers, bus);
    expect(applyCrackerAction(binding.action, ctx)).toBe(true);
    expect(crackers.selected).toBe('ladi');
    expect(crackers.held).toBeNull();
    expect(selected).toEqual(['ladi']);
  });
});

describe('rolled ladi chain', () => {
  it('pops every banger once, in string order, very fast for about 3–5 s', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const chain = rollLadiChain(ladi, seeded(seed));
      expect(chain.pops.map((p) => p.banger)).toEqual([...Array(LADI_STRING.bangers).keys()]);
      for (let i = 1; i < chain.pops.length; i++) expect(chain.pops[i]!.time).toBeGreaterThanOrEqual(chain.pops[i - 1]!.time);
      const first = chain.pops[0]!.time;
      const last = chain.pops[chain.pops.length - 1]!.time;
      expect(first).toBeGreaterThan(0);
      expect(last - first).toBeGreaterThan(2.8);
      expect(last - first).toBeLessThan(5);
      expect(chain.duration).toBeGreaterThan(last);
      expect(chain.duration).toBeGreaterThanOrEqual(activeDuration.ladi * 0.85 - 1e-9);
      expect(chain.duration).toBeLessThanOrEqual(activeDuration.ladi * 1.15 + 1e-9);
    }
  });

  it('rattles unevenly, with doublets, the odd stumble and the odd louder bang', () => {
    const gaps: number[] = [];
    let loud = 0;
    let pops = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { pops: chain } = rollLadiChain(ladi, seeded(seed));
      for (let i = 1; i < chain.length; i++) gaps.push(chain[i]!.time - chain[i - 1]!.time);
      loud += chain.filter((p) => p.loud).length;
      pops += chain.length;
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)]!;
    // "tadatadatada": more than ten pops a second most of the time.
    expect(median).toBeLessThan(0.1);
    expect(gaps.filter((g) => g < 0.025).length).toBeGreaterThan(gaps.length * 0.05);
    expect(gaps.filter((g) => g > 0.13).length).toBeGreaterThan(0);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(50);
    expect(loud).toBeGreaterThan(0);
    expect(loud).toBeLessThan(pops * 0.25);
  });

  it('lasts exactly the nominal time with a middling roll', () => {
    expect(rollLadiChain(ladi, () => 0.5).duration).toBeCloseTo(activeDuration.ladi);
  });
});

describe('ladi lifecycle', () => {
  it('lies along the heading it was placed with and is lit at its fuse', () => {
    const t = setup();
    const id = t.light(v(2, 0, 3), Math.PI / 2);
    expect(t.crackers.get(id)).toMatchObject({ type: 'ladi', state: 'fuseBurning', heading: Math.PI / 2, popped: 0 });
    expect(t.lit).toEqual([{ id, type: 'ladi', position: v(2, 0, 3), heading: Math.PI / 2 }]);
    t.run(fuse.ladi - 0.1);
    expect(t.active).toHaveLength(0);
    t.run(0.15);
    expect(t.active).toHaveLength(1);
    expect(t.active[0]!.ladi).toEqual({ chain: t.crackers.ladiChain(id), heading: Math.PI / 2 });
  });

  it('pops each banger on time along the string, away from the player, then finishes', () => {
    const t = setup();
    // Facing -X: the fuse end is towards +X, where the player stands.
    const id = t.light(v(2, 0, 3), Math.PI / 2);
    // Lit at t = 0, so it goes active at the end of its fuse.
    const startedAt = fuse.ladi;
    const chain = t.crackers.ladiChain(id)!;
    t.run(fuse.ladi + chain.duration + 1);

    expect(t.pops).toHaveLength(LADI_STRING.bangers);
    t.pops.forEach((pop, i) => {
      expect(pop).toMatchObject({ id, index: i, banger: i, loud: chain.pops[i]!.loud });
      // On the step its time comes, never early.
      const due = startedAt + chain.pops[i]!.time;
      expect(pop.at).toBeGreaterThanOrEqual(due - 1e-6);
      expect(pop.at).toBeLessThan(due + STEP + 1e-6);
      // On the string, on the ground.
      expect(Math.abs(pop.position.z - 3)).toBeLessThan(0.05);
      expect(Math.abs(pop.position.x - 2)).toBeLessThan(LADI_STRING.length / 2);
      expect(pop.position.y).toBeCloseTo(LADI_STRING.bangerRadius);
    });
    expect(t.pops[0]!.position.x).toBeGreaterThan(2.3);
    expect(t.pops[t.pops.length - 1]!.position.x).toBeLessThan(1.7);

    expect(t.finished).toEqual([{ id, type: 'ladi', reason: 'completed', at: expect.any(Number) }]);
    expect(t.finished[0]!.at - startedAt).toBeCloseTo(chain.duration, 1);
    expect(t.finished[0]!.at).toBeGreaterThanOrEqual(t.pops[t.pops.length - 1]!.at);
    expect(t.crackers.list()).toHaveLength(0);
  });

  it('tracks how many bangers have gone and counts as lit until it is done', () => {
    const t = setup();
    const id = t.light();
    expect(t.crackers.litCount).toBe(1);
    t.run(fuse.ladi + 1.5);
    const popped = t.crackers.get(id)!.popped!;
    expect(popped).toBe(t.pops.length);
    expect(popped).toBeGreaterThan(5);
    expect(popped).toBeLessThan(LADI_STRING.bangers);
    expect(t.crackers.litCount).toBe(1);
    t.run(6);
    expect(t.crackers.litCount).toBe(0);
  });

  it('places along the view: a click facing -X lays the string running -X', () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, initialSelection: 'ladi' });
    const forward = v(-0.8, -0.6, 0);
    expect(applyCrackerAction({ type: 'place' }, controls(crackers, bus, { forward }))).toBe(true);
    const [placed] = crackers.list();
    expect(placed).toMatchObject({ type: 'ladi', state: 'placed' });
    expect(placed!.heading).toBeCloseTo(Math.PI / 2);
    expect(headingOf(v(0, 0, -1))).toBeCloseTo(0);
  });

  it('is refused like any cracker while the hands carry something', () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, initialSelection: 'ladi' });
    const blocked: GameEvents['crackerBlocked'][] = [];
    bus.on('crackerBlocked', (e) => blocked.push(e));
    const ctx = { ...controls(crackers, bus), hands: { crackerBlock: () => 'carryingPlate' as const } };
    applyCrackerAction({ type: 'place' }, ctx);
    applyCrackerAction({ type: 'select', slot: 5 }, ctx);
    expect(crackers.list()).toHaveLength(0);
    expect(blocked.map((e) => e.action)).toEqual(['place', 'select']);
  });
});

describe('ladi pause and reset', () => {
  it('freezes mid-chain while paused and picks up where it left off', async () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, random: seeded(9) });
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({ bus, createContext: () => ctx.asAudioContext(), random: () => 0.5 });
    const session = new Session({ bus, resettables: [crackers] });
    session.start();
    await audio.unlock();
    const loop = new FixedStep({ step: STEP, maxSteps: 8 });
    let pops = 0;
    bus.on('ladiPop', () => pops++);
    const frame = (seconds: number) => {
      for (let t = 0; t < seconds; t += 0.02) {
        const { steps } = loop.advance(session.paused ? 0 : 0.02);
        for (let i = 0; i < steps; i++) crackers.update(STEP);
      }
    };
    const placed = crackers.place({ type: 'ladi', position: v(0, 0, 0) });
    if (!placed.ok) throw new Error(placed.reason);
    crackers.ignite(placed.id);
    frame(fuse.ladi + 1);
    const before = pops;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(LADI_STRING.bangers);

    session.pause('user');
    frame(10);
    expect(pops).toBe(before);
    expect(crackers.get(placed.id)?.popped).toBe(before);
    expect(ctx.state).toBe('suspended');

    session.resume();
    frame(8);
    expect(pops).toBe(LADI_STRING.bangers);
    expect(crackers.list()).toHaveLength(0);
  });

  it('stops popping on a fresh session', () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, random: seeded(2) });
    const effects = new FireworksEffects(bus, { random: seeded(4) });
    const session = new Session({ bus, resettables: [crackers] });
    let pops = 0;
    bus.on('ladiPop', () => pops++);
    const placed = crackers.place({ type: 'ladi', position: v(0, 0, 0) });
    if (!placed.ok) throw new Error(placed.reason);
    crackers.ignite(placed.id);
    for (let i = 0; i < (fuse.ladi + 1) * 60; i++) {
      crackers.update(STEP);
      effects.update(STEP);
    }
    expect(pops).toBeGreaterThan(0);
    session.reset();
    const after = pops;
    for (let i = 0; i < 6 * 60; i++) crackers.update(STEP);
    expect(pops).toBe(after);
    expect(crackers.list()).toHaveLength(0);
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
  });
});

describe('ladi capacity', () => {
  function budget() {
    const bus = createGameEventBus();
    const tuning = { ...TUNING, caps: { ...TUNING.caps, maxPlacedCrackers: 2, maxLitCrackers: 1 } };
    const capacity = new CapacityBudget({ crackers: () => crackers, bus, tuning, quality: qualityProfile('low') });
    const crackers = new Crackers({ bus, tuning, admission: capacity, random: () => 0.5 });
    return { bus, capacity, crackers };
  }

  it('takes a placed slot and a lit slot like any ground cracker, and frees both when done', () => {
    const { capacity, crackers } = budget();
    const a = crackers.place({ type: 'ladi', position: v(0, 0, 0) });
    const b = crackers.place({ type: 'anar', position: v(1, 0, 0) });
    expect(crackers.place({ type: 'ladi', position: v(2, 0, 0) })).toEqual({ ok: false, reason: 'capacity' });
    if (!a.ok || !b.ok) throw new Error('placement refused');
    expect(crackers.ignite(a.id)).toEqual({ ok: true });
    expect(crackers.ignite(b.id)).toEqual({ ok: false, reason: 'capacity' });
    expect(capacity.stats.resources.litCrackers.used).toBe(1);
    for (let i = 0; i < (fuse.ladi + activeDuration.ladi + 0.1) * 60; i++) crackers.update(STEP);
    expect(capacity.stats.resources).toMatchObject({ placedProps: { used: 1 }, litCrackers: { used: 0 } });
    expect(crackers.ignite(b.id)).toEqual({ ok: true });
  });

  it('is reclaimed when abandoned unlit', () => {
    const { bus, capacity, crackers } = budget();
    const finished: GameEvents['crackerFinished'][] = [];
    bus.on('crackerFinished', (e) => finished.push(e));
    const placed = crackers.place({ type: 'ladi', position: v(0, 0, 0) });
    if (!placed.ok) throw new Error(placed.reason);
    for (let i = 0; i < (TUNING.caps.unlitReclaimAfter + 1) * 60; i++) {
      crackers.update(STEP);
      capacity.update(STEP);
    }
    expect(finished).toEqual([{ id: placed.id, type: 'ladi', reason: 'reclaimed' }]);
  });
});

describe('ladi placement', () => {
  /** Flat ground with a pillar at x ∈ [-5, -4], a doorway at z = -10 and a neighbour area at x = -20. */
  function world(): WorldModule {
    return {
      bounds: { min: v(-50, -1, -50), max: v(50, 20, 50) },
      spawn: v(0, 0, 0),
      doorways: [{ id: 'door', centre: v(0, 0.8, -10), radius: 1.2 }],
      diyaSites: [],
      neighbourAreas: [{ id: 'gathering', centre: v(-20, 0, 0), radius: 2 }],
      surfaceBelow: (p) => ({ point: v(p.x, 0, p.z), normal: v(0, 1, 0), supportsPlacement: true }),
      isClear: (p, radius) => {
        const dx = Math.max(-5 - p.x, 0, p.x + 4);
        const dz = Math.max(-1 - p.z, 0, p.z - 1);
        return dx * dx + dz * dz >= radius * radius;
      },
      // A low roof everywhere: ladis, unlike rockets, need no sky.
      clearanceAbove: () => 2,
    };
  }
  const at = (target: Vec3) => ({ type: 'ladi' as const, target, playerPosition: v(target.x, 0, target.z + 1.5) });
  const reason = (result: PlacementResult) => (result.ok ? 'ok' : result.reason);

  it('follows the same rules as the other ground crackers', () => {
    const rules = new PlacementRules({
      world: world(),
      crackers: () => [{ id: 'c', type: 'anar', state: 'placed', position: v(10, 0, 10), stateTime: 0 }],
      neighbours: () => [{ id: 'n', position: v(20, 0, 20) }],
    });
    expect(rules.validate(at(v(5, 0, 5)))).toEqual({ ok: true, preview: { type: 'ladi', position: v(5, 0, 5) } });
    expect(reason(rules.validate(at(v(-3.8, 0, 0))))).toBe('blockedByGeometry');
    expect(reason(rules.validate(at(v(10.3, 0, 10))))).toBe('blockedByGeometry');
    expect(reason(rules.validate(at(v(0, 0, -8))))).toBe('nearDoorway');
    expect(reason(rules.validate(at(v(-17, 0, 0))))).toBe('nearNeighbour');
    expect(reason(rules.validate(at(v(21, 0, 20))))).toBe('nearNeighbour');
    expect(reason(rules.validate({ ...at(v(5, 0, 5)), playerPosition: v(5, 0, 9) }))).toBe('outOfReach');
  });

  it('keeps its whole string clear of walls: the clearance covers half its length', () => {
    expect(TUNING.placement.geometryClearance).toBeGreaterThanOrEqual(LADI_STRING.length / 2);
  });
});

describe('ladi effects', () => {
  function burn(profile = QUALITY_PROFILES.low, seed = 6) {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, random: seeded(seed) });
    const effects = new FireworksEffects(bus, { quality: profile, random: seeded(seed + 1) });
    const placed = crackers.place({ type: 'ladi', position: v(0, 0, 0) });
    if (!placed.ok) throw new Error(placed.reason);
    crackers.ignite(placed.id);
    const step = (seconds: number, check: () => void = () => {}) => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        crackers.update(STEP);
        effects.update(STEP);
        check();
      }
    };
    return { bus, crackers, effects, step, id: placed.id };
  }

  it('sparkles at the fuse tip and walks in to the string as it burns', () => {
    const { effects, step, id } = burn();
    const at = () => effects.engine.emitterPosition(effects.handleFor(id))!;
    // Heading 0: the string runs -Z, so the fuse sticks out towards +Z.
    expect(at().z).toBeCloseTo(LADI_STRING.length / 2 + LADI_STRING.fuse);
    step(fuse.ladi * 0.5);
    expect(at().z).toBeLessThan(LADI_STRING.length / 2 + LADI_STRING.fuse);
    expect(at().z).toBeGreaterThan(LADI_STRING.length / 2);
  });

  it('flashes, sparks, throws paper and puffs smoke at each pop, all in one effect', () => {
    const { effects, step } = burn(QUALITY_PROFILES.medium);
    let matte = 0;
    let effectsPeak = 0;
    // The fuse's last sparks die out first; then the whole ladi is one effect.
    step(fuse.ladi + 0.5);
    step(1.5, () => {
      matte = Math.max(matte, effects.engine.matte.count);
      effectsPeak = Math.max(effectsPeak, effects.stats.activeEffects);
    });
    expect(effects.engine.particles.count).toBeGreaterThan(10);
    expect(matte).toBeGreaterThan(20);
    expect(effectsPeak).toBe(1);
    // Paper flies up and smoke rises: nothing matte below the ground yet.
    const p = effects.engine.matte.positions;
    let highest = 0;
    for (let i = 0; i < effects.engine.matte.count; i++) highest = Math.max(highest, p[i * 3 + 1]!);
    expect(highest).toBeGreaterThan(0.2);
  });

  it.each(['low', 'medium', 'high'] as const)('stays within the %s budgets and drains to nothing', (level) => {
    const profile = QUALITY_PROFILES[level];
    const { effects, step } = burn(profile);
    let lights = 0;
    step(fuse.ladi + activeDuration.ladi * 1.2, () => {
      const { liveParticles, dynamicLights, activeEffects } = effects.stats;
      expect(liveParticles).toBeLessThanOrEqual(profile.maxParticles);
      expect(dynamicLights).toBeLessThanOrEqual(profile.maxDynamicLights);
      expect(activeEffects).toBeLessThanOrEqual(profile.maxActiveEffects);
      lights = Math.max(lights, dynamicLights);
    });
    // Only the odd loud bang gets a light.
    expect(lights).toBeGreaterThan(0);
    step(4);
    expect(effects.stats).toMatchObject({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 });
  });

  it('never takes a light from another firework, and gives most pops none', () => {
    const engine = new FireworksEngine({ particleCapacity: 4000, emitterCapacity: 4, flashCapacity: 2, random: seeded(1) });
    engine.applyBudget({ maxParticles: 4000, maxActiveEffects: 4, maxDynamicLights: 2, countScale: 1 });
    const handle = engine.startStream(LADI_BURN, 0, 0, 0);
    // Two dim, long glows hold both lights.
    engine.flash(5, 1, 5, 0xffffff, 1, 5, 10);
    engine.flash(-5, 1, 5, 0xffffff, 1, 5, 10);
    const lit = engine.flashes.slots.map((s) => s.x);
    for (let i = 0; i < 20; i++) engine.pop(handle, 0, 0.01, -i * 0.02, LADI_POP, true);
    expect(engine.flashes.slots.map((s) => s.x)).toEqual(lit);

    const quiet = new FireworksEngine({ particleCapacity: 4000, emitterCapacity: 4, flashCapacity: 2, random: seeded(1) });
    const stream = quiet.startStream(LADI_BURN, 0, 0, 0);
    for (let i = 0; i < 20; i++) quiet.pop(stream, 0, 0.01, -i * 0.02, LADI_POP, false);
    expect(quiet.stats.dynamicLights).toBe(0);
  });

  it('shares one particle budget between sparks and paper and smoke', () => {
    const engine = new FireworksEngine({ particleCapacity: 4000, emitterCapacity: 4, flashCapacity: 2, random: seeded(1) });
    engine.applyBudget({ maxParticles: 60, maxActiveEffects: 4, maxDynamicLights: 2, countScale: 1 });
    const handle = engine.startStream(LADI_BURN, 0, 0, 0);
    for (let i = 0; i < 40; i++) {
      engine.pop(handle, 0, 0.01, 0, LADI_POP, i % 3 === 0);
      engine.update(STEP);
      expect(engine.particles.count + engine.matte.count).toBeLessThanOrEqual(60);
      expect(engine.stats.liveParticles).toBe(engine.particles.count + engine.matte.count);
    }
    expect(engine.matte.count).toBeGreaterThan(0);
    expect(engine.matte.count).toBeLessThanOrEqual(Math.floor(60 * 0.06) + 1);
  });

  it('shows nothing, and still pops on time, when its effect was refused', () => {
    const { bus, crackers, effects, step, id } = burn({ ...QUALITY_PROFILES.low, maxActiveEffects: 0 });
    let pops = 0;
    bus.on('ladiPop', () => pops++);
    step(fuse.ladi + activeDuration.ladi * 1.2, () => expect(effects.stats.liveParticles).toBe(0));
    expect(pops).toBe(LADI_STRING.bangers);
    expect(crackers.get(id)).toBeUndefined();
  });
});

describe('ladi prop', () => {
  const snap = (state: 'placed' | 'active', popped = 0, heading = 0) => ({
    id: 'l',
    type: 'ladi' as const,
    state,
    position: v(1, 0, -2),
    stateTime: 0,
    heading,
    popped,
  });
  const mesh = (props: CrackerProps, name: string) => props.object.getObjectByName(name) as THREE.InstancedMesh;

  it('lays a string of bangers and a fuse on the ground, one draw call each', () => {
    const props = new CrackerProps(4);
    props.sync([snap('placed')]);
    expect(mesh(props, 'crackerProps.ladiCord').count).toBe(1);
    expect(mesh(props, 'crackerProps.ladiBanger').count).toBe(LADI_STRING.bangers);
    // All share one geometry and material.
    expect(props.object.children.filter((c) => c.name.startsWith('crackerProps.ladi'))).toHaveLength(2);
  });

  it('runs the string along its heading and drops each banger as it pops', () => {
    const props = new CrackerProps(4);
    props.sync([snap('active', 20, Math.PI / 2)]);
    const bangers = mesh(props, 'crackerProps.ladiBanger');
    expect(bangers.count).toBe(LADI_STRING.bangers - 20);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const xs: number[] = [];
    for (let i = 0; i < bangers.count; i++) {
      bangers.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      expect(position.z).toBeCloseTo(-2);
      xs.push(position.x);
    }
    // The remaining bangers are the far part of the string (heading π/2 runs -X from the fuse at +X).
    const nearest = 1 + LADI_STRING.length / 2 - ladiBanger(20).along;
    expect(Math.max(...xs)).toBeLessThan(nearest + 0.03);
    expect(Math.min(...xs)).toBeLessThan(1 - LADI_STRING.length / 2 + 0.05);
    props.sync([]);
    expect(bangers.count).toBe(0);
    expect(mesh(props, 'crackerProps.ladiCord').count).toBe(0);
  });
});

describe('ladi sound', () => {
  // No town ambience, so every voice counted is the ladi's.
  async function audioSetup(profile = { ...qualityProfile('low'), ambientFireworks: false }) {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({ bus, createContext: () => ctx.asAudioContext(), profile, random: () => 0.5 });
    await audio.unlock();
    return { bus, ctx, audio };
  }

  /** Drive a whole ladi through the audio engine on its chain's own timing. */
  function play(bus: GameEventBus, ctx: FakeAudioContext, audio: AudioEngine, onStep: () => void = () => {}) {
    const chain = rollLadiChain(ladi, seeded(12));
    bus.emit('fuseLit', { id: 'l', type: 'ladi', position: v(0, 0, -2), heading: 0 });
    bus.emit('crackerActive', { id: 'l', type: 'ladi', position: v(0, 0, -2), ladi: { chain, heading: 0 } });
    let next = 0;
    for (let t = 0; t <= chain.duration + STEP; t += STEP) {
      while (next < chain.pops.length && chain.pops[next]!.time <= t) {
        const pop = chain.pops[next]!;
        bus.emit('ladiPop', { id: 'l', index: next, banger: pop.banger, position: v(0, 0, -2), loud: pop.loud });
        next++;
      }
      ctx.currentTime += STEP;
      audio.update(STEP);
      onStep();
    }
    bus.emit('crackerFinished', { id: 'l', type: 'ladi', reason: 'completed' });
    return chain;
  }

  it('plays its pops in a few batched, spatial voices rather than one per banger', async () => {
    const { bus, ctx, audio } = await audioSetup();
    const panners = ctx.panners.length;
    const before = ctx.gains.length;
    let peak = 0;
    const chain = play(bus, ctx, audio, () => (peak = Math.max(peak, audio.activeVoices)));
    const voices = ctx.panners.length - panners;
    // One for the fuse, then a batch every `LADI_BATCH` seconds or so.
    expect(voices).toBeGreaterThan(3);
    expect(voices).toBeLessThan(chain.pops.length / 4);
    expect(voices - 1).toBeLessThanOrEqual(Math.ceil(chain.duration / LADI_BATCH) + 2);
    expect(peak).toBeLessThanOrEqual(3);
    expect(ctx.gains.length).toBeGreaterThan(before);
  });

  /** Sources playing one of the banger recordings: one-shot, banger-length buffers. */
  const bangerSources = (ctx: FakeAudioContext): FakeSource[] =>
    ctx.sources.filter(
      (source) => !source.loop && (source.buffer as AudioBuffer | null)?.length === Math.round(ctx.sampleRate * BANGER_SECONDS),
    );

  it('bangs once per banger, at its time', async () => {
    const { bus, ctx, audio } = await audioSetup();
    const start = ctx.currentTime;
    const chain = play(bus, ctx, audio);
    const bangs = bangerSources(ctx);
    expect(bangs).toHaveLength(chain.pops.length);
    // Each batch starts on its first pop's event, so every bang lands within a step of its pop.
    bangs.forEach((bang, i) => {
      expect(Math.abs(bang.startedAt! - start - chain.pops[i]!.time)).toBeLessThanOrEqual(STEP + 1e-9);
    });
  });

  it('schedules the batch pops exactly at their offsets, each at its own level, none pitched', () => {
    const ctx = new FakeAudioContext();
    const audio = ctx.asAudioContext();
    const pops = [
      { at: 0, level: 1 },
      { at: 0.05, level: 0.6 },
      { at: 0.06, level: 0.7 },
      { at: 0.2, level: 0.15 },
    ];
    synthesise(audio, createNoiseBank(audio, seeded(1)), 'ladiPops', audio.createGain(), { t0: 1, duration: 0.45, gain: 1, pops });
    const bangs = bangerSources(ctx);
    expect(bangs.map((b) => b.startedAt)).toEqual(pops.map((p) => expect.closeTo(1 + p.at, 9)));
    // Each bang feeds its own level, so a quiet pop never turns down a loud one's tail.
    const levels = bangs.map((b) => (b.outputs[0] as GainNode).gain.value);
    expect(levels).toEqual(pops.map((p) => p.level));
    expect(new Set(bangs.map((b) => b.outputs[0])).size).toBe(pops.length);
    // A bang has no pitch: every one plays within a few percent of its recorded speed.
    for (const bang of bangs) expect(Math.abs(bang.playbackRate.value - 1)).toBeLessThanOrEqual(BANGER_RATE_SPREAD);
    // And each has finished by the time the voice ends.
    for (const bang of bangs) expect(bang.stoppedAt).toBeLessThanOrEqual(1.45 + 1e-9);
  });

  it('lets its last bangs ring out after it finishes, but falls silent on reset', async () => {
    const { bus, ctx, audio } = await audioSetup();
    const chain = rollLadiChain(ladi, seeded(12));
    const last = chain.pops.length - 1;
    bus.emit('crackerActive', { id: 'l', type: 'ladi', position: v(0, 0, -2), ladi: { chain, heading: 0 } });
    bus.emit('ladiPop', { id: 'l', index: last, banger: last, position: v(0, 0, -2), loud: true });
    bus.emit('crackerFinished', { id: 'l', type: 'ladi', reason: 'completed' });
    expect(audio.activeVoices).toBe(1);
    // Nothing is cut short (a stopped voice would be gone within its 60 ms fade).
    expect(ctx.soundingSources().filter((s) => s.stoppedAt !== null && s.stoppedAt < 0.1)).toHaveLength(0);
    bus.emit('sessionReset', {});
    expect(audio.activeVoices).toBe(0);
  });

  it('never starves the others: a full pool on Low keeps its voice count', async () => {
    const { bus, ctx, audio } = await audioSetup();
    let peak = 0;
    for (let i = 0; i < 3; i++) bus.emit('crackerActive', { id: `a${i}`, type: 'anar', position: v(i, 0, 0) });
    play(bus, ctx, audio, () => (peak = Math.max(peak, audio.activeVoices)));
    expect(peak).toBeLessThanOrEqual(qualityProfile('low').maxAudioVoices);
    // The anars still roar.
    expect(audio.activeVoices).toBeGreaterThanOrEqual(3);
  });
});

describe('ladi on the HUD', () => {
  it('prompts to place and light a ladi', () => {
    expect(promptLines('ladi', { interactable: null })).toEqual([{ text: 'Click: Place ladi', blocked: false }]);
    const target: Interactable = { kind: 'cracker', id: 'l', position: v(0, 0, -1) };
    expect(promptLines('ladi', { interactable: target, interactableType: 'ladi' })[0]).toEqual({ text: 'E: Light ladi', blocked: false });
  });

  it('shows five slots, the fifth "5 Ladi"', () => {
    const doc = fakeDocument();
    const parent = doc.createElement('div');
    const bus = createGameEventBus();
    const model = new HudModel({ bus });
    createHud(parent as unknown as HTMLElement, model);
    bus.emit('sessionStarted', {});
    bus.emit('crackerSelected', { type: 'ladi' });
    const hotbar = (parent.children[0] as FakeElement).children.at(-1) as FakeElement;
    expect(hotbar.children).toHaveLength(5);
    const fifth = hotbar.children[4] as FakeElement;
    expect((fifth.children[0] as FakeElement).textContent).toBe('5');
    expect(fifth.children[1]).toBe('Ladi');
    expect(model.selected).toBe('ladi');
  });
});

// ── helpers ─────────────────────────────────────────────────────────────

/** The cracker controls with an interaction that accepts every placement where aimed. */
function controls(crackers: Crackers, bus: GameEventBus, view: Partial<CameraView> = {}) {
  const interaction: InteractionModule = {
    findInteractable: () => null,
    validatePlacement: ({ type, target }) => ({ ok: true, preview: { type, position: target } }),
  };
  const camera: CameraView = { mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, -0.5, -0.8), yaw: 0, pitch: 0, ...view };
  return {
    crackers,
    interaction,
    bus,
    pose: () => ({ position: v(0, 0, 0), yaw: 0, grounded: true }),
    view: () => camera,
  };
}

interface FakeElement {
  children: (FakeElement | string)[];
  style: Record<string, string>;
  textContent: string;
  className: string;
  ownerDocument: { createElement(tag?: string): FakeElement };
  append(...nodes: (FakeElement | string)[]): void;
  appendChild(node: FakeElement): void;
  replaceChildren(...nodes: (FakeElement | string)[]): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

/** Just enough DOM for the HUD to build its hotbar headless. */
function fakeDocument(): { createElement(tag?: string): FakeElement } {
  const doc = {
    createElement(_tag?: string): FakeElement {
      const element: FakeElement = {
        children: [],
        style: {},
        textContent: '',
        className: '',
        ownerDocument: doc,
        append: (...nodes) => element.children.push(...nodes),
        appendChild: (node) => void element.children.push(node),
        replaceChildren: (...nodes) => void (element.children = nodes),
        remove: () => undefined,
        setAttribute: () => undefined,
      };
      return element;
    },
  };
  return doc;
}
