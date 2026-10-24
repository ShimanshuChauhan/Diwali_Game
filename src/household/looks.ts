import type { FamilyMemberId } from '../core/homes';
import type { Look } from '../people/figure';

/**
 * The family, drawn with the same festive figures as the street's
 * neighbours: Mummy in a rani-pink saree, Papa in a cream kurta and blue
 * Nehru jacket, Chhotu (the younger sibling) in yellow, Dadi in a white saree
 * with a red border, Dadaji in white with a brown jacket. Grey hair marks
 * the grandparents; Chhotu is child-sized.
 */
export const FAMILY_LOOKS: Readonly<Record<FamilyMemberId, Look>> = {
  mother: { outfit: 'saree', main: '#d81b60', trim: '#ffd54f', second: '#ffb300', skin: '#a0673a', hair: '#160f0c', hairStyle: 'bun', bindi: true },
  father: { outfit: 'kurta', main: '#f3e9d2', trim: '#d4a017', second: '#f3e9d2', jacket: '#1e4fa0', skin: '#8d5524', hair: '#1b1410', hairStyle: 'short', moustache: true },
  sibling: { outfit: 'kurta', main: '#fbc02d', trim: '#e65100', second: '#f3e9d2', skin: '#a0673a', hair: '#1b1410', hairStyle: 'short', scale: 0.72 },
  grandmother: { outfit: 'saree', main: '#f7f2e6', trim: '#c62828', second: '#c62828', skin: '#8d5524', hair: '#cfc8bd', hairStyle: 'bun', bindi: true },
  grandfather: { outfit: 'kurta', main: '#fbf7ee', trim: '#b8860b', second: '#fbf7ee', jacket: '#6d4c41', skin: '#7a4a26', hair: '#dcd8d0', hairStyle: 'short', moustache: true },
};

/** A grandparent's gentle stoop, added to every pose. */
export const FAMILY_STOOP: Readonly<Record<FamilyMemberId, number>> = {
  mother: 0,
  father: 0,
  sibling: 0,
  grandmother: 0.1,
  grandfather: 0.08,
};
