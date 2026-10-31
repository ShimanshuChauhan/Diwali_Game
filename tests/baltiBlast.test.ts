import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { createNoiseBank, synthesise } from '../src/audio/synth';
import {
  applyBaltiAction,
  BALTI,
  BALTI_PROMPTS,
  BALTI_RUN_TEXT,
  BALTI_SPOT,
  BaltiBlast,
  BaltiEffects,
  BaltiFlight,
  baltiPrompt,
  restingTilt,
  type BaltiControlContext,
} from '../src/balti';
import { createGameEventBus, type GameEventBus, type GameEvents } from '../src/core/events';
import { qualityProfile } from '../src/core/quality';
import type { Vec3 } from '../src/core/types';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { Session } from '../src/session/session';
import { promptLines } from '../src/ui/hudModel';
import { createWorld } from '../src/world';
import { FakeAudioContext } from './fakeAudioContext';

const STEP = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const SPOT = v(0, 0, 0);
/** Facing the spot from the south, where the player walks up. */
const NORTH = v(0, 0, -1);
const AT_SPOT = v(0, 0, 1.2);

/** Small deterministic PRNG so behaviour is repeatable. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Log {
  steps: GameEvents['baltiStep'][];
  blasts: GameEvents['baltiBlast'][];
  bounces: GameEvents['baltiBounce'][];
}

function setup(options: { player?: Vec3 | null; seed?: number; bus?: GameEventBus } = {}) {
  const bus = options.bus ?? createGameEventBus();
  const log: Log = { steps: [], blasts: [], bounces: [] };
  bus.on('baltiStep', (e) => log.steps.push(e));
  bus.on('baltiBlast', (e) => log.blasts.push(e));
  bus.on('baltiBounce', (e) => log.bounces.push(e));
  const player = { at: options.player ?? null };
  const blast = new BaltiBlast({ spot: SPOT, bus, random: seeded(options.seed ?? 7), playerPosition: () => player.at });
  return { bus, log, player, blast };
}

function step(blast: BaltiBlast, seconds: number): void {
  for (let t = 0; t < seconds; t += STEP) blast.update(STEP);
}

/** Step until `done` holds, at most `limit` seconds; returns the seconds taken. */
function until(blast: BaltiBlast, done: () => boolean, limit = 40): number {
  let t = 0;
  while (!done() && t < limit) {
    blast.update(STEP);
    t += STEP;
  }
  return t;
}

const groundDistance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('the spot', () => {
  it('sits on the courtyard ground, clear of the neighbours and the street doors', () => {
    const world = createWorld();
    expect(world.surfaceBelow(BALTI_SPOT)?.point.y).toBe(0);
    expect(world.surfaceBelow(BALTI_SPOT)?.supportsPlacement).toBe(true);
    // Nothing the balti could come down on, within its widest landing and a bit.
    for (const solid of world.layout.solids) {
      if (solid.kind === 'ground') continue;
      const { min, max } = solid.box;
      const dx = Math.max(min.x - BALTI_SPOT.x, 0, BALTI_SPOT.x - max.x);
      const dz = Math.max(min.z - BALTI_SPOT.z, 0, BALTI_SPOT.z - max.z);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(BALTI.maxDrift + 1);
    }
    for (const area of world.neighbourAreas) {
      expect(groundDistance(area.centre, BALTI_SPOT)).toBeGreaterThan(area.radius + BALTI.gatherRadius);
    }
    for (const door of world.doorways) {
      expect(groundDistance(door.centre, BALTI_SPOT)).toBeGreaterThan(BALTI.safeRadius);
    }
  });

  it('leaves the kids room to run back on ground they can stand on', () => {
    const world = createWorld();
    const blast = new BaltiBlast({ spot: BALTI_SPOT, random: seeded(1) });
    for (let i = 0; i < BALTI.kids; i++) {
      const angle = (i / BALTI.kids) * Math.PI * 2 + 0.4;
      const safe = v(BALTI_SPOT.x + Math.sin(angle) * BALTI.safeRadius, 0, BALTI_SPOT.z + Math.cos(angle) * BALTI.safeRadius);
      expect(world.contains(safe)).toBe(true);
      expect(world.surfaceBelow(safe)?.point.y).toBe(0);
      // Room for a kid to stand: nothing solid within half a metre at body height.
      expect(world.isClear(v(safe.x, 0.6, safe.z), 0.5)).toBe(true);
    }
    expect(blast.views()).toHaveLength(BALTI.kids);
  });
});

