import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameAction } from '../src/core/actions';
import type { CameraView, PlayerPose } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import type { HandItem, HomeId, LocationId, Placement, TransitionRejection } from '../src/core/homes';
import { qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import type { CameraMode, Vec3 } from '../src/core/types';
import { CameraRig, rapierBoomCaster } from '../src/camera';
import { CapacityBudget } from '../src/capacity';
import { Crackers } from '../src/crackers';
import {
  allowedDuringFade,
  doorwayId,
  fadeOpacity,
  HeldItems,
  HOME_ENTRANCES,
  homeDoorways,
  homesResetHooks,
  Locations,
  pendingModules,
  registerHomesReset,
  TRANSITION_REJECTION_TEXT,
} from '../src/homes';
import { PLAYER_RADIUS, PlayerController } from '../src/player';
import { Session } from '../src/session/session';
import { createWorld } from '../src/world';
import { addWorldColliders } from '../src/world/colliders';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const { fadeDuration } = TUNING.homes;
const { fuse, activeDuration } = TUNING.crackers;
const HOMES: readonly HomeId[] = ['familyHome', 'neighbourHome'];

const ENTER_FAMILY = doorwayId('familyHome', 'enter');
const EXIT_FAMILY = doorwayId('familyHome', 'exit');
const ENTER_NEIGHBOUR = doorwayId('neighbourHome', 'enter');
const EXIT_NEIGHBOUR = doorwayId('neighbourHome', 'exit');

type Logged = { [K in GameEventName]: { name: K; payload: GameEvents[K] } }[GameEventName];

function record(bus: GameEventBus, names: readonly GameEventName[]): Logged[] {
  const log: Logged[] = [];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

const LOCATION_EVENTS: readonly GameEventName[] = ['transitionStarted', 'locationChanged', 'transitionRejected'];

function setup() {
  const bus = createGameEventBus();
  const log = record(bus, [...LOCATION_EVENTS, 'crackerFinished', 'fuseLit', 'crackerActive', 'crackerPlaced']);
  const crackers = new Crackers({ bus, random: () => 0.5, handPosition: () => v(0, 1.1, 0), initialSelection: 'anar' });
  const hands = new HeldItems({ bus, crackers });
  const arrivals: { arrival: Placement; location: LocationId; eventsBefore: number }[] = [];
  const locations = new Locations({
    bus,
    hands,
    onArrive: (arrival, location) =>
      arrivals.push({ arrival, location, eventsBefore: log.filter((e) => e.name === 'locationChanged').length }),
  });
  const names = () => log.filter((e) => LOCATION_EVENTS.includes(e.name)).map((e) => e.name);
  const count = (name: GameEventName) => log.filter((e) => e.name === name).length;
  const clear = () => (log.length = 0);
  const step = (seconds: number) => {
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) locations.update(STEP);
  };
  /** Use a door and wait out the whole fade. */
  const go = (doorway: string) => {
    expect(locations.requestTransition(doorway)).toEqual({ ok: true });
    step(fadeDuration + STEP);
    expect(locations.transition).toBeNull();
  };
  const serveTray = () => bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
  return { bus, log, names, count, clear, crackers, hands, locations, arrivals, step, go, serveTray };
}

describe('locations: active location and doorways', () => {
  it('starts outdoors with control and no fade', () => {
    const { locations } = setup();
    expect(locations.location).toBe('outdoors');
    expect(locations.transition).toBeNull();
    expect(locations.controlsLocked).toBe(false);
    expect(locations.fadeOpacity).toBe(0);
  });

  it('has an enter and an exit door for each home', () => {
    const { locations } = setup();
    for (const home of HOMES) {
      expect(locations.doorway(doorwayId(home, 'enter'))).toMatchObject({ location: 'outdoors', destination: home });
      expect(locations.doorway(doorwayId(home, 'exit'))).toMatchObject({ location: home, destination: 'outdoors' });
    }
    expect(locations.doorways()).toHaveLength(4);
    expect(locations.doorwaysHere().map((d) => d.id).sort()).toEqual([ENTER_FAMILY, ENTER_NEIGHBOUR].sort());
  });

  it('pairs each door with the arrival pose on its far side', () => {
    for (const home of HOMES) {
      const { street, interior } = HOME_ENTRANCES[home];
      const doorways = homeDoorways();
      const enter = doorways.find((d) => d.id === doorwayId(home, 'enter'));
      const exit = doorways.find((d) => d.id === doorwayId(home, 'exit'));
      expect(enter).toMatchObject({ position: street.door, arrival: interior.arrival });
      expect(exit).toMatchObject({ position: interior.door, arrival: street.arrival });
    }
  });
});

describe('locations: door transition state machine', () => {
  it('fades out, moves at the midpoint, fades in and returns control', () => {
    const { locations, names, log, arrivals, step } = setup();
    expect(locations.requestTransition(ENTER_FAMILY)).toEqual({ ok: true });
    expect(log[0]).toEqual({
      name: 'transitionStarted',
      payload: { doorway: ENTER_FAMILY, from: 'outdoors', to: 'familyHome', duration: fadeDuration },
    });
    expect(locations.transition).toMatchObject({ phase: 'fadingOut', from: 'outdoors', to: 'familyHome', elapsed: 0 });
    expect(locations.controlsLocked).toBe(true);
    expect(locations.location).toBe('outdoors');

    step(fadeDuration / 2 - 2 * STEP);
    expect(locations.transition?.phase).toBe('fadingOut');
    expect(locations.location).toBe('outdoors');
    expect(arrivals).toHaveLength(0);

    step(3 * STEP);
    expect(locations.transition?.phase).toBe('fadingIn');
    expect(locations.location).toBe('familyHome');
    expect(locations.controlsLocked).toBe(true);
    expect(arrivals).toEqual([{ arrival: HOME_ENTRANCES.familyHome.interior.arrival, location: 'familyHome', eventsBefore: 0 }]);

    step(fadeDuration / 2);
    expect(locations.transition).toBeNull();
    expect(locations.controlsLocked).toBe(false);
    expect(names()).toEqual(['transitionStarted', 'locationChanged']);
    expect(log[1]).toEqual({ name: 'locationChanged', payload: { doorway: ENTER_FAMILY, from: 'outdoors', to: 'familyHome' } });
  });

  it('publishes location events once per transition, however the fade is stepped', () => {
    for (const dts of [[STEP], [fadeDuration / 2], [fadeDuration * 10], [0.001, 0.5, 0.001, 2]]) {
      const { locations, count } = setup();
      locations.requestTransition(ENTER_FAMILY);
      for (let i = 0; locations.transition && i < 10_000; i++) locations.update(dts[i % dts.length]!);
      expect(locations.location).toBe('familyHome');
      expect(count('transitionStarted')).toBe(1);
      expect(count('locationChanged')).toBe(1);
      // Further steps after the fade publish nothing.
      for (let i = 0; i < 60; i++) locations.update(STEP);
      expect(count('locationChanged')).toBe(1);
    }
  });

  it('round-trips street → family → street → neighbour → street', () => {
    const { locations, go, log } = setup();
    go(ENTER_FAMILY);
    go(EXIT_FAMILY);
    go(ENTER_NEIGHBOUR);
    expect(locations.location).toBe('neighbourHome');
    go(EXIT_NEIGHBOUR);
    expect(locations.location).toBe('outdoors');
    const changes = log.filter((e) => e.name === 'locationChanged').map((e) => e.payload);
    expect(changes).toEqual([
      { doorway: ENTER_FAMILY, from: 'outdoors', to: 'familyHome' },
      { doorway: EXIT_FAMILY, from: 'familyHome', to: 'outdoors' },
      { doorway: ENTER_NEIGHBOUR, from: 'outdoors', to: 'neighbourHome' },
      { doorway: EXIT_NEIGHBOUR, from: 'neighbourHome', to: 'outdoors' },
    ]);
  });

  it('freezes the fade while the fixed step is stopped', () => {
    const { locations } = setup();
    locations.requestTransition(ENTER_FAMILY);
    locations.update(fadeDuration / 4);
    const frozen = locations.transition;
    for (let i = 0; i < 100; i++) locations.update(0);
    locations.update(Number.NaN);
    locations.update(-1);
    expect(locations.transition).toEqual(frozen);
  });

  it('fades the overlay to black at the midpoint and back to clear', () => {
    const { locations } = setup();
    locations.requestTransition(ENTER_FAMILY);
    const samples: number[] = [locations.fadeOpacity];
    while (locations.transition) {
      locations.update(STEP);
      samples.push(locations.fadeOpacity);
    }
    const peak = samples.indexOf(Math.max(...samples));
    expect(samples[0]).toBe(0);
    expect(Math.max(...samples)).toBeCloseTo(1, 1);
    expect(samples.at(-1)).toBe(0);
    for (let i = 1; i <= peak; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    for (let i = peak + 1; i < samples.length; i++) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!);
    expect(fadeOpacity(null)).toBe(0);
    const instant = { doorway: ENTER_FAMILY, from: 'outdoors', to: 'familyHome', elapsed: 0, duration: 0 } as const;
    expect(fadeOpacity({ ...instant, phase: 'fadingOut' })).toBe(0);
  });
});

describe('locations: rejections', () => {
  it('rejects overlapping requests during both halves of the fade', () => {
    const { locations, count, log, step } = setup();
    expect(locations.requestTransition(ENTER_FAMILY).ok).toBe(true);
    // Spam every door, every step, through the whole fade.
    let rejected = 0;
    while (locations.transition) {
      for (const id of [ENTER_FAMILY, ENTER_NEIGHBOUR, EXIT_FAMILY, 'nowhere']) {
        expect(locations.requestTransition(id)).toEqual({ ok: false, reason: 'transitionInProgress' });
        rejected++;
      }
      step(STEP);
    }
    expect(count('transitionStarted')).toBe(1);
    expect(count('locationChanged')).toBe(1);
    expect(count('transitionRejected')).toBe(rejected);
    expect(log.find((e) => e.name === 'transitionRejected')?.payload).toEqual({
      doorway: ENTER_FAMILY,
      reason: 'transitionInProgress',
    });
    expect(locations.location).toBe('familyHome');
  });

  it('accepts the next door once the fade has finished', () => {
    const { locations, go } = setup();
    go(ENTER_FAMILY);
    expect(locations.requestTransition(EXIT_FAMILY)).toEqual({ ok: true });
  });

  it('rejects unknown doorways and doors on the other side', () => {
    const { locations, log, go } = setup();
    expect(locations.requestTransition('nowhere')).toEqual({ ok: false, reason: 'unknownDoorway' });
    expect(locations.requestTransition(EXIT_FAMILY)).toEqual({ ok: false, reason: 'wrongLocation' });
    go(ENTER_FAMILY);
    expect(locations.requestTransition(ENTER_NEIGHBOUR)).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(locations.requestTransition(EXIT_NEIGHBOUR)).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(log.filter((e) => e.name === 'transitionRejected').map((e) => e.payload)).toEqual([
      { doorway: 'nowhere', reason: 'unknownDoorway' },
      { doorway: EXIT_FAMILY, reason: 'wrongLocation' },
      { doorway: ENTER_NEIGHBOUR, reason: 'wrongLocation' },
      { doorway: EXIT_NEIGHBOUR, reason: 'wrongLocation' },
    ]);
    expect(locations.location).toBe('familyHome');
    expect(locations.transition).toBeNull();
  });

  it('blocks leaving the family home with the sharing plate until it is back on the sweets table', () => {
    const { locations, hands, go, serveTray, count, log } = setup();
    go(ENTER_FAMILY);
    serveTray();
    expect(hands.pickUpPlate()).toEqual({ ok: true });

    expect(locations.requestTransition(EXIT_FAMILY)).toEqual({ ok: false, reason: 'carryingPlate' });
    expect(log.at(-1)).toEqual({ name: 'transitionRejected', payload: { doorway: EXIT_FAMILY, reason: 'carryingPlate' } });
    expect(TRANSITION_REJECTION_TEXT.carryingPlate).toMatch(/sweets table/);
    expect(locations.location).toBe('familyHome');
    expect(locations.transition).toBeNull();
    expect(locations.controlsLocked).toBe(false);
    expect(count('transitionStarted')).toBe(1);

    expect(hands.returnPlate()).toEqual({ ok: true });
    go(EXIT_FAMILY);
    expect(locations.location).toBe('outdoors');
  });

  it('lets gift boxes cross doors both ways', () => {
    const { locations, hands, go } = setup();
    const outbound: HandItem = { kind: 'giftBox', box: 'outbound' };
    go(ENTER_FAMILY);
    expect(hands.take(outbound)).toEqual({ ok: true });
    go(EXIT_FAMILY);
    go(ENTER_NEIGHBOUR);
    expect(hands.deliver('giftBox', { kind: 'giftBox', box: 'return' })).toEqual({ ok: true });
    go(EXIT_NEIGHBOUR);
    go(ENTER_FAMILY);
    expect(locations.location).toBe('familyHome');
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
  });

  it('refuses doors while holding the thali for aarti', () => {
    const { locations, hands, go } = setup();
    go(ENTER_FAMILY);
    expect(hands.reserveThali()).toEqual({ ok: true });
    expect(locations.requestTransition(EXIT_FAMILY)).toEqual({ ok: false, reason: 'participatingInAarti' });
    hands.release('thali');
    expect(locations.requestTransition(EXIT_FAMILY)).toEqual({ ok: true });
  });

  it('words every rejection for the player', () => {
    const reasons: TransitionRejection[] = [
      'transitionInProgress',
      'carryingPlate',
      'participatingInAarti',
      'unknownDoorway',
      'wrongLocation',
    ];
    for (const reason of reasons) expect(TRANSITION_REJECTION_TEXT[reason].length).toBeGreaterThan(0);
  });
});

describe('locations: control during the fade', () => {
  const actions: readonly GameAction[] = [
    { type: 'move', forward: 1, right: 0 },
    { type: 'run', active: true },
    { type: 'look', dx: 3, dy: 1 },
    { type: 'select', slot: 2 },
    { type: 'place' },
    { type: 'interact' },
    { type: 'toggleCamera' },
    { type: 'pause' },
  ];

  it('drops cracker and interaction actions but keeps look, camera, pause and held keys', () => {
    const passed = actions.filter(allowedDuringFade).map((a) => a.type);
    expect(passed).toEqual(['move', 'run', 'look', 'toggleCamera', 'pause']);
  });

  it('locks controls exactly while a transition runs', () => {
    const { locations } = setup();
    const locked: boolean[] = [];
    locations.requestTransition(ENTER_FAMILY);
    while (locations.transition) {
      locked.push(locations.controlsLocked);
      locations.update(STEP);
    }
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every(Boolean)).toBe(true);
    expect(locations.controlsLocked).toBe(false);
  });
});

