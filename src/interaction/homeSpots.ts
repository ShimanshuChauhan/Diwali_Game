import type { HomeId } from '../core/homes';
import type { Vec3 } from '../core/types';
import { HOME_ENTRANCES } from '../homes/doorways';

/** The fixed things the player can use inside one home. */
export interface HomeSpotSet {
  /** Where the player stands to join aarti; the family home only. */
  readonly puja?: Vec3;
  /** The sweets table: eat, take or return the plate, set down the return box. */
  readonly tray?: Vec3;
  /** Designated spot for this home's gift box (outbound at home, return at the neighbour's). */
  readonly giftSpot?: Vec3;
}

export type HomeSpots = Readonly<Record<HomeId, HomeSpotSet>>;

/** `x`, `z` metres from a home's interior door: +x east, -z into the room. */
function inside(home: HomeId, x: number, z: number): Vec3 {
  const door = HOME_ENTRANCES[home].interior.door;
  return { x: door.x + x, y: door.y, z: door.z + z };
}

/**
 * Default anchors, laid out from each interior's front door like the rooms
 * are (`HOME_ENTRANCES`): the puja corner at the back of the family room,
 * the sweets table to the east, the gift box west of the door, and the
 * neighbour's return box to the east of theirs. Interior presentation
 * (#55, #65) builds furniture round these and may pass its own.
 */
export const HOME_SPOTS: HomeSpots = {
  familyHome: {
    puja: inside('familyHome', 0, -6.5),
    tray: inside('familyHome', 2.5, -4),
    giftSpot: inside('familyHome', -2.5, -2.5),
  },
  neighbourHome: {
    giftSpot: inside('neighbourHome', 2.5, -2.5),
  },
};