describe('the kids', () => {
  it('start huddled round the spot, facing it, with the balti waiting beside it', () => {
    const { blast } = setup();
    expect(blast.phase).toBe('ready');
    for (const kid of blast.views()) {
      expect(groundDistance(kid.position, SPOT)).toBeCloseTo(BALTI.gatherRadius, 5);
      expect(kid.activity).toBe('chat');
    }
    const balti = blast.balti;
    expect(balti.tilt).toBe(0);
    expect(balti.position.y).toBeCloseTo(BALTI.restHeight);
    expect(groundDistance(balti.position, SPOT)).toBeGreaterThan(0.5);
    expect(blast.bombDown).toBe(false);
  });

  it('play a whole round on their own: bomb, balti, fuse, run, blast, cheer, huddle', () => {
    const { blast, log } = setup();
    const t = until(blast, () => log.steps.length > 0);
    expect(t).toBeLessThanOrEqual(BALTI.kidRoundWait[1] + 5);
    expect(log.steps.map((s) => s.step)).toEqual(['placed']);
    // The leader walked in and squats over it.
    expect(blast.views().filter((k) => k.activity === 'crouch')).toHaveLength(1);

    until(blast, () => blast.phase === 'fuseBurning');
    expect(log.steps.map((s) => [s.step, s.by])).toEqual([
      ['placed', 'kid'],
      ['covered', 'kid'],
      ['lit', 'kid'],
    ]);
    expect(log.steps[2]!.fuse).toBe(BALTI.fuse);
    expect(blast.balti.tilt).toBeCloseTo(Math.PI);
    expect(groundDistance(blast.balti.position, SPOT)).toBeLessThan(1e-9);
    expect(blast.views().every((k) => k.activity === 'run')).toBe(true);

    // Everyone gets to a safe spot before the bang and braces for it.
    step(blast, BALTI.fuse - 0.1);
    for (const kid of blast.views()) {
      expect(kid.activity).toBe('brace');
      expect(groundDistance(kid.position, SPOT)).toBeCloseTo(BALTI.safeRadius, 5);
    }

    until(blast, () => log.blasts.length > 0);
    expect(log.blasts[0]).toEqual({ position: SPOT, by: 'kid' });
    expect(blast.phase).toBe('flying');
    expect(blast.bombDown).toBe(false);
    expect(blast.views().every((k) => k.activity === 'cheer')).toBe(true);
    // They follow the balti up.
    step(blast, 0.4);
    expect(Math.max(...blast.views().map((k) => k.lookUp))).toBeGreaterThan(0.3);

    until(blast, () => blast.phase === 'cheering');
    expect(log.bounces.length).toBeGreaterThan(0);
    until(blast, () => blast.phase === 'ready');
    until(blast, () => blast.views().every((k) => k.activity === 'chat'), 10);
    for (const kid of blast.views()) expect(groundDistance(kid.position, SPOT)).toBeCloseTo(BALTI.gatherRadius, 5);
    expect(blast.blasts).toBe(1);
    expect(blast.setBy).toBeNull();
  });

  it('take turns leading and keep playing rounds', () => {
    const { blast, log } = setup({ seed: 3 });
    const leaders = new Set<string>();
    for (let round = 0; round < 4; round++) {
      until(blast, () => log.steps.length === round * 3 + 1);
      leaders.add(blast.views().find((k) => k.activity === 'crouch' || k.activity === 'walk')!.id);
      until(blast, () => log.blasts.length === round + 1);
    }
    expect(log.blasts).toHaveLength(4);
    expect(leaders.size).toBeGreaterThan(1);
  });

  it('wait for a player standing at the spot rather than starting without them', () => {
    const { blast, log } = setup({ player: AT_SPOT });
    step(blast, 30);
    expect(log.steps).toHaveLength(0);
    expect(blast.offer(AT_SPOT, NORTH)).toBe('placed');
  });

  it('shake off a session reset mid round', () => {
    const bus = createGameEventBus();
    const session = new Session({ bus });
    const { blast, log } = setup({ bus });
    until(blast, () => blast.phase === 'flying');
    session.reset();
    expect(blast.phase).toBe('ready');
    expect(blast.blasts).toBe(0);
    expect(blast.balti.tilt).toBe(0);
    for (const kid of blast.views()) {
      expect(kid.activity).toBe('chat');
      expect(groundDistance(kid.position, SPOT)).toBeCloseTo(BALTI.gatherRadius, 5);
    }
    expect(log.blasts).toHaveLength(1);
  });

  it('are the same kids doing the same thing for the same random source', () => {
    const run = () => {
      const { blast, log } = setup({ seed: 11 });
      until(blast, () => blast.phase === 'cheering');
      return { landed: { ...blast.balti.position }, tilt: blast.balti.tilt, bounces: log.bounces.map((b) => b.speed) };
    };
    expect(run()).toEqual(run());
  });
});

