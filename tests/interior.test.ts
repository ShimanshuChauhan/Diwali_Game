import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CameraView, PlayerPose } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import type { HomeInteractable, Placement } from '../src/core/homes';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import type { Aabb, CameraMode, Vec3 } from '../src/core/types';
import { CameraRig, rapierBoomCaster } from '../src/camera';
import { doorwayId, HOME_ENTRANCES, homeDoorways, Locations } from '../src/homes';
import { HOME_SPOTS, Interaction } from '../src/interaction';
import {
  addInteriorColliders,
  buildInteriorScene,
  createFamilyHomeLayout,
  facing,
  FAMILY_ROOM,
  familyHomeSpots,
  flicker,
  INTERIOR_MATERIALS,
  InteriorAssets,
  lightOnAt,
  LocationPresenter,
  type InteriorBox,
} from '../src/interior';
import { PLAYER_RADIUS, PlayerController } from '../src/player';
import { createWorld } from '../src/world';
import { addWorldColliders } from '../src/world/colliders';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const world = createWorld();
const home = createFamilyHomeLayout();
const { eyeHeight, maxStepHeight } = TUNING.player;
const { collisionMargin, pitchLimit, thirdPersonDistance, thirdPersonHeight } = TUNING.camera;
const fullBoom = Math.hypot(thirdPersonDistance, thirdPersonHeight - eyeHeight);
const { fadeDuration, doorRange, pujaRange, trayRange, returnSpotRange } = TUNING.homes;

const inside = (p: Vec3, b: Aabb, pad = 0) =>
  p.x > b.min.x - pad && p.x < b.max.x + pad && p.y > b.min.y - pad && p.y < b.max.y + pad && p.z > b.min.z - pad && p.z < b.max.z + pad;

/** Distance from `p` to the nearest point of `b` (0 inside). */
function distanceToBox(b: Aabb, p: Vec3): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const solidAt = (p: Vec3, pad = 0) => home.solids.find(({ box }) => inside(p, box, pad));
const anyBoxAt = (p: Vec3, pad = 0): InteriorBox | undefined =>
  solidAt(p, pad) ?? home.decor.find(({ box }) => inside(p, box, pad));
const byId = (id: string): InteriorBox | undefined => [...home.solids, ...home.decor].find((b) => b.id === id);

/** True when a standing capsule at `feet` overlaps no solid. */
function capsuleClear(feet: Vec3, slack = 0.05): boolean {
  for (const y of [PLAYER_RADIUS, 0.9, 1.75 - PLAYER_RADIUS]) {
    const centre = v(feet.x, feet.y + y, feet.z);
    for (const { box, kind } of home.solids) {
      if (kind === 'floor') continue;
      if (distanceToBox(box, centre) < PLAYER_RADIUS - slack) return false;
    }
  }
  return true;
}

function rangeFor(target: HomeInteractable): number {
  switch (target.kind) {
    case 'door':
      return doorRange;
    case 'puja':
      return pujaRange;
    case 'tray':
      return trayRange;
    case 'returnSpot':
      return Math.min(trayRange, returnSpotRange);
    case 'person':
      return TUNING.homes.personRange;
  }
}

