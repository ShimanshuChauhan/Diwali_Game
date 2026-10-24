import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CameraView, PlayerPose } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { NEIGHBOUR_HOSTS, type HomeInteractable, type LocationId, type Placement } from '../src/core/homes';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import type { Aabb, CameraMode, Vec3 } from '../src/core/types';
import { CameraRig, rapierBoomCaster } from '../src/camera';
import { doorwayId, HOME_ENTRANCES, homeDoorways, Locations } from '../src/homes';
import { HouseholdScene, NeighbourHosts } from '../src/household';
import { HOME_SPOTS, Interaction } from '../src/interaction';
import {
  addInteriorColliders,
  buildInteriorScene,
  createFamilyHomeLayout,
  createNeighbourHomeLayout,
  facing,
  INTERIOR_MATERIALS,
  InteriorAssets,
  lightOnAt,
  LocationPresenter,
  NEIGHBOUR_ROOM,
  neighbourHomeSpots,
  type InteriorBox,
} from '../src/interior';
import { PLAYER_RADIUS, PlayerController } from '../src/player';
import { createWorld } from '../src/world';
import { addWorldColliders } from '../src/world/colliders';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const world = createWorld();
const home = createNeighbourHomeLayout();
const familyHome = createFamilyHomeLayout();
const { eyeHeight, maxStepHeight } = TUNING.player;
const { collisionMargin, pitchLimit, thirdPersonDistance, thirdPersonHeight } = TUNING.camera;
const fullBoom = Math.hypot(thirdPersonDistance, thirdPersonHeight - eyeHeight);
const { fadeDuration, doorRange, trayRange, returnSpotRange, personRange } = TUNING.homes;

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
/** Room-local (from the interior door) → world. */
const local = (x: number, z: number) => v(home.door.x + x, 0, home.door.z + z);

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
    case 'tray':
      return trayRange;
    case 'returnSpot':
      return returnSpotRange;
    case 'person':
      return personRange;
    case 'puja':
      return 0;
  }
}