describe('the player joining in', () => {
  it('is offered the next step only within reach and facing the spot', () => {
    const { blast } = setup();
    expect(blast.offer(AT_SPOT, NORTH)).toBe('placed');
    expect(blast.offer(v(0, 0, BALTI.reach + 0.3), NORTH)).toBeNull();
    expect(blast.offer(AT_SPOT, v(0, 0, 1))).toBeNull();
    // On the rooftop, above the spot, nothing.
    expect(blast.offer(v(0, 4, 0.5), NORTH)).toBeNull();
    // Standing right over it, any view will do.
    expect(blast.offer(v(0, 0, 0.3), v(0, 0, 1))).toBe('placed');
  });

  it('sets it up with E three times, kids watching, then they all run and it blows', () => {
    const { blast, log, player } = setup({ player: AT_SPOT });
    expect(blast.playerStep(AT_SPOT, NORTH)).toBe('placed');
    expect(blast.bombDown).toBe(true);
    expect(blast.playerStep(AT_SPOT, NORTH)).toBe('covered');
    // The balti is still coming down over the bomb: nothing to light yet.
    expect(blast.offer(AT_SPOT, NORTH)).toBeNull();
    expect(blast.playerStep(AT_SPOT, NORTH)).toBeNull();
    step(blast, BALTI.coverTime);
    expect(blast.offer(AT_SPOT, NORTH)).toBe('lit');
    expect(blast.views().every((k) => k.activity === 'chat')).toBe(true);
    expect(blast.playerStep(AT_SPOT, NORTH)).toBe('lit');
    expect(log.steps.map((s) => [s.step, s.by])).toEqual([
      ['placed', 'player'],
      ['covered', 'player'],
      ['lit', 'player'],
    ]);
    expect(blast.setBy).toBe('player');
    expect(blast.offer(AT_SPOT, NORTH)).toBeNull();
    expect(blast.views().every((k) => k.activity === 'run')).toBe(true);
    player.at = v(0, 0, 5);
    until(blast, () => log.blasts.length > 0);
    expect(log.blasts[0]!.by).toBe('player');
  });

  it('left half done, is finished off by the nearest kid', () => {
    const { blast, log, player } = setup({ player: AT_SPOT });
    blast.playerStep(AT_SPOT, NORTH);
    player.at = null; // gone indoors
    blast.update(STEP);
    expect(blast.setBy).toBe('kid');
    expect(blast.offer(AT_SPOT, NORTH)).toBeNull();
    until(blast, () => log.blasts.length > 0);
    expect(log.steps.map((s) => [s.step, s.by])).toEqual([
      ['placed', 'player'],
      ['covered', 'kid'],
      ['lit', 'kid'],
    ]);
    expect(log.blasts[0]!.by).toBe('kid');
  });

  it('is not offered anything while the kids set up their own round', () => {
    const { blast, log, player } = setup();
    until(blast, () => log.steps.length > 0);
    player.at = AT_SPOT;
    expect(blast.offer(AT_SPOT, NORTH)).toBeNull();
    until(blast, () => blast.phase === 'ready' && log.blasts.length > 0);
    expect(blast.offer(AT_SPOT, NORTH)).toBe('placed');
  });
});

