import { describe, expect, it } from 'vitest';
import type { CameraView, Interactable, InteractionModule, PlacementResult, PlayerPose } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import { TUNING, type Tuning } from '../src/core/tuning';
import { CRACKER_TYPES, type CrackerType, type Vec3 } from '../src/core/types';
import {
  aimDistance,
  aimPoint,
  PLACE_FARTHEST,
  PLACE_NEAREST,
  applyCrackerAction,
  BURST_PATTERNS,
  CRACKER_DEFINITIONS,
  Crackers,
  rollRocketVariant,
  ROCKET_PALETTE,
} from '../src/crackers';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const { fuse, activeDuration } = TUNING.crackers;

type Logged = { [K in GameEventName]: { name: K; payload: GameEvents[K] } }[GameEventName];

function record(bus: GameEventBus): Logged[] {
  const log: Logged[] = [];
  const names: GameEventName[] = [
    'crackerSelected',
    'crackerPlaced',
    'placementRejected',
    'fuseLit',
    'ignitionRejected',
    'crackerActive',
    'crackerFinished',
    'burst',
  ];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

interface Setup {
  tuning?: Tuning;
  random?: () => number;
  hand?: { position: Vec3 };
  initialSelection?: CrackerType;
}

function setup(options: Setup = {}) {
  const bus = createGameEventBus();
  const log = record(bus);
  const hand = options.hand ?? { position: v(0, 1.1, 0) };
  const crackers = new Crackers({
    bus,
    tuning: options.tuning,
    random: options.random ?? (() => 0.5),
    handPosition: () => hand.position,
    initialSelection: options.initialSelection ?? 'anar',
  });
  const names = () => log.map((e) => e.name);
  return { bus, log, names, crackers, hand };
}

function run(crackers: Crackers, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += STEP) crackers.update(STEP);
}

function placed(crackers: Crackers, type: CrackerType = 'anar', position = v(0, 0, 0)): string {
  const result = crackers.place({ type, position });
  if (!result.ok) throw new Error(`place failed: ${result.reason}`);
  return result.id;
}

function withCaps(caps: Partial<Tuning['caps']>): Tuning {
  return { ...TUNING, caps: { ...TUNING.caps, ...caps } };
}

describe('cracker definitions', () => {
  it('defines all four types in key order with tuning timings', () => {
    CRACKER_TYPES.forEach((type, i) => {
      const def = CRACKER_DEFINITIONS[type];
      expect(def.slot).toBe(i + 1);
      expect(def.fuse).toBe(fuse[type]);
      expect(def.activeDuration).toBe(activeDuration[type]);
    });
    expect(CRACKER_DEFINITIONS.phuljhari.handheld).toBe(true);
    expect(CRACKER_DEFINITIONS.anar.handheld).toBe(false);
    expect(new Set(CRACKER_TYPES.map((t) => CRACKER_DEFINITIONS[t].effect.kind)).size).toBe(4);
  });
});

describe('selection', () => {
  it('selects each type and emits crackerSelected', () => {
    const { crackers, log } = setup();
    for (const type of CRACKER_TYPES) {
      crackers.select(type);
      expect(crackers.selected).toBe(type);
    }
    expect(log.filter((e) => e.name === 'crackerSelected').map((e) => e.payload)).toEqual(
      CRACKER_TYPES.map((type) => ({ type })),
    );
  });

  it('maps keys 1–4 to the four types through the action adapter', () => {
    const { crackers, bus } = setup();
    const ctx = controlContext(crackers, bus);
    for (const slot of [1, 2, 3, 4] as const) {
      expect(applyCrackerAction({ type: 'select', slot }, ctx)).toBe(true);
      expect(crackers.selected).toBe(CRACKER_TYPES[slot - 1]);
    }
  });

  it('has unlimited supply', () => {
    const { crackers } = setup({ tuning: withCaps({ maxPlacedCrackers: 1000, maxLitCrackers: 1000 }) });
    for (let i = 0; i < 200; i++) {
      const id = placed(crackers, 'chakri', v(i, 0, 0));
      expect(crackers.ignite(id).ok).toBe(true);
      run(crackers, fuse.chakri + activeDuration.chakri + STEP);
    }
    expect(crackers.list()).toHaveLength(0);
  });
});

