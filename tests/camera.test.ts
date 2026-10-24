import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CameraView, MovementIntent, PlayerPose } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { TUNING } from '../src/core/tuning';
import type { CameraMode, Vec3 } from '../src/core/types';
import { CameraRig, MAX_SENSITIVITY, MIN_SENSITIVITY, rapierBoomCaster, viewForward } from '../src/camera';
import { PlayerController } from '../src/player';
import { createWorld, LAYOUT } from '../src/world';
import { addWorldColliders } from '../src/world/colliders';

const world = createWorld();
const STEP = 1 / 60;
const { eyeHeight } = TUNING.player;
const { thirdPersonDistance, thirdPersonHeight, collisionMargin, pitchLimit } = TUNING.camera;

/** Yaws for the compass directions; yaw 0 looks down -Z (north). */
const NORTH = 0;
const SOUTH = Math.PI;
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

let physics: RAPIER.World;
const players: PlayerController[] = [];

beforeAll(async () => {
  await RAPIER.init();
  physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  addWorldColliders(physics, world.solids);
  physics.step(); // populate the broad phase
});

afterEach(() => {
  for (const player of players.splice(0)) player.dispose();
});

function spawnAt(spawn: Vec3, spawnYaw = 0): PlayerController {
  const player = new PlayerController({ physics, bounds: world.bounds, spawn, spawnYaw });
  players.push(player);
  return player;
}

function rigFor(player: PlayerController, mode: CameraMode = 'thirdPerson'): CameraRig {
  return new CameraRig({ mode, obstacles: rapierBoomCaster(physics, { margin: collisionMargin, exclude: player.collider }) });
}

/** Turn the rig to face `yaw`/`pitch` exactly. */
function aim(rig: CameraRig, yaw: number, pitch = 0): void {
  rig.look((rig.yaw - yaw) / rig.sensitivity, (rig.pitch - pitch) / rig.sensitivity);
}

const pose = (position: Vec3, yaw = 0): PlayerPose => ({ position, yaw, grounded: true });
const eyeOf = (p: PlayerPose): Vec3 => ({ x: p.position.x, y: p.position.y + eyeHeight, z: p.position.z });
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fullBoom = Math.hypot(thirdPersonDistance, thirdPersonHeight - eyeHeight);

/** Solid containing `p` grown by `pad`, if any; checked against layout data, not Rapier. */
function solidAt(p: Vec3, pad = 0) {
  return world.solids.find(({ box: { min, max } }) =>
    p.x > min.x - pad && p.x < max.x + pad && p.y > min.y - pad && p.y < max.y + pad && p.z > min.z - pad && p.z < max.z + pad,
  );
}

/** The view is outside every solid and the line of sight from the head to it crosses none. */
function expectClearView(view: CameraView, from: PlayerPose): void {
  const eye = eyeOf(from);
  // The near plane is 0.1 m; keep at least that from any surface.
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

/** Sweep the view all the way round at several pitches; returns the views. */
function sweep(rig: CameraRig, at: PlayerPose): CameraView[] {
  const views: CameraView[] = [];
  for (const pitch of [-pitchLimit, -0.6, -0.2, 0, 0.3, 0.8, pitchLimit]) {
    for (let k = 0; k < 24; k++) {
      aim(rig, (k / 24) * 2 * Math.PI - Math.PI, pitch);
      const view = rig.update(at, STEP);
      expectClearView(view, at);
      views.push(view);
    }
  }
  return views;
}

const walk = (yaw: number, forward = 1): MovementIntent => ({ forward, right: 0, run: false, yaw });

function walkUntil(player: PlayerController, intent: MovementIntent, done: (p: PlayerPose) => boolean, seconds = 20) {
  for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) {
    const p = player.move(intent, STEP);
    physics.step();
    if (done(p)) return p;
  }
  throw new Error(`condition not reached; stopped at ${JSON.stringify(player.pose.position)}`);
}

