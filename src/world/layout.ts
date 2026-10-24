import type { DiyaSite } from '../core/contracts';
import type { Aabb, ExclusionZone, Vec3 } from '../core/types';

/**
 * The prototype map as plain data: a residential lane opening onto a
 * courtyard, colourful houses with balconies and (non-enterable) doorways,
 * and one low house whose rooftop is reached by an outdoor staircase.
 *
 * Everything is an axis-aligned box, so the same data drives the Three.js
 * meshes, the Rapier colliders and the headless world queries. No Three.js or
 * Rapier imports here.
 *
 * Coordinates: metres, Y up. The lane runs along Z; the player spawns at its
 * south end looking north (-Z) towards the courtyard.
 *
 *            z = -42 ┌──────── north houses ────────┐
 *            z = -36 ├──┬──────────────────────┬────┤
 *                    │W │      courtyard       │ E  │ ← rooftop house,
 *                    │  │                    ▤ │    │   stairs ▤ on its
 *            z = -20 ├──┴───────┬──────┬───────┴────┤   west wall
 *                    │  lane    │ lane │   lane     │
 *                    │  houses  │      │   houses   │
 *            z =   8 └──────────┴──────┴────────────┘
 *                  x = -18   -4      4           18
 */

/** What a solid is, for colliders, placement rules and tests. */
export type SolidKind =
  | 'ground'
  | 'house'
  | 'wall'
  | 'balcony'
  | 'railing'
  | 'stair'
  | 'landing'
  | 'rooftop'
  | 'prop'
  | 'boundary';

/** Shared materials; meshes with the same key share one material. */
export type MaterialKey =
  | 'laneStone'
  | 'courtyardTile'
  | 'outerGround'
  | 'stairStone'
  | 'roofTerrace'
  | 'compoundWall'
  | 'railing'
  | 'slab'
  | 'door'
  | 'toran'
  | 'window'
  | 'lantern'
  | 'bulbWarm'
  | 'bulbPink'
  | 'bulbGreen'
  | 'platform'
  | HouseColour;

export const HOUSE_COLOURS = [
  'housePink',
  'houseTurquoise',
  'houseSaffron',
  'houseLime',
  'houseLavender',
  'houseOchre',
  'houseCoral',
  'houseSky',
] as const;
export type HouseColour = (typeof HOUSE_COLOURS)[number];

export interface WorldBox {
  readonly id: string;
  readonly box: Aabb;
  readonly material: MaterialKey;
}

/** A box with a collider. */
export interface Solid extends WorldBox {
  readonly kind: SolidKind;
  /** False for invisible boundaries. */
  readonly visible: boolean;
  /** Its top face is somewhere the player can stand. */
  readonly walkable: boolean;
  /** Its top face can hold a ground cracker. */
  readonly supportsPlacement: boolean;
}

/** A warm point light standing in for a lantern or bulb. */
export interface PracticalLight {
  readonly id: string;
  readonly position: Vec3;
  readonly colour: string;
  readonly intensity: number;
  readonly distance: number;
}

export interface WorldLayout {
  /** Region the player is kept inside; invisible boundary walls line it. */
  readonly bounds: Aabb;
  readonly spawn: Vec3;
  /** Facing at spawn in radians about +Y; 0 looks down -Z. */
  readonly spawnYaw: number;
  readonly solids: readonly Solid[];
  /** Visual-only boxes: doors, windows, torans, bulbs, distant ground. */
  readonly decor: readonly WorldBox[];
  readonly doorways: readonly ExclusionZone[];
  readonly diyaSites: readonly DiyaSite[];
  readonly neighbourAreas: readonly ExclusionZone[];
  readonly lights: readonly PracticalLight[];
}

/** Dimensions shared by the layout and its tests. */
export const LAYOUT = {
  laneHalfWidth: 4,
  laneSouthZ: 8,
  courtyardSouthZ: -20,
  courtyardNorthZ: -36,
  courtyardHalfWidth: 12,
  rooftopHouse: { minX: 12, maxX: 18, minZ: -36, maxZ: -20 },
  rooftopHeight: 4,
  stair: {
    /** Inner edge against the rooftop house's west wall. */
    x: 12,
    width: 1.2,
    /** South edge of the first step. */
    startZ: -22,
    rise: 0.2,
    tread: 0.3,
    /** Steps below the landing; the landing is the last rise. */
    steps: 19,
    landingDepth: 1.5,
  },
  railingHeight: 1,
  railingThickness: 0.1,
  boundaryHeight: 14,
  doorWidth: 1.2,
  doorHeight: 2.2,
  doorwayRadius: 1.2,
} as const;