describe('ground cracker lifecycle', () => {
  it('runs placed → fuseBurning → active → finished with events in order', () => {
    const { crackers, names, log } = setup();
    const id = placed(crackers, 'anar', v(1, 0, 2));
    expect(crackers.get(id)?.state).toBe('placed');

    run(crackers, 5);
    expect(crackers.get(id)?.state).toBe('placed'); // waits for E

    expect(crackers.ignite(id)).toEqual({ ok: true });
    expect(crackers.get(id)?.state).toBe('fuseBurning');

    run(crackers, fuse.anar - 0.1);
    expect(crackers.get(id)?.state).toBe('fuseBurning');
    run(crackers, 0.2);
    expect(crackers.get(id)?.state).toBe('active');

    run(crackers, activeDuration.anar);
    expect(crackers.get(id)).toBeUndefined();
    expect(crackers.list()).toHaveLength(0);

    expect(names()).toEqual(['crackerPlaced', 'fuseLit', 'crackerActive', 'crackerFinished']);
    expect(log[0]!.payload).toEqual({ id, type: 'anar', position: v(1, 0, 2) });
    expect(log[3]!.payload).toEqual({ id, type: 'anar', reason: 'completed' });
  });

  it('carries leftover time through transitions in one large step', () => {
    const { crackers, names } = setup();
    const id = placed(crackers);
    crackers.ignite(id);
    crackers.update(fuse.anar + 1);
    expect(crackers.get(id)?.state).toBe('active');
    expect(crackers.get(id)?.stateTime).toBeCloseTo(1);
    crackers.update(100);
    expect(names().slice(-2)).toEqual(['crackerActive', 'crackerFinished']);
  });

  it('copies the preview position', () => {
    const { crackers } = setup();
    const position = { x: 3, y: 0.5, z: -2 };
    const id = placed(crackers, 'chakri', position);
    position.x = 99;
    expect(crackers.get(id)?.position).toEqual(v(3, 0.5, -2));
  });

  it('refuses to place the phuljhari', () => {
    const { crackers, log } = setup();
    expect(crackers.place({ type: 'phuljhari', position: v(0, 0, 0) })).toEqual({ ok: false, reason: 'handheldOnly' });
    expect(log.at(-1)).toEqual({ name: 'placementRejected', payload: { type: 'phuljhari', reason: 'handheldOnly' } });
  });
});

describe('one-time ignition', () => {
  it('ignores re-lighting while the fuse burns, while active, and after finishing', () => {
    const { crackers, log } = setup();
    const id = placed(crackers);
    crackers.ignite(id);
    expect(crackers.ignite(id)).toEqual({ ok: false, reason: 'alreadyLit' });
    run(crackers, 0.5);
    const fuseTime = crackers.get(id)!.stateTime;
    crackers.ignite(id);
    expect(crackers.get(id)?.state).toBe('fuseBurning');
    expect(crackers.get(id)?.stateTime).toBe(fuseTime); // fuse not restarted

    run(crackers, fuse.anar);
    expect(crackers.ignite(id)).toEqual({ ok: false, reason: 'alreadyLit' });
    run(crackers, activeDuration.anar);
    expect(crackers.ignite(id)).toEqual({ ok: false, reason: 'notFound' });

    expect(log.filter((e) => e.name === 'fuseLit')).toHaveLength(1);
    expect(log.filter((e) => e.name === 'crackerActive')).toHaveLength(1);
    expect(log.filter((e) => e.name === 'ignitionRejected').map((e) => e.payload)).toEqual([
      { id, reason: 'alreadyLit' },
      { id, reason: 'alreadyLit' },
      { id, reason: 'alreadyLit' },
      { id, reason: 'notFound' },
    ]);
  });

  it('rejects unknown ids', () => {
    const { crackers } = setup();
    expect(crackers.ignite('nope')).toEqual({ ok: false, reason: 'notFound' });
  });
});

