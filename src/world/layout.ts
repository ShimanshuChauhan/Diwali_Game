import type { DiyaSite } from '../core/contracts';
import type { Aabb, ExclusionZone, Vec3 } from '../core/types';

/**
 * The prototype map as plain data: a residential lane opening onto a
 * courtyard, colourful houses with balconies and doorways, and one low house
 * whose rooftop is reached by an outdoor staircase. Most doors are shut; the
 * two enterable homes' stand open (`ENTERABLE_HOUSES`).
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
  | 'plinth'
  | 'windowDark'
  | 'tank'
  | 'metal'
  | 'terracotta'
  | 'leaf'
  | 'pavement'
  | 'drain'
  | 'laneStoneDark'
  | 'courtyardTileDark'
  | 'doorGlow'
  | 'marigold'
  | 'brass'
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

/**
 * Houses whose front door leads inside: the family home and the neighbour's
 * (`HOME_ENTRANCES` in the homes module, kept in step by a test). Their
 * doors stand open on a lamp-lit room, garlanded and name-plated, so the
 * player can tell from the lane which homes they can go into.
 */
export const ENTERABLE_HOUSES: readonly string[] = ['house.lane.w0', 'house.lane.e1'];

const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb => ({
  min: { x: minX, y: minY, z: minZ },
  max: { x: maxX, y: maxY, z: maxZ },
});

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Which way a facade faces, as a unit step on the ground plane. */
type Facing = '+x' | '-x' | '+z' | '-z';

/**
 * Box on a facade: `a0`/`a1` along it, `y0`/`y1` up, from `d0` to `d1`
 * metres out from the wall.
 */