describe('neighbour home layout', () => {
  const anchor = HOME_ENTRANCES.neighbourHome.interior;

  it('is built round the interior door anchor the locations module uses', () => {
    expect(home.home).toBe('neighbourHome');
    expect(home.door).toEqual(anchor.door);
    expect(home.arrival).toEqual(anchor.arrival);
    const enter = homeDoorways().find((d) => d.id === doorwayId('neighbourHome', 'enter'))!;
    const exit = homeDoorways().find((d) => d.id === doorwayId('neighbourHome', 'exit'))!;
    expect(enter.arrival).toEqual(home.arrival);
    expect(exit.position).toEqual(home.door);
  });

  it('puts the arrival on the floor, clear of furniture and facing into the room', () => {
    const { position, yaw } = home.arrival;
    expect(inside(position, home.bounds)).toBe(true);
    expect(capsuleClear(position, -0.2)).toBe(true);
    const floor = home.solids.find((s) => s.walkable && inside(v(position.x, -0.1, position.z), s.box));
    expect(floor?.box.max.y).toBe(0);
    expect(yaw).toBe(0);
    expect(position.z).toBeLessThan(home.door.z);
  });

  it('lets the player reach the exit door from inside the room', () => {
    const southInner = home.door.z + NEIGHBOUR_ROOM.southZ;
    expect(southInner - PLAYER_RADIUS - home.door.z).toBeLessThan(doorRange);
  });

  it('keeps the room apart from the street and from the family home', () => {
    const { min, max } = home.bounds;
    const street = world.bounds;
    expect(min.z > street.max.z || max.z < street.min.z || min.x > street.max.x || max.x < street.min.x).toBe(true);
    const f = familyHome.bounds;
    // Far enough apart that neither room's third-person boom or light reaches the other.
    expect(min.x - f.max.x).toBeGreaterThan(20);
  });

  it('encloses the room on every side, floor to ceiling', () => {
    const kinds = new Set(home.solids.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['floor', 'wall', 'ceiling', 'furniture']));
    const centre = v((home.bounds.min.x + home.bounds.max.x) / 2, 1.5, (home.bounds.min.z + home.bounds.max.z) / 2);
    for (const d of [v(1, 0, 0), v(-1, 0, 0), v(0, 0, 1), v(0, 0, -1), v(0, 1, 0), v(0, -1, 0)]) {
      let hit = false;
      for (let s = 0; s < 200 && !hit; s++) {
        const p = v(centre.x + d.x * s * 0.05, centre.y + d.y * s * 0.05, centre.z + d.z * s * 0.05);
        hit = home.solids.some((solid) => solid.kind !== 'furniture' && inside(p, solid.box));
      }
      expect(hit, JSON.stringify(d)).toBe(true);
    }
  });

  it('has a greeting area at the door: rangoli, toran, shoe rack, Ganesh ji and a divan', () => {
    for (const id of ['door', 'door.toran', 'greeting.rangoli', 'greeting.shoeRack', 'greeting.frame', 'divan.seat']) {
      expect(byId(id), id).toBeDefined();
    }
    // The rangoli lies between the arrival and Uncle.
    const rangoli = byId('greeting.rangoli')!.box;
    const middle = v((rangoli.min.x + rangoli.max.x) / 2, 0, (rangoli.min.z + rangoli.max.z) / 2);
    expect(middle.z).toBeLessThan(home.arrival.position.z);
    expect(middle.z).toBeGreaterThan(home.hosts.uncle.position.z);
  });

  it('has a sweets area: a table laid with a tray of mithai and boxes of more', () => {
    for (const id of ['sweets.table', 'sweets.tray', 'sweets.box.0', 'sweets.chair.0']) expect(byId(id), id).toBeDefined();
    const table = byId('sweets.table')!.box;
    const pieces = home.decor.filter((d) => d.id.startsWith('sweets.piece.'));
    expect(pieces.length).toBeGreaterThanOrEqual(4);
    for (const piece of pieces) expect(piece.box.min.y).toBeCloseTo(byId('sweets.tray')!.box.max.y);
    const tray = home.interactions.find((i) => i.target.kind === 'tray')!;
    expect(inside(v(tray.target.position.x, table.max.y - 0.01, tray.target.position.z), table)).toBe(true);
  });

  it('stands Uncle in the greeting area and Aunty by the sweets, on open floor, facing the arrival', () => {
    const table = byId('sweets.table')!.box;
    expect(home.hosts.uncle.position.z).toBeGreaterThan(table.max.z);
    expect(flat(home.hosts.aunty.position, v((table.min.x + table.max.x) / 2, 0, (table.min.z + table.max.z) / 2))).toBeLessThan(2);
    for (const id of NEIGHBOUR_HOSTS) {
      const place = home.hosts[id];
      expect(inside(place.position, home.bounds), id).toBe(true);
      expect(capsuleClear(place.position), id).toBe(true);
      expect(place.yaw, id).toBeCloseTo(facing(place.position, home.arrival.position));
      // Close enough to recognise the player as they come in, without blocking the doorway.
      expect(flat(place.position, home.arrival.position), id).toBeLessThan(4);
      expect(flat(place.position, home.arrival.position), id).toBeGreaterThan(1);
    }
  });

  it('offers every interaction point from a walkable stand within range', () => {
    const kinds = home.interactions.map((i) => (i.target.kind === 'person' ? `person.${i.target.id}` : i.target.kind));
    expect(kinds.sort()).toEqual(['door', 'person.aunty', 'person.uncle', 'returnSpot', 'tray']);
    for (const { target, stand } of home.interactions) {
      expect(inside(stand.position, home.bounds), target.kind).toBe(true);
      expect(capsuleClear(stand.position), target.kind).toBe(true);
      expect(flat(stand.position, target.position), target.kind).toBeLessThan(rangeFor(target));
    }
    const spot = home.interactions.find((i) => i.target.kind === 'returnSpot')!.target;
    expect(spot).toMatchObject({ id: 'giftBox@neighbourHome', item: 'giftBox', home: 'neighbourHome' });
    expect(spot.position).toEqual(home.giftSpot);
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

  it('reuses the family home materials rather than adding its own', () => {
    const family = new Set([...familyHome.solids, ...familyHome.decor].map((b) => b.material));
    for (const b of [...home.solids, ...home.decor]) expect(family.has(b.material), `${b.id}: ${b.material}`).toBe(true);
  });
});

describe('neighbour home: walking in, around and out', () => {
  let physics: RAPIER.World;
  const players: PlayerController[] = [];
  const bounds: Record<LocationId, Aabb> = {
    outdoors: world.bounds,
    familyHome: familyHome.bounds,
    neighbourHome: home.bounds,
  };

  beforeAll(async () => {
    await RAPIER.init();
    physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addWorldColliders(physics, world.solids);
    addInteriorColliders(physics, familyHome);
    addInteriorColliders(physics, home);
    physics.step();
  });

  afterEach(() => {
    for (const player of players.splice(0)) player.dispose();
  });

  const street = HOME_ENTRANCES.neighbourHome.street.arrival;

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
        player.teleport(arrival, bounds[to]);
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
        player.move({ forward: 1, right: 0, run: false, yaw: facing(p, target) }, STEP);
        expect(capsuleClear(player.pose.position), JSON.stringify(player.pose.position)).toBe(true);
      }
      return flat(player.pose.position, target) < 0.15;
    };
    return { player, rig, locations, idle, go, walkTo };
  }

  const stand = (match: (t: HomeInteractable) => boolean) => home.interactions.find((i) => match(i.target))!.stand.position;

  it('walks in through the door fade, visits both hosts, the mithai and the gift console, and walks out again', () => {
    const { player, rig, locations, go, walkTo } = setup();
    go(doorwayId('neighbourHome', 'enter'));
    expect(locations.location).toBe('neighbourHome');
    expect(flat(player.pose.position, home.arrival.position)).toBeLessThan(0.05);
    expect(rig.yaw).toBe(home.arrival.yaw);

    const route: Vec3[] = [
      stand((t) => t.kind === 'person' && t.id === 'uncle'),
      local(0.2, -3.0),
      stand((t) => t.kind === 'person' && t.id === 'aunty'),
      local(0.4, -4.4),
      stand((t) => t.kind === 'tray'),
      local(0.6, -3.0),
      local(2.6, -2.2),
      stand((t) => t.kind === 'returnSpot'),
      stand((t) => t.kind === 'door'),
    ];
    for (const waypoint of route) {
      expect(walkTo(waypoint), `reach ${JSON.stringify(waypoint)} from ${JSON.stringify(player.pose.position)}`).toBe(true);
      expect(player.pose.position.y).toBeCloseTo(0, 1);
    }
    expect(flat(player.pose.position, home.door)).toBeLessThan(doorRange);
    go(doorwayId('neighbourHome', 'exit'));
    expect(locations.location).toBe('outdoors');
    expect(flat(player.pose.position, street.position)).toBeLessThan(0.05);
    // Back under the street's bounds: walking down the lane works.
    for (let i = 0; i < 60; i++) player.move({ forward: 1, right: 0, run: false, yaw: street.yaw }, STEP);
    expect(player.pose.position.x).toBeLessThan(street.position.x - 1);
    expect(world.contains(player.pose.position)).toBe(true);
  });

  it('visits as often as the player likes, arriving at the same pose each time', () => {
    const { player, locations, go } = setup();
    for (let visit = 0; visit < 5; visit++) {
      go(doorwayId('neighbourHome', 'enter'));
      expect(locations.location).toBe('neighbourHome');
      expect(flat(player.pose.position, home.arrival.position)).toBeLessThan(0.05);
      go(doorwayId('neighbourHome', 'exit'));
      expect(locations.location).toBe('outdoors');
      expect(flat(player.pose.position, street.position)).toBeLessThan(0.05);
    }
  });

  it('keeps the player inside when they run into each wall', () => {
    const { player, go } = setup();
    go(doorwayId('neighbourHome', 'enter'));
    const centre = local(0, -3.6);
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

  it('never climbs or passes through the mithai table or the divan', () => {
    const { player, go } = setup();
    go(doorwayId('neighbourHome', 'enter'));
    const table = byId('sweets.table')!.box;
    const divan = byId('divan.seat')!.box;
    player.teleport({ position: local(0.2, -5.4), yaw: -Math.PI / 2 }, home.bounds);
    for (let i = 0; i < 180; i++) player.move({ forward: 1, right: 0, run: true, yaw: -Math.PI / 2 }, STEP);
    expect(player.pose.position.x).toBeLessThan(table.min.x - PLAYER_RADIUS + 0.05);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
    player.teleport({ position: local(-1.0, -4.0), yaw: Math.PI / 2 }, home.bounds);
    for (let i = 0; i < 180; i++) player.move({ forward: 1, right: 0, run: true, yaw: Math.PI / 2 }, STEP);
    expect(player.pose.position.x).toBeGreaterThan(divan.max.x + PLAYER_RADIUS - 0.05);
    expect(player.pose.position.y).toBeCloseTo(0, 1);
  });

  it('stays in the room and on the floor through a long random walk', () => {
    const { player, go } = setup();
    go(doorwayId('neighbourHome', 'enter'));
    let seed = 11;
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
      expect(anyBoxAt(view.position, 0.1)?.id, `camera at ${JSON.stringify(view.position)}`).toBeUndefined();
      for (let i = 1; i <= 40; i++) {
        const t = i / 40;
        const p = v(eye.x + (view.position.x - eye.x) * t, eye.y + (view.position.y - eye.y) * t, eye.z + (view.position.z - eye.z) * t);
        expect(solidAt(p)?.id, `boom crosses a solid at ${JSON.stringify(p)}`).toBeUndefined();
      }
    }

    const corners: Placement[] = [
      { position: local(-3.65, -7.15), yaw: 0 },
      { position: local(3.65, 0.15), yaw: Math.PI },
      { position: local(-3.0, 0.15), yaw: Math.PI / 2 },
      { position: local(3.65, -7.15), yaw: -Math.PI / 2 },
      { position: local(3.3, -5.4), yaw: Math.PI / 2 }, // between the table and the east wall
      { position: local(-2.9, -5.15), yaw: 0 }, // between the divan and its table
    ];
    const spots: Placement[] = [home.arrival, ...home.interactions.map((i) => i.stand), ...corners];

    for (const mode of ['firstPerson', 'thirdPerson'] as CameraMode[]) {
      it(`keeps the ${mode} camera out of walls, furniture and dressing everywhere it looks`, () => {
        const { player, rig, go } = setup(mode);
        go(doorwayId('neighbourHome', 'enter'));
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
        if (mode === 'thirdPerson') expect(shortened).toBeGreaterThan(100);
      });
    }
  });

  it('turns the view to the arrival facing, level, keeping the mode', () => {
    const { rig, go } = setup('thirdPerson');
    rig.look(-300, 200);
    go(doorwayId('neighbourHome', 'enter'));
    expect(rig.yaw).toBe(home.arrival.yaw);
    expect(rig.pitch).toBe(0);
    expect(rig.mode).toBe('thirdPerson');
  });
});