describe('simultaneous crackers', () => {
  it('runs several crackers of different types at once', () => {
    const { crackers, log } = setup();
    const ids = (['anar', 'chakri', 'rocket'] as const).map((type, i) => placed(crackers, type, v(i * 2, 0, 0)));
    for (const id of ids) expect(crackers.ignite(id).ok).toBe(true);
    crackers.select('phuljhari');
    expect(crackers.igniteHeld().ok).toBe(true);
    expect(crackers.litCount).toBe(4);

    run(crackers, Math.max(fuse.anar, fuse.chakri, fuse.rocket) + 0.05);
    expect(ids.map((id) => crackers.get(id)?.state)).toEqual(['active', 'active', 'active']);
    expect(crackers.get(crackers.held!.id)?.state).toBe('active');

    run(crackers, 60);
    expect(crackers.list()).toHaveLength(0);
    expect(crackers.litCount).toBe(0);
    const finished = log.filter((e) => e.name === 'crackerFinished').map((e) => e.payload.id);
    expect(finished).toHaveLength(4);
    expect(finished).toEqual(expect.arrayContaining(ids));
  });

  it('keeps placing while others are lit, and ignites them independently', () => {
    const { crackers } = setup();
    const a = placed(crackers, 'anar', v(0, 0, 0));
    crackers.ignite(a);
    run(crackers, 1);
    const b = placed(crackers, 'chakri', v(2, 0, 0));
    expect(crackers.get(b)?.state).toBe('placed');
    crackers.ignite(b);
    run(crackers, fuse.anar);
    expect(crackers.get(a)?.state).toBe('active');
    expect(crackers.get(b)?.state).toBe('active');
  });

  it('enforces the placed and lit caps with capacity rejections', () => {
    const { crackers, log } = setup({ tuning: withCaps({ maxPlacedCrackers: 3, maxLitCrackers: 2 }) });
    const ids = [0, 1, 2].map((i) => placed(crackers, 'anar', v(i, 0, 0)));
    expect(crackers.place({ type: 'anar', position: v(9, 0, 0) })).toEqual({ ok: false, reason: 'capacity' });
    expect(log.at(-1)).toEqual({ name: 'placementRejected', payload: { type: 'anar', reason: 'capacity' } });

    expect(crackers.ignite(ids[0]!).ok).toBe(true);
    expect(crackers.ignite(ids[1]!).ok).toBe(true);
    expect(crackers.ignite(ids[2]!)).toEqual({ ok: false, reason: 'capacity' });
    expect(crackers.get(ids[2]!)?.state).toBe('placed');

    run(crackers, fuse.anar + activeDuration.anar + 0.1);
    expect(crackers.ignite(ids[2]!).ok).toBe(true); // a slot freed up
  });

  it('reclaims only unlit crackers', () => {
    const { crackers, log } = setup();
    const unlit = placed(crackers, 'anar', v(0, 0, 0));
    const lit = placed(crackers, 'anar', v(2, 0, 0));
    crackers.ignite(lit);
    expect(crackers.reclaim(lit)).toBe(false);
    expect(crackers.reclaim(unlit)).toBe(true);
    expect(crackers.get(unlit)).toBeUndefined();
    expect(log.at(-1)).toEqual({ name: 'crackerFinished', payload: { id: unlit, type: 'anar', reason: 'reclaimed' } });
  });
});