describe('controls and prompt', () => {
  function context(blast: BaltiBlast, feet: Vec3 | null, busy = false): BaltiControlContext {
    return { balti: blast, feet: () => feet, forward: () => NORTH, busy: () => busy };
  }

  it('E at the spot takes the step; other actions and busy hands fall through', () => {
    const { blast } = setup();
    expect(applyBaltiAction({ type: 'place' }, context(blast, AT_SPOT))).toBe(false);
    expect(applyBaltiAction({ type: 'interact' }, context(blast, AT_SPOT, true))).toBe(false);
    expect(applyBaltiAction({ type: 'interact' }, context(blast, null))).toBe(false);
    expect(applyBaltiAction({ type: 'interact' }, context(blast, v(0, 0, 6)))).toBe(false);
    expect(blast.phase).toBe('ready');
    expect(applyBaltiAction({ type: 'interact' }, context(blast, AT_SPOT))).toBe(true);
    expect(blast.phase).toBe('bombPlaced');
  });

  it('says what E does next, then tells the player to run while their fuse burns', () => {
    const { blast } = setup({ player: AT_SPOT });
    const ctx = context(blast, AT_SPOT);
    expect(baltiPrompt(ctx)?.[0]?.text).toBe(BALTI_PROMPTS.placed);
    // The same lines each frame, so the HUD does not redraw.
    expect(baltiPrompt(ctx)).toBe(baltiPrompt(ctx));
    expect(baltiPrompt(context(blast, AT_SPOT, true))).toBeNull();
    blast.playerStep(AT_SPOT, NORTH);
    expect(baltiPrompt(ctx)?.[0]?.text).toBe(BALTI_PROMPTS.covered);
    blast.playerStep(AT_SPOT, NORTH);
    step(blast, BALTI.coverTime);
    expect(baltiPrompt(ctx)?.[0]?.text).toBe(BALTI_PROMPTS.lit);
    blast.playerStep(AT_SPOT, NORTH);
    expect(baltiPrompt(ctx)?.[0]).toEqual({ text: BALTI_RUN_TEXT, blocked: false, hint: true });
    expect(baltiPrompt(context(blast, v(0, 0, BALTI.safeRadius)))).toBeNull();
  });

  it('replaces the cracker prompts in the HUD', () => {
    const lines = promptLines('anar', { interactable: null, activity: [{ text: BALTI_PROMPTS.placed, blocked: false }] });
    expect(lines).toEqual([{ text: BALTI_PROMPTS.placed, blocked: false }]);
    expect(promptLines('anar', { interactable: null, activity: null })[0]?.text).toBe('Click: Place anar');
  });
});

describe('the balti in flight', () => {
  const g = BALTI.gravity;
  const apex = BALTI.launchSpeed[1] ** 2 / (2 * g) + BALTI.restHeight;

  for (let seed = 1; seed <= 40; seed++) {
    it(`goes up, stays bounded and settles steady (seed ${seed})`, () => {
      const flight = new BaltiFlight();
      flight.tilt = Math.PI;
      flight.launch(SPOT, seeded(seed));
      let high = 0;
      let impacts = 0;
      let t = 0;
      while (!flight.done && t < 20) {
        const impact = flight.step(STEP);
        if (impact > 0) impacts++;
        high = Math.max(high, flight.position.y);
        expect(groundDistance(flight.position, SPOT)).toBeLessThanOrEqual(BALTI.maxDrift + 1e-9);
        expect(flight.position.y).toBeGreaterThanOrEqual(BALTI.restHeight - 1e-9);
        t += STEP;
      }
      expect(flight.done).toBe(true);
      expect(t).toBeLessThanOrEqual(BALTI.maxFlight + 1 + STEP);
      // Thrown well above the kids' heads, never above its launch's apex.
      expect(high).toBeGreaterThan(5);
      expect(high).toBeLessThanOrEqual(apex + 0.01);
      expect(impacts).toBeGreaterThanOrEqual(1);
      expect(impacts).toBeLessThanOrEqual(BALTI.maxBounces);
      expect(flight.position.y).toBeCloseTo(BALTI.restHeight);
      expect(flight.tilt).toBeGreaterThanOrEqual(0);
      expect(flight.tilt).toBeLessThan(Math.PI * 2);
      expect(flight.tilt / (Math.PI / 2)).toBeCloseTo(Math.round(flight.tilt / (Math.PI / 2)), 6);
      expect(Number.isFinite(flight.yaw)).toBe(true);
    });
  }

  it('bounces lower each time', () => {
    const flight = new BaltiFlight();
    flight.launch(SPOT, seeded(5));
    const speeds: number[] = [];
    for (let t = 0; t < 10 && !flight.done; t += STEP) {
      const impact = flight.step(STEP);
      if (impact > 0) speeds.push(impact);
    }
    expect(speeds.length).toBeGreaterThan(1);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeLessThan(speeds[i - 1]!);
  });

  it('comes to rest on its base, side or rim', () => {
    expect(restingTilt(0.2)).toBe(0);
    expect(restingTilt(1.4)).toBeCloseTo(Math.PI / 2);
    expect(restingTilt(3.3)).toBeCloseTo(Math.PI);
    expect(restingTilt(-1.7)).toBeCloseTo(-Math.PI / 2);
  });

  it('waits where it landed for the next round, then is lowered over the next bomb', () => {
    const { blast, log } = setup({ seed: 9 });
    until(blast, () => blast.phase === 'ready' && log.blasts.length === 1);
    const landed = { ...blast.balti.position };
    expect(groundDistance(landed, SPOT)).toBeLessThanOrEqual(BALTI.maxDrift);
    until(blast, () => blast.phase === 'covered');
    // Lifting off its resting place...
    blast.update(STEP);
    expect(blast.balti.position.y).toBeGreaterThan(BALTI.restHeight);
    // ...and set upturned over the bomb.
    until(blast, () => blast.phase === 'fuseBurning');
    expect(groundDistance(blast.balti.position, SPOT)).toBeLessThan(1e-9);
    expect(blast.balti.tilt).toBeCloseTo(Math.PI);
  });
});

