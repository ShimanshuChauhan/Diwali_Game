import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import { AartiAudio, DRIFT_TOLERANCE, type AartiAudioOptions } from '../src/audio/aarti/aartiAudio';
import { AARTI_RECORDINGS, type AartiRecording } from '../src/audio/aarti/recordings';
import { AudioEngine } from '../src/audio/audioEngine';
import { createGameEventBus, type GameEvents } from '../src/core/events';
import { AARTI_SONG_IDS, type AartiSongId } from '../src/core/homes';
import { FakeAudioContext, type FakeSource } from './fakeAudioContext';

const STEP = 1 / 60;
const SECONDS = AARTI_RECORDINGS.omJaiJagdishHare.durationSeconds;

interface Deferred {
  readonly recording: AartiRecording;
  resolve(): void;
  reject(error?: Error): void;
}

/**
 * The game's audio path headless: a fake context behind the real engine,
 * the real ceremony driving `AartiAudio` through `sync` once per frame.
 * `instant` decodes immediately; otherwise loads wait in `loads` until the
 * test settles them.
 */
async function setup(options: { instant?: boolean; unlock?: boolean } & Partial<AartiAudioOptions> = {}) {
  const { instant = true, unlock = true, ...overrides } = options;
  const bus = createGameEventBus();
  const ctx = new FakeAudioContext();
  const engine = new AudioEngine({ bus, createContext: () => ctx.asAudioContext(), random: () => 0.5 });
  if (unlock) await engine.unlock();
  // Only the aarti's sources, not the engine's ambience bed.
  const decoded = new Set<unknown>();
  const recordingSources = () => ctx.sources.filter((source) => decoded.has(source.buffer));
  const sounding = () => recordingSources().filter((source) => source.sounding);

  const loads: Deferred[] = [];
  const buffer = (recording: AartiRecording) => {
    const decodedBuffer = ctx.createBuffer(1, Math.round(recording.durationSeconds * ctx.sampleRate), ctx.sampleRate);
    decoded.add(decodedBuffer);
    return decodedBuffer as unknown as AudioBuffer;
  };
  const loadBuffer = vi.fn(
    (recording: AartiRecording) =>
      new Promise<AudioBuffer>((resolve, reject) => {
        if (instant) resolve(buffer(recording));
        else loads.push({ recording, resolve: () => resolve(buffer(recording)), reject: (e) => reject(e ?? new Error('404')) });
      }),
  );

  let ceremony: AartiCeremony | null = null;
  const audio = new AartiAudio({
    bus,
    output: () => engine.musicOutput,
    onPlaybackEnded: (id) => ceremony?.playbackEnded(id),
    loadBuffer,
    ...overrides,
  });
  ceremony = new AartiCeremony({
    bus,
    hands: { reserveThali: () => ({ ok: true }), release: () => undefined },
    durationOf: (song) => audio.durationOf(song),
  });
  const c = ceremony;

  const failures: GameEvents['aartiAudioFailed'][] = [];
  bus.on('aartiAudioFailed', (payload) => failures.push(payload));

  /** One frame: the fixed step, then audio follows the snapshot. */
  const frame = () => {
    c.update(STEP);
    ctx.currentTime += STEP;
    audio.sync(c.snapshot);
  };
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) frame();
  };
  /** Sync (requesting any load), let pending loads settle, then sync again. */
  const settle = async () => {
    audio.sync(c.snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    audio.sync(c.snapshot);
  };
  const join = async () => {
    expect(c.join().ok).toBe(true);
    await settle();
  };
  return { bus, ctx, engine, audio, ceremony: c, loads, loadBuffer, failures, recordingSources, sounding, frame, run, settle, join };
}

function onlySounding(sounding: () => FakeSource[]): FakeSource {
  const list = sounding();
  expect(list).toHaveLength(1);
  return list[0]!;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AartiAudio — catalogue', () => {
  it('lists every song with title, source, licence, attribution, duration and asset', async () => {
    const { audio } = await setup();
    expect(audio.catalogue.map((entry) => entry.id)).toEqual([...AARTI_SONG_IDS]);
    for (const entry of audio.catalogue) {
      const recording = AARTI_RECORDINGS[entry.id];
      expect(entry).toMatchObject({ title: recording.title, duration: recording.durationSeconds, asset: recording.file });
      expect(entry.performer).not.toBe('');
      expect(entry.source).not.toBe('');
      expect(entry.licence).not.toBe('');
      // Placeholders are never presented as shippable.
      expect(entry.approved).toBe(recording.status === 'approved');
    }
  });

  it('knows each duration before anything loads, so the ceremony can commit', async () => {
    const { audio, loadBuffer } = await setup();
    for (const song of AARTI_SONG_IDS) {
      expect(audio.loadState(song)).toBe('unloaded');
      expect(audio.durationOf(song)).toBe(AARTI_RECORDINGS[song].durationSeconds);
    }
    expect(loadBuffer).not.toHaveBeenCalled();
  });

  it('shares one load per song and resolves with the decoded length', async () => {
    const { audio, loadBuffer } = await setup();
    const [a, b] = [audio.load('jaiLakshmiMata'), audio.load('jaiLakshmiMata')];
    expect(audio.loadState('jaiLakshmiMata')).toBe('loading');
    expect(await a).toBeCloseTo(SECONDS);
    expect(await b).toBeCloseTo(SECONDS);
    expect(audio.loadState('jaiLakshmiMata')).toBe('ready');
    await audio.load('jaiLakshmiMata');
    expect(loadBuffer).toHaveBeenCalledTimes(1);
  });
});