describe('rockets', () => {
  it('bursts where its flight ends at the end of its ascent, then finishes', () => {
    const { crackers, log, names } = setup();
    const id = placed(crackers, 'rocket', v(4, 0, -3));
    crackers.ignite(id);
    const variant = crackers.rocketVariant(id)!;
    run(crackers, fuse.rocket + variant.ascent - 0.05);
    expect(crackers.get(id)?.state).toBe('active');
    run(crackers, 0.1);
    expect(names().slice(-2)).toEqual(['burst', 'crackerFinished']);
    const burst = log.find((e) => e.name === 'burst')!.payload as GameEvents['burst'];
    expect(burst).toEqual({
      id,
      position: v(4 + variant.drift.x, variant.apexHeight, -3 + variant.drift.z),
      pattern: variant.pattern,
      colours: variant.colours,
    });
  });

  it('announces its flight when it launches so trail and sound can follow it', () => {
    const { crackers, log } = setup();
    const id = placed(crackers, 'rocket', v(0, 0, 0));
    crackers.ignite(id);
    run(crackers, fuse.rocket + 0.01);
    const variant = crackers.rocketVariant(id)!;
    const active = log.find((e) => e.name === 'crackerActive')!.payload as GameEvents['crackerActive'];
    expect(active.flight).toEqual({ ascent: variant.ascent, apexHeight: variant.apexHeight, drift: variant.drift });
  });

  it('leans each rocket a little off vertical, in varied directions', () => {
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const headings = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const r = rollRocketVariant(CRACKER_DEFINITIONS.rocket, random);
      const lean = (Math.atan2(Math.hypot(r.drift.x, r.drift.z), r.apexHeight) * 180) / Math.PI;
      expect(lean).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(lean).toBeLessThanOrEqual(12 + 1e-9);
      headings.add(Math.floor(((Math.atan2(r.drift.z, r.drift.x) + Math.PI) / (Math.PI * 2)) * 4));
    }
    expect(headings.size).toBe(4);
  });

  it('randomises burst shape, colours and timing per rocket', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const variants = Array.from({ length: 60 }, () => rollRocketVariant(CRACKER_DEFINITIONS.rocket, random));
    expect(new Set(variants.map((r) => r.pattern)).size).toBeGreaterThan(2);
    expect(new Set(variants.map((r) => r.colours.join())).size).toBeGreaterThan(10);
    expect(new Set(variants.map((r) => r.ascent.toFixed(3))).size).toBeGreaterThan(10);
    for (const r of variants) {
      expect(BURST_PATTERNS).toContain(r.pattern);
      expect(r.colours.length).toBeGreaterThanOrEqual(1);
      expect(r.colours.length).toBeLessThanOrEqual(3);
      expect(new Set(r.colours).size).toBe(r.colours.length);
      for (const c of r.colours) expect(ROCKET_PALETTE).toContain(c);
      // Climb speed stays at the nominal rate the trail and sound assume.
      expect(r.apexHeight / r.ascent).toBeCloseTo(TUNING.crackers.rocketApexHeight / activeDuration.rocket);
    }
  });

  it('stays in range at the extremes of the random source', () => {
    for (const value of [0, 0.999999]) {
      const r = rollRocketVariant(CRACKER_DEFINITIONS.rocket, () => value);
      expect(BURST_PATTERNS).toContain(r.pattern);
      expect(r.colours.every((c) => c !== undefined)).toBe(true);
    }
  });
});