describe('effects and sound', () => {
  function round(bus: GameEventBus) {
    const blast = new BaltiBlast({ spot: SPOT, bus, random: seeded(2), playerPosition: () => AT_SPOT });
    blast.playerStep(AT_SPOT, NORTH);
    blast.playerStep(AT_SPOT, NORTH);
    step(blast, BALTI.coverTime);
    blast.playerStep(AT_SPOT, NORTH);
    return blast;
  }

  it('sparkles at the fuse, then bursts in sparks, debris, smoke and one flash within budget', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const bus = createGameEventBus();
      const profile = qualityProfile(level);
      const effects = new FireworksEffects(bus, { quality: profile, random: seeded(4) });
      const balti = new BaltiEffects(bus, effects.engine);
      const blast = round(bus);
      for (let t = 0; t < 1; t += STEP) {
        blast.update(STEP);
        balti.update(STEP);
        effects.update(STEP);
      }
      expect(effects.stats.activeEffects).toBe(1);
      const sparkle = effects.engine.particles.count;
      expect(sparkle).toBeGreaterThan(0);

      let peakLights = 0;
      let peakMatte = 0;
      let peakSparks = 0;
      for (let t = 0; t < BALTI.fuse + 0.5; t += STEP) {
        blast.update(STEP);
        balti.update(STEP);
        effects.update(STEP);
        peakLights = Math.max(peakLights, effects.stats.dynamicLights);
        peakMatte = Math.max(peakMatte, effects.engine.matte.count);
        peakSparks = Math.max(peakSparks, effects.engine.particles.count);
        expect(effects.stats.liveParticles).toBeLessThanOrEqual(profile.maxParticles);
        expect(effects.stats.dynamicLights).toBeLessThanOrEqual(profile.maxDynamicLights);
      }
      expect(blast.blasts).toBe(1);
      expect(peakLights).toBe(1);
      expect(peakMatte).toBeGreaterThan(5);
      expect(peakSparks).toBeGreaterThan(sparkle * 2);
      // The fuse's stream lets go once the bang's sparks die.
      for (let t = 0; t < 5; t += STEP) effects.update(STEP);
      expect(effects.stats.activeEffects).toBe(0);
      balti.dispose();
    }
  });

  it('booms through the audio engine and clangs on each bounce', async () => {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({ bus, createContext: vi.fn(() => ctx.asAudioContext()), profile: qualityProfile('high'), random: () => 0.5 });
    await audio.unlock();
    const played = vi.spyOn(audio as unknown as { play: (kind: string) => unknown }, 'play');
    const blast = round(bus);
    expect(played.mock.calls.map((c) => c[0])).toEqual(['fuseHiss']);
    for (let t = 0; t < 12 && blast.phase !== 'ready'; t += STEP) blast.update(STEP);
    const kinds = played.mock.calls.map((c) => c[0]);
    expect(kinds[1]).toBe('baltiBoom');
    expect(kinds.slice(2).length).toBeGreaterThan(0);
    expect(kinds.slice(2).every((k) => k === 'baltiClang')).toBe(true);
  });

  it('synthesises both balti sounds headless', () => {
    for (const kind of ['baltiBoom', 'baltiClang'] as const) {
      const ctx = new FakeAudioContext();
      const audio = ctx.asAudioContext();
      const output = audio.createGain();
      const voice = synthesise(audio, createNoiseBank(audio, seeded(1)), kind, output, { t0: 0, duration: 1, gain: 1 });
      expect(voice.sources.length).toBeGreaterThan(3);
      for (const source of voice.sources) expect((source as unknown as { stoppedAt: number }).stoppedAt).toBeLessThanOrEqual(1.0001);
    }
  });
});
