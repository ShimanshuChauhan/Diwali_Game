import * as THREE from 'three';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { Aabb, Vec3 } from '../core/types';
import type { InteriorAssets, InteriorLayout } from '../interior';

/** What the sweets presentation draws from: the held-items snapshot. */
export interface SweetsState {
  /** The tray is served once aarti completes. */
  readonly served: boolean;
  /** The sharing plate is in the player's hands. */
  readonly carrying: boolean;
}

/** Which parts of the sweets presentation are shown. */
export interface SweetsVisibility {
  /** Sweets heaped on the tray. */
  readonly tray: boolean;
  /** The sharing plate on its spot on the sweets table. */
  readonly tablePlate: boolean;
  /** The sharing plate in the player's hands. */
  readonly heldPlate: boolean;
  /** Sweets on the sharing plate, wherever it is. */
  readonly plateSweets: boolean;
}

/**
 * The tray stays bare until aarti completes; the one sharing plate is on
 * the table or in the hands, never both, and carries sweets once served.
 */
export function sweetsVisibility(state: SweetsState): SweetsVisibility {
  return {
    tray: state.served,
    tablePlate: !state.carrying,
    heldPlate: state.carrying,
    plateSweets: state.served,
  };
}

/** Seconds a piece takes to vanish when eaten and come back to the tray. */
export const BITE_TIME = 0.7;

/**
 * Scale of a tray piece `t` seconds after it was eaten: gone at once, then
 * growing back, so the tray never runs out. 1 once `BITE_TIME` has passed.
 */
export function biteScale(t: number): number {
  if (!(t >= 0) || t >= BITE_TIME) return 1;
  const k = t / BITE_TIME;
  return k * k * (3 - 2 * k);
}

export type SweetKind = 'ladoo' | 'barfi';

export interface SweetPiece {
  readonly kind: SweetKind;
  /** Centre of the piece's base, resting on the surface. */
  readonly position: Vec3;
}

/** Ladoos and barfi in a 3×3 grid on the tray's top face, alternating. */
export function trayPieces(tray: Aabb): SweetPiece[] {
  const cx = (tray.min.x + tray.max.x) / 2;
  const cz = (tray.min.z + tray.max.z) / 2;
  const pitch = Math.min(tray.max.x - tray.min.x, tray.max.z - tray.min.z) / 3.4;
  const pieces: SweetPiece[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      pieces.push({
        kind: (row + col) % 2 === 0 ? 'ladoo' : 'barfi',
        position: { x: cx + (col - 1) * pitch, y: tray.max.y, z: cz + (row - 1) * pitch },
      });
    }
  }
  return pieces;
}

/** Sharing plate radius, metres; a steel thali for sweets. */
const PLATE_RADIUS = 0.12;
const PLATE_THICKNESS = 0.012;
const LADOO_RADIUS = 0.032;
/** Kaju-katli-style barfi: a flat diamond. */
const BARFI = { side: 0.06, height: 0.018 } as const;
/** Sweets on the sharing plate, relative to its centre: two ladoos, two barfi. */
const PLATE_PIECES: readonly SweetPiece[] = [
  { kind: 'ladoo', position: { x: -0.04, y: PLATE_THICKNESS, z: 0.02 } },
  { kind: 'ladoo', position: { x: 0.035, y: PLATE_THICKNESS, z: 0.04 } },
  { kind: 'barfi', position: { x: 0.04, y: PLATE_THICKNESS, z: -0.04 } },
  { kind: 'barfi', position: { x: -0.03, y: PLATE_THICKNESS, z: -0.05 } },
];

export interface SweetsSceneOptions {
  /** The family home; its `sweets.tray` and `sweets.plateSpot` decor place the sweets. */
  readonly layout: InteriorLayout;
  /** The home's interior root, so the sweets are drawn only while it is shown. */
  readonly parent: THREE.Object3D;
  /** Shared interior materials: the sweets and the steel plate reuse them. */
  readonly assets: InteriorAssets;
  /** Follows `sweetsEaten`, to take a bite out of the tray. */
  readonly bus: GameEventBus;
}

/**
 * The sweets on the family's table (issue #63): the tray heaped with ladoos
 * and barfi once aarti is over, and the sharing plate, on its spot or in
 * the player's hands. Each bite takes a piece off the tray that grows
 * straight back; supply is unlimited. Nothing here decides behaviour.
 *
 * Built once at boot from shared geometry and the interior's materials: the
 * tray is two instanced meshes, the plate five small meshes.
 */
export class SweetsScene {
  readonly object = new THREE.Group();

  private readonly tray: Record<SweetKind, THREE.InstancedMesh>;
  private readonly pieces: readonly SweetPiece[];
  /** Index in `pieces` of each piece's instance in its kind's mesh. */
  private readonly instanceOf: readonly number[];
  private readonly plate = new THREE.Group();
  private readonly plateSweets = new THREE.Group();
  private readonly platePlace: Vec3;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  /** Seconds since each tray piece was last eaten; Infinity when whole. */
  private readonly bitten: number[];
  private nextBite = 0;

