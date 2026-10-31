import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameAction } from '../src/core/actions';
import type { MovementIntent, PlayerPose } from '../src/core/contracts';
import { TUNING } from '../src/core/tuning';
import type { Vec3 } from '../src/core/types';
import { createWorld, LAYOUT } from '../src/world';
import { addWorldColliders } from '../src/world/colliders';
import { forwardFor, MovementIntentTracker, PLAYER_RADIUS, PlayerController, rightFor } from '../src/player';

const world = createWorld();
const STEP = 1 / 60;

/** Yaws for the four compass directions; yaw 0 looks down -Z (north). */
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

const walk = (yaw: number, forward = 1, right = 0, run = false): MovementIntent => ({ forward, right, run, yaw });

/** Run the game loop's fixed steps for `seconds`; returns every pose. */
function simulate(player: PlayerController, intent: MovementIntent, seconds: number, dt = STEP): PlayerPose[] {
  const poses: PlayerPose[] = [];
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
    poses.push(player.move(intent, dt));
    physics.step();
  }
  return poses;
}

/** Walk until `done` holds or `seconds` run out; fails if it never holds. */
function walkUntil(player: PlayerController, intent: MovementIntent, done: (p: PlayerPose) => boolean, seconds = 20) {
  for (let i = 0, n = Math.round(seconds / STEP); i < n; i++) {
    const pose = player.move(intent, STEP);
    physics.step();
    if (done(pose)) return pose;
  }
  throw new Error(`condition not reached; stopped at ${JSON.stringify(player.pose.position)}`);
}

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

function expectInsideBounds(p: Vec3) {
  const { min, max } = world.bounds;
  expect(p.x).toBeGreaterThanOrEqual(min.x);
  expect(p.x).toBeLessThanOrEqual(max.x);
  expect(p.z).toBeGreaterThanOrEqual(min.z);
  expect(p.z).toBeLessThanOrEqual(max.z);
}

const { stair, rooftopHouse, rooftopHeight } = LAYOUT;
/** Middle of the stair's walkable width, inside its west railing. */
const stairX = stair.x - (stair.width - LAYOUT.railingThickness) / 2;
const landingNearZ = stair.startZ - stair.tread * stair.steps;
const landingFarZ = landingNearZ - stair.landingDepth;
const landingZ = (landingNearZ + landingFarZ) / 2;

describe('facing directions', () => {
  it('yaw 0 looks down -Z with +X to the right', () => {
    expect(forwardFor(0)).toMatchObject({ x: -0, z: -1 });
    expect(rightFor(0)).toMatchObject({ x: 1, z: -0 });
    expect(forwardFor(EAST).x).toBeCloseTo(1);
  });
});

