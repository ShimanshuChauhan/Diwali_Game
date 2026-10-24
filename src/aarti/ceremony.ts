import { AARTI_RECORDINGS } from '../audio/aarti/recordings';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import {
  AARTI_SONG_IDS,
  type AartiCeremonyModule,
  type AartiRejection,
  type AartiSnapshot,
  type AartiSongId,
  type AartiState,
  type CommandResult,
  type HeldItemsModule,
  type LocationId,
} from '../core/homes';

/** The part of the held-items module the ceremony uses for the thali. */
export type CeremonyHands = Pick<HeldItemsModule, 'reserveThali' | 'release'>;

export interface AartiCeremonyOptions {
  readonly bus: GameEventBus;
  readonly hands: CeremonyHands;
  /**
   * Full length of a song's recording in seconds, or null while it is not
   * known (still loading, or failed). Defaults to the bundled catalogue.
   */
  readonly durationOf?: (song: AartiSongId) => number | null;
  /** Where the player is; joining needs the family home. Unchecked when absent. */
  readonly location?: () => LocationId;
  /** Song the ceremony starts with; the first in selector order by default. */
  readonly initialSong?: AartiSongId;
}

const OK: CommandResult<AartiRejection> = Object.freeze({ ok: true });

function catalogueDuration(song: AartiSongId): number | null {
  return AARTI_RECORDINGS[song]?.durationSeconds ?? null;
}

/**
 * The once-per-session family aarti: `waiting` until the player first joins,
 * `running` while the selected song's timeline advances, `completed` once it
 * reaches the recording's full duration.
 *
 * Time is unpaused simulation time from `update(dt)` alone, so the ceremony
 * keeps running while the player is away and freezes with the fixed step on
 * pause. Audio follows the snapshot and never drives the clock; the only
 * thing it may report is the natural end of the current recording, tagged
 * with its `playbackId`. Thali circling is intent for presentation and never
 * touches timing. Renderer-free.
 */
export class AartiCeremony implements AartiCeremonyModule {
  private readonly bus: GameEventBus;
  private readonly hands: CeremonyHands;
  private readonly durationOf: (song: AartiSongId) => number | null;
  private readonly location: (() => LocationId) | null;
  private readonly initialSong: AartiSongId;
  private readonly unsubscribes: Unsubscribe[] = [];

  private state: AartiState = 'waiting';
  private participating = false;
  private song: AartiSongId;
  private elapsed = 0;
  /** Committed when the song starts; the catalogue's value while waiting. */
  private duration = 0;
  private circling = false;
  private playbackId = 0;

  constructor(options: AartiCeremonyOptions) {
    this.bus = options.bus;
    this.hands = options.hands;
    this.durationOf = options.durationOf ?? catalogueDuration;
    this.location = options.location ?? null;
    this.initialSong = options.initialSong ?? AARTI_SONG_IDS[0];
    this.song = this.initialSong;
    // Held input is dropped on pause, so the thali comes to rest with it.
    this.unsubscribes.push(this.bus.on('paused', () => (this.circling = false)));
  }

  get snapshot(): AartiSnapshot {
    return {
      state: this.state,
      participating: this.participating,
      song: this.song,
      elapsed: this.elapsed,
      duration: this.state === 'waiting' ? (this.knownDuration(this.song) ?? 0) : this.duration,
      circling: this.circling,
      playbackId: this.playbackId,
    };
  }

  update(dt: number): void {
    if (this.state !== 'running' || !(dt > 0)) return;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) this.complete();
  }

  join(): CommandResult<AartiRejection> {
    if (this.state === 'completed') return this.reject('ceremonyCompleted');
    if (this.participating) return this.reject('alreadyParticipating');
    if (this.location && this.location() !== 'familyHome') return this.reject('wrongLocation');
    let duration = this.duration;
    if (this.state === 'waiting') {
      // Commit to the song only once its length is known.
      const known = this.knownDuration(this.song);
      if (known === null) return this.reject('songUnavailable');
      duration = known;
    }
    // The held-items module reports the specific item (`itemRejected`).
    if (!this.hands.reserveThali().ok) return this.reject('handsFull');

    if (this.state === 'waiting') {
      this.state = 'running';
      this.elapsed = 0;
      this.duration = duration;
    }
    this.participating = true;
    this.playbackId++;
    this.bus.emit('aartiJoined', { song: this.song, elapsed: this.elapsed, playbackId: this.playbackId });
    return OK;
  }

  leave(): CommandResult<AartiRejection> {
    if (!this.participating) return this.reject('notParticipating');
    this.stopParticipating();
    this.playbackId++;
    this.bus.emit('aartiLeft', { song: this.song, elapsed: this.elapsed });
    return OK;
  }

  selectSong(song: AartiSongId): CommandResult<AartiRejection> {
    if (this.state === 'completed') return this.reject('ceremonyCompleted');
    if (!this.participating) return this.reject('notParticipating');
    if (!AARTI_SONG_IDS.includes(song)) return this.reject('unknownSong');
    // Already playing it; there is no restart or repeat.
    if (song === this.song) return OK;
    const duration = this.knownDuration(song);
    if (duration === null) return this.reject('songUnavailable');

    this.song = song;
    this.elapsed = 0;
    this.duration = duration;
    this.playbackId++;
    this.bus.emit('aartiSongChanged', { song, duration, playbackId: this.playbackId });
    return OK;
  }

  setCircling(circling: boolean): CommandResult<AartiRejection> {
    // Resting is always allowed, so a release after leaving or completion is harmless.
    if (circling && !this.participating) return this.reject('notParticipating');
    this.circling = circling;
    return OK;
  }

  /**
   * Audio reports that the recording tagged `playbackId` played to its end.
   * The current one completes the ceremony even if simulation time lags the
   * file slightly; any older tag (left, song changed, completed, reset) is
   * ignored, so a replaced song can never be finished by its predecessor.
   * Returns true when it completed the ceremony.
   */
  playbackEnded(playbackId: number): boolean {
    if (playbackId !== this.playbackId || this.state !== 'running' || !this.participating) return false;
    this.elapsed = this.duration;
    this.complete();
    return true;
  }

  /** Fresh session: waiting again with the initial song. Silent; the hands reset themselves. */
  reset(): void {
    this.state = 'waiting';
    this.participating = false;
    this.song = this.initialSong;
    this.elapsed = 0;
    this.duration = 0;
    this.circling = false;
    this.playbackId++;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Once per session, whether or not the player is participating. */
  private complete(): void {
    const participating = this.participating;
    this.state = 'completed';
    this.elapsed = this.duration;
    if (participating) this.stopParticipating();
    this.playbackId++;
    this.bus.emit('aartiCompleted', { song: this.song, participating });
  }

  /** Put down the thali, freeing the hands and restoring movement. */
  private stopParticipating(): void {
    this.participating = false;
    this.circling = false;
    this.hands.release('thali');
  }

  private knownDuration(song: AartiSongId): number | null {
    const duration = this.durationOf(song);
    return duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  private reject(reason: AartiRejection): CommandResult<AartiRejection> {
    this.bus.emit('aartiRejected', { reason });
    return { ok: false, reason };
  }
}