  constructor(options: SweetsSceneOptions) {
    this.object.name = 'sweets';
    const decor = (id: string) => {
      const found = options.layout.decor.find((d) => d.id === id);
      if (!found) throw new Error(`family home has no ${id}`);
      return found.box;
    };
    const ladoo = this.geometry(new THREE.SphereGeometry(LADOO_RADIUS, 12, 8).translate(0, LADOO_RADIUS * 0.85, 0));
    const barfi = this.geometry(
      new THREE.BoxGeometry(BARFI.side, BARFI.height, BARFI.side).rotateY(Math.PI / 4).translate(0, BARFI.height / 2, 0),
    );
    const geometryOf: Record<SweetKind, THREE.BufferGeometry> = { ladoo, barfi };
    const materialOf: Record<SweetKind, THREE.Material> = {
      ladoo: options.assets.material('sweets'),
      barfi: options.assets.material('sweetsPink'),
    };

    this.pieces = trayPieces(decor('sweets.tray'));
    this.bitten = this.pieces.map(() => Infinity);
    const counts: Record<SweetKind, number> = { ladoo: 0, barfi: 0 };
    this.instanceOf = this.pieces.map((piece) => counts[piece.kind]++);
    this.tray = {
      ladoo: new THREE.InstancedMesh(ladoo, materialOf.ladoo, counts.ladoo),
      barfi: new THREE.InstancedMesh(barfi, materialOf.barfi, counts.barfi),
    };
    for (const kind of ['ladoo', 'barfi'] as const) {
      this.tray[kind].name = `sweets.tray.${kind}`;
      this.object.add(this.tray[kind]);
    }
    for (let i = 0; i < this.pieces.length; i++) this.placePiece(i, 1);
    for (const mesh of Object.values(this.tray)) mesh.computeBoundingSphere();

    // The sharing plate: a steel disc with a few sweets on top.
    const spot = decor('sweets.plateSpot');
    this.platePlace = { x: (spot.min.x + spot.max.x) / 2, y: spot.max.y, z: (spot.min.z + spot.max.z) / 2 };
    this.plate.name = 'sweets.plate';
    const disc = new THREE.Mesh(
      this.geometry(new THREE.CylinderGeometry(PLATE_RADIUS, PLATE_RADIUS * 0.9, PLATE_THICKNESS, 24).translate(0, PLATE_THICKNESS / 2, 0)),
      options.assets.material('plate'),
    );
    this.plate.add(disc, this.plateSweets);
    for (const piece of PLATE_PIECES) {
      const mesh = new THREE.Mesh(geometryOf[piece.kind], materialOf[piece.kind]);
      mesh.position.set(piece.position.x, piece.position.y, piece.position.z);
      this.plateSweets.add(mesh);
    }
    this.object.add(this.plate);

    this.unsubscribes.push(options.bus.on('sweetsEaten', () => this.bite()));
    options.parent.add(this.object);
    this.frame(0, { served: false, carrying: false });
  }

  /**
   * Per rendered frame while the home is shown. `hold` is where the carried
   * plate's centre goes, facing `yaw`; the plate stays on its spot without it.
   */
  frame(delta: number, state: SweetsState, hold?: { readonly center: Vec3; readonly yaw: number }): void {
    const dt = delta > 0 ? delta : 0;
    const shown = sweetsVisibility(state);
    this.tray.ladoo.visible = shown.tray;
    this.tray.barfi.visible = shown.tray;
    if (shown.tray) this.stepBites(dt);
    this.plateSweets.visible = shown.plateSweets;
    if (shown.heldPlate && hold) {
      this.plate.visible = true;
      this.plate.position.set(hold.center.x, hold.center.y, hold.center.z);
      this.plate.rotation.set(0, hold.yaw, 0);
    } else {
      this.plate.visible = shown.tablePlate;
      this.plate.position.set(this.platePlace.x, this.platePlace.y, this.platePlace.z);
      this.plate.rotation.set(0, 0, 0);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const mesh of Object.values(this.tray)) mesh.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.object.removeFromParent();
    this.object.clear();
  }

  /** The next piece round the tray disappears and starts growing back. */
  private bite(): void {
    this.bitten[this.nextBite] = 0;
    this.placePiece(this.nextBite, 0);
    this.nextBite = (this.nextBite + 1) % this.pieces.length;
  }

  private stepBites(dt: number): void {
    for (let i = 0; i < this.bitten.length; i++) {
      const t = this.bitten[i]!;
      if (t === Infinity) continue;
      const next = t + dt;
      this.bitten[i] = next >= BITE_TIME ? Infinity : next;
      this.placePiece(i, biteScale(next));
    }
  }

  private placePiece(index: number, size: number): void {
    const piece = this.pieces[index]!;
    const mesh = this.tray[piece.kind];
    const { x, y, z } = piece.position;
    // A vanished piece keeps a sliver of scale so the matrix stays invertible.
    const s = Math.max(size, 1e-3);
    mesh.setMatrixAt(this.instanceOf[index]!, this.matrix.compose(this.position.set(x, y, z), this.rotation, this.scale.set(s, s, s)));
    mesh.instanceMatrix.needsUpdate = true;
  }

  private geometry<G extends THREE.BufferGeometry>(geometry: G): G {
    this.geometries.push(geometry);
    return geometry;
  }
}
