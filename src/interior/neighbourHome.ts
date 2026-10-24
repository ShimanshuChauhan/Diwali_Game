import type { NeighbourHostId, Placement } from '../core/homes';
import { doorwayId, HOME_ENTRANCES } from '../homes/doorways';
import { facing, InteriorBuilder, type InteriorLayout } from './layout';

/** Yaws for the compass directions; yaw 0 looks down -Z (north). */
const SOUTH = Math.PI;
const EAST = -Math.PI / 2;

/** Room dimensions shared by the layout and its tests, in room-local metres. */
export const NEIGHBOUR_ROOM = {
  halfWidth: 4,
  /** Inner face of the south (door) wall; the door anchor is at z = 0. */
  southZ: 0.5,
  /** Inner face of the north wall, behind the sweets table. */
  northZ: -7.5,
  height: 3.1,
  wallThickness: 0.25,
  doorWidth: 1.2,
  doorHeight: 2.2,
} as const;

/** The neighbour home adds where Uncle and Aunty stand to receive the player. */
export interface NeighbourHomeLayout extends InteriorLayout {
  readonly home: 'neighbourHome';
  /**
   * Uncle in the greeting area just inside the door, Aunty beside the sweets
   * table; both on open floor, facing the player coming in.
   */
  readonly hosts: Readonly<Record<NeighbourHostId, Placement>>;
  /** Where the return box rests on the console by the door. */
  readonly giftSpot: Placement['position'];
  /**
   * Uncle's side table, just west of him: the return box waits on it until
   * he hands it over, and the family's box is set down on it once received.
   * `yaw` turns him to face it.
   */
  readonly sideTable: { readonly waiting: Placement['position']; readonly received: Placement['position']; readonly yaw: number };
}

/**
 * Uncle and Aunty's home: one front room, entered from the lane through the
 * door in its south wall, smaller and plainer than the family's and built
 * from the same shared boxes and materials.
 *
 * The greeting area is the front of the room: a rangoli and a toran at the
 * door, a shoe rack, Ganesh ji on the west wall, and a divan with a low
 * table for guests. The sweets area is the north-east corner: a dining
 * table laid with a tray of mithai and boxes of more, two chairs behind it.
 * A console by the door holds the return gift; a side table beside Uncle,
 * the boxes he exchanges.
 *
 *          z = -7.5 ┌──────── north wall ─────────┐
 *                   │▐       ▭ ▭ chairs           │
 *                   │▐ divan   ▭ table ▭ ☺ aunty  │
 *                   │▐ ▭ low table                │
 *                   │   ▭ ☺ uncle                 │
 *                   │ ▭ shoes  ░rangoli░  console▭│
 *          z =  0.5 └──────────── ▯ door ─────────┘
 *                 x = -4                         4
 *
 * As in the family home, nothing is climbable and wall dressing stays
 * thinner than the camera's collision margin.
 */