describe('player movement: walking and running', () => {
  it('starts at spawn, grounded and facing the spawn yaw', () => {
    const player = spawnAt(world.spawn, world.spawnYaw);
    expect(player.pose).toMatchObject({ position: world.spawn, yaw: world.spawnYaw, grounded: true });
  });

  it('stays put and grounded with no input', () => {
    const player = spawnAt(world.spawn);
    const poses = simulate(player, walk(NORTH, 0), 1);
    const last = poses[poses.length - 1]!;
    expect(horizontal(last.position, world.spawn)).toBeLessThan(1e-3);
    expect(last.position.y).toBeCloseTo(0, 2);
    expect(last.grounded).toBe(true);
  });

  it('accelerates smoothly up to walk speed in the facing direction', () => {
    const player = spawnAt(world.spawn);
    player.move(walk(NORTH), STEP);
    expect(player.speed).toBeGreaterThan(0);
    expect(player.speed).toBeLessThan(TUNING.player.walkSpeed);
    simulate(player, walk(NORTH), 0.5);
    expect(player.speed).toBeCloseTo(TUNING.player.walkSpeed);
    expect(player.pose.position.z).toBeLessThan(world.spawn.z);
    expect(player.pose.position.x).toBeCloseTo(world.spawn.x);
  });

  it('runs faster than it walks', () => {
    const walker = spawnAt(world.spawn);
    const runner = spawnAt({ x: 2, y: 0, z: 5 });
    simulate(walker, walk(NORTH), 1.5);
    simulate(runner, walk(NORTH, 1, 0, true), 1.5);
    expect(runner.speed).toBeCloseTo(TUNING.player.runSpeed);
    const walked = world.spawn.z - walker.pose.position.z;
    const ran = 5 - runner.pose.position.z;
    expect(ran).toBeGreaterThan(walked * 1.8);
  });

  it('is no faster on a diagonal', () => {
    const player = spawnAt(world.spawn);
    simulate(player, walk(NORTH, 1, 1), 1);
    expect(player.speed).toBeCloseTo(TUNING.player.walkSpeed);
  });

  it('comes to a stop shortly after input is released', () => {
    const player = spawnAt(world.spawn);
    simulate(player, walk(NORTH, 1, 0, true), 1);
    const released = player.pose.position;
    simulate(player, walk(NORTH, 0), 0.5);
    expect(player.speed).toBe(0);
    const slid = horizontal(player.pose.position, released);
    expect(slid).toBeGreaterThan(0);
    expect(slid).toBeLessThan(0.5);
  });

  it('reports facing from the intent', () => {
    const player = spawnAt(world.spawn);
    expect(player.move(walk(1.2, 0), STEP).yaw).toBe(1.2);
  });

  it('covers the same ground at 30 and 60 FPS frame steps', () => {
    const at60 = spawnAt({ x: -2, y: 0, z: 5 });
    const at30 = spawnAt({ x: 2, y: 0, z: 5 });
    simulate(at60, walk(NORTH, 1, 0, true), 2, 1 / 60);
    simulate(at30, walk(NORTH, 1, 0, true), 2, 1 / 30);
    const d60 = 5 - at60.pose.position.z;
    const d30 = 5 - at30.pose.position.z;
    expect(Math.abs(d60 - d30)).toBeLessThan(0.1);
  });

  it('ignores a zero or negative time step', () => {
    const player = spawnAt(world.spawn);
    expect(player.move(walk(NORTH), 0)).toBe(player.pose);
    expect(player.move(walk(NORTH), -1).position).toEqual(world.spawn);
  });

  it('returns to spawn, at rest, on reset', () => {
    const player = spawnAt(world.spawn, world.spawnYaw);
    simulate(player, walk(EAST, 1, 0, true), 1);
    player.reset();
    expect(player.pose).toMatchObject({ position: world.spawn, yaw: world.spawnYaw });
    expect(player.speed).toBe(0);
  });
});

describe('player movement: walls and boundaries', () => {
  it('a house wall blocks walking out of the lane', () => {
    const player = spawnAt(world.spawn);
    const poses = simulate(player, walk(EAST, 1, 0, true), 3);
    const wallX = LAYOUT.laneHalfWidth;
    for (const pose of poses) expect(pose.position.x).toBeLessThan(wallX - PLAYER_RADIUS + 0.05);
    expect(player.pose.position.x).toBeGreaterThan(wallX - PLAYER_RADIUS - 0.1);
    expect(player.speed).toBeLessThan(0.1);
  });

  it('slides along a wall when walking into it at an angle', () => {
    const player = spawnAt({ x: 3, y: 0, z: 0 });
    simulate(player, walk(NORTH, 1, 1), 2);
    expect(player.pose.position.x).toBeLessThan(LAYOUT.laneHalfWidth - PLAYER_RADIUS + 0.05);
    expect(player.pose.position.z).toBeLessThan(-2);
  });

  it('the entrance wall blocks leaving the south end of the lane', () => {
    const player = spawnAt(world.spawn);
    simulate(player, walk(SOUTH, 1, 0, true), 3);
    expect(player.pose.position.z).toBeLessThan(LAYOUT.laneSouthZ - PLAYER_RADIUS + 0.05);
  });

  it('the courtyard boundary holds in every direction', () => {
    for (const yaw of [NORTH, WEST, SOUTH, EAST]) {
      const player = spawnAt({ x: -6, y: 0, z: -28 });
      for (const pose of simulate(player, walk(yaw, 1, 0, true), 6)) expectInsideBounds(pose.position);
      expect(player.pose.position.y).toBeCloseTo(0, 1);
      player.dispose();
      players.splice(players.indexOf(player), 1);
    }
  });

  it('the stair railing blocks climbing on from the side', () => {
    const player = spawnAt({ x: 9, y: 0, z: stair.startZ - stair.tread * 10 });
    simulate(player, walk(EAST), 3);
    expect(player.pose.position.x).toBeLessThan(stair.x - stair.width);
    expect(player.pose.position.y).toBeLessThan(0.05);
  });

  it('cannot walk through the tulsi platform', () => {
    // 0.5 m is above the autostep height.
    const player = spawnAt({ x: 0, y: 0, z: -24 });
    simulate(player, walk(NORTH), 3);
    expect(player.pose.position.z).toBeGreaterThan(-27);
    expect(player.pose.position.y).toBeLessThan(0.05);
  });
});