describe('locations: session reset', () => {
  it('returns outdoors and clears a running fade without publishing', () => {
    const { locations, go, count } = setup();
    go(ENTER_FAMILY);
    locations.requestTransition(EXIT_FAMILY);
    locations.update(STEP);
    const before = count('locationChanged');
    locations.reset();
    expect(locations.location).toBe('outdoors');
    expect(locations.transition).toBeNull();
    expect(locations.controlsLocked).toBe(false);
    for (let i = 0; i < 60; i++) locations.update(STEP);
    expect(count('locationChanged')).toBe(before);
  });

  it('replaces its pending reset stub and resets with the session', () => {
    const { bus, locations, hands, go } = setup();
    const hooks = homesResetHooks({ heldItems: hands, locations });
    expect(pendingModules(hooks)).not.toContain('locations');
    const session = new Session({ bus });
    registerHomesReset(session, hooks);
    go(ENTER_NEIGHBOUR);
    session.reset();
    expect(locations.location).toBe('outdoors');
  });
});

describe('locations: the outdoor world keeps running while indoors', () => {
  function outdoorSetup() {
    const s = setup();
    const capacity = new CapacityBudget({
      crackers: () => crackers,
      bus: s.bus,
      quality: qualityProfile('medium'),
      effects: () => ({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 }),
      voices: () => 0,
    });
    const crackers = new Crackers({ bus: s.bus, admission: capacity, random: () => 0.5, initialSelection: 'anar' });
    const hands = new HeldItems({ bus: s.bus, crackers });
    const locations = new Locations({ bus: s.bus, hands });
    // The game loop steps every rule module each fixed step, wherever the player is.
    const step = (seconds: number) => {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) {
        crackers.update(STEP);
        capacity.update(STEP);
        locations.update(STEP);
      }
    };
    const go = (doorway: string) => {
      expect(locations.requestTransition(doorway).ok).toBe(true);
      step(fadeDuration + STEP);
    };
    return { ...s, crackers, locations, step, go };
  }

  it('finishes lit crackers while the street is not active and never brings them back', () => {
    const { crackers, locations, step, go, log } = outdoorSetup();
    const placed = crackers.place({ type: 'anar', position: v(0, 0, -5) });
    if (!placed.ok) throw new Error('placement refused');
    expect(crackers.ignite(placed.id).ok).toBe(true);

    go(ENTER_FAMILY);
    expect(locations.location).toBe('familyHome');
    step(fuse.anar + activeDuration.anar + 1);

    const finished = log.filter((e) => e.name === 'crackerFinished');
    expect(finished.map((e) => e.payload)).toEqual([{ id: placed.id, type: 'anar', reason: 'completed' }]);
    expect(crackers.list()).toEqual([]);
    expect(crackers.get(placed.id)).toBeUndefined();

    const before = log.length;
    go(EXIT_FAMILY);
    step(5);
    expect(locations.location).toBe('outdoors');
    expect(crackers.list()).toEqual([]);
    const after = log.slice(before).map((e) => e.name);
    expect(after).not.toContain('fuseLit');
    expect(after).not.toContain('crackerActive');
    expect(after).not.toContain('crackerFinished');
  });

  it('keeps a lifecycle mid-flight across a visit without resetting it', () => {
    const { crackers, step, go } = outdoorSetup();
    const placed = crackers.place({ type: 'anar', position: v(0, 0, -5) });
    if (!placed.ok) throw new Error('placement refused');
    crackers.ignite(placed.id);
    step(fuse.anar + 1);
    expect(crackers.get(placed.id)?.state).toBe('active');
    const stateTime = crackers.get(placed.id)!.stateTime;

    go(ENTER_FAMILY);
    go(EXIT_FAMILY);
    const after = crackers.get(placed.id);
    expect(after?.state).toBe('active');
    expect(after!.stateTime).toBeCloseTo(stateTime + 2 * (fadeDuration + STEP), 5);
  });

  it('reclaims an abandoned unlit cracker while the player is inside', () => {
    const { crackers, locations, step, go, log } = outdoorSetup();
    const placed = crackers.place({ type: 'chakri', position: v(0, 0, -5) });
    if (!placed.ok) throw new Error('placement refused');

    go(ENTER_NEIGHBOUR);
    step(TUNING.caps.unlitReclaimAfter + 1);
    expect(locations.location).toBe('neighbourHome');
    expect(log.filter((e) => e.name === 'crackerFinished').map((e) => e.payload)).toEqual([
      { id: placed.id, type: 'chakri', reason: 'reclaimed' },
    ]);
    go(EXIT_NEIGHBOUR);
    expect(crackers.list()).toEqual([]);
  });
});