describe('family home layout', () => {
  const anchor = HOME_ENTRANCES.familyHome.interior;

  it('is built round the interior door anchor the locations module uses', () => {
    expect(home.door).toEqual(anchor.door);
    expect(home.arrival).toEqual(anchor.arrival);
    const enter = homeDoorways().find((d) => d.id === doorwayId('familyHome', 'enter'))!;
    const exit = homeDoorways().find((d) => d.id === doorwayId('familyHome', 'exit'))!;
    expect(enter.arrival).toEqual(home.arrival);
    expect(exit.position).toEqual(home.door);
  });

  it('puts the arrival on the floor, clear of furniture and facing into the room', () => {
    const { position, yaw } = home.arrival;
    expect(inside(position, home.bounds)).toBe(true);
    expect(capsuleClear(position, -0.2)).toBe(true);
    const floor = home.solids.find((s) => s.walkable && inside(v(position.x, -0.1, position.z), s.box));
    expect(floor?.box.max.y).toBe(0);
    // Facing north, away from the door in the south wall.
    expect(yaw).toBe(0);
    expect(position.z).toBeLessThan(home.door.z);
  });

  it('lets the player reach the exit door from inside the room', () => {
    const southInner = home.door.z + FAMILY_ROOM.southZ;
    expect(southInner - PLAYER_RADIUS - home.door.z).toBeLessThan(doorRange);
  });

  it('keeps the room well apart from the street and the neighbour home', () => {
    const { min, max } = home.bounds;
    const street = world.bounds;
    expect(min.z > street.max.z || max.z < street.min.z || min.x > street.max.x || max.x < street.min.x).toBe(true);
    expect(inside(HOME_ENTRANCES.neighbourHome.interior.door, home.bounds, 10)).toBe(false);
  });

  it('encloses the room on every side, floor to ceiling', () => {
    const kinds = new Set(home.solids.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['floor', 'wall', 'ceiling', 'furniture']));
    const centre = v((home.bounds.min.x + home.bounds.max.x) / 2, 1.5, (home.bounds.min.z + home.bounds.max.z) / 2);
    const directions = [v(1, 0, 0), v(-1, 0, 0), v(0, 0, 1), v(0, 0, -1), v(0, 1, 0), v(0, -1, 0)];
    for (const d of directions) {
      let hit = false;
      for (let s = 0; s < 200 && !hit; s++) {
        const p = v(centre.x + d.x * s * 0.05, centre.y + d.y * s * 0.05, centre.z + d.z * s * 0.05);
        hit = home.solids.some((solid) => solid.kind !== 'furniture' && inside(p, solid.box));
      }
      expect(hit, JSON.stringify(d)).toBe(true);
    }
  });

  it('has a puja corner with chowki, thali, diyas, bell, idols and frame', () => {
    for (const id of ['puja.chowki', 'puja.mandir', 'puja.thali', 'puja.bell', 'puja.frame', 'puja.idol.0', 'puja.rangoli']) {
      expect(byId(id), id).toBeDefined();
    }
    const flames = home.decor.filter((d) => d.id.startsWith('puja.') && d.material === 'flame');
    expect(flames.length).toBeGreaterThanOrEqual(3);
    expect(inside(home.thali, byId('puja.chowki')!.box, 0.01)).toBe(true);
  });

  it('has a seating area with a sweets table, tray and a seat for each family member', () => {
    for (const id of ['sweets.table', 'sweets.tray', 'sweets.plateSpot', 'sofa.seat', 'armchair.seat', 'moodha']) {
      expect(byId(id), id).toBeDefined();
    }
    const furniture = home.solids.filter((s) => s.kind === 'furniture');
    for (const [member, seat] of Object.entries(home.seats)) {
      const under = furniture.find(({ box }) => inside(v(seat.position.x, box.max.y - 0.01, seat.position.z), box));
      expect(under, member).toBeDefined();
    }
    expect(inside(home.giftTable, byId('sweets.table')!.box, 0.01)).toBe(true);
  });

  it('gathers the family at the puja corner on open floor, facing the shrine', () => {
    const chowki = byId('puja.chowki')!.box;
    const shrine = v((chowki.min.x + chowki.max.x) / 2, 0, chowki.min.z);
    const stand = home.interactions.find((i) => i.target.kind === 'puja')!.stand.position;
    for (const [member, place] of Object.entries(home.gathering)) {
      expect(inside(place.position, home.bounds), member).toBe(true);
      expect(capsuleClear(place.position, 0.05), member).toBe(true);
      expect(flat(place.position, shrine), member).toBeLessThan(3.5);
      expect(flat(place.position, stand), member).toBeGreaterThan(0.6);
      expect(place.yaw).toBeCloseTo(facing(place.position, shrine));
    }
  });

  it('offers every interaction point from a walkable stand within range', () => {
    const kinds = home.interactions.map((i) => (i.target.kind === 'returnSpot' ? `return.${i.target.item}` : i.target.kind));
    expect(kinds.sort()).toEqual(['door', 'puja', 'return.giftBox', 'return.sweetsPlate', 'tray']);
    for (const { target, stand } of home.interactions) {
      expect(inside(stand.position, home.bounds), target.kind).toBe(true);
      expect(capsuleClear(stand.position), target.kind).toBe(true);
      expect(flat(stand.position, target.position), target.kind).toBeLessThan(rangeFor(target));
    }
  });

  it('marks every interaction point with a box that is never dropped on Low', () => {
    for (const { target, marker } of home.interactions) {
      const box = byId(marker);
      expect(box, `${target.kind} marker ${marker}`).toBeDefined();
      expect(box!.detail ?? false).toBe(false);
      expect(distanceToBox(box!.box, target.position), marker).toBeLessThan(1);
    }
  });

  it('has nothing the player can climb onto', () => {
    for (const solid of home.solids.filter((s) => s.kind === 'furniture')) {
      expect(solid.box.max.y, solid.id).toBeGreaterThan(maxStepHeight);
      expect(solid.walkable).toBe(false);
    }
  });

  it('keeps wall dressing thinner than the camera margin', () => {
    const walls = home.solids.filter((s) => s.kind === 'wall' || s.kind === 'ceiling');
    const onWalls = home.decor.filter((deco) =>
      walls.some((w) => distanceToBox(w.box, deco.box.min) < 0.01 || distanceToBox(w.box, deco.box.max) < 0.01),
    );
    expect(onWalls.length).toBeGreaterThan(10);
    for (const deco of onWalls) {
      const size = v(deco.box.max.x - deco.box.min.x, deco.box.max.y - deco.box.min.y, deco.box.max.z - deco.box.min.z);
      expect(Math.min(size.x, size.y, size.z), deco.id).toBeLessThanOrEqual(collisionMargin);
    }
  });

  it('uses only a few real lights, one of them on Low', () => {
    expect(home.lights.length).toBeLessThanOrEqual(3);
    for (const level of QUALITY_LEVELS) {
      const on = home.lights.filter((l) => lightOnAt(l.minLevel, level));
      expect(on.length, level).toBeGreaterThanOrEqual(1);
      expect(on.length, level).toBeLessThanOrEqual(qualityProfile(level).maxDynamicLights + 1);
    }
    for (const light of home.lights) expect(inside(light.position, home.bounds), light.id).toBe(true);
  });
});

