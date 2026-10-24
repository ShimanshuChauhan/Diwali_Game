import type { HomeSpotSet } from '../interaction';
import type { FamilyHomeLayout } from './layout';

/**
 * The interaction module's puja, tray and gift-box anchors, taken from the
 * built room rather than its defaults: the puja is where the player stands
 * to join, the tray is the sweets table, the gift spot is the side table.
 */
export function familyHomeSpots(layout: FamilyHomeLayout): HomeSpotSet {
  const find = (match: (target: FamilyHomeLayout['interactions'][number]['target']) => boolean) =>
    layout.interactions.find((i) => match(i.target));
  return {
    puja: find((t) => t.kind === 'puja')?.stand.position,
    tray: find((t) => t.kind === 'tray')?.target.position,
    giftSpot: find((t) => t.kind === 'returnSpot' && t.item === 'giftBox')?.target.position,
  };
}
