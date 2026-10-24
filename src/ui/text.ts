import type { CameraMode, CrackerType, IgnitionRejection, PlacementRejection, QualityLevel } from '../core/types';

/**
 * Player-facing wording for the HUD and pause menu. Plain data so the
 * rules that pick a line can be tested without a DOM.
 */

export const CRACKER_LABELS: Readonly<Record<CrackerType, string>> = {
  phuljhari: 'Phuljhari',
  anar: 'Anar',
  chakri: 'Chakri',
  rocket: 'Rocket',
};

export const QUALITY_LABELS: Readonly<Record<QualityLevel, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = {
  firstPerson: 'First person',
  thirdPerson: 'Third person',
};

/** Why a ground cracker cannot go where the player is aiming. */
export const PLACEMENT_REJECTION_TEXT: Readonly<Record<PlacementRejection, string>> = {
  outOfReach: 'Too far away — move closer to place it',
  unsupportedSurface: 'Needs flat, open ground to stand on',
  blockedByGeometry: 'Not enough room here — too close to something',
  nearDoorway: 'Keep doorways clear',
  nearNeighbour: 'Too close to a neighbour — give them some space',
  noSkyClearance: 'Rockets need open sky above them',
  capacity: 'Too many crackers placed — light or wait for some to finish',
  handheldOnly: 'The phuljhari is held, not placed — press E to light it',
};

/** Why lighting a cracker was refused. */
export const IGNITION_REJECTION_TEXT: Readonly<Record<IgnitionRejection, string>> = {
  notFound: 'That cracker is no longer there',
  alreadyLit: 'Already lit — step back and watch',
  outOfReach: 'Too far away to light — move closer',
  capacity: 'Too many fireworks going off — wait a moment',
};

export type RejectionKind = 'placement' | 'ignition';

/**
 * Readable text for a rejection reason. `outOfReach` and `capacity` exist
 * for both placing and lighting, so `kind` picks the wording; an ignition
 * reason that placement lacks is always worded as ignition.
 */
export function rejectionText(reason: PlacementRejection | IgnitionRejection, kind: RejectionKind = 'placement'): string {
  if (kind === 'ignition' && Object.hasOwn(IGNITION_REJECTION_TEXT, reason)) {
    return IGNITION_REJECTION_TEXT[reason as IgnitionRejection];
  }
  if (Object.hasOwn(PLACEMENT_REJECTION_TEXT, reason)) return PLACEMENT_REJECTION_TEXT[reason as PlacementRejection];
  return IGNITION_REJECTION_TEXT[reason as IgnitionRejection];
}

/** Key hints listed in the pause menu's controls help. */
export const CONTROLS_HELP: readonly (readonly [string, string])[] = [
  ['WASD', 'Move'],
  ['Shift', 'Run'],
  ['Mouse', 'Look'],
  ['1–4', 'Select phuljhari · anar · chakri · rocket'],
  ['Click', 'Place the selected ground cracker'],
  ['E', 'Light a nearby cracker or diya, or the held phuljhari'],
  ['V', 'Switch first / third person'],
  ['Esc', 'Pause'],
];