describe('player movement: stairs and rooftop', () => {
  function climbToLanding(): PlayerController {
    const player = spawnAt({ x: stairX, y: 0, z: stair.startZ + 1 });
    walkUntil(player, walk(NORTH), (p) => p.position.z < landingZ);
    return player;
  }

  it('climbs the stairs to the rooftop level without jumping', () => {
    const player = spawnAt({ x: stairX, y: 0, z: stair.startZ + 1 });
    const poses: PlayerPose[] = [];
    walkUntil(player, walk(NORTH), (p) => (poses.push(p), p.position.z < landingZ));
    expect(player.pose.position.y).toBeCloseTo(rooftopHeight, 1);
    expect(player.pose.grounded).toBe(true);
    // Never rises more than a step at a time.
    for (let i = 1; i < poses.length; i++) {
      expect(poses[i]!.position.y - poses[i - 1]!.position.y).toBeLessThanOrEqual(TUNING.player.maxStepHeight + 0.01);
    }
  });

  it('climbs the stairs while running', () => {
    const player = spawnAt({ x: stairX, y: 0, z: stair.startZ + 1 });
    walkUntil(player, walk(NORTH, 1, 0, true), (p) => p.position.z < landingZ);
    expect(player.pose.position.y).toBeCloseTo(rooftopHeight, 1);
  });

  it('walks from the landing onto the rooftop terrace', () => {
    const player = climbToLanding();
    walkUntil(player, walk(EAST), (p) => p.position.x > rooftopHouse.minX + 2);
    expect(player.pose.position.y).toBeCloseTo(rooftopHeight, 1);
    expect(player.pose.grounded).toBe(true);
  });

  it('stays on the rooftop and inside the boundaries whichever way it walks', () => {
    const player = climbToLanding();
    walkUntil(player, walk(EAST), (p) => p.position.x > rooftopHouse.minX + 2);
    walkUntil(player, walk(SOUTH), (p) => p.position.z > -26);
    for (const yaw of [EAST, NORTH, WEST, SOUTH, EAST]) {
      for (const pose of simulate(player, walk(yaw, 1, 0, true), 5)) {
        expectInsideBounds(pose.position);
        expect(pose.position.y).toBeCloseTo(rooftopHeight, 1);
        expect(pose.position.x).toBeGreaterThan(rooftopHouse.minX);
        expect(pose.position.x).toBeLessThan(rooftopHouse.maxX);
        expect(pose.position.z).toBeGreaterThan(rooftopHouse.minZ);
        expect(pose.position.z).toBeLessThan(rooftopHouse.maxZ);
      }
    }
  });

  it('walks back down the stairs, staying grounded on each step', () => {
    const player = climbToLanding();
    const poses: PlayerPose[] = [];
    walkUntil(player, walk(SOUTH), (p) => (poses.push(p), p.position.z > stair.startZ + 0.5));
    expect(player.pose.position.y).toBeCloseTo(0, 1);
    // Snapped to the steps rather than launching off them.
    const airborne = poses.filter((p) => !p.grounded).length;
    expect(airborne).toBeLessThan(poses.length * 0.1);
    for (let i = 1; i < poses.length; i++) {
      expect(poses[i - 1]!.position.y - poses[i]!.position.y).toBeLessThanOrEqual(stair.rise + 0.05);
    }
  });

  it('runs back down the stairs to the courtyard', () => {
    const player = climbToLanding();
    walkUntil(player, walk(SOUTH, 1, 0, true), (p) => p.position.z > stair.startZ + 0.5);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
  });
});

