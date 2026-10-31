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
  BaltiScene,
  baltiSupport,
  contactAt,
  kidPose,
  restingTilt,
  SIDE_LEAN,
  type BaltiControlContext,
  type KidActivity,
  type KidView,
} from '../src/balti';
import * as THREE from 'three';
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
  settles: GameEvents['baltiSettle'][];
}

function setup(options: { player?: Vec3 | null; seed?: number; bus?: GameEventBus } = {}) {
  const bus = options.bus ?? createGameEventBus();
  const log: Log = { steps: [], blasts: [], bounces: [], settles: [] };
  bus.on('baltiStep', (e) => log.steps.push(e));
  bus.on('baltiBlast', (e) => log.blasts.push(e));
  bus.on('baltiBounce', (e) => log.bounces.push(e));
  bus.on('baltiSettle', (e) => log.settles.push(e));
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

  it('play a whole round on their own: bomb, balti, fuse, run, blast, flinch, watch, cheer, fetch, huddle', () => {
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
    const fuse = log.steps[2]!.fuse!;
    expect(fuse).toBe(blast.fuseSeconds);
    expect(fuse).toBeGreaterThanOrEqual(BALTI.fuse[0]);
    expect(fuse).toBeLessThanOrEqual(BALTI.fuse[1]);
    expect(blast.balti.tilt).toBeCloseTo(Math.PI);
    expect(groundDistance(blast.balti.position, SPOT)).toBeLessThan(1e-9);
    expect(blast.views().every((k) => k.activity === 'run')).toBe(true);

    // Everyone gets to a safe spot before the bang and braces for it, more tensely as it runs down.
    step(blast, 1.5);
    const early = blast.views()[0]!.tension;
    step(blast, fuse - 1.6);
    for (const kid of blast.views()) {
      expect(kid.activity).toBe('brace');
      expect(groundDistance(kid.position, SPOT)).toBeCloseTo(BALTI.safeRadius, 5);
      expect(kid.tension).toBeGreaterThan(early);
      expect(kid.tension).toBeLessThanOrEqual(1);
    }

    until(blast, () => log.blasts.length > 0);
    expect(log.blasts[0]!.position).toEqual(SPOT);
    expect(log.blasts[0]!.by).toBe('kid');
    expect(log.blasts[0]!.launch!.speed).toBeGreaterThanOrEqual(BALTI.launchSpeed[0]);
    expect(blast.phase).toBe('flying');
    expect(blast.bombDown).toBe(false);
    // They flinch at the bang, then look up for it.
    expect(blast.views().every((k) => k.activity === 'flinch' && k.tension === 0)).toBe(true);
    step(blast, BALTI.flinchTime + 0.1);
    expect(blast.views().every((k) => k.activity === 'watch')).toBe(true);
    expect(Math.max(...blast.views().map((k) => k.lookUp))).toBeGreaterThan(0.3);

    until(blast, () => blast.phase === 'cheering');
    expect(log.bounces.length).toBeGreaterThan(0);
    expect(log.settles).toHaveLength(1);
    expect(blast.views().every((k) => k.activity === 'cheer')).toBe(true);
    until(blast, () => blast.phase === 'fetching');
    const fetcher = blast.fetchingKid!;
    expect(fetcher).not.toBeNull();
    until(blast, () => fetcher.activity === 'carry');
    until(blast, () => blast.phase === 'ready');
    expect(blast.fetchingKid).toBeNull();
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
        // Never into the ground: its lowest way to lie is on its side.
        expect(flight.position.y).toBeGreaterThanOrEqual(baltiSupport(restingTilt(Math.PI / 2)) - 1e-9);
        t += STEP;
      }
      expect(flight.done).toBe(true);
      expect(t).toBeLessThanOrEqual(BALTI.maxFlight + BALTI.maxSettle + STEP);
      // Thrown well above the kids' heads, never above its launch's apex.
      expect(high).toBeGreaterThan(5);
      expect(high).toBeLessThanOrEqual(apex + 0.01);
      expect(impacts).toBeGreaterThanOrEqual(1);
      expect(impacts).toBeLessThanOrEqual(BALTI.maxBounces);
      expect(flight.position.y).toBeCloseTo(baltiSupport(flight.tilt), 6);
      expect(flight.tilt).toBeGreaterThanOrEqual(0);
      expect(flight.tilt).toBeLessThan(Math.PI * 2);
      // On its base, its rim or leaning on its side.
      expect(restingTilt(flight.tilt)).toBeCloseTo(flight.tilt, 6);
      expect(flight.contact).toBe(contactAt(flight.tilt));
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

  it('comes to rest on its base, side or rim, leaning on its side with its mouth end up', () => {
    expect(restingTilt(0.2)).toBe(0);
    expect(restingTilt(1.4)).toBeCloseTo(Math.PI / 2 - SIDE_LEAN);
    expect(restingTilt(3.3)).toBeCloseTo(Math.PI);
    expect(restingTilt(-1.7)).toBeCloseTo(-Math.PI / 2 + SIDE_LEAN);
    expect(restingTilt(4.6)).toBeCloseTo((3 * Math.PI) / 2 + SIDE_LEAN);
    expect(contactAt(0)).toBe('base');
    expect(contactAt(Math.PI)).toBe('rim');
    expect(contactAt(restingTilt(1.4))).toBe('side');
  });

  it('touches the ground with its lowest point, however it is tipped', () => {
    expect(baltiSupport(0)).toBeCloseTo(BALTI.restHeight);
    expect(baltiSupport(Math.PI)).toBeCloseTo(BALTI.restHeight);
    // Lying on its side, the rim and the base's edge both touch.
    const side = Math.PI / 2 - SIDE_LEAN;
    const h = BALTI.restHeight;
    expect(-h * Math.cos(side) + BALTI.rimRadius * Math.sin(side)).toBeCloseTo(h * Math.cos(side) + BALTI.baseRadius * Math.sin(side), 9);
    // Up on a corner it stands taller than either way flat.
    expect(baltiSupport(Math.PI * 0.75)).toBeGreaterThan(BALTI.restHeight + 0.05);
  });

  it('springs back off its rim more than its flat base', () => {
    const bounceOff = (tilt: number) => {
      const flight = new BaltiFlight();
      flight.launch(SPOT, () => 0.5);
      // Falling straight down at 8 m/s, not turning.
      flight.tilt = tilt;
      flight.tumble = 0;
      flight.twirl = 0;
      flight.position.y = baltiSupport(tilt) + 0.01;
      flight.velocity.y = -8;
      flight.step(STEP);
      return { up: flight.velocity.y, contact: flight.contact };
    };
    const rim = bounceOff(Math.PI);
    const base = bounceOff(0);
    expect(rim.contact).toBe('rim');
    expect(base.contact).toBe('base');
    expect(rim.up).toBeGreaterThan(base.up);
  });

  it('rocks still on its rim or base, and rolls round in an arc on its side', () => {
    const contacts = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const flight = new BaltiFlight();
      flight.tilt = Math.PI;
      flight.launch(SPOT, seeded(seed));
      let settledTilts = 0;
      let lastTilt = 0;
      let swings = 0;
      let wasAbove = false;
      for (let t = 0; t < 20 && !flight.done; t += STEP) {
        flight.step(STEP);
        if (!flight.settling || flight.done) continue;
        settledTilts++;
        if (flight.contact !== 'side') {
          const above = flight.tilt > flight.restTilt;
          if (settledTilts > 1 && above !== wasAbove) swings++;
          wasAbove = above;
        }
        lastTilt = flight.tilt;
      }
      contacts.add(flight.contact);
      expect(Number.isFinite(lastTilt)).toBe(true);
      expect(flight.settleTime).toBeGreaterThan(0);
      expect(flight.settleTime).toBeLessThanOrEqual(BALTI.maxSettle);
      // Settling on its rim or base, it sways back and forth a few times first.
      if (flight.contact !== 'side') expect(swings).toBeGreaterThanOrEqual(2);
    }
    expect(contacts.size).toBeGreaterThanOrEqual(2);
  });

  it('flies differently each round: some barely turning over, most tumbling', () => {
    const spins: number[] = [];
    const highs: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const flight = new BaltiFlight();
      flight.tilt = Math.PI;
      flight.launch(SPOT, seeded(seed));
      spins.push(Math.abs(flight.tumble));
      highs.push(flight.velocity.y ** 2 / (2 * BALTI.gravity));
    }
    expect(spins.some((s) => s <= BALTI.wobbleTumble[1])).toBe(true);
    expect(spins.some((s) => s >= BALTI.tumble[0] + 3)).toBe(true);
    expect(Math.max(...highs) - Math.min(...highs)).toBeGreaterThan(3);
  });

  it('is fetched back beside the spot, mouth up, then lowered over the next bomb', () => {
    const { blast, log } = setup({ seed: 9 });
    until(blast, () => blast.phase === 'fetching');
    const landed = { ...blast.balti.position };
    expect(groundDistance(landed, SPOT)).toBeLessThanOrEqual(BALTI.maxDrift);
    // It stays where it landed until the kid has it in hand...
    const fetcher = blast.fetchingKid!;
    until(blast, () => fetcher.activity === 'carry');
    expect(groundDistance(blast.balti.position, landed)).toBeLessThan(0.05);
    // ...lifted to carrying height and walked back, never dropping on the way.
    let lowest = Infinity;
    step(blast, BALTI.liftTime + 0.05);
    while (blast.phase === 'fetching') {
      lowest = Math.min(lowest, blast.balti.position.y);
      blast.update(STEP);
    }
    expect(lowest).toBeGreaterThan(BALTI.carryHeight - 0.01);
    expect(blast.phase).toBe('ready');
    expect(blast.balti.tilt).toBe(0);
    expect(blast.balti.position.y).toBeCloseTo(BALTI.restHeight);
    const place = v(SPOT.x + BALTI.restOffset.x, 0, SPOT.z + BALTI.restOffset.z);
    expect(groundDistance(blast.balti.position, place)).toBeLessThan(0.15);
    expect(log.blasts).toHaveLength(1);
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
      for (let t = 0; t < BALTI.fuse[1] + 0.5; t += STEP) {
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
    audio.setListener({ mode: 'firstPerson', position: v(0, 1.6, 6.86), forward: v(0, 0, -1), yaw: 0, pitch: 0 });
    const played = vi.spyOn(audio as unknown as { play: (kind: string, options: { delay?: number; contact?: string }) => unknown }, 'play');
    const blast = round(bus);
    expect(played.mock.calls.map((c) => c[0])).toEqual(['baltiFuse']);
    for (let t = 0; t < 14 && blast.phase !== 'ready'; t += STEP) blast.update(STEP);
    const kinds = played.mock.calls.map((c) => c[0]);
    expect(kinds.slice(1, 3)).toEqual(['baltiBoom', 'baltiWhoosh']);
    // A clang per bounce, each for how it landed, then one rattle or roll as it settles.
    const clangs = played.mock.calls.filter((c) => c[0] === 'baltiClang');
    expect(clangs.length).toBeGreaterThan(0);
    for (const [, options] of clangs) expect(['rim', 'base', 'side']).toContain(options.contact);
    expect(kinds.slice(3, -1).every((k) => k === 'baltiClang')).toBe(true);
    expect(kinds[kinds.length - 1]).toBe('baltiRattle');
    // Heard 7 m off, everything arrives about 20 ms after it is seen.
    for (const [, options] of played.mock.calls) expect(options.delay).toBeGreaterThan(0.015);
  });

  it('synthesises every balti sound headless, inside its voice', () => {
    const cases = [
      ['baltiFuse', {}],
      ['baltiBoom', { spin: 7 }],
      ['baltiWhoosh', { spin: 7 }],
      ['baltiClang', { contact: 'rim', strength: 1 }],
      ['baltiClang', { contact: 'base', strength: 0.3 }],
      ['baltiClang', { contact: 'side', strength: 0.6 }],
      ['baltiRattle', { contact: 'rim' }],
      ['baltiRattle', { contact: 'side', speed: 1 }],
    ] as const;
    for (const [kind, extra] of cases) {
      const ctx = new FakeAudioContext();
      const audio = ctx.asAudioContext();
      const output = audio.createGain();
      const voice = synthesise(audio, createNoiseBank(audio, seeded(1)), kind, output, { t0: 0, duration: 1, gain: 1, ...extra });
      expect(voice.sources.length).toBeGreaterThanOrEqual(3);
      for (const source of voice.sources) expect((source as unknown as { stoppedAt: number }).stoppedAt).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('the scene', () => {
  it('poses a kid for every activity, all finite', () => {
    const activities: KidActivity[] = ['chat', 'walk', 'crouch', 'run', 'brace', 'flinch', 'watch', 'cheer', 'carry'];
    const proxy = { id: 'k', position: v(0, 0, 0), yaw: 0, lookUp: 0, activity: 'chat' as const, activityTime: 0, outfit: 0 };
    for (const activity of activities) {
      for (const tension of [0, 0.5, 1]) {
        const view: KidView = { id: 'k', position: v(0, 0, 0), yaw: 0, lookUp: 0.8, activity, activityTime: 0.2, look: 0, tension };
        const pose = kidPose(view, 1.3, { ...proxy });
        for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true);
      }
    }
    // Bracing hunches lower as the fuse runs down.
    const brace = (tension: number) =>
      kidPose({ id: 'k', position: v(0, 0, 0), yaw: 0, lookUp: 0, activity: 'brace', activityTime: 0, look: 0, tension }, 0, { ...proxy }).bob!;
    expect(brace(1)).toBeLessThan(brace(0) - 0.05);
  });

  it('blackens and dents the balti a little more with each blast, clean again after a reset', () => {
    const bus = createGameEventBus();
    const session = new Session({ bus });
    const scene = new THREE.Scene();
    const blast = new BaltiBlast({ spot: SPOT, bus, random: seeded(3) });
    const view = new BaltiScene({ scene, blast });
    const pail = scene.getObjectByName('balti')!.children[0] as THREE.Mesh;
    const colours = pail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const positions = pail.geometry.getAttribute('position') as THREE.BufferAttribute;
    // The middle of the base: the lathe's first ring of vertices.
    const darkness = () => 1 - colours.getX(0);
    const bulge = () => -BALTI.restHeight - positions.getY(0);
    view.frame(STEP);
    expect(darkness()).toBeCloseTo(0, 6);
    expect(bulge()).toBeCloseTo(0, 6);
    const seen: number[] = [];
    for (let round = 1; round <= 2; round++) {
      until(blast, () => blast.blasts === round, 60);
      view.frame(STEP);
      seen.push(darkness());
      expect(bulge()).toBeGreaterThan(0);
      expect(bulge()).toBeLessThan(0.03);
    }
    expect(seen[0]).toBeGreaterThan(0.1);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
    session.reset();
    view.frame(STEP);
    expect(darkness()).toBeCloseTo(0, 6);
    expect(bulge()).toBeCloseTo(0, 6);
    view.dispose();
  });
});