describe('AartiAudio — offsets', () => {
  it('plays nothing while the ceremony waits', async () => {
    const { audio, ceremony, run, recordingSources } = await setup();
    audio.sync(ceremony.snapshot);
    run(2);
    expect(recordingSources()).toHaveLength(0);
    expect(audio.activeSources).toBe(0);
  });

  it('starts the selected recording from zero on the first join', async () => {
    const { audio, engine, join, sounding } = await setup();
    await join();
    const source = onlySounding(sounding);
    expect(source.startOffset).toBe(0);
    expect(source.outputs).toEqual([engine.musicOutput!.destination]);
    expect(audio.activeSources).toBe(1);
  });

  it('keeps one source playing across frames instead of re-seeking', async () => {
    const { join, run, recordingSources } = await setup();
    await join();
    run(5);
    expect(recordingSources()).toHaveLength(1);
  });

  it('rejoins at the ceremony elapsed offset after time away', async () => {
    const { audio, ceremony, join, run, sounding } = await setup();
    await join();
    run(3);
    ceremony.leave();
    run(4);
    await join();
    const source = onlySounding(sounding);
    expect(source.startOffset).toBeCloseTo(ceremony.snapshot.elapsed, 5);
    expect(source.startOffset).toBeCloseTo(7, 1);
    expect(audio.activeSources).toBe(1);
  });

  it('starts a changed song from its beginning with its own buffer', async () => {
    const { ceremony, join, run, settle, sounding, recordingSources } = await setup();
    await join();
    run(4);
    const first = onlySounding(sounding);
    ceremony.selectSong('jaiGaneshDeva');
    await settle();
    const second = onlySounding(sounding);
    expect(second).not.toBe(first);
    expect(second.startOffset).toBe(0);
    expect(second.buffer).not.toBe(first.buffer);
    expect(first.outputs).toEqual([]);
    expect(recordingSources()).toHaveLength(2);
  });

  it('re-seeks once when the recording drifts past the tolerance', async () => {
    const { ctx, audio, ceremony, join, run, sounding, recordingSources } = await setup();
    await join();
    run(1);
    // The context's clock stalls while the simulation keeps stepping.
    let stalled = 0;
    while (recordingSources().length === 1 && stalled < 2) {
      ceremony.update(STEP);
      audio.sync(ceremony.snapshot);
      stalled += STEP;
    }
    expect(stalled).toBeCloseTo(DRIFT_TOLERANCE, 1);
    expect(recordingSources()).toHaveLength(2);
    expect(onlySounding(sounding).startOffset).toBeCloseTo(ceremony.snapshot.elapsed, 5);
    run(2);
    expect(recordingSources()).toHaveLength(2);
    expect(ctx.state).toBe('running');
  });

  it('does not re-seek while the context is suspended for pause', async () => {
    const { ctx, bus, audio, ceremony, join, recordingSources } = await setup();
    await join();
    bus.emit('paused', {} as GameEvents['paused']);
    await Promise.resolve();
    expect(ctx.state).toBe('suspended');
    for (let i = 0; i < 120; i++) audio.sync(ceremony.snapshot);
    expect(recordingSources()).toHaveLength(1);
  });
});

