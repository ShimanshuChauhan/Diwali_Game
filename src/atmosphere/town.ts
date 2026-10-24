import type { Aabb, Vec3 } from '../core/types';
import type { WorldLayout } from '../world/layout';
import type { AtmosphereBudget } from './budget';
import { BULB_COLOURS } from './decorations';

/**
 * The town round the colony as plain data: blocks of flat-roofed houses
 * with lit windows, water tanks and stair rooms, rooftop fairy lights,
 * street lamps, trees and a lit temple across the road from the lane gate.
 * It fills the view past the playable houses so the colony sits in a
 * celebrating neighbourhood rather than a void.
 *
 * Visual only: no colliders, nothing the player can reach. Every candidate
 * is generated from a fixed seed per city block, then the nearest are kept
 * up to the budget, so a higher quality level shows a superset of a lower
 * one and the near town looks the same at every level.
 */

export interface TownBox {
  readonly box: Aabb;
  /** 0xRRGGBB. */
  readonly colour: number;
  /** Washed in warm lamplight (the temple), so it reads at night. */
  readonly lit?: boolean;
}

export type TownFacing = '+x' | '-x' | '+z' | '-z';

export interface TownWindow {
  /** Centre of the pane, just proud of the wall. */
  readonly position: Vec3;
  readonly facing: TownFacing;
  readonly colour: number;
  /** Pane size in metres; a standard window when omitted. */
  readonly width?: number;
  readonly height?: number;
}

export interface TownTree {
  /** Base of the trunk. */
  readonly position: Vec3;
  readonly height: number;
  readonly radius: number;
  readonly colour: number;
}

export interface TownLight {
  readonly position: Vec3;
  readonly colour: number;
  /** Glow diameter in metres. */
  readonly size: number;
}

export interface TownPlan {
  /** Walls, parapets, stair rooms, the temple and tree trunks. */
  readonly boxes: readonly TownBox[];
  /** Base centre of each rooftop water tank. */
  readonly tanks: readonly Vec3[];
  readonly windows: readonly TownWindow[];
  readonly trees: readonly TownTree[];
  /** Rooftop fairy lights, temple outline and street lamps. */
  readonly lights: readonly TownLight[];
  readonly buildings: number;
  readonly lamps: number;
}

/** City block pitch and the road between blocks, in metres. */
const BLOCK = 10;
const ROAD = 3;
/** Blocks are kept inside this radius of the map's centre, inside the fog. */
const TOWN_RADIUS = 118;
/** Gap kept between the town and the playable map. */
const CLEARANCE = 1.5;
const MIN_SIDE = 3;
const STOREY = 3;

const WALL_COLOURS = [0xe0708f, 0x3fb5b0, 0xf0a03c, 0xa6c94a, 0x9c86d6, 0xc99a3e, 0xe8775a, 0x5fa0e0, 0xd8cbb0, 0xc8b8a0];
/** Night shade the wall colours are mixed towards, so the town sits back from the lit colony. */
const DUSK = 0x2a2234;
const DUSK_MIX = 0.3;
const WINDOW_COLOURS = [
  { colour: 0xffb347, weight: 0.62 },
  { colour: 0xffd27a, weight: 0.2 },
  { colour: 0xa8c4ff, weight: 0.1 },
  { colour: 0xff7ab8, weight: 0.08 },
];
const LEAF_COLOURS = [0x1f4a22, 0x26562a, 0x2c5e2a, 0x1c4030];
const TRUNK = 0x3a2a1e;
/** Rooftop water tank cylinder, in metres. */
export const TOWN_TANK = { radius: 0.55, height: 1.1 } as const;
const LAMP = { colour: 0xffa040, size: 0.7, height: 5 } as const;
const BULB_SIZE = 0.22;
const BULB_SPACING = 0.7;

