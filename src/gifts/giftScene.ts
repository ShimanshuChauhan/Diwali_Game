import * as THREE from 'three';
import type { GiftBoxId, GiftBoxSnapshot } from '../core/homes';
import type { Vec3 } from '../core/types';
import type { InteriorAssets, InteriorMaterial } from '../interior';

/**
 * Where each box can be seen; at most one place per box. A box in a host's
 * hands is not drawn here but by the household scene, in those hands.
 */
export interface GiftVisibility {
  /** The outbound box on its side table at home. */
  readonly outboundSpot: boolean;
  /** The outbound box set down on Uncle's side table, kept there once handed over. */
  readonly outboundReceived: boolean;
  /** The return box on Uncle and Aunty's console. */
  readonly returnSpot: boolean;
  /** The return box on the family sweets table, waiting or acknowledged. */
  readonly returnTable: boolean;
  /** The box in the player's hands, if any. */
  readonly held: GiftBoxId | null;
}

/**
 * Which box shows where. The return box is nowhere to be seen until Uncle
 * lifts it to hand over (before then it is not in `boxes`); the delivered
 * outbound box is kept on his side table; the acknowledged return box stays
 * on the family table.
 */
export function giftVisibility(boxes: readonly GiftBoxSnapshot[]): GiftVisibility {
  let outboundSpot = false;
  let outboundReceived = false;
  let returnSpot = false;
  let returnTable = false;
  let held: GiftBoxId | null = null;
  for (const { id, place } of boxes) {
    if (place.kind === 'hands') held = id;
    else if (place.kind === 'host') continue;
    else if (id === 'outbound') {
      outboundSpot = place.kind === 'spot';
      outboundReceived = place.kind === 'delivered';
    } else if (place.kind === 'spot') returnSpot = true;
    else returnTable = true;
  }
  return { outboundSpot, outboundReceived, returnSpot, returnTable, held };
}

/** Box size, metres: a mithai-and-dry-fruits gift box. */
export const GIFT_BOX = { width: 0.28, height: 0.16, depth: 0.22 } as const;
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
  /** The neighbour home's interior root: the return box's spot and Uncle's side table. */
  readonly neighbourHome: THREE.Object3D;
  /** Where a carried box is drawn; it crosses doors, so it is not part of either home. */
  readonly held: THREE.Object3D;
  /** Surface centres the boxes rest on. */
  readonly places: {
    readonly outboundSpot: Vec3;
    readonly returnSpot: Vec3;
    readonly table: Vec3;
    /** Uncle's side table, where the family's box is kept once received. */
    readonly received: Vec3;
  };
}

/**
 * A wrapped gift box with a crossed ribbon and a bow, base centred on its
 * origin: four meshes over the interiors' unit box and materials, so it
 * adds no GPU resources. The household scene uses it for a host's hands.
 */
export function buildGiftBox(assets: InteriorAssets, id: GiftBoxId): THREE.Group {
  const group = new THREE.Group();
  const { body, ribbon } = WRAPPING[id];
  const part = (material: InteriorMaterial, w: number, h: number, d: number, y: number) => {
    const mesh = new THREE.Mesh(assets.geometry, assets.material(material));
    mesh.scale.set(w, h, d);
    mesh.position.y = y;
    group.add(mesh);
  };
  const { width, height, depth } = GIFT_BOX;
  part(body, width, height, depth, height / 2);
  // Ribbons sit a hair proud of the body so they never z-fight.
  part(ribbon, RIBBON, height + 0.004, depth + 0.004, height / 2);
  part(ribbon, width + 0.004, height + 0.004, RIBBON, height / 2);
  part(ribbon, 0.07, 0.03, 0.05, height + 0.015);
  return group;
}

/**
 * The two gift boxes (issue #66), drawn from `GiftExchangeModule.boxes()`:
 * resting on their spots, on Uncle's side table, on the family sweets
 * table, or in the player's hands. Nothing here decides behaviour. Every
 * mesh reuses the interiors' unit box and materials, so the boxes add no
 * GPU resources of their own.
 */
export class GiftScene {
  private readonly outboundSpot: THREE.Group;
  private readonly outboundReceived: THREE.Group;
  private readonly returnSpot: THREE.Group;
  private readonly returnTable: THREE.Group;
  private readonly held: Record<GiftBoxId, THREE.Group>;

  constructor(options: GiftSceneOptions) {
    const { assets, places } = options;
    this.outboundSpot = this.box(assets, 'outbound', 'gift.outbound.spot', places.outboundSpot, options.familyHome);
    this.outboundReceived = this.box(assets, 'outbound', 'gift.outbound.received', places.received, options.neighbourHome);
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
    this.outboundReceived.visible = shown.outboundReceived;
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
    const { outboundSpot, outboundReceived, returnSpot, returnTable, held } = this;
    for (const group of [outboundSpot, outboundReceived, returnSpot, returnTable, held.outbound, held.return]) {
      group.removeFromParent();
      group.clear();
    }
  }

  /** A wrapped box, its base centred on `at`. */
  private box(assets: InteriorAssets, id: GiftBoxId, name: string, at: Vec3 | null, parent: THREE.Object3D): THREE.Group {
    const group = buildGiftBox(assets, id);
    group.name = name;
    if (at) group.position.set(at.x, at.y, at.z);
    parent.add(group);
    return group;
  }
}