describe('AartiAudio — single source', () => {
  it('never layers voices through rejoins and song changes', async () => {
    const { audio, ceremony, join, run, settle, sounding } = await setup();
    await join();
    for (const song of ['jaiLakshmiMata', 'jaiGaneshDeva', 'omJaiJagdishHare'] as AartiSongId[]) {
      run(1);
      ceremony.selectSong(song);
      await settle();
      expect(sounding()).toHaveLength(1);
      ceremony.leave();
      audio.sync(ceremony.snapshot);
      expect(sounding()).toHaveLength(0);
      await join();
      expect(sounding()).toHaveLength(1);
    }
    expect(audio.activeSources).toBe(1);
  });

  it('silences playback when the player leaves while ceremony time advances', async () => {
    const { audio, ceremony, join, run, sounding } = await setup();
    await join();
    run(2);
    const source = onlySounding(sounding);
    ceremony.leave();
    expect(sounding()).toHaveLength(0);
    expect(source.onended).toBeNull();
    expect(source.outputs).toEqual([]);
    const elapsed = ceremony.snapshot.elapsed;
    run(3);
    expect(ceremony.snapshot.elapsed).toBeCloseTo(elapsed + 3, 5);
    expect(sounding()).toHaveLength(0);
    expect(audio.activeSources).toBe(0);
  });

  it('stops for a door transition and stays silent until the next playback', async () => {
    const { bus, ceremony, join, run, settle, sounding } = await setup();
    await join();
    bus.emit('transitionStarted', { doorway: 'familyFront', from: 'familyHome', to: 'outdoors', duration: 0.6 });
    expect(sounding()).toHaveLength(0);
    run(1);
    expect(sounding()).toHaveLength(0);
    ceremony.selectSong('jaiLakshmiMata');
    await settle();
    expect(sounding()).toHaveLength(1);
  });

  it('stops on completion, including completion by ceremony time', async () => {
    const { ceremony, join, run, sounding } = await setup();
    await join();
    run(SECONDS + 1);
    expect(ceremony.snapshot.state).toBe('completed');
    expect(sounding()).toHaveLength(0);
  });

  it('detects completion while absent without playing anything', async () => {
    const { ceremony, join, run, recordingSources } = await setup();
    await join();
    ceremony.leave();
    const started = recordingSources().length;
    run(SECONDS + 1);
    expect(ceremony.snapshot.state).toBe('completed');
    expect(recordingSources()).toHaveLength(started);
  });

  it('reclaims its source and listeners on dispose', async () => {
    const { bus, audio, join, sounding } = await setup();
    const listeners = bus.listenerCount('aartiLeft');
    await join();
    audio.dispose();
    expect(sounding()).toHaveLength(0);
    expect(audio.activeSources).toBe(0);
    expect(bus.listenerCount('aartiLeft')).toBe(listeners - 1);
  });

  it('is silent again after a fresh-session reset', async () => {
    const { audio, ceremony, join, sounding } = await setup();
    await join();
    audio.reset();
    ceremony.reset();
    audio.sync(ceremony.snapshot);
    expect(sounding()).toHaveLength(0);
  });
});

describe('AartiAudio — end callbacks', () => {
  it('completes the ceremony when the current recording ends', async () => {
    const { ceremony, join, run, sounding } = await setup();
    await join();
    run(2);
    onlySounding(sounding).onended!();
    expect(ceremony.snapshot.state).toBe('completed');
  });

  it('ignores the end of a replaced song', async () => {
    const { ceremony, join, settle, sounding } = await setup();
    await join();
    const first = onlySounding(sounding);
    const handler = first.onended!;
    ceremony.selectSong('jaiLakshmiMata');
    await settle();
    // The browser fires `ended` for the stopped source after the switch.
    handler();
    expect(ceremony.snapshot.state).toBe('running');
    expect(sounding()).toHaveLength(1);
  });

  it('ignores the end of a source stopped by leaving, even after rejoining', async () => {
    const { ceremony, join, sounding } = await setup();
    await join();
    const handler = onlySounding(sounding).onended!;
    ceremony.leave();
    handler();
    await join();
    handler();
    expect(ceremony.snapshot.state).toBe('running');
    expect(sounding()).toHaveLength(1);
  });

  it('does not restart a recording that has ended', async () => {
    const onPlaybackEnded = vi.fn();
    const { audio, ceremony, join, run, recordingSources } = await setup({ onPlaybackEnded });
    await join();
    recordingSources()[0]!.onended!();
    expect(onPlaybackEnded).toHaveBeenCalledWith(ceremony.snapshot.playbackId);
    run(1);
    expect(recordingSources()).toHaveLength(1);
    expect(audio.activeSources).toBe(0);
  });
});

describe('AartiAudio — mute and unlock', () => {
  it('mutes through the master gain without touching playback or timing', async () => {
    const { ctx, engine, ceremony, join, run, sounding, recordingSources } = await setup();
    await join();
    run(2);
    engine.setMuted(true);
    const master = ctx.gains[0]!;
    expect(master.gain.value).toBe(0);
    run(3);
    expect(ceremony.snapshot.elapsed).toBeCloseTo(5, 1);
    expect(sounding()).toHaveLength(1);
    engine.setMuted(false);
    run(1);
    expect(recordingSources()).toHaveLength(1);
    expect(master.gain.value).toBeGreaterThan(0);
  });

  it('starts at the elapsed offset once a later gesture unlocks audio', async () => {
    const { engine, ceremony, run, settle, sounding } = await setup({ unlock: false });
    expect(ceremony.join().ok).toBe(true);
    run(2);
    await settle();
    expect(sounding()).toHaveLength(0);
    await engine.unlock();
    run(STEP);
    expect(onlySounding(sounding).startOffset).toBeCloseTo(ceremony.snapshot.elapsed, 5);
  });
});