describe('neighbour home presentation', () => {
  const assets = new InteriorAssets();
  const family = buildInteriorScene(familyHome, assets);
  const materialsAfterFamily = assets.materialCount;
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

  it('adds no geometry or materials beyond the family home’s', () => {
    expect(assets.materialCount).toBe(materialsAfterFamily);
    const all = [...core, ...detail];
    expect(new Set(all.map((m) => m.geometry))).toEqual(new Set([assets.geometry]));
    expect(all.length).toBeLessThanOrEqual(Object.keys(INTERIOR_MATERIALS).length * 2);
    expect(all.length).toBeLessThan(45);
  });

  it('keeps every interaction point drawn and lit on Low, dropping only dressing and extra lights', () => {
    interior.applyQuality(qualityProfile('low'));
    expect(interior.detail.visible).toBe(false);
    expect(interior.activeLights).toBe(1);
    const coreMaterials = new Set(core.map((m) => m.name.split('.').pop()));
    for (const { marker } of home.interactions) expect(coreMaterials.has(byId(marker)!.material), marker).toBe(true);
    interior.applyQuality(qualityProfile('medium'));
    expect(interior.activeLights).toBe(2);
    interior.applyQuality(qualityProfile('high'));
    expect(interior.activeLights).toBe(3);
  });

  it('draws only the neighbour home while there, with Uncle and Aunty inside it', () => {
    const scene = new THREE.Scene();
    const street = new THREE.Group();
    street.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    scene.add(street, family.root, interior.root);
    const bus = createGameEventBus();
    const hosts = new NeighbourHosts({ bus, layout: home });
    const figures = new HouseholdScene({ household: hosts, layout: home, parent: interior.root, assets });
    const presenter = new LocationPresenter({ outdoor: [street], interiors: [family, interior], profile: qualityProfile('low') });
    expect(presenter.has('neighbourHome')).toBe(true);

    presenter.activate('neighbourHome');
    expect(interior.root.visible).toBe(true);
    expect(family.root.visible).toBe(false);
    expect(street.visible).toBe(false);
    expect(presenter.stats).toMatchObject({ active: 'neighbourHome', visibleInteriors: 1, interiorLights: 1 });
    for (const id of NEIGHBOUR_HOSTS) {
      const figure = interior.root.getObjectByName(`household.${id}`)!;
      expect(figure, id).toBeDefined();
      figures.frame(0.1, home.arrival.position);
      expect(flat(figure.position, home.hosts[id].position), id).toBeLessThan(1e-6);
    }

    presenter.activate('familyHome');
    expect(interior.root.visible).toBe(false);
    presenter.activate('outdoors');
    expect(street.visible).toBe(true);
    expect(interior.root.visible).toBe(false);
    figures.dispose();
    hosts.dispose();
  });
});

