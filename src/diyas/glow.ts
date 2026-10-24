import type { DiyaSite } from '../core/contracts';
import type { QualityLevel, Vec3 } from '../core/types';

/**
 * Renderer-free rules for how diyas light their surroundings. Flames are
 * emissive and cast nothing; warmth comes from a small pool of point lights
 * (no shadows) that follows the lit clusters nearest the player, so the
 * light count stays fixed however many diyas burn.
 */

/** Diyas within this ground distance (and on one level) share a light. */
export const CLUSTER_RADIUS = 3;
const CLUSTER_LEVEL = 1;

/** Point lights the diyas may use at each quality level. */
export const DIYA_LIGHTS: Readonly<Record<QualityLevel, number>> = { low: 2, medium: 4, high: 6 };

export interface DiyaCluster {
  readonly centre: Vec3;
  /** Indices into the site list. */
  readonly members: readonly number[];
}

/** Group sites that stand together (a door pair, a rooftop corner, a platform). */
export function clusterDiyas(sites: readonly DiyaSite[], radius = CLUSTER_RADIUS): DiyaCluster[] {
  const parent = sites.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!.position;
      const b = sites[j]!.position;
      if (Math.abs(a.y - b.y) > CLUSTER_LEVEL) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) <= radius) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < sites.length; i++) {
    const r = root(i);
    const group = groups.get(r);
    if (group) group.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].map((members) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const m of members) {
      const p = sites[m]!.position;
      x += p.x;
      y += p.y;
      z += p.z;
    }
    const n = members.length;
    return { centre: { x: x / n, y: y / n, z: z / n }, members };
  });
}

/**
 * Fill `out` with the indices of up to `count` clusters with any warmth,
 * nearest `from` first. `out` is reused so per-frame calls allocate nothing.
 */
export function nearestWarmClusters(
  clusters: readonly DiyaCluster[],
  warmth: ArrayLike<number>,
  from: Vec3,
  count: number,
  out: number[],
): number[] {
  out.length = 0;
  if (count <= 0) return out;
  const distSq = (i: number): number => {
    const c = clusters[i]!.centre;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const dz = c.z - from.z;
    return dx * dx + dy * dy + dz * dz;
  };
  for (let i = 0; i < clusters.length; i++) {
    if (!(warmth[i]! > 0)) continue;
    const d = distSq(i);
    if (out.length === count && d >= distSq(out[count - 1]!)) continue;
    let at = Math.min(out.length, count - 1);
    if (out.length < count) out.push(i);
    while (at > 0 && distSq(out[at - 1]!) > d) {
      out[at] = out[at - 1]!;
      at--;
    }
    out[at] = i;
  }
  return out;
}

/** Seconds for a newly lit flame to grow to full size. */
export const IGNITE_TIME = 0.35;

/** Ease a flame's glow in [0, 1] towards lit (1) or out (0). */
export function stepGlow(glow: number, lit: boolean, dt: number): number {
  if (!lit) return 0;
  return Math.min(1, glow + dt / IGNITE_TIME);
}

/**
 * Flame flicker multiplier around 1, from layered incommensurate sines so
 * neighbouring flames (different `phase`) never pulse in step.
 * Always within [1 - FLICKER_DEPTH, 1 + FLICKER_DEPTH].
 */
export const FLICKER_DEPTH = 0.25;

export function flicker(time: number, phase: number): number {
  const wave =
    0.5 * Math.sin(time * 11.3 + phase) +
    0.3 * Math.sin(time * 23.7 + phase * 2.17) +
    0.2 * Math.sin(time * 41.9 + phase * 3.31);
  return 1 + FLICKER_DEPTH * wave;
}