const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb => ({
  min: { x: minX, y: minY, z: minZ },
  max: { x: maxX, y: maxY, z: maxZ },
});

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Which way a facade faces, as a unit step on the ground plane. */
type Facing = '+x' | '-x' | '+z' | '-z';

interface HouseSpec {
  readonly id: string;
  /** Footprint on the ground. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly height: number;
  readonly colour: HouseColour;
  /** Side facing the lane or courtyard; holds the door and balcony. */
  readonly facing: Facing;
  /** Door centre along the facade; defaults to the facade's middle. */
  readonly doorAt?: number;
  readonly balcony: boolean;
  /** Contrasting roofline band; off where stairs run up the wall. */
  readonly band?: boolean;
}

class LayoutBuilder {
  readonly solids: Solid[] = [];
  readonly decor: WorldBox[] = [];
  readonly doorways: ExclusionZone[] = [];
  readonly diyaSites: DiyaSite[] = [];
  readonly lights: PracticalLight[] = [];

  solid(
    id: string,
    kind: SolidKind,
    b: Aabb,
    material: MaterialKey,
    flags: { walkable?: boolean; supportsPlacement?: boolean; visible?: boolean } = {},
  ): void {
    this.solids.push({
      id,
      kind,
      box: b,
      material,
      visible: flags.visible ?? true,
      walkable: flags.walkable ?? false,
      supportsPlacement: flags.supportsPlacement ?? false,
    });
  }

  deco(id: string, b: Aabb, material: MaterialKey): void {
    this.decor.push({ id, box: b, material });
  }

  diya(id: string, position: Vec3): void {
    this.diyaSites.push({ id, position });
  }

  light(id: string, position: Vec3, colour = '#ffb35c', intensity = 18, distance = 14): void {
    this.lights.push({ id, position, colour, intensity, distance });
  }

  /**
   * A solid house with a door, torans, windows, two diyas at the door and,
   * optionally, a railed balcony above it. Doors are decoration: houses are
   * not enterable.
   */
  house(spec: HouseSpec): void {
    const { id, minX, maxX, minZ, maxZ, height, colour, facing } = spec;
    this.solid(`${id}.body`, 'house', box(minX, 0, minZ, maxX, height, maxZ), colour);
    // Contrasting parapet band along the roofline.
    if (spec.band ?? true) this.deco(`${id}.band`, box(minX - 0.1, height - 0.3, minZ - 0.1, maxX + 0.1, height, maxZ + 0.1), 'slab');

    const alongX = facing === '+z' || facing === '-z';
    const lo = alongX ? minX : minZ;
    const hi = alongX ? maxX : maxZ;
    const door = spec.doorAt ?? (lo + hi) / 2;
    const out = facing === '+x' || facing === '+z' ? 1 : -1;
    const face = facing === '+x' ? maxX : facing === '-x' ? minX : facing === '+z' ? maxZ : minZ;

    /**
     * Box on the facade: `a`/`b` along it, `y0`/`y1` up, from `d0` to `d1`
     * metres out from the wall.
     */
    const onFacade = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number): Aabb => {
      const n0 = face + out * d0;
      const n1 = face + out * d1;
      const [nMin, nMax] = n0 < n1 ? [n0, n1] : [n1, n0];
      return alongX ? box(a0, y0, nMin, a1, y1, nMax) : box(nMin, y0, a0, nMax, y1, a1);
    };
    const point = (a: number, y: number, d: number): Vec3 =>
      alongX ? v(a, y, face + out * d) : v(face + out * d, y, a);

    const halfDoor = LAYOUT.doorWidth / 2;
    this.deco(`${id}.door`, onFacade(door - halfDoor, door + halfDoor, 0, LAYOUT.doorHeight, 0, 0.06), 'door');
    this.deco(
      `${id}.toran`,
      onFacade(door - halfDoor - 0.2, door + halfDoor + 0.2, LAYOUT.doorHeight, LAYOUT.doorHeight + 0.2, 0, 0.1),
      'toran',
    );
    this.doorways.push({ id: `${id}.doorway`, centre: point(door, 0, 0.8), radius: LAYOUT.doorwayRadius });
    this.diya(`${id}.diya.left`, point(door - halfDoor - 0.5, 0, 0.3));
    this.diya(`${id}.diya.right`, point(door + halfDoor + 0.5, 0, 0.3));