describe('family home: walking in, around and out', () => {
  let physics: RAPIER.World;
  const players: PlayerController[] = [];

  beforeAll(async () => {
    await RAPIER.init();
    physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addWorldColliders(physics, world.solids);
    addInteriorColliders(physics, home);
    physics.step();
  });

  afterEach(() => {
    for (const player of players.splice(0)) player.dispose();
  });

  const street = HOME_ENTRANCES.familyHome.street.arrival;

  function setup(mode: CameraMode = 'firstPerson') {
    const player = new PlayerController({ physics, bounds: world.bounds, spawn: street.position, spawnYaw: street.yaw });
    players.push(player);
    const rig = new CameraRig({
      mode,
      spawnYaw: street.yaw,
      obstacles: rapierBoomCaster(physics, { margin: collisionMargin, exclude: player.collider }),
    });
    const bus = createGameEventBus();
    const locations = new Locations({
      bus,
      onArrive: (arrival, to) => {
        player.teleport(arrival, to === 'familyHome' ? home.bounds : world.bounds);
        rig.face(arrival.yaw);
      },
    });
    const idle = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        locations.update(STEP);
        player.move({ forward: 0, right: 0, run: false, yaw: rig.yaw }, STEP);
      }
    };
    const go = (doorway: string) => {
      expect(locations.requestTransition(doorway)).toEqual({ ok: true });
      idle(fadeDuration + STEP);
      expect(locations.transition).toBeNull();
    };
    /** Steer straight at `target`; true once within 0.15 m. */
    const walkTo = (target: Vec3, seconds = 8) => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        const p = player.pose.position;
        if (flat(p, target) < 0.15) return true;
        const yaw = facing(p, target);
        player.move({ forward: 1, right: 0, run: false, yaw }, STEP);
        expect(capsuleClear(player.pose.position), JSON.stringify(player.pose.position)).toBe(true);
      }
      return flat(player.pose.position, target) < 0.15;
    };
    return { player, rig, locations, idle, go, walkTo };
  }

  it('walks in through the door fade, visits every interaction point and walks out again', () => {
    const { player, rig, locations, go, walkTo } = setup();
    go(doorwayId('familyHome', 'enter'));
    expect(locations.location).toBe('familyHome');
    expect(flat(player.pose.position, home.arrival.position)).toBeLessThan(0.05);
    expect(rig.yaw).toBe(home.arrival.yaw);

    const stands = Object.fromEntries(
      home.interactions.map((i) => [i.target.kind === 'returnSpot' ? i.target.item : i.target.kind, i.stand.position]),
    );
    const route: Vec3[] = [
      v(-2.5, 0, 96), // up the room's west side
      stands.puja!,
      v(0.6, 0, 94.5),
      stands.tray!,
      v(1.2, 0, 97),
      stands.sweetsPlate!,
      v(0, 0, 98.5),
      stands.giftBox!,
      stands.door!,
    ];
    for (const waypoint of route) {
      expect(walkTo(waypoint), `reach ${JSON.stringify(waypoint)} from ${JSON.stringify(player.pose.position)}`).toBe(true);
      expect(player.pose.position.y).toBeCloseTo(0, 1);
    }
    expect(flat(player.pose.position, home.door)).toBeLessThan(doorRange);
    go(doorwayId('familyHome', 'exit'));
    expect(locations.location).toBe('outdoors');
    expect(flat(player.pose.position, street.position)).toBeLessThan(0.05);
    // Back on the street, under its bounds again: walking east down the lane works.
    for (let i = 0; i < 60; i++) player.move({ forward: 1, right: 0, run: false, yaw: street.yaw }, STEP);
    expect(player.pose.position.x).toBeGreaterThan(street.position.x + 1);
    expect(world.contains(player.pose.position)).toBe(true);
  });

  it('keeps the player inside when they run into each wall', () => {
    const { player, go } = setup();
    go(doorwayId('familyHome', 'enter'));
    const centre = v(-0.5, 0, 96);
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, (-3 * Math.PI) / 4]) {
      player.teleport({ position: centre, yaw }, home.bounds);
      for (let i = 0; i < 240; i++) {
        player.move({ forward: 1, right: 0, run: true, yaw }, STEP);
        expect(capsuleClear(player.pose.position)).toBe(true);
      }
      expect(inside(player.pose.position, home.bounds), `yaw ${yaw}`).toBe(true);
      expect(player.pose.position.y).toBeCloseTo(0, 1);
    }
  });

  it('never climbs or passes through furniture', () => {
    const { player, go } = setup();
    go(doorwayId('familyHome', 'enter'));
    const sofa = home.solids.find((s) => s.id === 'sofa.seat')!.box;
    const table = home.solids.find((s) => s.id === 'sweets.table')!.box;
    // Run east into the sofa, then into the sweets table.
    player.teleport({ position: v(3.2, 0, 95.6), yaw: -Math.PI / 2 }, home.bounds);
    for (let i = 0; i < 180; i++) player.move({ forward: 1, right: 0, run: true, yaw: -Math.PI / 2 }, STEP);
    expect(player.pose.position.x).toBeLessThan(sofa.min.x - PLAYER_RADIUS + 0.05);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
    player.teleport({ position: v(1.0, 0, 95.6), yaw: -Math.PI / 2 }, home.bounds);
    for (let i = 0; i < 180; i++) player.move({ forward: 1, right: 0, run: true, yaw: -Math.PI / 2 }, STEP);
    expect(player.pose.position.x).toBeLessThan(table.min.x - PLAYER_RADIUS + 0.05);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
  });

  it('stays in the room and on the floor through a long random walk', () => {
    const { player, go } = setup();
    go(doorwayId('familyHome', 'enter'));
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let intent = { forward: 1, right: 0, run: false, yaw: 0 };
    for (let i = 0; i < 60 * 60; i++) {
      if (i % 45 === 0) {
        intent = { forward: random() * 2 - 1, right: random() * 2 - 1, run: random() > 0.5, yaw: random() * 2 * Math.PI - Math.PI };
      }
      const pose = player.move(intent, STEP);
      expect(inside(pose.position, home.bounds)).toBe(true);
      expect(capsuleClear(pose.position)).toBe(true);
      expect(pose.position.y).toBeCloseTo(0, 1);
    }
  });

  describe('camera views indoors', () => {
    function expectClearView(view: CameraView, from: PlayerPose): void {
      const eye = v(from.position.x, from.position.y + eyeHeight, from.position.z);
      // The near plane must not reach into a wall, furniture or dressing.
      expect(anyBoxAt(view.position, 0.1)?.id, `camera at ${JSON.stringify(view.position)}`).toBeUndefined();
      for (let i = 1; i <= 40; i++) {
        const t = i / 40;
        const p = v(eye.x + (view.position.x - eye.x) * t, eye.y + (view.position.y - eye.y) * t, eye.z + (view.position.z - eye.z) * t);
        expect(solidAt(p)?.id, `boom crosses a solid at ${JSON.stringify(p)}`).toBeUndefined();
      }
    }

    const corners: Placement[] = [
      { position: v(-4.15, 0, 91.85), yaw: 0 },
      { position: v(4.15, 0, 100.15), yaw: Math.PI },
      { position: v(-4.15, 0, 100.15), yaw: Math.PI / 2 },
      { position: v(3.15, 0, 95), yaw: -Math.PI / 2 }, // between the table and the sofa
      { position: v(-0.3, 0, 92.0), yaw: 0 }, // by the mandir
    ];
    const spots: Placement[] = [home.arrival, ...home.interactions.map((i) => i.stand), ...corners];

    for (const mode of ['firstPerson', 'thirdPerson'] as CameraMode[]) {
      it(`keeps the ${mode} camera out of walls, furniture and dressing everywhere it looks`, () => {
        const { player, rig, go } = setup(mode);
        go(doorwayId('familyHome', 'enter'));
        expectClearView(rig.update(player.pose, STEP), player.pose);
        let shortened = 0;
        for (const spot of spots) {
          const pose = player.teleport(spot, home.bounds);
          expect(capsuleClear(pose.position), JSON.stringify(spot.position)).toBe(true);
          for (const pitch of [-pitchLimit, -0.6, -0.3, 0, 0.5, pitchLimit]) {
            for (let k = 0; k < 16; k++) {
              const yaw = (k / 16) * 2 * Math.PI - Math.PI;
              rig.look((rig.yaw - yaw) / rig.sensitivity, (rig.pitch - pitch) / rig.sensitivity);
              const view = rig.update(pose, STEP);
              expectClearView(view, pose);
              const eye = v(pose.position.x, pose.position.y + eyeHeight, pose.position.z);
              const boom = Math.hypot(view.position.x - eye.x, view.position.y - eye.y, view.position.z - eye.z);
              if (mode === 'firstPerson') expect(boom).toBeLessThan(1e-9);
              else if (boom < fullBoom - 0.05) shortened++;
            }
          }
        }
        // From these spots the third-person boom meets walls, furniture and the ceiling and pulls in.
        if (mode === 'thirdPerson') expect(shortened).toBeGreaterThan(100);
      });
    }

    it('keeps the camera clear while walking about in third person', () => {
      const { player, rig, go, walkTo } = setup('thirdPerson');
      go(doorwayId('familyHome', 'enter'));
      const tray = home.interactions.find((i) => i.target.kind === 'tray')!.stand.position;
      for (const target of [v(-2.5, 0, 96), v(0.6, 0, 94.5), tray, home.arrival.position]) {
        for (let i = 0; i < 240 && flat(player.pose.position, target) > 0.15; i++) {
          rig.look((rig.yaw - facing(player.pose.position, target)) / rig.sensitivity, 0);
          const pose = player.move({ forward: 1, right: 0, run: false, yaw: rig.yaw }, STEP);
          expectClearView(rig.update(pose, STEP), pose);
        }
        expect(walkTo(target, 1)).toBe(true);
      }
    });
  });

  it('returns to the street spawn and its bounds on a session reset from indoors', () => {
    const { player, rig, locations, go } = setup('thirdPerson');
    go(doorwayId('familyHome', 'enter'));
    locations.reset();
    player.reset();
    rig.reset();
    expect(locations.location).toBe('outdoors');
    expect(player.pose.position).toEqual(street.position);
    for (let i = 0; i < 30; i++) player.move({ forward: 1, right: 0, run: true, yaw: street.yaw }, STEP);
    expect(world.contains(player.pose.position)).toBe(true);
    expect(player.pose.position.x).toBeGreaterThan(street.position.x);
  });

  it('turns the view to the arrival facing, level, keeping the mode', () => {
    const { rig, go } = setup('thirdPerson');
    rig.look(-300, 200);
    go(doorwayId('familyHome', 'enter'));
    expect(rig.yaw).toBe(home.arrival.yaw);
    expect(rig.pitch).toBe(0);
    expect(rig.mode).toBe('thirdPerson');
  });
});