/** Deterministic hash of a few integers to [0, 1). */
export function hash01(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 0x01000193);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A small seeded generator (mulberry32) for one block's choices. */
function blockRandom(gx: number, gz: number): () => number {
  let a = Math.floor(hash01(gx, gz, 7) * 4294967296);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function shade(colour: number, k: number): number {
  return mix(colour, 0x000000, 1 - k);
}

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;

/** Ground distance from a point to a rectangle; 0 inside. */
function distanceTo(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Trims `r` so it no longer overlaps `keepOut`, cutting along whichever side
 * loses least. Null when too little is left to be a building.
 */
function trimOutside(r: Rect, keepOut: Rect): Rect | null {
  if (!overlaps(r, keepOut)) return r;
  const options: Rect[] = [
    { ...r, maxX: keepOut.minX },
    { ...r, minX: keepOut.maxX },
    { ...r, maxZ: keepOut.minZ },
    { ...r, minZ: keepOut.maxZ },
  ].filter((o) => o.maxX - o.minX >= MIN_SIDE && o.maxZ - o.minZ >= MIN_SIDE);
  if (options.length === 0) return null;
  const area = (o: Rect) => (o.maxX - o.minX) * (o.maxZ - o.minZ);
  return options.reduce((a, b) => (area(b) > area(a) ? b : a));
}

/** The playable map's footprint (every visible solid but the ground), padded. */
export function townKeepOut(layout: WorldLayout): Rect {
  const r: Rect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const s of layout.solids) {
    if (s.kind === 'ground') continue;
    r.minX = Math.min(r.minX, s.box.min.x);
    r.maxX = Math.max(r.maxX, s.box.max.x);
    r.minZ = Math.min(r.minZ, s.box.min.z);
    r.maxZ = Math.max(r.maxZ, s.box.max.z);
  }
  return { minX: r.minX - CLEARANCE, maxX: r.maxX + CLEARANCE, minZ: r.minZ - CLEARANCE, maxZ: r.maxZ + CLEARANCE };
}

interface Building {
  readonly rect: Rect;
  readonly height: number;
  readonly colour: number;
  readonly distance: number;
  /** Stable identity for per-building choices. */
  readonly seed: number;
  readonly mumty: boolean;
  readonly tank: boolean;
}

interface Candidates {
  readonly buildings: Building[];
  readonly trees: TownTree[];
  readonly lamps: { position: Vec3; distance: number }[];
  readonly temple: Rect;
}

/** Every building, tree and lamp the town could hold, nearest first. */
function candidates(keepOut: Rect): Candidates {
  const centreX = (keepOut.minX + keepOut.maxX) / 2;
  const centreZ = (keepOut.minZ + keepOut.maxZ) / 2;
  // The temple faces the lane gate across the road south of the colony.
  const templeHalf = 6.5;
  const templeZ = keepOut.maxZ + ROAD + templeHalf;
  const temple: Rect = { minX: -templeHalf, maxX: templeHalf, minZ: templeZ - templeHalf, maxZ: templeZ + templeHalf };
  const templeKeepOut: Rect = {
    minX: temple.minX - CLEARANCE,
    maxX: temple.maxX + CLEARANCE,
    minZ: temple.minZ - CLEARANCE,
    maxZ: temple.maxZ + CLEARANCE,
  };

  const buildings: Building[] = [];
  const trees: TownTree[] = [];
  const lamps: { position: Vec3; distance: number }[] = [];
  const span = Math.ceil(TOWN_RADIUS / BLOCK) + 1;
  const half = BLOCK / 2 - ROAD / 2;

  for (let gx = -span; gx <= span; gx++) {
    for (let gz = -span; gz <= span; gz++) {
      const cx = centreX + gx * BLOCK;
      const cz = centreZ + gz * BLOCK;
      if (Math.hypot(cx - centreX, cz - centreZ) > TOWN_RADIUS) continue;
      const random = blockRandom(gx, gz);

      // A lamp at the block's road corner.
      const lamp = { x: cx + BLOCK / 2, y: LAMP.height, z: cz + BLOCK / 2 };
      const lampDistance = distanceTo(keepOut, lamp.x, lamp.z);
      if (lampDistance > 1 && distanceTo(templeKeepOut, lamp.x, lamp.z) > 0.5) {
        lamps.push({ position: lamp, distance: lampDistance });
      }

      const block: Rect = { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
      if (overlaps(block, templeKeepOut)) continue;

      // Some blocks are small parks of trees.
      if (random() < 0.1) {
        const count = 3 + Math.floor(random() * 3);
        for (let i = 0; i < count; i++) {
          const x = block.minX + 1.5 + random() * (2 * half - 3);
          const z = block.minZ + 1.5 + random() * (2 * half - 3);
          if (distanceTo(keepOut, x, z) < 2) continue;
          trees.push(tree(x, z, random));
        }
        continue;
      }

      // One house, or two side by side.
      const parts: Rect[] = [];
      if (random() < 0.5) {
        parts.push(block);
      } else {
        const alongX = random() < 0.5;
        const t = 0.4 + random() * 0.2;
        if (alongX) {
          const split = block.minX + t * (block.maxX - block.minX);
          parts.push({ ...block, maxX: split - 0.2 }, { ...block, minX: split + 0.2 });
        } else {
          const split = block.minZ + t * (block.maxZ - block.minZ);
          parts.push({ ...block, maxZ: split - 0.2 }, { ...block, minZ: split + 0.2 });
        }
      }

      parts.forEach((part, p) => {
        const inset = () => random() * 0.6;
        const rect = trimOutside(
          { minX: part.minX + inset(), maxX: part.maxX - inset(), minZ: part.minZ + inset(), maxZ: part.maxZ - inset() },
          keepOut,
        );
        // Draw every random number before deciding, so later choices stay stable.
        const storeyRoll = random();
        const towerRoll = random();
        const colourRoll = random();
        const mumtyRoll = random();
        const tankRoll = random();
        if (!rect || rect.maxX - rect.minX < MIN_SIDE || rect.maxZ - rect.minZ < MIN_SIDE) return;
        const x = (rect.minX + rect.maxX) / 2;
        const z = (rect.minZ + rect.maxZ) / 2;
        const distance = distanceTo(keepOut, x, z);
        // One or two storeys against the colony so the rooftop sees out over
        // them, taller further off, and a few apartment towers in the distance.
        const storeys =
          distance > 40 && towerRoll < 0.05
            ? 8 + Math.floor(storeyRoll * 4)
            : distance < 8
              ? 1 + Math.floor(storeyRoll * 2)
              : 2 + Math.floor(storeyRoll * (distance < 20 ? 2 : 3));
        buildings.push({
          rect,
          height: storeys * STOREY + 0.4,
          colour: mix(WALL_COLOURS[Math.floor(colourRoll * WALL_COLOURS.length)]!, DUSK, DUSK_MIX),
          distance,
          seed: Math.floor(hash01(gx, gz, p) * 1e9),
          mumty: storeys < 8 && mumtyRoll < 0.45,
          tank: tankRoll < 0.7,
        });
      });

      // A street tree on the block's corner now and then.
      if (random() < 0.35) {
        const x = cx - BLOCK / 2;
        const z = cz + (random() - 0.5) * (BLOCK - 2);
        if (distanceTo(keepOut, x, z) > 2 && distanceTo(templeKeepOut, x, z) > 1) trees.push(tree(x, z, random));
      }
    }
  }

  const byDistance = (a: { distance: number }, b: { distance: number }) => a.distance - b.distance;
  buildings.sort(byDistance);
  lamps.sort(byDistance);
  const treeDistance = (t: TownTree) => distanceTo(keepOut, t.position.x, t.position.z);
  trees.sort((a, b) => treeDistance(a) - treeDistance(b));
  return { buildings, trees, lamps, temple };
}

function tree(x: number, z: number, random: () => number): TownTree {
  return {
    position: { x, y: 0, z },
    height: 5 + random() * 3,
    radius: 1.6 + random() * 1,
    colour: LEAF_COLOURS[Math.floor(random() * LEAF_COLOURS.length)]!,
  };
}

const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb => ({
  min: { x: minX, y: minY, z: minZ },
  max: { x: maxX, y: maxY, z: maxZ },
});

function windowColour(roll: number): number {
  let acc = 0;
  for (const { colour, weight } of WINDOW_COLOURS) {
    acc += weight;
    if (roll < acc) return colour;
  }
  return WINDOW_COLOURS[0]!.colour;
}

/** Bulbs every `BULB_SPACING` round a rectangle at height `y`. */
function outline(out: TownLight[], r: Rect, y: number, offset: number): void {
  const corners: [number, number][] = [
    [r.minX, r.minZ],
    [r.maxX, r.minZ],
    [r.maxX, r.maxZ],
    [r.minX, r.maxZ],
  ];
  let k = offset;
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i]!;
    const [x1, z1] = corners[(i + 1) % 4]!;
    const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / BULB_SPACING));
    for (let s = 0; s < steps; s++, k++) {
      const t = s / steps;
      out.push({
        position: { x: x0 + (x1 - x0) * t, y, z: z0 + (z1 - z0) * t },
        colour: BULB_COLOURS[k % BULB_COLOURS.length]!,
        size: BULB_SIZE,
      });
    }
  }
}