describe('locations: street arrival poses', () => {
  const world = createWorld();
  const { eyeHeight } = TUNING.player;
  const { collisionMargin, pitchLimit } = TUNING.camera;

  let physics: RAPIER.World;
  const players: PlayerController[] = [];

  beforeAll(async () => {
    await RAPIER.init();
    physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addWorldColliders(physics, world.solids);
    physics.step();
  });

  afterEach(() => {
    for (const player of players.splice(0)) player.dispose();
  });

  const forwardOf = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

  function solidAt(p: Vec3, pad = 0) {
    return world.solids.find(
      ({ box: { min, max } }) =>
        p.x > min.x - pad && p.x < max.x + pad && p.y > min.y - pad && p.y < max.y + pad && p.z > min.z - pad && p.z < max.z + pad,
    );
  }

  function expectClearView(view: CameraView, from: PlayerPose): void {
    const eye = { x: from.position.x, y: from.position.y + eyeHeight, z: from.position.z };
    expect(solidAt(view.position, 0.1)?.id, `camera at ${JSON.stringify(view.position)}`).toBeUndefined();
    for (let i = 1; i <= 40; i++) {
      const t = i / 40;
      const p = {
        x: eye.x + (view.position.x - eye.x) * t,
        y: eye.y + (view.position.y - eye.y) * t,
        z: eye.z + (view.position.z - eye.z) * t,
      };
      expect(solidAt(p)?.id, `boom crosses a solid at ${JSON.stringify(p)}`).toBeUndefined();
    }
  }

  for (const home of HOMES) {
    const { house, street, interior } = HOME_ENTRANCES[home];

    describe(home, () => {
      it('uses the street door of its house in the layout', () => {
        const zone = world.doorways.find((d) => d.id === `${house}.doorway`);
        expect(zone, house).toBeDefined();
        expect(street.door).toEqual(zone!.centre);
      });

      it('puts the player on walkable ground, clear of walls, facing away from the door', () => {
        const { position, yaw } = street.arrival;
        const ground = world.surfaceBelow(v(position.x, position.y + 0.01, position.z));
        expect(ground?.point.y).toBe(0);
        expect(world.isClear(v(position.x, 0.9, position.z), PLAYER_RADIUS + 0.2)).toBe(true);
        expect(world.contains(position)).toBe(true);
        const out = { x: position.x - street.door.x, z: position.z - street.door.z };
        const facing = forwardOf(yaw);
        expect(out.x * facing.x + out.z * facing.z).toBeGreaterThan(0);
        for (const area of world.neighbourAreas) {
          expect(Math.hypot(position.x - area.centre.x, position.z - area.centre.z)).toBeGreaterThan(area.radius);
        }
      });

      it('lands the player at rest where the pose says', () => {
        const player = new PlayerController({
          physics,
          bounds: world.bounds,
          spawn: street.arrival.position,
          spawnYaw: street.arrival.yaw,
        });
        players.push(player);
        let pose = player.pose;
        for (let i = 0; i < 30; i++) pose = player.move({ forward: 0, right: 0, run: false, yaw: street.arrival.yaw }, STEP);
        expect(pose.grounded).toBe(true);
        const { x, z } = street.arrival.position;
        expect(Math.hypot(pose.position.x - x, pose.position.z - z)).toBeLessThan(0.05);
        expect(Math.abs(pose.position.y - street.arrival.position.y)).toBeLessThan(0.05);
      });

      for (const mode of ['firstPerson', 'thirdPerson'] as CameraMode[]) {
        it(`gives a clear ${mode} view at arrival and looking round`, () => {
          const player = new PlayerController({
            physics,
            bounds: world.bounds,
            spawn: street.arrival.position,
            spawnYaw: street.arrival.yaw,
          });
          players.push(player);
          const rig = new CameraRig({
            mode,
            spawnYaw: street.arrival.yaw,
            obstacles: rapierBoomCaster(physics, { margin: collisionMargin, exclude: player.collider }),
          });
          const pose = player.pose;
          expectClearView(rig.update(pose, STEP), pose);
          for (const pitch of [-pitchLimit, -0.3, 0, 0.5, pitchLimit]) {
            for (let k = 0; k < 16; k++) {
              const yaw = (k / 16) * 2 * Math.PI - Math.PI;
              rig.look((rig.yaw - yaw) / rig.sensitivity, (rig.pitch - pitch) / rig.sensitivity);
              expectClearView(rig.update(pose, STEP), pose);
            }
          }
        });
      }

      it('keeps its interior apart from the street', () => {
        expect(world.contains(interior.arrival.position)).toBe(false);
        expect(world.contains(interior.door)).toBe(false);
        const { x, z } = interior.arrival.position;
        expect(Math.hypot(x - interior.door.x, z - interior.door.z)).toBeGreaterThan(1);
      });
    });
  }

  it('gives each home its own interior', () => {
    const [a, b] = HOMES.map((home) => HOME_ENTRANCES[home].interior.arrival.position);
    expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeGreaterThan(20);
  });
});