export function createNeighbourHomeLayout(anchor = HOME_ENTRANCES.neighbourHome.interior): NeighbourHomeLayout {
  const b = new InteriorBuilder(anchor.door);
  const { halfWidth: hw, southZ, northZ, height: h, wallThickness: t, doorWidth, doorHeight } = NEIGHBOUR_ROOM;

  // ── Shell ──────────────────────────────────────────────────────────────
  b.solid('floor', 'floor', b.box(-hw - t, -0.3, northZ - t, hw + t, 0, southZ + t), 'floorTile', true);
  b.solid('ceiling', 'ceiling', b.box(-hw - t, h, northZ - t, hw + t, h + 0.25, southZ + t), 'ceiling');
  b.solid('wall.north', 'wall', b.box(-hw - t, 0, northZ - t, hw + t, h, northZ), 'plaster');
  b.solid('wall.south', 'wall', b.box(-hw - t, 0, southZ, hw + t, h, southZ + t), 'plaster');
  b.solid('wall.west', 'wall', b.box(-hw - t, 0, northZ, -hw, h, southZ), 'plasterAccent');
  b.solid('wall.east', 'wall', b.box(hw, 0, northZ, hw + t, h, southZ), 'plaster');
  b.deco('skirting.north', b.box(-hw, 0, northZ, hw, 0.12, northZ + 0.03), 'skirting');
  b.deco('skirting.east', b.box(hw - 0.03, 0, northZ, hw, 0.12, southZ), 'skirting');
  b.deco('skirting.south', b.box(-hw, 0, southZ - 0.03, hw, 0.12, southZ), 'skirting');

  // ── Greeting area: door, toran, rangoli and shoe rack ─────────────────
  const halfDoor = doorWidth / 2;
  b.deco('door', b.box(-halfDoor, 0, southZ - 0.06, halfDoor, doorHeight, southZ), 'doorWood');
  b.deco('door.toran', b.box(-halfDoor - 0.2, doorHeight, southZ - 0.08, halfDoor + 0.2, doorHeight + 0.18, southZ), 'marigold');
  for (const side of [-1, 1] as const) {
    const x = side * (halfDoor + 0.15);
    b.deco(`door.toran.drop.${side}`, b.box(x - 0.04, doorHeight - 0.5, southZ - 0.06, x + 0.04, doorHeight, southZ), 'marigold', true);
  }
  // A welcome rangoli between the door and Uncle, diyas at its corners.
  const rangoliZ = -2.2;
  b.deco('greeting.rangoli', b.box(-0.7, 0, rangoliZ - 0.5, 0.7, 0.008, rangoliZ + 0.5), 'rangoliTeal');
  b.deco('greeting.rangoli.inner', b.box(-0.4, 0.008, rangoliZ - 0.28, 0.4, 0.012, rangoliZ + 0.28), 'rangoliPink');
  for (const [i, x, z] of [
    [0, -0.6, rangoliZ - 0.4],
    [1, 0.6, rangoliZ - 0.4],
    [2, -0.6, rangoliZ + 0.4],
    [3, 0.6, rangoliZ + 0.4],
  ] as const) {
    b.diya(`greeting.rangoli.diya.${i}`, x, 0.012, z, i >= 2);
  }
  b.solid('greeting.shoeRack', 'furniture', b.box(-hw, 0, -1.5, -hw + 0.45, 0.55, -0.4), 'woodDark');
  b.deco('greeting.shoeRack.diya.bowl', b.box(-hw + 0.16, 0.55, -0.66, -hw + 0.28, 0.59, -0.54), 'clay');
  b.deco('greeting.shoeRack.diya.flame', b.box(-hw + 0.2, 0.59, -0.62, -hw + 0.24, 0.67, -0.58), 'flame');
  // Ganesh ji framed on the west wall, a lamp either side.
  b.deco('greeting.frame', b.box(-hw, 1.3, -3.4, -hw + 0.03, 2.1, -2.6), 'frame');
  b.deco('greeting.frame.deity', b.box(-hw + 0.03, 1.4, -3.3, -hw + 0.04, 2.0, -2.7), 'idol');
  for (const [i, z] of [
    [0, -3.65],
    [1, -2.35],
  ] as const) {
    b.deco(`greeting.lamp.${i}`, b.box(-hw, 1.55, z - 0.08, -hw + 0.06, 1.8, z + 0.08), 'lampShade', i === 1);
  }

  // ── Guests' divan (west) with a low table ─────────────────────────────
  const divan = { maxX: -hw + 0.85, minZ: -6.4, maxZ: -3.9 };
  b.solid('divan.seat', 'furniture', b.box(-hw, 0, divan.minZ, divan.maxX, 0.45, divan.maxZ), 'fabricGold');
  b.solid('divan.back', 'furniture', b.box(-hw, 0.45, divan.minZ, -hw + 0.25, 0.95, divan.maxZ), 'fabricGold');
  for (let i = 0; i < 2; i++) {
    const z = divan.minZ + 0.7 + i * 1.1;
    b.deco(`divan.cushion.${i}`, b.box(-hw + 0.25, 0.45, z - 0.35, -hw + 0.3, 0.85, z + 0.35), 'cushion');
  }
  b.solid('divan.table', 'furniture', b.box(-2.55, 0, -5.6, -1.85, 0.42, -4.7), 'wood');
  b.deco('divan.table.bowl', b.box(-2.35, 0.42, -5.3, -2.05, 0.48, -5.0), 'brass');
  b.deco('divan.rug', b.box(-3.1, 0, -6.2, -1.2, 0.006, -4.1), 'rug');

  // ── Sweets area (north-east): the dining table laid with mithai ───────
  const table = { minX: 1.2, maxX: 2.8, minZ: -6.2, maxZ: -4.6, top: 0.76 };
  const tableX = (table.minX + table.maxX) / 2;
  const tableZ = (table.minZ + table.maxZ) / 2;
  b.solid('sweets.table', 'furniture', b.box(table.minX, 0, table.minZ, table.maxX, table.top, table.maxZ), 'wood');
  b.deco('sweets.tray', b.box(tableX - 0.35, table.top, tableZ - 0.3, tableX + 0.35, table.top + 0.03, tableZ + 0.3), 'brass');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const x = tableX - 0.2 + col * 0.2;
      const z = tableZ - 0.1 + row * 0.2;
      const material = (row + col) % 2 === 0 ? 'sweetsPink' : 'sweets';
      b.deco(`sweets.piece.${row}.${col}`, b.box(x - 0.05, table.top + 0.03, z - 0.05, x + 0.05, table.top + 0.1, z + 0.05), material);
    }
  }
  // Boxes of more mithai, stacked at the table's east end; one only beyond Low.
  b.deco('sweets.box.0', b.box(table.maxX - 0.4, table.top, table.minZ + 0.15, table.maxX - 0.1, table.top + 0.08, table.minZ + 0.45), 'fabricRed');
  b.deco('sweets.box.1', b.box(table.maxX - 0.38, table.top + 0.08, table.minZ + 0.17, table.maxX - 0.12, table.top + 0.15, table.minZ + 0.43), 'fabricGold', true);
  b.diya('sweets.table.diya', table.minX + 0.2, table.top, table.maxZ - 0.2);
  // Two chairs behind the table, backs to the north wall.
  for (const [i, x] of [
    [0, 1.65],
    [1, 2.35],
  ] as const) {
    b.solid(`sweets.chair.${i}`, 'furniture', b.box(x - 0.24, 0, -6.95, x + 0.24, 0.45, -6.45), 'woodDark');
    b.solid(`sweets.chair.${i}.back`, 'furniture', b.box(x - 0.24, 0.45, -6.95, x + 0.24, 1.0, -6.85), 'woodDark');
  }
  b.light('sweets.lamp', b.at(tableX, 2.6, tableZ + 0.6), 'medium', '#ffc070', 6, 8);

  // ── Console by the door (east) for the return gift ────────────────────
  const consoleTable = { minX: hw - 0.5, maxX: hw, minZ: -2.0, maxZ: -1.0, top: 0.8 };
  b.solid('gift.console', 'furniture', b.box(consoleTable.minX, 0, consoleTable.minZ, consoleTable.maxX, consoleTable.top, consoleTable.maxZ), 'woodDark');
  const consoleZ = (consoleTable.minZ + consoleTable.maxZ) / 2;
  const giftSpot = b.mat('gift.spot', (consoleTable.minX + consoleTable.maxX) / 2, consoleTable.top, consoleZ, 0.18, 0.01, 'fabricGold');
  b.diya('gift.console.diya', consoleTable.maxX - 0.1, consoleTable.top, consoleTable.minZ + 0.12, true);

  // ── Uncle's side table, an arm's length west of him: the boxes he exchanges ──
  const sideTable = { minX: -1.52, maxX: -1.1, minZ: -3.24, maxZ: -2.56, top: 0.8 };
  b.solid('greeting.sideTable', 'furniture', b.box(sideTable.minX, 0, sideTable.minZ, sideTable.maxX, sideTable.top, sideTable.maxZ), 'woodDark');
  const sideX = sideTable.maxX - 0.16;
  const sideZ = (sideTable.minZ + sideTable.maxZ) / 2;

  // ── Walls: windows, curtains and garlands ─────────────────────────────
  b.deco('window.east', b.box(hw - 0.03, 1.0, -4.4, hw, 2.2, -3.2), 'windowNight');
  for (const s of [-1, 1] as const) {
    const cz = -3.8 + s * 0.75;
    b.deco(`window.east.curtain.${s}`, b.box(hw - 0.06, 0.9, cz - 0.18, hw, 2.4, cz + 0.18), 'curtain');
  }
  b.diya('window.east.sill', hw - 0.05, 1.0, -3.8, true);
  b.deco('lamp.wall.north', b.box(-0.1, 2.1, northZ, 0.1, 2.35, northZ + 0.06), 'lampShade');
  b.deco('garland.north', b.box(-hw, h - 0.4, northZ, hw, h - 0.3, northZ + 0.05), 'marigold', true);
  for (let k = 0; k < 7; k++) {
    const x = -hw + 0.6 + k * 1.15;
    b.deco(`garland.north.drop.${k}`, b.box(x - 0.03, h - 0.75, northZ, x + 0.03, h - 0.4, northZ + 0.05), 'marigold', true);
  }
  b.light('greeting.lamp', b.at(-0.4, 2.6, -2.8), 'low', '#ffb35c', 6, 8);
  b.light('room.fill', b.at(-2.2, 2.7, -5.2), 'high', '#ffa860', 4, 7);

  // ── Anchors ────────────────────────────────────────────────────────────
  const arrival = anchor.arrival.position;
  const host = (x: number, z: number): Placement => {
    const position = b.at(x, 0, z);
    return { position, yaw: facing(position, arrival) };
  };
  const hosts: Record<NeighbourHostId, Placement> = {
    uncle: host(-0.8, -2.9),
    aunty: host(2.0, -3.85),
  };

  const trayTarget = b.at(tableX, 0, tableZ);
  const trayStand = b.at(table.minX - 0.45, 0, tableZ);
  const giftStand = b.at(consoleTable.minX - 0.55, 0, consoleZ);
  const doorStand = b.at(0, 0, -0.3);
  const greet = (id: NeighbourHostId, x: number, z: number) => {
    const position = b.at(x, 0, z);
    return { position, yaw: facing(position, hosts[id].position) };
  };

  return {
    home: 'neighbourHome',
    bounds: b.box(-hw, -1, northZ, hw, h, southZ),
    door: anchor.door,
    arrival: anchor.arrival,
    solids: b.solids,
    decor: b.decor,
    lights: b.lights,
    ambient: { sky: '#ffdcb0', ground: '#4a2c1c', intensity: 1.1 },
    interactions: [
      {
        target: { kind: 'door', id: doorwayId('neighbourHome', 'exit'), position: anchor.door },
        stand: { position: doorStand, yaw: SOUTH },
        marker: 'door',
      },
      {
        target: { kind: 'tray', id: 'neighbourHome', position: trayTarget },
        stand: { position: trayStand, yaw: EAST },
        marker: 'sweets.tray',
      },
      {
        target: { kind: 'returnSpot', id: 'giftBox@neighbourHome', item: 'giftBox', home: 'neighbourHome', position: giftSpot },
        stand: { position: giftStand, yaw: facing(giftStand, giftSpot) },
        marker: 'gift.spot',
      },
      {
        target: { kind: 'person', id: 'uncle', position: hosts.uncle.position },
        stand: greet('uncle', -0.4, -2.0),
        marker: 'greeting.rangoli',
      },
      {
        target: { kind: 'person', id: 'aunty', position: hosts.aunty.position },
        stand: greet('aunty', 1.0, -3.0),
        marker: 'sweets.table',
      },
    ],
    hosts,
    giftSpot,
    sideTable: {
      // Side by side as Uncle faces the table: the return box on his right, the family's box set down on his left.
      waiting: b.at(sideX, sideTable.top, sideZ - 0.14),
      received: b.at(sideX, sideTable.top, sideZ + 0.14),
      yaw: facing(hosts.uncle.position, b.at(sideX, 0, sideZ)),
    },
  };
}
