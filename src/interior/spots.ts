import type { HomeSpotSet } from '../interaction';
import type { FamilyHomeLayout, InteriorLayout } from './layout';
import type { NeighbourHomeLayout } from './neighbourHome';

type Target = InteriorLayout['interactions'][number]['target'];

const find = (layout: InteriorLayout, match: (target: Target) => boolean) => layout.interactions.find((i) => match(i.target));

/**
 * The interaction module's puja, tray and gift-box anchors, taken from the
 * built room rather than its defaults: the puja is where the player stands
 * to join, the tray is the sweets table, the gift spot is the side table.
 */
export function familyHomeSpots(layout: FamilyHomeLayout): HomeSpotSet {
  return {
    puja: find(layout, (t) => t.kind === 'puja')?.stand.position,
    tray: find(layout, (t) => t.kind === 'tray')?.target.position,
    giftSpot: find(layout, (t) => t.kind === 'returnSpot' && t.item === 'giftBox')?.target.position,
  };
}

/** The neighbour's mithai table and the return box's console; there is no puja next door. */
export function neighbourHomeSpots(layout: NeighbourHomeLayout): HomeSpotSet {
  return {
    tray: find(layout, (t) => t.kind === 'tray')?.target.position,
    giftSpot: find(layout, (t) => t.kind === 'returnSpot' && t.item === 'giftBox')?.target.position,
  };
}