describe('player movement: grounding', () => {
  it('falls to the ground when spawned in the air, then is grounded', () => {
    const player = spawnAt({ x: 0, y: 2, z: 0 });
    expect(player.move(walk(NORTH, 0), STEP).grounded).toBe(false);
    simulate(player, walk(NORTH, 0), 1.5);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
    expect(player.pose.grounded).toBe(true);
  });

  it('returns to spawn after falling out of the world', () => {
    // Inside the bounds but behind the east lane houses, over no ground.
    const player = spawnAt({ x: 15, y: 0, z: 0 });
    const poses = simulate(player, walk(NORTH, 0), 2);
    for (const pose of poses) expect(pose.position.y).toBeGreaterThanOrEqual(world.bounds.min.y);
    const fell = poses.findIndex((p, i) => i > 0 && p.position.y > poses[i - 1]!.position.y);
    expect(fell).toBeGreaterThan(0);
    expect(poses[fell]).toMatchObject({ position: { x: 15, y: 0, z: 0 }, grounded: true });
  });
});

describe('player movement: jumping', () => {
  const jump = (yaw = NORTH, forward = 0): MovementIntent => ({ ...walk(yaw, forward), jump: true });
  const { jumpSpeed, gravity } = TUNING.player;
  const apex = (jumpSpeed * jumpSpeed) / (2 * gravity);

  /** Jump once from rest, then stand still until landed; returns every pose. */
  function jumpOnce(player: PlayerController, intent = jump()): PlayerPose[] {
    const poses = [player.move(intent, STEP)];
    physics.step();
    return poses.concat(simulate(player, { ...intent, jump: false }, 1.5));
  }

  it('leaves the ground, rises about the tuned height and lands back on it', () => {
    const player = spawnAt(world.spawn);
    const poses = jumpOnce(player);
    expect(poses[0]!.grounded).toBe(false);
    expect(poses[0]!.position.y).toBeGreaterThan(world.spawn.y);
    const peak = Math.max(...poses.map((p) => p.position.y)) - world.spawn.y;
    expect(peak).toBeGreaterThan(apex * 0.85);
    expect(peak).toBeLessThan(apex * 1.1);
    const last = poses[poses.length - 1]!;
    expect(last.grounded).toBe(true);
    expect(last.position.y).toBeCloseTo(world.spawn.y, 2);
  });

  it('carries the walking speed through the air', () => {
    const player = spawnAt(world.spawn);
    simulate(player, walk(NORTH), 0.5);
    const before = player.pose.position;
    player.move(jump(NORTH, 1), STEP);
    physics.step();
    simulate(player, walk(NORTH), 0.3);
    expect(player.pose.grounded).toBe(false);
    expect(horizontal(player.pose.position, before)).toBeGreaterThan(TUNING.player.walkSpeed * 0.25);
  });

  it('cannot jump again in mid-air', () => {
    const player = spawnAt(world.spawn);
    const poses: PlayerPose[] = [];
    // Press jump on every step of the flight: only the first press counts.
    for (let i = 0; i < 60; i++) {
      poses.push(player.move(jump(), STEP));
      physics.step();
      if (i > 0 && poses[i]!.grounded) break;
    }
    const peak = Math.max(...poses.map((p) => p.position.y)) - world.spawn.y;
    expect(peak).toBeLessThan(apex * 1.1);
    expect(poses[poses.length - 1]!.grounded).toBe(true);
  });

  it('jumps again once landed', () => {
    const player = spawnAt(world.spawn);
    jumpOnce(player);
    expect(player.pose.grounded).toBe(true);
    expect(player.move(jump(), STEP).position.y).toBeGreaterThan(world.spawn.y);
  });

  it('does not jump while falling', () => {
    const player = spawnAt({ x: 0, y: 2, z: 0 });
    player.move(walk(NORTH, 0), STEP);
    physics.step();
    const before = player.pose.position.y;
    expect(player.move(jump(), STEP).position.y).toBeLessThan(before);
  });

  it('stays inside the boundaries when jumping at them', () => {
    const player = spawnAt(world.spawn);
    for (let i = 0; i < 60 * 6; i++) {
      player.move({ ...walk(EAST, 1, 0, true), jump: i % 40 === 0 }, STEP);
      physics.step();
      expectInsideBounds(player.pose.position);
    }
  });

  it('a ceiling overhead stops the rise and the player drops back down', () => {
    const room = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    room.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.1, 5).setTranslation(0, -0.1, 0));
    // Underside 0.2 m above the top of a standing capsule.
    const ceiling = 1.75 + 0.02 + 0.2;
    room.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.1, 5).setTranslation(0, ceiling + 0.1, 0));
    room.step();
    const bounds = { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 5, z: 5 } };
    const player = new PlayerController({ physics: room, bounds, spawn: { x: 0, y: 0, z: 0 } });
    const poses = [player.move(jump(), STEP)];
    room.step();
    for (let i = 0; i < 90; i++) {
      poses.push(player.move(walk(NORTH, 0), STEP));
      room.step();
    }
    const peak = Math.max(...poses.map((p) => p.position.y));
    expect(peak).toBeLessThan(0.2 + 0.01);
    expect(peak).toBeGreaterThan(0.1);
    // The rise ends at the ceiling rather than pressing into it until gravity
    // wins, so the player is back down in about the time a 0.2 m drop takes.
    const landed = poses.findIndex((p, i) => i > 0 && p.grounded);
    expect(landed).toBeGreaterThan(0);
    expect(landed * STEP).toBeLessThan(0.4);
    expect(poses[poses.length - 1]).toMatchObject({ grounded: true });
    expect(poses[poses.length - 1]!.position.y).toBeCloseTo(0, 2);
    player.dispose();
    room.free();
  });
});