function addBuilding(plan: MutablePlan, b: Building, roofLights: boolean, windowChance: number): void {
  const { rect, height, colour, seed } = b;
  plan.boxes.push({ box: box(rect.minX, 0, rect.minZ, rect.maxX, height, rect.maxZ), colour });
  // Parapet band in a darker shade.
  plan.boxes.push({ box: box(rect.minX, height, rect.minZ, rect.maxX, height + 0.6, rect.maxZ), colour: shade(colour, 0.7) });

  // Stair room and water tank in one corner of the roof.
  const roof = height + 0.6;
  const corner = hash01(seed, 1) < 0.5;
  const mx = corner ? rect.minX + 0.4 : rect.maxX - 2.6;
  const mz = hash01(seed, 2) < 0.5 ? rect.minZ + 0.4 : rect.maxZ - 2.6;
  let tankBase = roof;
  if (b.mumty) {
    plan.boxes.push({ box: box(mx, height, mz, mx + 2.2, height + 2.6, mz + 2.2), colour });
    tankBase = height + 2.6;
  }
  if (b.tank) plan.tanks.push({ x: mx + 1.1, y: tankBase, z: mz + 1.1 });

  // Window slots on every face, each lit by a stable roll so lower levels
  // light a subset of the same windows.
  const storeys = Math.floor((height - 0.4) / STOREY);
  const faces: { facing: TownFacing; along: [number, number]; at: number }[] = [
    { facing: '-z', along: [rect.minX, rect.maxX], at: rect.minZ },
    { facing: '+z', along: [rect.minX, rect.maxX], at: rect.maxZ },
    { facing: '-x', along: [rect.minZ, rect.maxZ], at: rect.minX },
    { facing: '+x', along: [rect.minZ, rect.maxZ], at: rect.maxX },
  ];
  faces.forEach(({ facing, along: [a0, a1], at }, f) => {
    const columns = Math.max(1, Math.floor((a1 - a0) / 2.4));
    const proud = facing === '+x' || facing === '+z' ? 0.03 : -0.03;
    for (let s = 0; s < storeys; s++) {
      for (let c = 0; c < columns; c++) {
        const roll = hash01(seed, f, s, c);
        if (roll >= windowChance) continue;
        const a = a0 + ((c + 0.5) * (a1 - a0)) / columns;
        const y = s * STOREY + 1.6;
        const alongX = facing === '+z' || facing === '-z';
        plan.windows.push({
          position: alongX ? { x: a, y, z: at + proud } : { x: at + proud, y, z: a },
          facing,
          colour: windowColour(hash01(seed, f, s, c, 3)),
        });
      }
    }
  });

  if (roofLights) {
    const r = { minX: rect.minX - 0.08, maxX: rect.maxX + 0.08, minZ: rect.minZ - 0.08, maxZ: rect.maxZ + 0.08 };
    outline(plan.lights, r, roof + 0.05, seed);
  }
}

