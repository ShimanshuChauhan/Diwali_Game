import type { Aabb, Vec3 } from '../core/types';
import { LAYOUT, type Solid, type WorldLayout } from '../world/layout';
import type { AtmosphereBudget } from './budget';

/**
 * Static Diwali decorations planned from the world layout as plain data:
 * fairy-light strings on balconies and rooflines, akash kandils (hanging
 * lanterns) beside each door and a rangoli in front of it. Decorations are
 * visual only — they add no colliders and never change placement rules.
 */

export interface Bulb {
  readonly position: Vec3;
  /** 0xRRGGBB. */
  readonly colour: number;
}

export interface Kandil {
  readonly id: string;
  /** Centre of the lantern body. */
  readonly position: Vec3;
  readonly colour: number;
}

export interface Rangoli {
  readonly id: string;
  /** On the ground surface; the renderer lifts it a few millimetres. */
  readonly centre: Vec3;
  readonly radius: number;
  /** Petals on the outer ring. */
  readonly petals: number;
  /** Ring colours, centre outwards. */
  readonly colours: readonly number[];
  /** Radians about +Y. */
  readonly rotation: number;
}

export interface DecorationPlan {
  readonly bulbs: readonly Bulb[];
  readonly kandils: readonly Kandil[];
  readonly rangolis: readonly Rangoli[];
  /** Kandils that carry a real point light, spread across the map. */
  readonly litKandils: readonly Kandil[];
}

export const BULB_COLOURS = [0xffc04a, 0xff4fa0, 0x4aff6a, 0x4fb6ff, 0xffe9a8] as const;
export const KANDIL_COLOURS = [0xff6a1a, 0xff2f6d, 0xffc21a, 0xb84aff, 0x2fd0c0] as const;
const RANGOLI_PALETTES: readonly (readonly number[])[] = [
  [0xffffff, 0xff3d6e, 0xffb000, 0x1fa85a],
  [0xffd400, 0x3a6cff, 0xff4fa0, 0xffffff],
  [0xff7a00, 0xffffff, 0x8a2be2, 0x00b3a4],
  [0xffffff, 0xe0115f, 0xffd400, 0x1e90ff],
];

/** Half-extent of a kandil body; also the clearance kept from solids. */
export const KANDIL_HALF = { x: 0.16, y: 0.24 } as const;
/** Gap kept between any decoration and solid geometry. */
const MARGIN = 0.03;
/** Distance between swag anchor points on a string. */
const SWAG = { balcony: 1.5, roofline: 2 } as const;

/** One house's street-facing side, recovered from its body and doorway. */
interface Facade {
  readonly id: string;
  readonly body: Aabb;
  readonly alongX: boolean;
  /** Coordinate of the wall plane. */
  readonly face: number;
  /** +1 or -1: which way is out of the wall. */
  readonly out: number;
  readonly door: number;
}

function facades(layout: WorldLayout): Facade[] {
  const result: Facade[] = [];
  for (const solid of layout.solids) {
    if (solid.kind !== 'house' || !solid.id.endsWith('.body')) continue;
    const id = solid.id.slice(0, -'.body'.length);
    const doorway = layout.doorways.find((d) => d.id === `${id}.doorway`);
    if (!doorway) continue;
    const { min, max } = solid.box;
    const c = doorway.centre;
    // The doorway zone sits just outside the facade, so its centre lies
    // beyond exactly one face of the body.
    const candidates = [
      { alongX: false, face: max.x, out: 1, gap: c.x - max.x, door: c.z },
      { alongX: false, face: min.x, out: -1, gap: min.x - c.x, door: c.z },
      { alongX: true, face: max.z, out: 1, gap: c.z - max.z, door: c.x },
      { alongX: true, face: min.z, out: -1, gap: min.z - c.z, door: c.x },
    ];
    const best = candidates.reduce((a, b) => (b.gap > a.gap ? b : a));
    result.push({ id, body: solid.box, alongX: best.alongX, face: best.face, out: best.out, door: best.door });
  }
  return result;
}

/** World point `a` along the facade, `y` up, `d` metres out from the wall. */
function onFacade(f: Facade, a: number, y: number, d: number): Vec3 {
  const n = f.face + f.out * d;
  return f.alongX ? { x: a, y, z: n } : { x: n, y, z: a };
}

function inside(b: Aabb, p: Vec3, hx: number, hy: number, hz: number): boolean {
  return (
    p.x + hx > b.min.x - MARGIN &&
    p.x - hx < b.max.x + MARGIN &&
    p.y + hy > b.min.y - MARGIN &&
    p.y - hy < b.max.y + MARGIN &&
    p.z + hz > b.min.z - MARGIN &&
    p.z - hz < b.max.z + MARGIN
  );
}

