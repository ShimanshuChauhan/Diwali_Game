import type { Unsubscribe } from '../../core/eventBus';
import type { GameEventBus } from '../../core/events';
import type {
  AartiAudioModule,
  AartiRecording as CatalogueEntry,
  AartiSnapshot,
  AartiSongId,
  RecordingLoadState,
} from '../../core/homes';
import type { MusicOutput } from '../audioEngine';
import { AARTI_RECORDINGS, aartiRecordings, type AartiAccompaniment, type AartiRecording } from './recordings';

/**
 * Seconds the playing recording may wander from ceremony time (e.g. after a
 * long frame or a slow context resume) before it is seeked back into place.
 */
export const DRIFT_TOLERANCE = 0.75;

export interface AartiAudioOptions {
  readonly bus: GameEventBus;
  /** Where to play, normally `AudioEngine.musicOutput`; null while audio is locked. */
  readonly output: () => MusicOutput | null;
  /** Normally the ceremony's `playbackEnded`: the recording tagged `playbackId` played to its end. */
  readonly onPlaybackEnded?: (playbackId: number) => void;
  /**
   * Fetch and decode one recording; `context` is the music context once
   * unlocked. Defaults to `fetch` plus `decodeAudioData`. Tests inject a fake.
   */
  readonly loadBuffer?: (recording: AartiRecording, context: BaseAudioContext | null) => Promise<AudioBuffer>;
  readonly catalogue?: Readonly<Record<AartiSongId, AartiRecording>>;
}

interface Playing {
  readonly playbackId: number;
  readonly song: AartiSongId;
  readonly source: AudioBufferSourceNode;
  readonly context: BaseAudioContext;
  /** Context time at which buffer position `offset` was playing. */
  readonly startTime: number;
  readonly offset: number;
}

/**
 * Recorded aarti playback (PRD → Recorded aarti audio): plays the selected
 * recording from the ceremony's elapsed offset, only while the player
 * participates, through at most one source.
 *
 * It follows `AartiSnapshot`s passed to `sync()` (normally every frame) and
 * never moves ceremony time. Playback restarts only when the snapshot's
 * `playbackId` changes (join, rejoin, song change) or it drifts past
 * `DRIFT_TOLERANCE`; leaving, completion and a door transition silence it.
 * The only thing it reports back is the natural end of the current source,
 * tagged with its `playbackId`, so a stale callback cannot finish a
 * replacement song.
 *
 * Unlock, mute and master gain come from the audio engine's music output,
 * so muting never touches timing. Pause and focus loss (`paused`) stop the
 * source outright instead of trusting the context suspend, which lands
 * asynchronously: nothing sounds, drifts or ends while the ceremony is
 * frozen. The first sync after `resumed` starts one fresh source at the
 * ceremony's elapsed offset. A load or decode failure
 * emits `aartiAudioFailed` and leaves the ceremony as it was: it keeps
 * running on its own clock, and `durationOf` refuses the failed song so the
 * player cannot switch to it until a retry succeeds.
 */
export class AartiAudio implements AartiAudioModule {
  readonly catalogue: readonly CatalogueEntry[];

  private readonly bus: GameEventBus;
  private readonly output: () => MusicOutput | null;
  private readonly onPlaybackEnded: (playbackId: number) => void;
  private readonly loadBuffer: (recording: AartiRecording, context: BaseAudioContext | null) => Promise<AudioBuffer>;
  private readonly recordings: Readonly<Record<AartiSongId, AartiRecording>>;
  private readonly unsubscribes: Unsubscribe[] = [];

  // Decoded files are assets, not session state: they survive `reset()`.
  private readonly buffers = new Map<AartiSongId, AudioBuffer>();
  private readonly pending = new Map<AartiSongId, Promise<number>>();
  private readonly failed = new Set<AartiSongId>();
  /** The playback each failed song last failed for; `sync` retries on a later one. */
  private readonly failedFor = new Map<AartiSongId, number>();