describe('MovementIntentTracker', () => {
  it('hands a jump press to one intent only', () => {
    const tracker = new MovementIntentTracker();
    tracker.apply({ type: 'jump' });
    expect(tracker.intent(0).jump).toBe(true);
    expect(tracker.intent(0).jump).toBe(false);
    tracker.apply({ type: 'jump' });
    tracker.reset();
    expect(tracker.intent(0).jump).toBe(false);
  });


  it('folds move and run actions into an intent and ignores the rest', () => {
    const tracker = new MovementIntentTracker();
    const actions: GameAction[] = [
      { type: 'move', forward: 1, right: 0 },
      { type: 'run', active: true },
      { type: 'look', dx: 4, dy: 0 },
      { type: 'move', forward: 1, right: -1 },
    ];
    for (const action of actions) tracker.apply(action);
    expect(tracker.intent(0.5)).toEqual({ forward: 1, right: -1, run: true, jump: false, yaw: 0.5 });
    tracker.apply({ type: 'run', active: false });
    expect(tracker.intent(0).run).toBe(false);
  });

  it('resets to standing still', () => {
    const tracker = new MovementIntentTracker();
    tracker.apply({ type: 'move', forward: -1, right: 1 });
    tracker.apply({ type: 'run', active: true });
    tracker.reset();
    expect(tracker.intent(0)).toEqual({ forward: 0, right: 0, run: false, jump: false, yaw: 0 });
  });
});