    // Lit windows either side of the door on each storey.
    const storeys = Math.max(1, Math.floor(height / 3));
    for (let storey = 0; storey < storeys; storey++) {
      const y0 = storey * 3 + 1;
      for (const side of [-1, 1] as const) {
        const centre = door + side * Math.min(2.2, (hi - lo) / 2 - 0.9);
        if (storey === 0 && Math.abs(centre - door) < halfDoor + 0.6) continue;
        this.deco(`${id}.window.${storey}.${side}`, onFacade(centre - 0.4, centre + 0.4, y0, y0 + 1, 0, 0.04), 'window');
      }
    }

    if (!spec.balcony || height < 5) return;
    // Balcony slab above the door, with a front rail and two side rails.
    const floor = 3;
    const depth = 1.2;
    const half = 1.5;
    const rail = LAYOUT.railingThickness;
    const railTop = floor + 0.9;
    this.solid(`${id}.balcony`, 'balcony', onFacade(door - half, door + half, floor - 0.15, floor, 0, depth), 'slab');
    this.solid(
      `${id}.balcony.rail.front`,
      'railing',
      onFacade(door - half, door + half, floor, railTop, depth - rail, depth),
      'railing',
    );
    this.solid(`${id}.balcony.rail.a`, 'railing', onFacade(door - half, door - half + rail, floor, railTop, 0, depth), 'railing');
    this.solid(`${id}.balcony.rail.b`, 'railing', onFacade(door + half - rail, door + half, floor, railTop, 0, depth), 'railing');
    this.deco(`${id}.balcony.door`, onFacade(door - 0.5, door + 0.5, floor, floor + 2.1, 0, 0.05), 'door');
    this.deco(`${id}.balcony.lantern`, onFacade(door - 0.15, door + 0.15, floor + 2.0, floor + 2.4, 0.45, 0.75), 'lantern');
  }
}