  private playing: Playing | null = null;
  /** The latest snapshot's `playbackId`. */
  private currentId: number | null = null;
  /** A playback that is over for audio (ended, transitioned away); stays silent until the id changes. */
  private silencedId: number | null = null;
  /** The session is paused or lost focus: silent until it resumes. */
  private suspended = false;

  constructor(options: AartiAudioOptions) {
    this.bus = options.bus;
    this.output = options.output;
    this.onPlaybackEnded = options.onPlaybackEnded ?? (() => undefined);
    this.loadBuffer = options.loadBuffer ?? fetchAndDecode;
    this.recordings = options.catalogue ?? AARTI_RECORDINGS;
    this.catalogue = aartiRecordings(this.recordings).map(catalogueEntry);
    this.unsubscribes.push(
      this.bus.on('aartiLeft', () => this.stop()),
      this.bus.on('aartiCompleted', () => this.stop()),
      // Participants cannot use doors, but a fade must never carry the song along.
      this.bus.on('transitionStarted', () => {
        this.stop();
        this.silencedId = this.currentId;
      }),
      this.bus.on('paused', () => {
        this.suspended = true;
        this.stop();
      }),
      this.bus.on('resumed', () => (this.suspended = false)),
      this.bus.on('sessionStarted', () => (this.suspended = false)),
    );
  }

  /** 0 or 1. */
  get activeSources(): number {
    return this.playing ? 1 : 0;
  }

  loadState(song: AartiSongId): RecordingLoadState {
    if (this.buffers.has(song)) return 'ready';
    if (this.pending.has(song)) return 'loading';
    return this.failed.has(song) ? 'failed' : 'unloaded';
  }

  /**
   * The length the ceremony should commit to, known from the catalogue
   * before the file loads; null once the song has failed to load.
   */
  durationOf(song: AartiSongId): number | null {
    if (this.failed.has(song)) return null;
    return this.recordings[song]?.durationSeconds ?? null;
  }

  /**
   * Whether the family's own bell or clap effect may sound now: not while
   * the playing recording already contains it.
   */
  layerAllowed(sound: AartiAccompaniment): boolean {
    return !this.playing || !this.recordings[this.playing.song].includes.includes(sound);
  }

  /** Fetch and decode `song`; resolves with its decoded length. Retries a failed song. */
  load(song: AartiSongId): Promise<number> {
    const buffer = this.buffers.get(song);
    if (buffer) return Promise.resolve(buffer.duration);
    const pending = this.pending.get(song);
    if (pending) return pending;
    const recording = this.recordings[song];
    if (!recording) return Promise.reject(new Error(`Unknown aarti song: ${song}`));
    const promise = this.fetchRecording(recording).finally(() => this.pending.delete(song));
    this.pending.set(song, promise);
    return promise;
  }

  sync(snapshot: AartiSnapshot): void {
    this.currentId = snapshot.playbackId;
    if (snapshot.state !== 'running' || !snapshot.participating || snapshot.playbackId === this.silencedId) {
      this.stop();
      return;
    }
    const buffer = this.buffers.get(snapshot.song);
    if (this.suspended) {
      // Frozen with the ceremony; a song chosen meanwhile can still load.
      this.stop();
      if (!buffer) this.requestLoad(snapshot.song, snapshot.playbackId);
      return;
    }
    const playing = this.playing;
    if (playing && playing.playbackId === snapshot.playbackId && playing.song === snapshot.song) {
      if (!this.drifted(playing, snapshot.elapsed)) return;
    }

    const output = this.output();
    if (!output || !buffer) {
      // Silent until the gesture unlocks audio or the file arrives, then
      // starts wherever the ceremony has reached by that time.
      this.stop();
      if (!buffer) this.requestLoad(snapshot.song, snapshot.playbackId);
      return;
    }
    this.start(output, buffer, snapshot);
  }

