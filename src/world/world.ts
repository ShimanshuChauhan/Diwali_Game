import type { DiyaSite, SurfaceHit, WorldModule } from '../core/contracts';
import type { Aabb, ExclusionZone, Vec3 } from '../core/types';
import { createLayout, type Solid, type WorldLayout } from './layout';

/** Tolerance for "standing on" a surface, so feet at y = 0 find the ground. */
const SURFACE_EPSILON = 0.05;

const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** A top face of a solid, as a rectangle at height `y`. */
export interface Surface {
  readonly id: string;
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function footprintContains(b: Aabb, x: number, z: number): boolean {
  return x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
}

/** Squared distance from `p` to the nearest point of `b` (0 inside). */
function distanceSqToBox(b: Aabb, p: Vec3): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return dx * dx + dy * dy + dz * dz;
}

function topFace(solid: Solid): Surface {
  const { min, max } = solid.box;
  return { id: solid.id, y: max.y, minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
}

/**
 * The static world's queries, answered from layout data alone. This is the
 * `WorldModule` that rule modules (placement, interaction) talk to; it needs
 * neither a renderer nor Rapier, so tests can use it directly. The Rapier
 * colliders (`colliders.ts`) and meshes (`scene.ts`) are built from the same
 * layout, so they agree with these answers.
 */
export class StaticWorld implements WorldModule {
  readonly layout: WorldLayout;
  readonly bounds: Aabb;
  readonly spawn: Vec3;
  readonly spawnYaw: number;
  readonly doorways: readonly ExclusionZone[];
  readonly diyaSites: readonly DiyaSite[];
  readonly neighbourAreas: readonly ExclusionZone[];
  /** Top faces the player can stand on: ground, stairs, landing, rooftop. */
  readonly traversableSurfaces: readonly Surface[];
  /** Top faces that can hold a ground cracker: ground and the rooftop. */
  readonly placementSurfaces: readonly Surface[];

  constructor(layout: WorldLayout = createLayout()) {
    this.layout = layout;
    this.bounds = layout.bounds;
    this.spawn = layout.spawn;
    this.spawnYaw = layout.spawnYaw;
    this.doorways = layout.doorways;
    this.diyaSites = layout.diyaSites;
    this.neighbourAreas = layout.neighbourAreas;
    this.traversableSurfaces = layout.solids.filter((s) => s.walkable).map(topFace);
    this.placementSurfaces = layout.solids.filter((s) => s.supportsPlacement).map(topFace);
  }

  /** Every collidable solid, in layout order. */
  get solids(): readonly Solid[] {
    return this.layout.solids;
  }

  /**
   * Highest solid top at or just below `position` (within 5 cm above it, so
   * feet resting on a surface find it). All solids are axis-aligned boxes,
   * so the normal is always straight up.
   */
  surfaceBelow(position: Vec3): SurfaceHit | null {
    let best: Solid | null = null;
    for (const solid of this.layout.solids) {
      const { box } = solid;
      if (!footprintContains(box, position.x, position.z)) continue;
      if (box.max.y > position.y + SURFACE_EPSILON) continue;
      if (!best || box.max.y > best.box.max.y) best = solid;
    }
    if (!best) return null;
    return {
      point: { x: position.x, y: best.box.max.y, z: position.z },
      normal: UP,
      supportsPlacement: best.supportsPlacement,
    };
  }

  /** Touching (distance exactly `radius`) counts as clear. */
  isClear(position: Vec3, radius: number): boolean {
    const r2 = radius * radius;
    return this.layout.solids.every((solid) => distanceSqToBox(solid.box, position) >= r2);
  }

  clearanceAbove(position: Vec3, maxHeight: number): number {
    let clear = maxHeight;
    for (const { box } of this.layout.solids) {
      if (!footprintContains(box, position.x, position.z)) continue;
      if (box.max.y <= position.y) continue;
      clear = Math.min(clear, Math.max(0, box.min.y - position.y));
    }
    return clear;
  }

  /** True when `position` lies inside the walkable bounds. */
  contains(position: Vec3): boolean {
    const { min, max } = this.bounds;
    return (
      position.x >= min.x &&
      position.x <= max.x &&
      position.y >= min.y &&
      position.y <= max.y &&
      position.z >= min.z &&
      position.z <= max.z
    );
  }
}

export function createWorld(layout?: WorldLayout): StaticWorld {
  return new StaticWorld(layout);
}