describe('held phuljhari', () => {
  it('is held while selected and dropped when another type is selected', () => {
    const { crackers } = setup();
    expect(crackers.held).toBeNull();
    crackers.select('phuljhari');
    expect(crackers.held).toMatchObject({ type: 'phuljhari', lit: false });
    expect(crackers.list()).toHaveLength(0); // not a ground cracker
    crackers.select('rocket');
    expect(crackers.held).toBeNull();
  });

  it('starts in hand when the session begins on key 1', () => {
    const { crackers } = setup({ initialSelection: 'phuljhari' });
    expect(crackers.selected).toBe('phuljhari');
    expect(crackers.held?.lit).toBe(false);
  });

  it('is lit directly, follows the hand, burns out and leaves the hand', () => {
    const hand = { position: v(0, 1.1, 0) };
    const { crackers, log, names } = setup({ hand });
    crackers.select('phuljhari');
    const id = crackers.held!.id;
    expect(crackers.igniteHeld()).toEqual({ ok: true });
    expect(crackers.held).toEqual({ id, type: 'phuljhari', lit: true });
    expect(log.at(-1)).toEqual({ name: 'fuseLit', payload: { id, type: 'phuljhari', position: v(0, 1.1, 0) } });

    hand.position = v(5, 1.1, 5);
    run(crackers, fuse.phuljhari + 0.05);
    expect(crackers.get(id)?.state).toBe('active');
    expect(crackers.get(id)?.position).toEqual(v(5, 1.1, 5));
    const active = log.find((e) => e.name === 'crackerActive')!.payload as GameEvents['crackerActive'];
    expect(active.position).toEqual(v(5, 1.1, 5));

    run(crackers, activeDuration.phuljhari);
    expect(crackers.held).toBeNull();
    expect(crackers.get(id)).toBeUndefined();
    expect(crackers.selected).toBe('phuljhari');
    expect(names().slice(-1)).toEqual(['crackerFinished']);
    expect(crackers.igniteHeld()).toEqual({ ok: false, reason: 'notFound' });

    crackers.select('phuljhari'); // take a fresh one
    expect(crackers.held?.id).not.toBe(id);
    expect(crackers.held?.lit).toBe(false);
  });

  it('lights only once', () => {
    const { crackers } = setup();
    crackers.select('phuljhari');
    crackers.igniteHeld();
    expect(crackers.igniteHeld()).toEqual({ ok: false, reason: 'alreadyLit' });
    expect(crackers.ignite(crackers.held!.id)).toEqual({ ok: false, reason: 'alreadyLit' });
  });

  it('keeps a lit phuljhari when phuljhari is reselected', () => {
    const { crackers } = setup();
    crackers.select('phuljhari');
    const id = crackers.held!.id;
    crackers.igniteHeld();
    crackers.select('phuljhari');
    expect(crackers.held).toEqual({ id, type: 'phuljhari', lit: true });
  });

  it('finishes a lit phuljhari early when switching away', () => {
    const { crackers, log } = setup();
    crackers.select('phuljhari');
    const id = crackers.held!.id;
    crackers.igniteHeld();
    run(crackers, 1);
    crackers.select('anar');
    expect(crackers.held).toBeNull();
    expect(log.find((e) => e.name === 'crackerFinished')?.payload).toEqual({ id, type: 'phuljhari', reason: 'completed' });
    expect(crackers.litCount).toBe(0);
  });
});

describe('session reset', () => {
  it('drops every cracker silently and restores the initial selection', () => {
    const { crackers, bus, log } = setup();
    crackers.ignite(placed(crackers));
    placed(crackers, 'chakri', v(3, 0, 0));
    crackers.select('phuljhari');
    crackers.igniteHeld();
    const before = log.length;
    bus.emit('sessionReset', {});
    expect(crackers.list()).toHaveLength(0);
    expect(crackers.held).toBeNull();
    expect(crackers.selected).toBe('anar');
    expect(crackers.litCount).toBe(0);
    run(crackers, 60);
    expect(log.length).toBe(before);
  });
});

// ── action adapter ─────────────────────────────────────────────────────────