describe('AartiAudio — loading and failure', () => {
  it('starts a slow load wherever the ceremony has reached when it arrives', async () => {
    const { ceremony, loads, run, settle, sounding } = await setup({ instant: false });
    expect(ceremony.join().ok).toBe(true);
    run(1.5);
    expect(sounding()).toHaveLength(0);
    expect(loads).toHaveLength(1);
    loads[0]!.resolve();
    await settle();
    expect(onlySounding(sounding).startOffset).toBeCloseTo(1.5, 1);
  });

  it('reports a failed load visibly, stays silent and never completes the ceremony', async () => {
    const onPlaybackEnded = vi.fn();
    const { audio, ceremony, loads, run, settle, failures, sounding } = await setup({ instant: false, onPlaybackEnded });
    expect(ceremony.join().ok).toBe(true);
    audio.sync(ceremony.snapshot);
    loads[0]!.reject();
    await settle();
    expect(audio.loadState('omJaiJagdishHare')).toBe('failed');
    expect(failures).toEqual([{ song: 'omJaiJagdishHare', message: expect.stringContaining('Om Jai Jagdish Hare') }]);
    run(3);
    // No retry storm within the same playback, and no audio-driven completion.
    expect(loads).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(sounding()).toHaveLength(0);
    expect(onPlaybackEnded).not.toHaveBeenCalled();
    expect(ceremony.snapshot.state).toBe('running');
  });

  it('leaves the controls usable after a failure', async () => {
    const { audio, ceremony, loads, run, settle, sounding } = await setup({ instant: false });
    expect(ceremony.join().ok).toBe(true);
    audio.sync(ceremony.snapshot);
    loads[0]!.reject();
    await settle();

    // Switching to another song works and plays it.
    expect(ceremony.selectSong('jaiLakshmiMata').ok).toBe(true);
    audio.sync(ceremony.snapshot);
    loads[1]!.resolve();
    await settle();
    expect(onlySounding(sounding).startOffset).toBe(0);

    // The failed song is refused, so the playing one keeps its state.
    const before = ceremony.snapshot;
    expect(ceremony.selectSong('omJaiJagdishHare')).toEqual({ ok: false, reason: 'songUnavailable' });
    expect(ceremony.snapshot).toEqual(before);
    run(1);
    expect(sounding()).toHaveLength(1);

    // Leaving and rejoining still work.
    expect(ceremony.leave().ok).toBe(true);
    expect(ceremony.join().ok).toBe(true);
    run(STEP);
    expect(sounding()).toHaveLength(1);
  });

  it('retries a failed song on the next join', async () => {
    const { audio, ceremony, loads, settle, sounding } = await setup({ instant: false });
    expect(ceremony.join().ok).toBe(true);
    audio.sync(ceremony.snapshot);
    loads[0]!.reject();
    await settle();
    ceremony.leave();
    audio.sync(ceremony.snapshot);
    expect(ceremony.join().ok).toBe(true);
    audio.sync(ceremony.snapshot);
    expect(loads).toHaveLength(2);
    loads[1]!.resolve();
    await settle();
    expect(audio.loadState('omJaiJagdishHare')).toBe('ready');
    expect(audio.durationOf('omJaiJagdishHare')).toBe(SECONDS);
    expect(sounding()).toHaveLength(1);
  });

  it('refuses to start the ceremony on a song that failed to load', async () => {
    const { audio, ceremony, loads } = await setup({ instant: false });
    const load = audio.load('omJaiJagdishHare');
    loads[0]!.reject();
    await expect(load).rejects.toThrow();
    expect(ceremony.join()).toEqual({ ok: false, reason: 'songUnavailable' });
    expect(ceremony.snapshot.state).toBe('waiting');
  });

  it('treats an empty decode as a failure', async () => {
    const ctx = new FakeAudioContext();
    const { audio, failures } = await setup({
      loadBuffer: async () => ctx.createBuffer(1, 0, ctx.sampleRate) as unknown as AudioBuffer,
    });
    await expect(audio.load('jaiGaneshDeva')).rejects.toThrow(/empty/);
    expect(failures).toHaveLength(1);
  });
});

describe('AartiAudio — accompaniment', () => {
  it('holds back the family bell while a recording that contains one plays', async () => {
    const { audio, ceremony, join } = await setup();
    expect(audio.layerAllowed('bell')).toBe(true);
    await join();
    expect(AARTI_RECORDINGS.omJaiJagdishHare.includes).toContain('bell');
    expect(audio.layerAllowed('bell')).toBe(false);
    expect(audio.layerAllowed('claps')).toBe(true);
    ceremony.leave();
    expect(audio.layerAllowed('bell')).toBe(true);
  });
});
