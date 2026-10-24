import type { FamilyMemberId, HomeId, HomeInteractable, Placement } from '../core/homes';
import type { Aabb, QualityLevel, Vec3 } from '../core/types';

/**
 * Interiors as plain data, in the same spirit as the street layout
 * (`world/layout.ts`): every piece is an axis-aligned box, so one description
 * drives the Three.js meshes, the Rapier colliders and the headless tests.
 * No Three.js or Rapier imports here.
 *
 * Each home is a separate location away from the street (see
 * `homes/doorways.ts`): the room is built north (-Z) of its front door's
 * interior anchor, with the door in the south wall.
 */

/** What an interior solid is, for colliders and tests. */
export type InteriorSolidKind = 'floor' | 'wall' | 'ceiling' | 'furniture';

/**
 * Shared interior materials; meshes with the same key share one material,
 * across every home, so a second interior adds no new materials.
 */
export type InteriorMaterial =
  | 'plaster'
  | 'plasterAccent'
  | 'ceiling'
  | 'floorTile'
  | 'skirting'
  | 'wood'
  | 'woodDark'
  | 'doorWood'
  | 'fabricRed'
  | 'fabricGold'
  | 'cushion'
  | 'rug'
  | 'brass'
  | 'clay'
  | 'flame'
  | 'marigold'
  | 'idol'
  | 'frame'
  | 'rangoliPink'
  | 'rangoliTeal'
  | 'sweets'
  | 'sweetsPink'
  | 'plate'
  | 'windowNight'
  | 'curtain'
  | 'lampShade';

export interface InteriorBox {
  readonly id: string;
  readonly box: Aabb;
  readonly material: InteriorMaterial;
  /**
   * Optional dressing (garlands, extra lamps) dropped on Low. Nothing that
   * marks an interaction point is ever a detail.
   */
  readonly detail?: boolean;
}

/** A box with a collider. */
export interface InteriorSolid extends InteriorBox {
  readonly kind: InteriorSolidKind;
  /** Its top face is somewhere the player stands. */
  readonly walkable: boolean;
}

/** A warm point light; few per room, the rest of the glow is emissive. */
export interface InteriorLight {
  readonly id: string;
  readonly position: Vec3;
  readonly colour: string;
  readonly intensity: number;
  readonly distance: number;
  /** Lowest quality level it is switched on at. */
  readonly minLevel: QualityLevel;
}

/** A spot the player uses inside, with the box that shows where it is. */
export interface InteriorInteraction {
  readonly target: HomeInteractable;
  /** Where the player stands to use it; walkable and within range. */
  readonly stand: Placement;
  /** Id of the decor or solid that marks it; never a Low-only detail. */
  readonly marker: string;
}

export interface InteriorLayout {
  readonly home: HomeId;
  /** The room's walkable inside; the player is kept within it. */
  readonly bounds: Aabb;
  /** Where the exit door is used from, and where the player arrives. */
  readonly door: Vec3;
  readonly arrival: Placement;
  readonly solids: readonly InteriorSolid[];
  /** Visual-only boxes: idols, thali, diyas, sweets, rugs, garlands. */
  readonly decor: readonly InteriorBox[];
  readonly lights: readonly InteriorLight[];
  /** Ambient fill so every corner reads even with one point light. */
  readonly ambient: { readonly sky: string; readonly ground: string; readonly intensity: number };
  readonly interactions: readonly InteriorInteraction[];
}

/** A family home adds the anchors the household and sweets presentation use. */
export interface FamilyHomeLayout extends InteriorLayout {
  readonly home: 'familyHome';
  /** Where each family member stands, gathered at the puja corner. */
  readonly gathering: Readonly<Record<FamilyMemberId, Placement>>;
  /** Where each family member sits after aarti. */
  readonly seats: Readonly<Record<FamilyMemberId, Placement>>;
  /**
   * Furniture-free walks from each gathering spot to its seat: the
   * waypoints between the two, in order. The server's passes through `serving`.
   */
  readonly routes: Readonly<Record<FamilyMemberId, readonly Vec3[]>>;
  /** Where the tray is served from after aarti, beside the sweets table. */
  readonly serving: Placement;
  /** The thali's resting place on the chowki. */
  readonly thali: Vec3;
  /** Where the neighbour's return box goes on the sweets table. */
  readonly giftTable: Vec3;
}

export const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb => ({
  min: { x: minX, y: minY, z: minZ },
  max: { x: maxX, y: maxY, z: maxZ },
});

/** Yaw that looks from `from` towards `to` on the ground plane; yaw 0 looks down -Z. */
export function facing(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/**
 * Collects an interior's boxes in room-local coordinates: x across the room,
 * z from the door (0) into the room (negative), y up. Everything is shifted
 * to the home's interior anchor on the way in.
 */
export class InteriorBuilder {
  readonly solids: InteriorSolid[] = [];
  readonly decor: InteriorBox[] = [];
  readonly lights: InteriorLight[] = [];

  constructor(private readonly origin: Vec3) {}

  /** Room-local point → world. */
  at(x: number, y: number, z: number): Vec3 {
    return { x: this.origin.x + x, y: this.origin.y + y, z: this.origin.z + z };
  }

  /** Room-local box → world. */
  box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb {
    const o = this.origin;
    return box(o.x + minX, o.y + minY, o.z + minZ, o.x + maxX, o.y + maxY, o.z + maxZ);
  }

  solid(id: string, kind: InteriorSolidKind, b: Aabb, material: InteriorMaterial, walkable = false): void {
    this.solids.push({ id, kind, box: b, material, walkable });
  }

  deco(id: string, b: Aabb, material: InteriorMaterial, detail = false): void {
    this.decor.push(detail ? { id, box: b, material, detail } : { id, box: b, material });
  }

  light(id: string, position: Vec3, minLevel: QualityLevel, colour = '#ffb35c', intensity = 6, distance = 9): void {
    this.lights.push({ id, position, colour, intensity, distance, minLevel });
  }

  /**
   * A flat square mat of half-size `half` resting on a surface at room-local
   * `y`, centred on (`x`, `z`); returns that centre in world coordinates.
   */
  mat(id: string, x: number, y: number, z: number, half: number, thickness: number, material: InteriorMaterial): Vec3 {
    this.deco(id, this.box(x - half, y, z - half, x + half, y + thickness, z + half), material);
    return this.at(x, y, z);
  }

  /** A small clay diya with its flame on a surface at room-local `y`. */
  diya(id: string, x: number, y: number, z: number, detail = false): void {
    this.deco(`${id}.bowl`, this.box(x - 0.06, y, z - 0.06, x + 0.06, y + 0.04, z + 0.06), 'clay', detail);
    this.deco(`${id}.flame`, this.box(x - 0.02, y + 0.04, z - 0.02, x + 0.02, y + 0.12, z + 0.02), 'flame', detail);
  }
}
