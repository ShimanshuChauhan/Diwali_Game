import type { FamilyMemberId, Placement } from '../core/homes';
import type { Vec3 } from '../core/types';
import { doorwayId, HOME_ENTRANCES } from '../homes/doorways';
import { facing, InteriorBuilder, type FamilyHomeLayout } from './layout';

/** Yaws for the compass directions; yaw 0 looks down -Z (north). */
const NORTH = 0;
const SOUTH = Math.PI;
const WEST = Math.PI / 2;

/** Room dimensions shared by the layout and its tests, in room-local metres. */
export const FAMILY_ROOM = {
  halfWidth: 4.5,
  /** Inner face of the south (door) wall; the door anchor is at z = 0. */
  southZ: 0.5,
  /** Inner face of the north wall, behind the puja corner. */
  northZ: -8.5,
  height: 3.2,
  wallThickness: 0.25,
  doorWidth: 1.2,
  doorHeight: 2.2,
} as const;

/**
 * The family home: one warm living room, entered from the street door in its
 * south wall. The puja corner sits against the north wall on the west side
 * (chowki, mandir shelf with framed deity and idols, thali, diyas, bell and a
 * rangoli in front); the seating and sweets area is on the east side (sofa,
 * armchair, a moodha and the low sweets table with its tray and the sharing
 * plate's spot). A side table by the door holds the gift box.
 *
 *          z = -8.5 ┌─────────── north wall ───────────┐
 *                   │ ▣ mandir ▣         armchair ▭     │
 *                   │  ░rangoli░                       ▐│
 *                   │   ☺ puja stand      ▭ table ▭    ▐│ sofa
 *                   │                       moodha    ▐│
 *                   │ ▭ gift                            │
 *          z =  0.5 └────────────── ▯ door ────────────┘
 *                 x = -4.5                           4.5
 *
 * Nothing the player can reach is climbable: furniture tops are above the
 * autostep height and rugs and rangoli are flat decor. Wall dressing stays
 * within a few centimetres of the walls, so the camera's collision margin
 * keeps both views out of it.
 */
