import * as THREE from 'three';
import type { GiftBoxId, GiftBoxSnapshot } from '../core/homes';
import type { Vec3 } from '../core/types';
import type { InteriorAssets, InteriorMaterial } from '../interior';

/** Where each box can be seen; at most one place per box. */
export interface GiftVisibility {
  /** The outbound box on its side table at home. */
  readonly outboundSpot: boolean;
  /** The return box on Uncle and Aunty's console. */
  readonly returnSpot: boolean;
  /** The return box on the family sweets table, waiting or acknowledged. */
  readonly returnTable: boolean;
  /** The box in the player's hands, if any. */
  readonly held: GiftBoxId | null;
}

/**
 * Which box shows where. A delivered outbound box is gone with the
 * neighbours; the acknowledged return box stays on the family table.
 */
export function giftVisibility(boxes: readonly GiftBoxSnapshot[]): GiftVisibility {
  let outboundSpot = false;
  let returnSpot = false;
  let returnTable = false;
  let held: GiftBoxId | null = null;
  for (const { id, place } of boxes) {
    if (place.kind === 'hands') held = id;
    else if (id === 'outbound') outboundSpot = place.kind === 'spot';
    else if (place.kind === 'spot') returnSpot = true;
    else returnTable = true;
  }
  return { outboundSpot, returnSpot, returnTable, held };
}

/** Box size, metres: a mithai-and-dry-fruits gift box. */
const BOX = { width: 0.28, height: 0.16, depth: 0.22 } as const;
const RIBBON = 0.035;

/** Each box's wrapping, from the shared interior palette. */
const WRAPPING: Readonly<Record<GiftBoxId, { readonly body: InteriorMaterial; readonly ribbon: InteriorMaterial }>> = {
  outbound: { body: 'fabricRed', ribbon: 'fabricGold' },
  return: { body: 'rangoliPink', ribbon: 'brass' },
};

export interface GiftSceneOptions {
  readonly assets: InteriorAssets;
  /** The family home's interior root: the outbound box's spot and the sweets table. */
  readonly familyHome: THREE.Object3D;
  /** The neighbour home's interior root: the return box's spot. */
  readonly neighbourHome: THREE.Object3D;
  /** Where a carried box is drawn; it crosses doors, so it is not part of either home. */
  readonly held: THREE.Object3D;
  /** Surface centres the boxes rest on. */
  readonly places: { readonly outboundSpot: Vec3; readonly returnSpot: Vec3; readonly table: Vec3 };
}

/**
 * The two gift boxes (issue #66), drawn from `GiftExchangeModule.boxes()`:
 * resting on their spots, on the family sweets table, or in the hands.
 * Nothing here decides behaviour. Every mesh reuses the interiors' unit box
 * and materials, so the boxes add no GPU resources of their own.
 */
export class GiftScene {
  private readonly outboundSpot: THREE.Group;
  private readonly returnSpot: THREE.Group;
  private readonly returnTable: THREE.Group;
  private readonly held: Record<GiftBoxId, THREE.Group>;

  constructor(options: GiftSceneOptions) {
    const { assets, places } = options;
    this.outboundSpot = this.box(assets, 'outbound', 'gift.outbound.spot', places.outboundSpot, options.familyHome);
    this.returnSpot = this.box(assets, 'return', 'gift.return.spot', places.returnSpot, options.neighbourHome);
    this.returnTable = this.box(assets, 'return', 'gift.return.table', places.table, options.familyHome);
    this.held = {
      outbound: this.box(assets, 'outbound', 'gift.outbound.held', null, options.held),
      return: this.box(assets, 'return', 'gift.return.held', null, options.held),
    };
    this.frame([]);
  }

  /** Per rendered frame. `hold` is where a carried box's base centre goes, facing `yaw`. */
  frame(boxes: readonly GiftBoxSnapshot[], hold?: { readonly center: Vec3; readonly yaw: number }): void {
    const shown = giftVisibility(boxes);
    this.outboundSpot.visible = shown.outboundSpot;
    this.returnSpot.visible = shown.returnSpot;
    this.returnTable.visible = shown.returnTable;
    for (const id of ['outbound', 'return'] as const) {
      const group = this.held[id];
      group.visible = shown.held === id && hold !== undefined;
      if (group.visible && hold) {
        group.position.set(hold.center.x, hold.center.y, hold.center.z);
        group.rotation.set(0, hold.yaw, 0);
      }
    }
  }

  dispose(): void {
    for (const group of [this.outboundSpot, this.returnSpot, this.returnTable, this.held.outbound, this.held.return]) {
      group.removeFromParent();
      group.clear();
    }
  }

  /** A wrapped box with a crossed ribbon and a bow, its base centred on `at`. */
  private box(assets: InteriorAssets, id: GiftBoxId, name: string, at: Vec3 | null, parent: THREE.Object3D): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    const { body, ribbon } = WRAPPING[id];
    const part = (material: InteriorMaterial, w: number, h: number, d: number, y: number) => {
      const mesh = new THREE.Mesh(assets.geometry, assets.material(material));
      mesh.scale.set(w, h, d);
      mesh.position.y = y;
      group.add(mesh);
    };
    const { width, height, depth } = BOX;
    part(body, width, height, depth, height / 2);
    // Ribbons sit a hair proud of the body so they never z-fight.
    part(ribbon, RIBBON, height + 0.004, depth + 0.004, height / 2);
    part(ribbon, width + 0.004, height + 0.004, RIBBON, height / 2);
    part(ribbon, 0.07, 0.03, 0.05, height + 0.015);
    if (at) group.position.set(at.x, at.y, at.z);
    parent.add(group);
    return group;
  }
}