type FacadeBox = (a0: number, a1: number, y0: number, y1: number, d0: number, d1: number) => Aabb;

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
  /** Contrasting roofline band and rooftop parapet; off where stairs run up the wall. */
  readonly band?: boolean;
  /** Potted plants either side of the door, beyond the diyas. */
  readonly pots?: boolean;
  /** A stair room (mumty) on the roof, with the water tank on top of it. */
  readonly mumty?: boolean;
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
   * Concrete sill below a window and a chhajja sunshade above it. `face` and
   * `out` place them on a wall `face` metres from the facade, facing `out`.
   */
  windowTrim(
    id: string,
    onFacade: FacadeBox,
    centre: number,
    y0: number,
    face = 0,
    out = 1,
  ): void {
    this.deco(`${id}.sill`, onFacade(centre - 0.5, centre + 0.5, y0 - 0.08, y0, face, face + out * 0.14), 'slab');
    this.deco(`${id}.shade`, onFacade(centre - 0.6, centre + 0.6, y0 + 1.12, y0 + 1.2, face, face + out * 0.4), 'slab');
  }

  /** A terracotta pot (solid, so the player walks round it) with a leafy top. */
  pot(id: string, x: number, z: number, half: number, height: number): void {
    this.solid(id, 'prop', box(x - half, 0, z - half, x + half, height, z + half), 'terracotta');
    this.deco(`${id}.rim`, box(x - half - 0.03, height - 0.06, z - half - 0.03, x + half + 0.03, height, z + half + 0.03), 'terracotta');
    // A bush in tiers, narrowing upwards.
    let y = height;
    [1.1, 0.8, 0.45].forEach((k, i) => {
      const r = half * k;
      const h = half * (1 - i * 0.2);
      this.deco(`${id}.leaf.${i}`, box(x - r, y, z - r, x + r, y + h, z + r), 'leaf');
      y += h * 0.85;
    });
  }

  /**
   * A parked scooter: one invisible collider round a few visual boxes.
   * `alongX` picks which way it points.
   */
  scooter(id: string, x: number, z: number, alongX: boolean, colour: HouseColour): void {
    const length = 1.6;
    const width = 0.6;
    // Box in scooter space: `l` along its length from the rear, `w` across from its centre line.
    const part = (l0: number, l1: number, y0: number, y1: number, w0: number, w1: number): Aabb => {
      const a0 = (alongX ? x : z) - length / 2 + l0;
      const a1 = (alongX ? x : z) - length / 2 + l1;
      const c = alongX ? z : x;
      return alongX ? box(a0, y0, c + w0, a1, y1, c + w1) : box(c + w0, y0, a0, c + w1, y1, a1);
    };
    const half = width / 2;
    this.solid(`${id}.collider`, 'prop', part(0, length, 0, 1.1, -half, half), 'metal', { visible: false });
    this.deco(`${id}.wheel.rear`, part(0.05, 0.45, 0, 0.4, -0.06, 0.06), 'tank');
    this.deco(`${id}.wheel.front`, part(1.15, 1.55, 0, 0.4, -0.06, 0.06), 'tank');
    this.deco(`${id}.body`, part(0.05, 0.95, 0.3, 0.75, -0.25, 0.25), colour);
    this.deco(`${id}.seat`, part(0.15, 0.85, 0.75, 0.85, -0.18, 0.18), 'railing');
    this.deco(`${id}.floor`, part(0.95, 1.2, 0.25, 0.35, -0.2, 0.2), 'railing');
    this.deco(`${id}.shield`, part(1.2, 1.32, 0.3, 1.0, -0.22, 0.22), colour);
    this.deco(`${id}.handlebar`, part(1.22, 1.3, 1.0, 1.06, -0.32, 0.32), 'metal');
    this.deco(`${id}.headlamp`, part(1.32, 1.36, 0.82, 0.92, -0.06, 0.06), 'bulbWarm');
  }

  /**
   * The open front door of an enterable home, all decoration and no
   * colliders: a warm lamp-lit room seen through the doorway between two
   * leaves pushed back against the jambs, a wooden frame and threshold,
   * marigold strands hanging from the toran with a swag across it, a lit
   * brass name plate above, and a doormat short of the rangoli.
   */
  openDoor(id: string, onFacade: FacadeBox, door: number): void {
    const half = LAYOUT.doorWidth / 2;
    const top = LAYOUT.doorHeight;
    this.deco(`${id}.door.glow`, onFacade(door - half, door + half, 0, top, 0, 0.05), 'doorGlow');
    for (const side of [-1, 1] as const) {
      const name = side < 0 ? 'left' : 'right';
      const jamb = door + side * half;
      // Leaf folded back inside the opening, and the frame just outside it.
      this.deco(`${id}.door.leaf.${name}`, onFacade(Math.min(jamb, jamb - side * 0.16), Math.max(jamb, jamb - side * 0.16), 0, top, 0.05, 0.08), 'door');
      this.deco(`${id}.door.jamb.${name}`, onFacade(Math.min(jamb, jamb + side * 0.1), Math.max(jamb, jamb + side * 0.1), 0, top, 0, 0.1), 'door');
      // Marigold strand from the toran's end, orange and yellow in turn.
      const a = door + side * (half + 0.2);
      for (let k = 0, y = top - 0.02; y > 1.05; k++, y -= 0.13) {
        this.deco(`${id}.marigold.${name}.${k}`, onFacade(a - 0.05, a + 0.05, y - 0.1, y, 0.03, 0.13), k % 2 ? 'toran' : 'marigold');
      }
    }
    this.deco(`${id}.door.lintel`, onFacade(door - half - 0.1, door + half + 0.1, top - 0.1, top, 0, 0.1), 'door');
    // A wooden sill, dark like the frame: a pale stone one sits right under the
    // diyas' light and flares white.
    this.deco(`${id}.door.threshold`, onFacade(door - half - 0.1, door + half + 0.1, 0, 0.06, 0, 0.22), 'door');
    // A swag of marigolds dipping below the toran.
    const beads = 11;
    for (let k = 0; k < beads; k++) {
      const t = k / (beads - 1);
      const a = door + (t - 0.5) * 2 * (half + 0.1);
      const y = top - 0.04 - 0.16 * Math.sin(Math.PI * t);
      this.deco(`${id}.marigold.swag.${k}`, onFacade(a - 0.05, a + 0.05, y - 0.09, y, 0.1, 0.18), k % 2 ? 'toran' : 'marigold');
    }
    // Brass name plate above the toran, below any balcony slab, with a few
    // dark strokes standing in for the family's name. Its face glows like a
    // window, softer than the doorway beneath it.
    this.deco(`${id}.nameplate`, onFacade(door - 0.42, door + 0.42, top + 0.26, top + 0.58, 0, 0.05), 'brass');
    this.deco(`${id}.nameplate.face`, onFacade(door - 0.36, door + 0.36, top + 0.31, top + 0.53, 0.05, 0.07), 'window');
    for (const [k, a0, a1] of [
      [0, -0.28, -0.1],
      [1, -0.05, 0.12],
      [2, 0.17, 0.28],
    ] as const) {
      this.deco(`${id}.nameplate.text.${k}`, onFacade(door + a0, door + a1, top + 0.39, top + 0.45, 0.07, 0.08), 'door');
    }
    this.deco(`${id}.doormat`, onFacade(door - 0.45, door + 0.45, 0, 0.012, 0.3, 0.75), 'terracotta');
  }

  /**
   * A solid house with a door, torans, windows, two diyas at the door and,
   * optionally, a railed balcony above it. Doors are decoration and stay
   * shut, bar the two enterable homes' (`openDoor`).
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

    const onFacade: FacadeBox = (a0, a1, y0, y1, d0, d1) => {
      const n0 = face + out * d0;
      const n1 = face + out * d1;
      const [nMin, nMax] = n0 < n1 ? [n0, n1] : [n1, n0];
      return alongX ? box(a0, y0, nMin, a1, y1, nMax) : box(nMin, y0, a0, nMax, y1, a1);
    };
    const point = (a: number, y: number, d: number): Vec3 =>
      alongX ? v(a, y, face + out * d) : v(face + out * d, y, a);

    const halfDoor = LAYOUT.doorWidth / 2;
    if (ENTERABLE_HOUSES.includes(id)) this.openDoor(id, onFacade, door);
    else this.deco(`${id}.door`, onFacade(door - halfDoor, door + halfDoor, 0, LAYOUT.doorHeight, 0, 0.06), 'door');
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
        this.windowTrim(`${id}.window.${storey}.${side}`, onFacade, centre, y0);
      }
    }

    // Lit and dark windows on the back wall, with an AC unit under one.
    const back = -(alongX ? maxZ - minZ : maxX - minX);
    const columns = Math.max(1, Math.floor((hi - lo) / 2.6));
    for (let storey = 0; storey < storeys; storey++) {
      const y0 = storey * 3 + 1;
      for (let c = 0; c < columns; c++) {
        const centre = lo + ((c + 0.5) * (hi - lo)) / columns;
        const lit = (storey + c + id.length) % 3 !== 0;
        const wid = `${id}.back.${storey}.${c}`;
        this.deco(wid, onFacade(centre - 0.4, centre + 0.4, y0, y0 + 1, back - 0.04, back), lit ? 'window' : 'windowDark');
        this.windowTrim(wid, onFacade, centre, y0, back, -1);
      }
    }
    if (storeys > 1) {
      const centre = lo + (0.5 * (hi - lo)) / columns;
      this.deco(`${id}.back.ac`, onFacade(centre - 0.4, centre + 0.4, 3.3, 3.8, back - 0.32, back), 'metal');
    }

    // Plinth round the base.
    this.deco(`${id}.plinth`, box(minX - 0.04, 0, minZ - 0.04, maxX + 0.04, 0.4, maxZ + 0.04), 'plinth');

    // Roof: a parapet with a cream coping, a water tank, and on taller houses
    // a stair room that carries the tank.
    if (spec.band ?? true) {
      const t = 0.15;
      const top = height + 0.6;
      const edges: [string, Aabb][] = [
        ['n', box(minX, height, minZ, maxX, top, minZ + t)],
        ['s', box(minX, height, maxZ - t, maxX, top, maxZ)],
        ['w', box(minX, height, minZ + t, minX + t, top, maxZ - t)],
        ['e', box(maxX - t, height, minZ + t, maxX, top, maxZ - t)],
      ];
      for (const [side, b] of edges) {
        this.deco(`${id}.parapet.${side}`, b, colour);
        this.deco(
          `${id}.parapet.${side}.coping`,
          box(b.min.x - 0.03, top, b.min.z - 0.03, b.max.x + 0.03, top + 0.08, b.max.z + 0.03),
          'slab',
        );
      }
      // Tucked into the back corner, away from the street.
      const a0 = lo + 0.5;
      let base = height;
      if (spec.mumty) {
        this.deco(`${id}.mumty`, onFacade(a0, a0 + 2.4, height, height + 2.6, back + 0.5, back + 2.9), colour);
        this.deco(`${id}.mumty.roof`, onFacade(a0 - 0.1, a0 + 2.5, height + 2.6, height + 2.75, back + 0.4, back + 3), 'slab');
        this.deco(`${id}.mumty.door`, onFacade(a0 + 0.8, a0 + 1.6, height, height + 2, back + 2.9, back + 2.95), 'door');
        base = height + 2.75;
      } else {
        this.deco(`${id}.tank.stand`, onFacade(a0, a0 + 1.2, height, height + 0.4, back + 0.5, back + 1.7), 'stairStone');
        base = height + 0.4;
      }
      this.deco(`${id}.tank`, onFacade(a0 + 0.1, a0 + 1.1, base, base + 1.1, back + 0.6, back + 1.6), 'tank');
    }

    // Potted plants beyond the diyas.
    if (spec.pots) {
      for (const side of [-1, 1] as const) {
        const p = point(door + side * 1.9, 0, 0.35);
        this.pot(`${id}.pot.${side < 0 ? 'left' : 'right'}`, p.x, p.z, 0.2, 0.45);
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
  // Ground under the distant town beyond the houses; never reachable.
  b.deco('ground.outer', box(-150, -0.6, -170, 150, -0.02, 140), 'outerGround');

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
      // Not the family home's door (w0): its entrance stays uncluttered.
      pots: i % 2 === 1,
      mumty: i % 2 === 0,
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
      // Not the neighbour's door (e1).
      pots: i % 2 === 0,
      mumty: i % 2 === 1,
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
    pots: true,
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
    pots: true,
    mumty: true,
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

  // ── Paving: lane pavements with a drain line, joints, courtyard tiles ─
  // Flat overlays a few millimetres proud of the ground; decoration only, so
  // placement still rests on the ground beneath.
  const skin = 0.003;
  const kerb = 0.9;
  for (const side of [-1, 1] as const) {
    const inner = side * (lane - kerb);
    const outer = side * lane;
    b.deco(`paving.lane.${side < 0 ? 'w' : 'e'}`, box(Math.min(inner, outer), -0.1, courtyardSouthZ, Math.max(inner, outer), skin, laneSouthZ), 'pavement');
    const d0 = inner;
    const d1 = inner - side * 0.15;
    b.deco(`paving.drain.${side < 0 ? 'w' : 'e'}`, box(Math.min(d0, d1), -0.1, courtyardSouthZ, Math.max(d0, d1), skin + 0.001, laneSouthZ), 'drain');
  }
  for (let k = 0, z = laneSouthZ - 1.5; z > courtyardSouthZ + 0.5; k++, z -= 1.5) {
    b.deco(`paving.joint.${k}`, box(-lane + kerb + 0.15, -0.1, z - 0.04, lane - kerb - 0.15, skin, z + 0.04), 'laneStoneDark');
  }
  for (let i = 0, x = -court; x < court; i++, x += 2) {
    for (let k = 0, z = courtyardNorthZ; z < courtyardSouthZ; k++, z += 2) {
      if ((i + k) % 2 === 0) continue;
      b.deco(`paving.tile.${i}.${k}`, box(x + 0.04, -0.1, z + 0.04, x + 1.96, skin, z + 1.96), 'courtyardTileDark');
    }
  }

  // ── Street life: parked scooters and planters by the gate ─────────────
  b.scooter('scooter.courtyard.west', -11.3, -23, false, 'houseTurquoise');
  b.scooter('scooter.courtyard.north', 9.5, -35.55, true, 'housePink');
  for (const side of [-1, 1] as const) {
    b.pot(`gate.planter.${side < 0 ? 'w' : 'e'}`, side * 3.3, laneSouthZ - 0.7, 0.35, 0.6);
  }

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