describe('player teleport and per-location bounds', () => {
  let physics: RAPIER.World;
  beforeAll(async () => {
    await RAPIER.init();
    physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addWorldColliders(physics, world.solids);
    addInteriorColliders(physics, home);
    physics.step();
  });

  it('places the player at rest and clamps to the new bounds', () => {
    const player = new PlayerController({ physics, bounds: world.bounds, spawn: world.spawn });
    for (let i = 0; i < 30; i++) player.move({ forward: 1, right: 0, run: true, yaw: 0 }, STEP);
    expect(player.speed).toBeGreaterThan(0);
    const pose = player.teleport(home.arrival, home.bounds);
    expect(pose.position).toEqual(home.arrival.position);
    expect(pose.yaw).toBe(home.arrival.yaw);
    expect(player.speed).toBe(0);
    // A street-bounds clamp would yank the player back towards z = 8; the room's does not.
    for (let i = 0; i < 30; i++) player.move({ forward: 0, right: 0, run: false, yaw: 0 }, STEP);
    expect(flat(player.pose.position, home.arrival.position)).toBeLessThan(0.05);
    player.dispose();
  });
});

describe('family home presentation', () => {
  const assets = new InteriorAssets();
  const interior = buildInteriorScene(home, assets);
  const meshesIn = (group: THREE.Object3D) =>
    group.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
  const core = meshesIn(interior.root);
  const detail = meshesIn(interior.detail);

  it('draws every solid and decor box exactly once, dressing apart', () => {
    const drawn = (meshes: THREE.InstancedMesh[]) => meshes.reduce((n, m) => n + m.count, 0);
    const dressing = home.decor.filter((d) => d.detail).length;
    expect(drawn(core)).toBe(home.solids.length + home.decor.length - dressing);
    expect(drawn(detail)).toBe(dressing);
    expect(dressing).toBeGreaterThan(0);
  });

  it('batches the room into a few dozen draw calls over one shared geometry', () => {
    const all = [...core, ...detail];
    expect(new Set(all.map((m) => m.geometry))).toEqual(new Set([assets.geometry]));
    expect(new Set(core.map((m) => m.material)).size).toBe(core.length);
    expect(all.length).toBeLessThanOrEqual(Object.keys(INTERIOR_MATERIALS).length * 2);
    expect(all.length).toBeLessThan(45);
  });

  it('shares materials between homes rather than duplicating them', () => {
    const before = assets.materialCount;
    const again = buildInteriorScene(home, assets);
    expect(assets.materialCount).toBe(before);
    const materials = (root: THREE.Object3D) => {
      const set = new Set<THREE.Material>();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) set.add(o.material as THREE.Material);
      });
      return set;
    };
    expect(materials(again.root)).toEqual(materials(interior.root));
  });

  it('keeps every interaction point drawn and lit on Low, dropping only dressing and extra lights', () => {
    interior.applyQuality(qualityProfile('low'));
    expect(interior.detail.visible).toBe(false);
    expect(interior.activeLights).toBe(1);
    const fill = interior.root.children.find((c) => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight;
    expect(fill.visible).toBe(true);
    expect(fill.intensity).toBeGreaterThanOrEqual(1);
    const coreMaterials = new Set(core.map((m) => m.name.split('.').pop()));
    for (const { marker } of home.interactions) {
      const box = byId(marker)!;
      expect(coreMaterials.has(box.material), marker).toBe(true);
    }
    // Flames glow by emission, at every level.
    expect(assets.material('flame').emissiveIntensity).toBeGreaterThan(1);
    interior.applyQuality(qualityProfile('medium'));
    expect(interior.detail.visible).toBe(true);
    expect(interior.activeLights).toBe(2);
    interior.applyQuality(qualityProfile('high'));
    expect(interior.activeLights).toBe(3);
  });

  it('flickers the flames gently around their base glow', () => {
    const base = INTERIOR_MATERIALS.flame.emissiveIntensity!;
    for (let t = 0; t < 10; t += 0.07) {
      expect(flicker(t)).toBeGreaterThan(0.8);
      expect(flicker(t)).toBeLessThan(1.2);
    }
    interior.frame(0.5);
    const glow = assets.material('flame').emissiveIntensity;
    expect(glow).toBeGreaterThan(base * 0.8);
    expect(glow).toBeLessThan(base * 1.2);
    interior.frame(0);
    expect(assets.material('flame').emissiveIntensity).toBe(glow);
  });
});