function controlContext(
  crackers: Crackers,
  bus: GameEventBus,
  options: { validate?: PlacementResult; interactable?: Interactable | null } = {},
) {
  const pose: PlayerPose = { position: v(0, 0, 0), yaw: 0, grounded: true };
  const view: CameraView = { mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, 0, -1), yaw: 0, pitch: 0 };
  const requests: Vec3[] = [];
  const interaction: InteractionModule = {
    findInteractable: () => options.interactable ?? null,
    validatePlacement: (request) => {
      requests.push(request.target);
      return options.validate ?? { ok: true, preview: { type: request.type, position: request.target } };
    },
  };
  return { crackers, bus, interaction, pose: () => pose, view: () => view, requests };
}

describe('cracker actions', () => {
  it('click places the selected ground cracker ahead of the player', () => {
    const { crackers, bus } = setup();
    const ctx = controlContext(crackers, bus);
    crackers.select('chakri');
    applyCrackerAction({ type: 'place' }, ctx);
    expect(ctx.requests).toEqual([aimPoint(v(0, 0, 0), v(0, 0, -1))]);
    expect(crackers.list()).toMatchObject([{ type: 'chakri', state: 'placed', position: v(0, 0, -PLACE_FARTHEST) }]);
  });

  it('reports validation failures as placement rejections', () => {
    const { crackers, bus, log } = setup();
    const ctx = controlContext(crackers, bus, { validate: { ok: false, reason: 'nearDoorway' } });
    applyCrackerAction({ type: 'place' }, ctx);
    expect(crackers.list()).toHaveLength(0);
    expect(log.at(-1)).toEqual({ name: 'placementRejected', payload: { type: 'anar', reason: 'nearDoorway' } });
  });

  it('E lights the cracker in front, separately from placing it', () => {
    const { crackers, bus } = setup();
    const id = placed(crackers);
    const ctx = controlContext(crackers, bus, { interactable: { kind: 'cracker', id, position: v(0, 0, 0) } });
    expect(crackers.get(id)?.state).toBe('placed');
    applyCrackerAction({ type: 'interact' }, ctx);
    expect(crackers.get(id)?.state).toBe('fuseBurning');
  });

  it('click or E lights the held phuljhari', () => {
    for (const type of ['place', 'interact'] as const) {
      const { crackers, bus } = setup();
      crackers.select('phuljhari');
      applyCrackerAction({ type }, controlContext(crackers, bus));
      expect(crackers.held?.lit).toBe(true);
    }
  });

  it('passes other actions through', () => {
    const { crackers, bus } = setup();
    expect(applyCrackerAction({ type: 'move', forward: 1, right: 0 }, controlContext(crackers, bus))).toBe(false);
  });
});

describe('aiming', () => {
  const eye = 1.6;

  it('aims where the view meets the ground', () => {
    // 45 degrees down from 1.6 m reaches the ground 1.6 m ahead.
    expect(aimDistance(v(0, -Math.SQRT1_2, -Math.SQRT1_2), eye)).toBeCloseTo(1.6);
  });

  it('aims at the far limit when looking level or up', () => {
    expect(aimDistance(v(0, 0, -1), eye)).toBe(PLACE_FARTHEST);
    expect(aimDistance(v(0, 0.5, -0.8), eye)).toBe(PLACE_FARTHEST);
    expect(aimDistance(v(0, -0.2, -0.98), eye)).toBe(PLACE_FARTHEST);
  });

  it('keeps the farthest aim inside the interact range so new crackers can be lit at once', () => {
    expect(PLACE_FARTHEST).toBeLessThan(TUNING.interaction.interactRange);
  });

  it('never aims closer than the near limit when looking straight down', () => {
    expect(aimDistance(v(0, -1, 0), eye)).toBe(PLACE_NEAREST);
  });

  it('turning the view moves the aim point, so new spots are reachable without walking', () => {
    const down = -Math.SQRT1_2;
    const left = aimPoint(v(0, 0, 0), v(-Math.SQRT1_2, down, 0));
    const ahead = aimPoint(v(0, 0, 0), v(0, down, -Math.SQRT1_2));
    expect(left.x).toBeLessThan(-1);
    expect(ahead.z).toBeLessThan(-1);
  });
});
