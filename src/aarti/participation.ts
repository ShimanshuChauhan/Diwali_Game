import type { GameAction, SelectSlot } from '../core/actions';
import type { MovementIntent } from '../core/contracts';
import { AARTI_SONG_IDS, type AartiCeremonyModule, type AartiSnapshot, type AartiSongId } from '../core/homes';
import type { Vec3 } from '../core/types';

/** The ceremony commands a participant's controls reach. */
export type ParticipantCeremony = Pick<AartiCeremonyModule, 'snapshot' | 'leave' | 'selectSong' | 'setCircling'>;

/** The number key that picks each song in the mini player, in selector order. */
export function songForSlot(slot: SelectSlot): AartiSongId | null {
  return AARTI_SONG_IDS[slot - 1] ?? null;
}

export function slotForSong(song: AartiSongId): SelectSlot {
  return (AARTI_SONG_IDS.indexOf(song) + 1) as SelectSlot;
}

/**
 * Route an action while the player takes part in aarti (PRD → Aarti state
 * and timing; Controls and layout). Returns true when the action was used
 * here; on false the caller passes it on unchanged.
 *
 * - Holding click circles the thali and letting go rests it. The song plays
 *   on either way: circling is presentation and never touches timing, and
 *   nothing is scored.
 * - 1–3 choose a song in the mini player (the hands are full, so they cannot
 *   mean crackers); 4 does nothing.
 * - E leaves: the thali goes down and movement comes back.
 * - Look, camera, pause and the held movement keys pass through, so the
 *   player can look round in either camera mode; `holdStill` keeps them in
 *   place, facing the puja.
 *
 * Song choice never touches the thali or leaves, and a release always
 * rests the thali, so it cannot stay circling after leaving or a pause.
 */
export function applyAartiAction(action: GameAction, ceremony: ParticipantCeremony): boolean {
  if (action.type === 'placeReleased') {
    ceremony.setCircling(false);
    return ceremony.snapshot.participating;
  }
  if (!ceremony.snapshot.participating) return false;
  switch (action.type) {
    case 'place':
      ceremony.setCircling(true);
      return true;
    case 'interact':
      ceremony.leave();
      return true;
    case 'select': {
      const song = songForSlot(action.slot);
      if (song) ceremony.selectSong(song);
      return true;
    }
    case 'move':
    case 'run':
    case 'look':
    case 'toggleCamera':
    case 'pause':
      return false;
  }
}

/**
 * A participant stands still, facing the puja: translation is off and the
 * body keeps `facing` (normally `facePuja` on joining), so the camera can
 * look round the player, and see the thali, in third person.
 */
export function holdStill(
  intent: MovementIntent,
  aarti: Pick<AartiSnapshot, 'participating'>,
  facing = intent.yaw,
): MovementIntent {
  return aarti.participating ? { ...intent, forward: 0, right: 0, yaw: facing } : intent;
}

/** Closer than this on the ground plane, the way to the puja is no direction at all. */
const AT_PUJA = 0.05;

/**
 * The yaw a participant at `feet` keeps while taking part: looking straight
 * at the puja at `puja` on the ground plane (yaw 0 looks down -Z), or
 * `fallback` when there is no puja or they stand right on it.
 */
export function facePuja(feet: Vec3, puja: Vec3 | undefined, fallback: number): number {
  if (!puja) return fallback;
  const dx = puja.x - feet.x;
  const dz = puja.z - feet.z;
  return Math.hypot(dx, dz) < AT_PUJA ? fallback : Math.atan2(-dx, -dz);
}