export function createFamilyHomeLayout(anchor = HOME_ENTRANCES.familyHome.interior): FamilyHomeLayout {
  const b = new InteriorBuilder(anchor.door);
  const { halfWidth: hw, southZ, northZ, height: h, wallThickness: t, doorWidth, doorHeight } = FAMILY_ROOM;

  // ── Shell ──────────────────────────────────────────────────────────────
  b.solid('floor', 'floor', b.box(-hw - t, -0.3, northZ - t, hw + t, 0, southZ + t), 'floorTile', true);
  b.solid('ceiling', 'ceiling', b.box(-hw - t, h, northZ - t, hw + t, h + 0.25, southZ + t), 'ceiling');
  b.solid('wall.north', 'wall', b.box(-hw - t, 0, northZ - t, hw + t, h, northZ), 'plasterAccent');
  b.solid('wall.south', 'wall', b.box(-hw - t, 0, southZ, hw + t, h, southZ + t), 'plaster');
  b.solid('wall.west', 'wall', b.box(-hw - t, 0, northZ, -hw, h, southZ), 'plaster');
  b.solid('wall.east', 'wall', b.box(hw, 0, northZ, hw + t, h, southZ), 'plaster');
  // Skirting, flush enough to stay inside the camera margin.
  b.deco('skirting.west', b.box(-hw, 0, northZ, -hw + 0.03, 0.12, southZ), 'skirting');
  b.deco('skirting.east', b.box(hw - 0.03, 0, northZ, hw, 0.12, southZ), 'skirting');
  b.deco('skirting.south', b.box(-hw, 0, southZ - 0.03, hw, 0.12, southZ), 'skirting');

  // ── Front door, inside face, with a marigold toran ────────────────────
  const halfDoor = doorWidth / 2;
  b.deco('door', b.box(-halfDoor, 0, southZ - 0.06, halfDoor, doorHeight, southZ), 'doorWood');
  b.deco('door.toran', b.box(-halfDoor - 0.2, doorHeight, southZ - 0.08, halfDoor + 0.2, doorHeight + 0.18, southZ), 'marigold');
  for (const side of [-1, 1] as const) {
    const x = side * (halfDoor + 0.15);
    b.deco(`door.toran.drop.${side}`, b.box(x - 0.04, doorHeight - 0.5, southZ - 0.06, x + 0.04, doorHeight, southZ), 'marigold', true);
  }

  // ── Puja corner (north-west) ───────────────────────────────────────────
  const puja = { minX: -3.6, maxX: -1.4, front: northZ + 0.7, top: 0.6 };
  const pujaX = (puja.minX + puja.maxX) / 2;
  b.solid('puja.chowki', 'furniture', b.box(puja.minX, 0, northZ, puja.maxX, puja.top, puja.front), 'wood');
  // Mandir shelf against the wall: a backboard with a little canopy on top.
  const shelfFront = northZ + 0.3;
  b.solid('puja.mandir', 'furniture', b.box(puja.minX + 0.2, puja.top, northZ, puja.maxX - 0.2, 2.3, shelfFront), 'woodDark');
  b.deco('puja.mandir.canopy', b.box(puja.minX + 0.1, 2.3, northZ, puja.maxX - 0.1, 2.45, shelfFront + 0.04), 'brass');
  b.deco('puja.frame', b.box(pujaX - 0.5, 1.15, shelfFront, pujaX + 0.5, 2.05, shelfFront + 0.03), 'frame');
  b.deco('puja.frame.deity', b.box(pujaX - 0.38, 1.25, shelfFront + 0.03, pujaX + 0.38, 1.95, shelfFront + 0.04), 'idol');
  for (const [i, dx] of [
    [0, -0.32],
    [1, 0.32],
  ] as const) {
    const x = pujaX + dx;
    b.deco(`puja.idol.${i}`, b.box(x - 0.1, puja.top, shelfFront, x + 0.1, puja.top + 0.32, shelfFront + 0.16), 'idol');
  }
  // Brass thali at the chowki's front edge, its own diya burning on it.
  const thali = b.at(pujaX, puja.top, puja.front - 0.2);
  b.deco('puja.thali', b.box(pujaX - 0.22, puja.top, puja.front - 0.42, pujaX + 0.22, puja.top + 0.03, puja.front - 0.02), 'brass');
  b.diya('puja.thali.diya', pujaX, puja.top + 0.03, puja.front - 0.22);
  b.diya('puja.diya.west', puja.minX + 0.12, puja.top, puja.front - 0.15);
  b.diya('puja.diya.east', puja.maxX - 0.12, puja.top, puja.front - 0.15);
  // Bell hanging from the canopy's east end, inside the shelf's footprint.
  const bellX = puja.maxX - 0.35;
  b.deco('puja.bell.chain', b.box(bellX - 0.01, 1.85, shelfFront + 0.05, bellX + 0.01, 2.3, shelfFront + 0.07), 'brass');
  b.deco('puja.bell', b.box(bellX - 0.07, 1.7, shelfFront - 0.01, bellX + 0.07, 1.85, shelfFront + 0.13), 'brass');
  // Rangoli on the floor in front of the chowki, a diya at its heart.
  const rangoliZ = puja.front + 0.75;
  b.deco('puja.rangoli', b.box(pujaX - 0.6, 0, rangoliZ - 0.45, pujaX + 0.6, 0.008, rangoliZ + 0.45), 'rangoliPink');
  b.deco('puja.rangoli.inner', b.box(pujaX - 0.35, 0.008, rangoliZ - 0.25, pujaX + 0.35, 0.012, rangoliZ + 0.25), 'rangoliTeal');
  b.diya('puja.rangoli.diya', pujaX, 0.012, rangoliZ);
  b.light('puja.lamp', b.at(pujaX, 2.6, puja.front + 0.6), 'low', '#ffb050', 7, 8);

  // ── Seating and sweets area (east) ─────────────────────────────────────
  // Sofa along the east wall: seat, backrest and arms.
  const sofa = { minX: hw - 0.8, minZ: -6.2, maxZ: -2.6 };
  b.solid('sofa.seat', 'furniture', b.box(sofa.minX, 0, sofa.minZ, hw, 0.45, sofa.maxZ), 'fabricRed');
  b.solid('sofa.back', 'furniture', b.box(hw - 0.25, 0.45, sofa.minZ, hw, 1.0, sofa.maxZ), 'fabricRed');
  b.solid('sofa.arm.north', 'furniture', b.box(sofa.minX, 0, sofa.minZ - 0.2, hw, 0.65, sofa.minZ), 'wood');
  b.solid('sofa.arm.south', 'furniture', b.box(sofa.minX, 0, sofa.maxZ, hw, 0.65, sofa.maxZ + 0.2), 'wood');
  for (let i = 0; i < 3; i++) {
    const z = sofa.minZ + 0.6 + i * 1.2;
    b.deco(`sofa.cushion.${i}`, b.box(hw - 0.3, 0.45, z - 0.35, hw - 0.25, 0.85, z + 0.35), 'cushion');
  }
  // Armchair north of the table, facing it.
  b.solid('armchair.seat', 'furniture', b.box(1.7, 0, -7.0, 2.7, 0.45, -6.2), 'fabricGold');
  b.solid('armchair.back', 'furniture', b.box(1.7, 0.45, -7.0, 2.7, 1.0, -6.8), 'fabricGold');
  // A cane moodha south of the table.
  b.solid('moodha', 'furniture', b.box(2.0, 0, -2.7, 2.4, 0.4, -2.3), 'cushion');
  // The low sweets table, its tray, and a cloth mat where the sharing plate
  // rests. The sweets and the plate itself are drawn by `SweetsScene` (#63),
  // since the tray is served only after aarti and the plate can be carried.
  const table = { minX: 1.6, maxX: 2.8, minZ: -5.2, maxZ: -3.6, top: 0.45 };
  const tableX = (table.minX + table.maxX) / 2;
  const tableZ = (table.minZ + table.maxZ) / 2;
  b.solid('sweets.table', 'furniture', b.box(table.minX, 0, table.minZ, table.maxX, table.top, table.maxZ), 'wood');
  b.deco('sweets.tray', b.box(tableX - 0.35, table.top, tableZ - 0.35, tableX + 0.35, table.top + 0.04, tableZ + 0.35), 'brass');
  const plate = b.mat('sweets.plateSpot', tableX + 0.3, table.top, table.maxZ - 0.2, 0.14, 0.005, 'fabricRed');
  const giftTable = b.mat('sweets.giftMat', table.minX + 0.2, table.top, table.minZ + 0.25, 0.16, 0.01, 'fabricGold');
  b.deco('seating.rug', b.box(0.8, 0, -6.0, 3.6, 0.006, -2.8), 'rug');
  b.light('seating.lamp', b.at(2.4, 2.7, -4.4), 'medium', '#ffc070', 6, 8);

  // ── Gift side table by the door (west) ────────────────────────────────
  const side = { minX: -hw, maxX: -hw + 0.7, minZ: -1.2, maxZ: -0.2, top: 0.8 };
  b.solid('gift.sideTable', 'furniture', b.box(side.minX, 0, side.minZ, side.maxX, side.top, side.maxZ), 'woodDark');
  const sideZ = (side.minZ + side.maxZ) / 2;
  const giftSpot = b.mat('gift.spot', (side.minX + side.maxX) / 2, side.top, sideZ, 0.2, 0.01, 'fabricGold');
  b.diya('gift.sideTable.diya', side.maxX - 0.12, side.top, side.maxZ - 0.12, true);

  // ── Walls: windows, curtains, lamps and garlands ──────────────────────
  for (const [i, z] of [
    [0, -6.0],
    [1, -3.2],
  ] as const) {
    b.deco(`window.west.${i}`, b.box(-hw, 1.0, z - 0.6, -hw + 0.03, 2.2, z + 0.6), 'windowNight');
    for (const s of [-1, 1] as const) {
      const cz = z + s * 0.75;
      b.deco(`window.west.${i}.curtain.${s}`, b.box(-hw, 0.9, cz - 0.18, -hw + 0.06, 2.4, cz + 0.18), 'curtain');
    }
    b.diya(`window.west.${i}.sill`, -hw + 0.05, 1.0, z, true);
  }
  // Wall lamps either side of the room; the one by the mandir is dressing dropped on Low.
  for (const [i, minX, maxX, minZ, maxZ] of [
    [0, -hw, -hw + 0.06, -4.7, -4.5],
    [1, hw - 0.06, hw, -1.5, -1.3],
    [2, -0.6, -0.4, northZ, northZ + 0.06],
  ] as const) {
    b.deco(`lamp.wall.${i}`, b.box(minX, 2.1, minZ, maxX, 2.35, maxZ), 'lampShade', i === 2);
  }
  // Marigold strings swagged along the north and east walls under the ceiling.
  b.deco('garland.north', b.box(-hw, h - 0.4, northZ, hw, h - 0.3, northZ + 0.05), 'marigold', true);
  b.deco('garland.east', b.box(hw - 0.05, h - 0.4, northZ, hw, h - 0.3, southZ), 'marigold', true);
  for (let k = 0; k < 8; k++) {
    const x = -hw + 0.6 + k * 1.1;
    b.deco(`garland.north.drop.${k}`, b.box(x - 0.03, h - 0.75, northZ, x + 0.03, h - 0.4, northZ + 0.05), 'marigold', true);
  }
  b.light('room.fill', b.at(0, 2.8, -1.6), 'high', '#ffa860', 4, 7);

  // ── Anchors ────────────────────────────────────────────────────────────
  const at = (x: number, z: number, yaw: number): Placement => ({ position: b.at(x, 0, z), yaw });
  const shrine = b.at(pujaX, 0, northZ);
  const around = (x: number, z: number): Placement => {
    const position = b.at(x, 0, z);
    return { position, yaw: facing(position, shrine) };
  };
  const gathering: Record<FamilyMemberId, Placement> = {
    mother: around(-3.8, -7.0),
    father: around(-1.2, -7.0),
    grandmother: around(-4.0, -5.9),
    grandfather: around(-1.0, -5.9),
    sibling: around(-1.7, -5.1),
  };
  const seats: Record<FamilyMemberId, Placement> = {
    father: at(hw - 0.45, sofa.minZ + 0.6, WEST),
    grandmother: at(hw - 0.45, sofa.minZ + 1.8, WEST),
    mother: at(hw - 0.45, sofa.minZ + 3.0, WEST),
    grandfather: at(2.2, -6.55, SOUTH),
    sibling: at(2.2, -2.5, NORTH),
  };

  // Walks to the seats keep to open floor: the aisle west of the table, the
  // gap between the armchair and the table, and the strip in front of the
  // sofa; the tray is served from the table's south side.
  const servingPosition = b.at(tableX - 0.3, 0, table.maxZ + 0.4);
  const serving: Placement = { position: servingPosition, yaw: facing(servingPosition, b.at(tableX, 0, tableZ)) };
  const aisle = b.at(1.0, 0, -5.7);
  const sofaFront = (z: number) => b.at(sofa.minX - 0.4, 0, z);
  const routes: Record<FamilyMemberId, readonly Vec3[]> = {
    mother: [b.at(0.9, 0, table.maxZ + 0.4), servingPosition, sofaFront(sofa.minZ + 3.0)],
    father: [aisle, sofaFront(-5.7)],
    grandmother: [aisle, sofaFront(-5.7), sofaFront(sofa.minZ + 1.8)],
    grandfather: [aisle, b.at(2.2, 0, -5.7)],
    sibling: [b.at(0.9, 0, -2.5)],
  };

  const pujaTarget = b.at(pujaX, 0, puja.front + 0.1);
  const trayTarget = b.at(tableX, 0, tableZ);
  const trayStand = b.at(table.minX - 0.45, 0, tableZ);
  const plateStand = b.at(tableX + 0.3, 0, table.maxZ + 0.45);
  const giftStand = b.at(side.maxX + 0.5, 0, sideZ);
  const doorStand = b.at(0, 0, -0.3);

  return {
    home: 'familyHome',
    bounds: b.box(-hw, -1, northZ, hw, h, southZ),
    door: anchor.door,
    arrival: anchor.arrival,
    solids: b.solids,
    decor: b.decor,
    lights: b.lights,
    ambient: { sky: '#ffd9a8', ground: '#5a3220', intensity: 1.1 },
    interactions: [
      {
        target: { kind: 'door', id: doorwayId('familyHome', 'exit'), position: anchor.door },
        stand: { position: doorStand, yaw: SOUTH },
        marker: 'door',
      },
      {
        target: { kind: 'puja', id: 'familyHome', position: pujaTarget },
        stand: { position: b.at(pujaX, 0, puja.front + 1.2), yaw: NORTH },
        marker: 'puja.chowki',
      },
      {
        target: { kind: 'tray', id: 'familyHome', position: trayTarget },
        stand: { position: trayStand, yaw: facing(trayStand, trayTarget) },
        marker: 'sweets.tray',
      },
      {
        target: { kind: 'returnSpot', id: 'sweetsPlate@familyHome', item: 'sweetsPlate', home: 'familyHome', position: plate },
        stand: { position: plateStand, yaw: facing(plateStand, plate) },
        marker: 'sweets.plateSpot',
      },
      {
        target: { kind: 'returnSpot', id: 'giftBox@familyHome', item: 'giftBox', home: 'familyHome', position: giftSpot },
        stand: { position: giftStand, yaw: facing(giftStand, giftSpot) },
        marker: 'gift.spot',
      },
    ],
    gathering,
    seats,
    routes,
    serving,
    thali,
    giftTable,
  };
}