describe('location presenter', () => {
  function setup() {
    const scene = new THREE.Scene();
    const street = new THREE.Group();
    street.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture() })));
    const sky = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    const moon = new THREE.DirectionalLight();
    scene.add(street, sky, moon);
    const body = new THREE.Group();
    scene.add(body);
    const assets = new InteriorAssets();
    const interior = buildInteriorScene(home, assets);
    scene.add(interior.root);
    const fades: number[] = [];
    const presenter = new LocationPresenter({
      outdoor: [street, sky, moon],
      interiors: [interior],
      profile: qualityProfile('low'),
      fade: (o) => fades.push(o),
    });
    return { scene, street, sky, moon, body, interior, assets, presenter, fades };
  }

  /** Every GPU-backed resource reachable from the scene. */
  function resources(scene: THREE.Scene) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    let objects = 0;
    scene.traverse((o) => {
      objects++;
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        const material = o.material as THREE.MeshStandardMaterial;
        materials.add(material);
        if (material.map) textures.add(material.map);
      }
    });
    return { objects, geometries: geometries.size, materials: materials.size, textures: textures.size };
  }

  /** Objects the renderer would draw: visible all the way up. */
  function drawn(scene: THREE.Scene): Set<THREE.Object3D> {
    const out = new Set<THREE.Object3D>();
    scene.traverseVisible((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Light) out.add(o);
    });
    return out;
  }

  it('starts outdoors, drawing the street and no interior', () => {
    const { scene, street, interior, presenter } = setup();
    expect(presenter.active).toBe('outdoors');
    expect(interior.root.visible).toBe(false);
    expect(drawn(scene).has(street.children[0]!)).toBe(true);
    expect(presenter.stats).toMatchObject({ visibleInteriors: 0, interiorLights: 0, switches: 0 });
  });

  it('draws only the family home while inside, and the player body either way', () => {
    const { scene, street, sky, moon, body, interior, presenter } = setup();
    presenter.activate('familyHome');
    const shown = drawn(scene);
    for (const object of [street.children[0]!, sky, moon]) expect(shown.has(object)).toBe(false);
    expect(interior.root.visible).toBe(true);
    expect(body.visible).toBe(true);
    expect(presenter.stats).toMatchObject({ active: 'familyHome', visibleInteriors: 1, interiorLights: 1, switches: 1 });
    presenter.activate('outdoors');
    expect(drawn(scene).has(street.children[0]!)).toBe(true);
    expect(interior.root.visible).toBe(false);
  });

  it('does not grow geometry, material, texture or object counts over repeated visits', () => {
    const { scene, assets, presenter } = setup();
    const before = resources(scene);
    const materialCount = assets.materialCount;
    for (let i = 0; i < 50; i++) {
      presenter.activate('familyHome');
      presenter.frame(1 / 60);
      presenter.activate('outdoors');
    }
    expect(resources(scene)).toEqual(before);
    expect(assets.materialCount).toBe(materialCount);
    expect(presenter.stats.switches).toBe(100);
  });

  it('ignores re-activating the shown location', () => {
    const { presenter } = setup();
    for (let i = 0; i < 5; i++) presenter.activate('outdoors');
    expect(presenter.stats.switches).toBe(0);
  });

  it('shows the street for a home with no interior built yet', () => {
    const { presenter, street } = setup();
    expect(presenter.has('familyHome')).toBe(true);
    expect(presenter.has('neighbourHome')).toBe(false);
    presenter.activate('neighbourHome');
    expect(presenter.stats.visibleInteriors).toBe(0);
    expect(street.visible).toBe(false);
  });

  it('preloads the street and each interior and puts the shown location back', () => {
    const { presenter, interior, street } = setup();
    presenter.activate('familyHome');
    const seen: { location: string; visible: boolean; street: boolean }[] = [];
    presenter.preload((l) => seen.push({ location: l, visible: interior.root.visible, street: street.visible }));
    expect(seen).toEqual([
      { location: 'outdoors', visible: false, street: true },
      { location: 'familyHome', visible: true, street: false },
    ]);
    expect(interior.root.visible).toBe(true);
    expect(street.visible).toBe(false);
    expect(presenter.stats.switches).toBe(1);
    presenter.activate('outdoors');
    presenter.preload(() => undefined);
    expect(interior.root.visible).toBe(false);
    expect(street.visible).toBe(true);
    // Only the two real visits count.
    expect(presenter.stats.switches).toBe(2);
  });

  it('forwards the door fade and quality changes', () => {
    const { presenter, interior, fades } = setup();
    presenter.setFade(0.5);
    presenter.setFade(0);
    expect(fades).toEqual([0.5, 0]);
    presenter.applyQuality(qualityProfile('high'));
    expect(interior.activeLights).toBe(3);
    expect(interior.detail.visible).toBe(true);
  });
});