describe('camera: look', () => {
  it('starts in first-person at eye height, facing the spawn yaw', () => {
    const rig = new CameraRig({ spawnYaw: 1 });
    expect(rig.mode).toBe('firstPerson');
    const view = rig.update(pose({ x: 1, y: 2, z: 3 }), STEP);
    expect(view).toMatchObject({ mode: 'firstPerson', position: { x: 1, y: 2 + eyeHeight, z: 3 }, yaw: 1, pitch: 0 });
  });

  it('turns with the mouse: right turns right, down looks down', () => {
    const rig = new CameraRig();
    rig.look(100, 0);
    expect(rig.yaw).toBeCloseTo(-100 * TUNING.camera.mouseSensitivity);
    expect(viewForward(rig.yaw, 0).x).toBeGreaterThan(0);
    rig.look(0, 100);
    expect(rig.pitch).toBeLessThan(0);
    expect(rig.update(pose({ x: 0, y: 0, z: 0 }), STEP).forward.y).toBeLessThan(0);
  });

  it('clamps pitch short of straight up and down', () => {
    const rig = new CameraRig();
    rig.look(0, -1e6);
    expect(rig.pitch).toBe(pitchLimit);
    rig.look(0, 1e6);
    expect(rig.pitch).toBe(-pitchLimit);
  });

  it('keeps yaw wrapped and ignores non-finite deltas', () => {
    const rig = new CameraRig();
    for (let i = 0; i < 1000; i++) rig.look(500, 0);
    expect(Math.abs(rig.yaw)).toBeLessThanOrEqual(Math.PI);
    const { yaw, pitch } = rig;
    rig.look(Number.NaN, Infinity);
    expect(rig.yaw).toBe(yaw);
    expect(rig.pitch).toBe(pitch);
  });

  it('has an adjustable, bounded sensitivity', () => {
    const rig = new CameraRig();
    rig.sensitivity = 0.004;
    rig.look(10, 0);
    expect(rig.yaw).toBeCloseTo(-0.04);
    rig.sensitivity = 1;
    expect(rig.sensitivity).toBe(MAX_SENSITIVITY);
    rig.sensitivity = 0;
    expect(rig.sensitivity).toBe(MIN_SENSITIVITY);
    rig.sensitivity = Number.NaN;
    expect(rig.sensitivity).toBe(MIN_SENSITIVITY);
  });

  it('gives a unit view direction', () => {
    for (const [yaw, pitch] of [[0, 0], [1, 0.5], [-2, -1.2]] as const) {
      const f = viewForward(yaw, pitch);
      expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1);
    }
    expect(viewForward(0, 0)).toMatchObject({ x: -0, y: 0, z: -1 });
  });
});

describe('camera: mode switching', () => {
  it('V toggles between first- and third-person and emits each change', () => {
    const bus = createGameEventBus();
    const modes: CameraMode[] = [];
    bus.on('cameraModeChanged', ({ mode }) => modes.push(mode));
    const rig = new CameraRig({ bus });
    rig.toggleMode();
    expect(rig.mode).toBe('thirdPerson');
    rig.toggleMode();
    expect(rig.mode).toBe('firstPerson');
    rig.setMode('firstPerson'); // no change, no event
    expect(modes).toEqual(['thirdPerson', 'firstPerson']);
  });

  it('keeps the look direction across a switch', () => {
    const rig = new CameraRig();
    rig.look(120, 40);
    const before = rig.update(pose({ x: 0, y: 0, z: -28 }), STEP);
    rig.toggleMode();
    const after = rig.update(pose({ x: 0, y: 0, z: -28 }), STEP);
    expect(after).toMatchObject({ mode: 'thirdPerson', yaw: before.yaw, pitch: before.pitch, forward: before.forward });
  });

  it('places the third-person camera behind and above the head in the open', () => {
    const player = spawnAt({ x: -6, y: 0, z: -28 });
    const rig = rigFor(player);
    aim(rig, NORTH);
    const view = rig.update(player.pose, STEP);
    expect(view.position.x).toBeCloseTo(-6);
    expect(view.position.y).toBeCloseTo(thirdPersonHeight);
    expect(view.position.z).toBeCloseTo(-28 + thirdPersonDistance);
  });

  it('toggling mode leaves the player pose unchanged', () => {
    const start = { x: 0, y: 0, z: 2 };
    const route = [walk(NORTH), walk(EAST), walk(SOUTH, 0), walk(WEST)];

    // The same walk twice, once toggling the camera every few steps.
    function run(toggle: boolean): PlayerPose[] {
      const player = spawnAt(start);
      const rig = rigFor(player, 'firstPerson');
      const poses: PlayerPose[] = [];
      for (let i = 0; i < 240; i++) {
        if (toggle && i % 7 === 0) {
          const before = player.pose;
          rig.toggleMode();
          rig.update(player.pose, STEP);
          expect(player.pose).toBe(before);
          expect(player.collider.translation()).toEqual(player.collider.translation());
        }
        poses.push(player.move(route[Math.floor(i / 60)]!, STEP));
        physics.step();
      }
      player.dispose();
      players.splice(players.indexOf(player), 1);
      return poses;
    }

    expect(run(true)).toEqual(run(false));
  });

  it('toggling while standing still does not nudge the player', () => {
    const player = spawnAt({ x: 1, y: 0, z: 1 });
    const rig = rigFor(player, 'firstPerson');
    const capsule = { ...player.collider.translation() };
    const before = player.pose;
    for (let i = 0; i < 6; i++) {
      rig.toggleMode();
      rig.update(player.pose, STEP);
      physics.step();
    }
    expect(player.pose).toEqual(before);
    expect(player.collider.translation()).toEqual(capsule);
  });

  it('returns to first-person and the spawn facing on reset', () => {
    const bus = createGameEventBus();
    const modes: CameraMode[] = [];
    bus.on('cameraModeChanged', ({ mode }) => modes.push(mode));
    const rig = new CameraRig({ bus, spawnYaw: 0.5 });
    rig.toggleMode();
    rig.look(300, 200);
    rig.reset();
    expect(rig).toMatchObject({ mode: 'firstPerson', yaw: 0.5, pitch: 0 });
    expect(modes).toEqual(['thirdPerson', 'firstPerson']);
  });
});