/** A white temple with a stepped shikhara, saffron flag and outline lights. */
function addTemple(plan: MutablePlan, r: Rect): void {
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const stone = 0xd8cbb0;
  const white = 0xece4d4;
  const saffron = 0xff8a1a;
  const add = (b: Aabb, colour: number) => plan.boxes.push({ box: b, colour, lit: true });

  add(box(cx - 6.5, 0, cz - 6.5, cx + 6.5, 1.2, cz + 6.5), stone);
  // Steps up to the hall on the gate side.
  for (let i = 0; i < 3; i++) {
    add(box(cx - 2, 0, r.minZ - 1.2 + i * 0.4, cx + 2, 0.4 * (i + 1), r.minZ + 0.4 * i), stone);
  }
  // Mandapa: an open hall of pillars in front (towards the gate) and the
  // sanctum tower behind.
  const hallFront = r.minZ + 0.8;
  const hallBack = cz + 0.5;
  for (const x of [-3.7, -1.9, 1.9, 3.7]) {
    add(box(cx + x - 0.25, 1.2, hallFront, cx + x + 0.25, 5.2, hallFront + 0.5), white);
  }
  add(box(cx - 4, 1.2, hallFront + 2, cx + 4, 5.2, hallBack), white);
  add(box(cx - 4.3, 5.2, r.minZ + 0.5, cx + 4.3, 5.6, cz + 0.8), saffron);
  // Lamp-lit sanctum doorway seen between the pillars.
  plan.windows.push({
    position: { x: cx, y: 2.6, z: hallFront + 1.97 },
    facing: '-z',
    colour: 0xffa040,
    width: 1.6,
    height: 2.8,
  });
  const tiers = [
    { half: 3.2, height: 4 },
    { half: 2.6, height: 3.5 },
    { half: 2, height: 3 },
    { half: 1.4, height: 2.5 },
    { half: 0.8, height: 2 },
  ];
  let y = 1.2;
  const towerZ = cz + 2.2;
  tiers.forEach(({ half, height }, i) => {
    add(box(cx - half, y, towerZ - half, cx + half, y + height, towerZ + half), i % 2 ? stone : white);
    outline(plan.lights, { minX: cx - half - 0.06, maxX: cx + half + 0.06, minZ: towerZ - half - 0.06, maxZ: towerZ + half + 0.06 }, y + height, i * 3);
    y += height;
  });
  // Kalash and flag.
  add(box(cx - 0.3, y, towerZ - 0.3, cx + 0.3, y + 0.9, towerZ + 0.3), 0xe0a020);
  add(box(cx - 0.04, y + 0.9, towerZ - 0.04, cx + 0.04, y + 3.4, towerZ + 0.04), 0x3a2a1e);
  add(box(cx + 0.04, y + 2.4, towerZ - 0.02, cx + 1.4, y + 3.3, towerZ + 0.02), saffron);
  // Diya-lit steps and hall roofline.
  outline(plan.lights, { minX: cx - 6.55, maxX: cx + 6.55, minZ: r.minZ - 0.05, maxZ: r.maxZ + 0.05 }, 1.25, 0);
  outline(plan.lights, { minX: cx - 4.35, maxX: cx + 4.35, minZ: r.minZ + 0.45, maxZ: cz + 0.85 }, 5.65, 1);
}