describe('family home spots for interaction routing', () => {
  const spots = familyHomeSpots(home);
  const doorways = homeDoorways().filter((d) => d.location === 'familyHome');
  const at = (kind: HomeInteractable['kind']) => home.interactions.find((i) => i.target.kind === kind)!;

  function interactionAt(feet: Vec3) {
    return new Interaction({
      world,
      playerPosition: () => feet,
      location: () => 'familyHome',
      doorways: () => doorways,
      spots: { ...HOME_SPOTS, familyHome: spots },
    });
  }

  const viewFrom = ({ position, yaw }: Placement): CameraView => ({
    mode: 'firstPerson',
    position: v(position.x, position.y + eyeHeight, position.z),
    forward: v(-Math.sin(yaw), 0, -Math.cos(yaw)),
    yaw,
    pitch: 0,
  });

  it('takes the puja, tray and gift spots from the built room', () => {
    expect(spots.puja).toEqual(at('puja').stand.position);
    expect(spots.tray).toEqual(at('tray').target.position);
    const gift = home.interactions.find((i) => i.target.kind === 'returnSpot' && i.target.item === 'giftBox')!;
    expect(spots.giftSpot).toEqual(gift.target.position);
  });

  for (const kind of ['puja', 'tray', 'door'] as const) {
    it(`offers the ${kind} from its stand in the room`, () => {
      const { stand } = at(kind);
      expect(interactionAt(stand.position).findInteractable(viewFrom(stand))).toMatchObject({ kind });
    });
  }
});