describe('camera: third-person obstacle avoidance', () => {
  it('pulls in against a wall behind the player', () => {
    // In the lane beside its east houses, looking west: the boom points into the wall.
    const at = pose({ x: LAYOUT.laneHalfWidth - 0.5, y: 0, z: 0 });
    const player = spawnAt(at.position);
    const rig = rigFor(player);
    aim(rig, WEST);
    const view = rig.update(player.pose, STEP);
    expect(distance(view.position, eyeOf(at))).toBeLessThan(fullBoom - 1);
    expect(view.position.x).toBeLessThanOrEqual(LAYOUT.laneHalfWidth - collisionMargin + 1e-3);
    expectClearView(view, at);
  });

  it('stays out of the walls in the lane corner at the entrance', () => {
    const corner = { x: LAYOUT.laneHalfWidth - 0.4, y: 0, z: LAYOUT.laneSouthZ - 0.4 };
    const player = spawnAt(corner);
    const rig = rigFor(player);
    const views = sweep(rig, player.pose);
    // Some directions are blocked, others open up the lane.
    expect(Math.min(...views.map((v) => distance(v.position, eyeOf(player.pose))))).toBeLessThan(1);
    expect(Math.max(...views.map((v) => distance(v.position, eyeOf(player.pose))))).toBeGreaterThan(fullBoom - 0.1);
  });

  it('stays out of the walls in a courtyard corner', () => {
    const { courtyardHalfWidth, courtyardNorthZ } = LAYOUT;
    const player = spawnAt({ x: -courtyardHalfWidth + 0.5, y: 0, z: courtyardNorthZ + 0.5 });
    sweep(rigFor(player), player.pose);
  });

  it('stays out of the walls, railing and steps on the stairs', () => {
    const { stair } = LAYOUT;
    const stairX = stair.x - (stair.width - LAYOUT.railingThickness) / 2;
    const player = spawnAt({ x: stairX, y: 0, z: stair.startZ + 1 });
    const rig = rigFor(player);
    for (const height of [0.6, 1.6, 2.6, 3.6]) {
      walkUntil(player, walk(NORTH), (p) => p.position.y >= height);
      sweep(rig, player.pose);
    }
  });

  it('stays out of the house and roof on the stair landing and the rooftop', () => {
    const { stair } = LAYOUT;
    const stairX = stair.x - (stair.width - LAYOUT.railingThickness) / 2;
    const landingZ = stair.startZ - stair.tread * stair.steps - stair.landingDepth / 2;
    const player = spawnAt({ x: stairX, y: 0, z: stair.startZ + 1 });
    walkUntil(player, walk(NORTH), (p) => p.position.z < landingZ);
    const rig = rigFor(player);
    sweep(rig, player.pose);
    walkUntil(player, walk(EAST), (p) => p.position.x > LAYOUT.rooftopHouse.minX + 0.6);
    // Looking up from the roof swings the camera below the terrace.
    const views = sweep(rig, player.pose);
    for (const view of views) expect(view.position.y).toBeGreaterThan(LAYOUT.rooftopHeight);
  });

  it('pulls in at once and eases back out once the obstacle clears', () => {
    let free = 0.5;
    const rig = new CameraRig({ mode: 'thirdPerson', obstacles: (_o, _d, max) => Math.min(free, max) });
    const at = pose({ x: 0, y: 0, z: 0 });
    const boom = () => distance(rig.update(at, STEP).position, eyeOf(at));
    expect(boom()).toBeCloseTo(0.5);
    free = Infinity;
    const eased = boom();
    expect(eased).toBeGreaterThan(0.5);
    expect(eased).toBeLessThan(fullBoom);
    for (let i = 0; i < 60; i++) boom();
    expect(boom()).toBeCloseTo(fullBoom);
    free = 1;
    expect(boom()).toBeCloseTo(1);
  });
});