/** Builds the prototype map. Pure and deterministic. */
export function createLayout(): WorldLayout {
  const b = new LayoutBuilder();
  const { laneHalfWidth: lane, laneSouthZ, courtyardSouthZ, courtyardNorthZ, courtyardHalfWidth: court } = LAYOUT;
  const roofHouse = LAYOUT.rooftopHouse;
  const roofY = LAYOUT.rooftopHeight;

  // ── Ground ─────────────────────────────────────────────────────────────
  b.solid('ground.lane', 'ground', box(-lane, -0.5, courtyardSouthZ, lane, 0, laneSouthZ), 'laneStone', {
    walkable: true,
    supportsPlacement: true,
  });
  b.solid('ground.courtyard', 'ground', box(-court, -0.5, courtyardNorthZ, court, 0, courtyardSouthZ), 'courtyardTile', {
    walkable: true,
    supportsPlacement: true,
  });
  // Distant ground beyond the houses, seen from the rooftop; never reachable.
  b.deco('ground.outer', box(-60, -0.6, -80, 60, -0.02, 50), 'outerGround');

  // ── Lane houses: four a side, facing the lane ─────────────────────────
  const laneZ = [8, 1, -6, -13, -20];
  const laneHeights = [7, 6.5, 8, 7.5];
  for (let i = 0; i < 4; i++) {
    const maxZ = laneZ[i]!;
    const minZ = laneZ[i + 1]!;
    b.house({
      id: `house.lane.w${i}`,
      minX: -court,
      maxX: -lane,
      minZ,
      maxZ,
      height: laneHeights[i]!,
      colour: HOUSE_COLOURS[i % HOUSE_COLOURS.length]!,
      facing: '+x',
      balcony: true,
    });
    b.house({
      id: `house.lane.e${i}`,
      minX: lane,
      maxX: court,
      minZ,
      maxZ,
      height: laneHeights[(i + 2) % 4]!,
      colour: HOUSE_COLOURS[(i + 4) % HOUSE_COLOURS.length]!,
      facing: '-x',
      balcony: i % 2 === 0,
    });
  }

  // ── Courtyard houses ───────────────────────────────────────────────────
  b.house({
    id: 'house.court.w',
    minX: -18,
    maxX: -court,
    minZ: courtyardNorthZ,
    maxZ: courtyardSouthZ,
    height: 7,
    colour: 'houseCoral',
    facing: '+x',
    balcony: true,
  });
  b.house({
    id: 'house.court.nw',
    minX: -court,
    maxX: 0,
    minZ: -42,
    maxZ: courtyardNorthZ,
    height: 8,
    colour: 'houseSky',
    facing: '+z',
    balcony: true,
  });
  b.house({
    id: 'house.court.ne',
    minX: 0,
    maxX: court,
    minZ: -42,
    maxZ: courtyardNorthZ,
    height: 6.5,
    colour: 'houseSaffron',
    facing: '+z',
    balcony: true,
  });
  // The rooftop house: a single storey with a terrace on top. Its door sits
  // south of the stair's footprint so the stairs never block it.
  b.house({
    id: 'house.court.e',
    minX: roofHouse.minX,
    maxX: roofHouse.maxX,
    minZ: roofHouse.minZ,
    maxZ: roofHouse.maxZ,
    height: roofY - 0.1,
    colour: 'houseLime',
    facing: '-x',
    doorAt: -33,
    balcony: false,
    band: false,
  });
  b.solid(
    'rooftop.floor',
    'rooftop',
    box(roofHouse.minX, roofY - 0.1, roofHouse.minZ, roofHouse.maxX, roofY, roofHouse.maxZ),
    'roofTerrace',
    { walkable: true, supportsPlacement: true },
  );

  // ── Staircase up the rooftop house's west wall ────────────────────────
  // Solid steps rising northwards, then a landing level with the terrace.
  const s = LAYOUT.stair;
  const outerX = s.x - s.width;
  const rail = LAYOUT.railingThickness;
  const railH = LAYOUT.railingHeight;
  for (let i = 0; i < s.steps; i++) {
    const top = s.rise * (i + 1);
    const nearZ = s.startZ - s.tread * i;
    const farZ = nearZ - s.tread;
    b.solid(`stair.step.${i}`, 'stair', box(outerX, 0, farZ, s.x, top, nearZ), 'stairStone', { walkable: true });
    // Stepped railing along the open (west) side, one segment per tread.
    b.solid(`stair.rail.${i}`, 'railing', box(outerX, top, farZ, outerX + rail, top + railH, nearZ), 'railing');
  }
  const landingNearZ = s.startZ - s.tread * s.steps;
  const landingFarZ = landingNearZ - s.landingDepth;
  b.solid('stair.landing', 'landing', box(outerX, 0, landingFarZ, s.x, roofY, landingNearZ), 'stairStone', {
    walkable: true,
  });
  b.solid('stair.landing.rail.w', 'railing', box(outerX, roofY, landingFarZ, outerX + rail, roofY + railH, landingNearZ), 'railing');
  b.solid('stair.landing.rail.n', 'railing', box(outerX, roofY, landingFarZ, s.x, roofY + railH, landingFarZ + rail), 'railing');

  // ── Rooftop parapet railings, open where the landing meets the terrace ─
  const { minX, maxX, minZ, maxZ } = roofHouse;
  const top = roofY + railH;
  b.solid('rooftop.rail.e', 'railing', box(maxX - rail, roofY, minZ, maxX, top, maxZ), 'railing');
  b.solid('rooftop.rail.n', 'railing', box(minX, roofY, minZ, maxX, top, minZ + rail), 'railing');
  b.solid('rooftop.rail.s', 'railing', box(minX, roofY, maxZ - rail, maxX, top, maxZ), 'railing');
  b.solid('rooftop.rail.w.north', 'railing', box(minX, roofY, minZ, minX + rail, top, landingFarZ), 'railing');
  b.solid('rooftop.rail.w.south', 'railing', box(minX, roofY, landingNearZ, minX + rail, top, maxZ), 'railing');
  b.light('rooftop.lamp', v(15, roofY + 2.2, -28), '#ffb35c', 14, 12);
  b.deco('rooftop.lantern', box(14.85, roofY + 1.9, -28.15, 15.15, roofY + 2.3, -27.85), 'lantern');
  for (const [i, x, z] of [
    [0, 13.5, -21],
    [1, 17, -21],
    [2, 17, -35],
    [3, 13.5, -35],
  ] as const) {
    b.diya(`rooftop.diya.${i}`, v(x, roofY, z));
  }

  // ── Courtyard tulsi platform with diyas round it ──────────────────────
  const platformTop = 0.5;
  b.solid('courtyard.platform', 'prop', box(-1, 0, -29, 1, platformTop, -27), 'platform');
  for (const [i, x, z] of [
    [0, -0.7, -27.3],
    [1, 0.7, -27.3],
    [2, 0.7, -28.7],
    [3, -0.7, -28.7],
  ] as const) {
    b.diya(`courtyard.platform.diya.${i}`, v(x, platformTop, z));
  }

  // ── Lane entrance: compound wall with a gate across the south end ─────
  b.solid('wall.lane.south', 'wall', box(-lane, 0, laneSouthZ, lane, 2.2, laneSouthZ + 0.3), 'compoundWall');
  b.deco('wall.lane.gate', box(-1.2, 0, laneSouthZ - 0.04, 1.2, 2, laneSouthZ), 'door');

  // ── Strings of bulbs across the lane and courtyard ────────────────────
  const bulbs: MaterialKey[] = ['bulbWarm', 'bulbPink', 'bulbGreen'];
  for (const z of [4, -4, -12]) {
    for (let k = 0, x = -lane + 0.3; x < lane; k++, x += 0.5) {
      const y = 5.2 - 0.25 * Math.cos(((x + lane) / (2 * lane)) * Math.PI * 2);
      b.deco(`bulbs.lane.${z}.${k}`, box(x - 0.05, y - 0.05, z - 0.05, x + 0.05, y + 0.05, z + 0.05), bulbs[k % 3]!);
    }
  }
  for (let k = 0, z = courtyardSouthZ - 0.5; z > courtyardNorthZ; k++, z -= 0.6) {
    const y = 5.5 - 0.3 * Math.cos(((z - courtyardSouthZ) / (courtyardNorthZ - courtyardSouthZ)) * Math.PI * 2);
    b.deco(`bulbs.court.${k}`, box(-0.05, y - 0.05, z - 0.05, 0.05, y + 0.05, z + 0.05), bulbs[k % 3]!);
  }

  b.light('lane.lamp.south', v(0, 4.6, 4), '#ffb060', 16, 14);
  b.light('lane.lamp.mid', v(0, 4.6, -8), '#ffb060', 16, 14);
  b.light('courtyard.lamp', v(0, 4.8, -28), '#ffa850', 24, 18);

  // ── Neighbour gathering areas ─────────────────────────────────────────
  const neighbourAreas: ExclusionZone[] = [
    { id: 'neighbours.courtyard.west', centre: v(-7, 0, -30), radius: 2.5 },
    { id: 'neighbours.courtyard.east', centre: v(5.5, 0, -25), radius: 2 },
    { id: 'neighbours.lane', centre: v(-2.4, 0, -6), radius: 1.5 },
  ];

  // ── Invisible boundary walls just outside the walkable bounds ─────────
  const bounds = box(-court, -1, courtyardNorthZ, roofHouse.maxX, LAYOUT.boundaryHeight, laneSouthZ);
  const t = 0.5;
  const h = LAYOUT.boundaryHeight;
  const { min, max } = bounds;
  const hidden = { visible: false };
  b.solid('boundary.west', 'boundary', box(min.x - t, 0, min.z - t, min.x, h, max.z + t), 'railing', hidden);
  b.solid('boundary.east', 'boundary', box(max.x, 0, min.z - t, max.x + t, h, max.z + t), 'railing', hidden);
  b.solid('boundary.north', 'boundary', box(min.x - t, 0, min.z - t, max.x + t, h, min.z), 'railing', hidden);
  b.solid('boundary.south', 'boundary', box(min.x - t, 0, max.z, max.x + t, h, max.z + t), 'railing', hidden);

  return {
    bounds,
    spawn: v(0, 0, 5),
    spawnYaw: 0,
    solids: b.solids,
    decor: b.decor,
    doorways: b.doorways,
    diyaSites: b.diyaSites,
    neighbourAreas,
    lights: b.lights,
  };
}