  /** Fresh session: silent, with failed songs retried. Decoded files are kept; pause stays the session's. */
  reset(): void {
    this.stop();
    this.currentId = null;
    this.silencedId = null;
    this.failed.clear();
    this.failedFor.clear();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.stop();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async fetchRecording(recording: AartiRecording): Promise<number> {
    try {
      const buffer = await this.loadBuffer(recording, this.output()?.context ?? null);
      if (!(buffer.duration > 0)) throw new Error('the decoded recording is empty');
      this.buffers.set(recording.id, buffer);
      this.failed.delete(recording.id);
      return buffer.duration;
    } catch (error) {
      console.warn(`Aarti recording "${recording.title}" could not be loaded:`, error);
      this.failed.add(recording.id);
      this.bus.emit('aartiAudioFailed', { song: recording.id, message: failureMessage(recording) });
      throw error;
    }
  }

  /** Load for `sync`, once per playback: a failure is retried only on a later join or song change. */
  private requestLoad(song: AartiSongId, playbackId: number): void {
    if (this.pending.has(song) || this.failedFor.get(song) === playbackId) return;
    this.load(song).catch(() => this.failedFor.set(song, playbackId));
  }

  private start(output: MusicOutput, buffer: AudioBuffer, snapshot: AartiSnapshot): void {
    this.stop();
    const offset = Math.max(0, snapshot.elapsed);
    // The file is over (it is shorter than the ceremony); the ceremony's own clock finishes it.
    if (offset >= buffer.duration) {
      this.silencedId = snapshot.playbackId;
      return;
    }
    const { context, destination } = output;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const playing: Playing = {
      playbackId: snapshot.playbackId,
      song: snapshot.song,
      source,
      context,
      startTime: context.currentTime,
      offset,
    };
    source.onended = () => this.ended(playing);
    source.start(context.currentTime, offset);
    this.playing = playing;
  }

  /** A source finished. Only the current one reports; replaced or stopped ones are stale. */
  private ended(playing: Playing): void {
    if (this.playing !== playing) return;
    this.stop();
    this.silencedId = playing.playbackId;
    this.onPlaybackEnded(playing.playbackId);
  }

  /** Stop and reclaim the source at once, so two recordings never overlap. */
  private stop(): void {
    const playing = this.playing;
    if (!playing) return;
    this.playing = null;
    playing.source.onended = null;
    playing.source.stop();
    playing.source.disconnect();
  }

  /** Only a running context advances; while it is still resuming or the browser interrupts it, wait. */
  private drifted(playing: Playing, elapsed: number): boolean {
    if (playing.context.state !== 'running') return false;
    const position = playing.offset + (playing.context.currentTime - playing.startTime);
    return Math.abs(position - elapsed) > DRIFT_TOLERANCE;
  }
}

/** Player-facing feedback for a failed recording. */
export function failureMessage(recording: Pick<AartiRecording, 'title'>): string {
  return `Couldn't load "${recording.title}". The aarti carries on; rejoin to try again or choose another song.`;
}

/** The contract's catalogue row for one recording. */
function catalogueEntry(recording: AartiRecording): CatalogueEntry {
  const common = {
    id: recording.id,
    title: recording.title,
    duration: recording.durationSeconds,
    asset: recording.file,
  };
  if (recording.status === 'approved') {
    const p = recording.provenance;
    return {
      ...common,
      performer: p.performer,
      source: p.sourceUrl,
      licence: p.licence,
      attribution: p.attribution,
      approved: true,
    };
  }
  return {
    ...common,
    performer: 'Placeholder bell pattern',
    source: 'scripts/make-aarti-placeholders.mjs',
    licence: 'None: development placeholder, must not ship',
    attribution: '',
    approved: false,
  };
}

async function fetchAndDecode(recording: AartiRecording, context: BaseAudioContext | null): Promise<AudioBuffer> {
  const response = await fetch(recording.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${recording.file}`);
  const bytes = await response.arrayBuffer();
  // Buffers play in any context, so a file can decode before the unlock gesture.
  const decoder =
    context ?? (typeof OfflineAudioContext === 'undefined' ? null : new OfflineAudioContext(1, 1, 44100));
  if (!decoder) throw new Error('Web Audio is unavailable');
  return decoder.decodeAudioData(bytes);
}