interface MutablePlan {
  boxes: TownBox[];
  tanks: Vec3[];
  windows: TownWindow[];
  trees: TownTree[];
  lights: TownLight[];
}

const cache = new WeakMap<WorldLayout, Candidates>();

/** Plans the town for `layout` within `budget`. Pure and deterministic. */
export function planTown(layout: WorldLayout, budget: AtmosphereBudget): TownPlan {
  let all = cache.get(layout);
  if (!all) {
    all = candidates(townKeepOut(layout));
    cache.set(layout, all);
  }
  const plan: MutablePlan = { boxes: [], tanks: [], windows: [], trees: [], lights: [] };

  addTemple(plan, all.temple);
  const buildings = all.buildings.slice(0, budget.townBuildings);
  buildings.forEach((b, i) => addBuilding(plan, b, i < budget.townRoofLights, budget.townWindowChance));

  const lamps = all.lamps.slice(0, budget.townLamps);
  for (const { position } of lamps) {
    plan.lights.push({ position, colour: LAMP.colour, size: LAMP.size });
    plan.boxes.push({ box: box(position.x - 0.06, 0, position.z - 0.06, position.x + 0.06, position.y, position.z + 0.06), colour: 0x2a2a2e });
  }

  for (const t of all.trees.slice(0, budget.townTrees)) {
    plan.trees.push(t);
    const { x, z } = t.position;
    plan.boxes.push({ box: box(x - 0.15, 0, z - 0.15, x + 0.15, t.height * 0.55, z + 0.15), colour: TRUNK });
  }

  return { ...plan, buildings: buildings.length, lamps: lamps.length };
}
