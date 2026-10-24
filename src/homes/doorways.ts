import type { DoorwaySnapshot, HomeId, Placement } from '../core/homes';
import type { Vec3 } from '../core/types';

/** Yaws for the compass directions; yaw 0 looks down -Z (north). */
const NORTH = 0;
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Where a home's front door is used from, on one side of it. */
export interface DoorSide {
  /** Where the player uses the door. */
  readonly door: Vec3;
  /** Where the player stands after coming through the door to this side. */
  readonly arrival: Placement;
}

export interface HomeEntrance {
  /** The street house whose front door leads in (a `house.*` id in the world layout). */
  readonly house: string;
  readonly street: DoorSide;
  readonly interior: DoorSide;
}

/**
 * The two enterable homes' front doors (issue #51 → Locations and
 * transitions). The family home is the pink house beside the spawn, west of
 * the lane; the neighbour is across the lane and one house north.
 *
 * Street doors are the layout's doorway zones (0.8 m out from the facade);
 * the player comes out 2 m from the facade, facing the lane, so the
 * third-person boom has room behind them and they stand clear of the door.
 *
 * Interiors are separate locations away from the street, since only the
 * active location is drawn and no doorway traversal is seamless. Each room
 * is built north (-Z) of its front door, which sits in its south wall; the
 * player arrives 1.5 m inside, facing into the room. Interior presentation
 * builds the rooms (#55, #65) around these anchors.
 */
export const HOME_ENTRANCES: Readonly<Record<HomeId, HomeEntrance>> = {
  familyHome: {
    house: 'house.lane.w0',
    street: { door: v(-3.2, 0, 4.5), arrival: { position: v(-2, 0, 4.5), yaw: EAST } },
    interior: { door: v(0, 0, 100), arrival: { position: v(0, 0, 98.5), yaw: NORTH } },
  },
  neighbourHome: {
    house: 'house.lane.e1',
    street: { door: v(3.2, 0, -2.5), arrival: { position: v(2, 0, -2.5), yaw: WEST } },
    interior: { door: v(40, 0, 100), arrival: { position: v(40, 0, 98.5), yaw: NORTH } },
  },
};

/** Doorway ids: `<home>.enter` from the street, `<home>.exit` from inside. */
export function doorwayId(home: HomeId, side: 'enter' | 'exit'): string {
  return `${home}.${side}`;
}

/** Both sides of each home's front door, as the locations module uses them. */
export function homeDoorways(entrances: Readonly<Record<HomeId, HomeEntrance>> = HOME_ENTRANCES): DoorwaySnapshot[] {
  return (Object.keys(entrances) as HomeId[]).flatMap((home) => {
    const { street, interior } = entrances[home];
    return [
      {
        id: doorwayId(home, 'enter'),
        location: 'outdoors',
        destination: home,
        position: street.door,
        arrival: interior.arrival,
      },
      {
        id: doorwayId(home, 'exit'),
        location: home,
        destination: 'outdoors',
        position: interior.door,
        arrival: street.arrival,
      },
    ];
  });
}