/** True when a box of half-size `h` at `p` touches a visible solid. */
export function hitsSolid(solids: readonly Solid[], p: Vec3, hx: number, hy: number, hz = hx): boolean {
  return solids.some((s) => s.visible && inside(s.box, p, hx, hy, hz));
}

/**
 * Bulbs from `a0` to `a1` along a facade, drooping in swags of about
 * `swag` metres that hang `sag` below `y`, `d` metres out from the wall.
 */
function string(
  out: Bulb[],
  f: Facade,
  a0: number,
  a1: number,
  y: number,
  d: number,
  sag: number,
  swag: number,
  spacing: number,
  colourOffset: number,
): void {
  const length = a1 - a0;
  if (length <= 0) return;
  const swags = Math.max(1, Math.round(length / swag));
  const count = Math.max(2, Math.floor(length / spacing) + 1);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const local = (t * swags) % 1;
    const droop = sag * Math.sin(Math.PI * local);
    out.push({
      position: onFacade(f, a0 + t * length, y - droop, d),
      colour: BULB_COLOURS[(i + colourOffset) % BULB_COLOURS.length]!,
    });
  }
}

/** Picks `k` of `n` indices spread evenly. */
export function spreadIndices(n: number, k: number): number[] {
  const count = Math.min(n, Math.max(0, Math.floor(k)));
  return Array.from({ length: count }, (_, i) => Math.floor(((i + 0.5) * n) / count));
}

/** Plans every decoration for `layout`. Pure and deterministic. */
export function planDecorations(layout: WorldLayout, budget: AtmosphereBudget): DecorationPlan {
  const bulbs: Bulb[] = [];
  const kandils: Kandil[] = [];
  const rangolis: Rangoli[] = [];
  const solidsById = new Map(layout.solids.map((s) => [s.id, s]));

  facades(layout).forEach((f, index) => {
    const lo = f.alongX ? f.body.min.x : f.body.min.z;
    const hi = f.alongX ? f.body.max.x : f.body.max.z;

    // Balcony: a string draped along the outside of the front rail.
    const rail = solidsById.get(`${f.id}.balcony.rail.front`);
    if (rail) {
      const r = rail.box;
      const a0 = f.alongX ? r.min.x : r.min.z;
      const a1 = f.alongX ? r.max.x : r.max.z;
      const outer = f.alongX ? (f.out > 0 ? r.max.z : r.min.z) : f.out > 0 ? r.max.x : r.min.x;
      const d = Math.abs(outer - f.face) + 0.1;
      string(bulbs, f, a0 + 0.05, a1 - 0.05, r.max.y - 0.08, d, 0.18, SWAG.balcony, budget.bulbSpacing, index);
    }

    // Roofline: swags just under the parapet band.
    if (budget.rooflineLights) {
      string(bulbs, f, lo + 0.2, hi - 0.2, f.body.max.y - 0.4, 0.16, 0.3, SWAG.roofline, budget.bulbSpacing, index + 2);
    }

    // Akash kandil hanging from a bracket beside the door, above head height
    // and below any balcony slab.
    const kandil = onFacade(f, f.door + 1.1, LAYOUT.doorHeight + 0.3, 0.45);
    kandils.push({ id: `${f.id}.kandil`, position: kandil, colour: KANDIL_COLOURS[index % KANDIL_COLOURS.length]! });

    // Rangoli on the ground in front of the door, outside the diyas.
    rangolis.push({
      id: `${f.id}.rangoli`,
      centre: onFacade(f, f.door, 0, 1.5),
      radius: 0.6,
      petals: 6 + (index % 3),
      colours: RANGOLI_PALETTES[index % RANGOLI_PALETTES.length]!,
      rotation: (index * Math.PI) / 7,
    });
  });

  // A larger centrepiece in the courtyard, south of the tulsi platform.
  rangolis.push({
    id: 'courtyard.rangoli',
    centre: { x: 0, y: 0, z: LAYOUT.courtyardSouthZ - 3.4 },
    radius: 1.4,
    petals: 8,
    colours: RANGOLI_PALETTES[0]!,
    rotation: 0,
  });

  const visibleBulbs = bulbs.filter((b) => !hitsSolid(layout.solids, b.position, 0.05, 0.05));
  const visibleKandils = kandils.filter(
    (k) => !hitsSolid(layout.solids, k.position, KANDIL_HALF.x, KANDIL_HALF.y),
  );
  const litKandils = spreadIndices(visibleKandils.length, budget.lanternLights).map((i) => visibleKandils[i]!);
  return { bulbs: visibleBulbs, kandils: visibleKandils, rangolis, litKandils };
}