describe('neighbour home spots for interaction routing', () => {
  const spots = neighbourHomeSpots(home);
  const doorways = homeDoorways().filter((d) => d.location === 'neighbourHome');
  const bus = createGameEventBus();
  const hosts = new NeighbourHosts({ bus, layout: home });

  function interactionAt(feet: Vec3) {
    return new Interaction({
      world,
      playerPosition: () => feet,
      location: () => 'neighbourHome',
      doorways: () => doorways,
      members: () => hosts.members(),
      gifts: () => [{ id: 'return', place: { kind: 'spot', home: 'neighbourHome' } }],
      spots: { ...HOME_SPOTS, neighbourHome: spots },
    });
  }

  const viewFrom = ({ position, yaw }: Placement): CameraView => ({
    mode: 'firstPerson',
    position: v(position.x, position.y + eyeHeight, position.z),
    forward: v(-Math.sin(yaw), 0, -Math.cos(yaw)),
    yaw,
    pitch: 0,
  });

  it('takes the mithai table and the gift console from the built room; there is no puja next door', () => {
    expect(spots.puja).toBeUndefined();
    expect(spots.tray).toEqual(home.interactions.find((i) => i.target.kind === 'tray')!.target.position);
    expect(spots.giftSpot).toEqual(home.giftSpot);
  });

  for (const { target, stand } of home.interactions) {
    const name = target.kind === 'person' ? target.id : target.kind;
    it(`offers the ${name} from its stand in the room`, () => {
      expect(interactionAt(stand.position).findInteractable(viewFrom(stand))).toMatchObject({ kind: target.kind, id: target.id });
    });
  }

  it('lets the player greet Uncle straight from the arrival', () => {
    expect(interactionAt(home.arrival.position).findInteractable(viewFrom(home.arrival))).toMatchObject({
      kind: 'person',
      id: 'uncle',
    });
  });
});
