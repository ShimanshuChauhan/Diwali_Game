import { describe, expect, it } from 'vitest';
import { AARTI_RECORDINGS } from '../src/audio/aarti/recordings';
import { createGameEventBus } from '../src/core/events';
import { AARTI_SONG_IDS, type AartiSnapshot } from '../src/core/homes';
import { formatTime, MiniPlayerModel, miniPlayerView } from '../src/ui/miniPlayer';

function aarti(fields: Partial<AartiSnapshot> = {}): AartiSnapshot {
  return {
    state: 'running',
    participating: true,
    song: 'omJaiJagdishHare',
    elapsed: 12,
    duration: 24,
    circling: false,
    playbackId: 1,
    ...fields,
  };
}

describe('mini player view', () => {
  it('shows only while the player takes part in a running aarti', () => {
    expect(miniPlayerView(aarti()).visible).toBe(true);
    expect(miniPlayerView(aarti({ participating: false })).visible).toBe(false);
    expect(miniPlayerView(aarti({ state: 'waiting', participating: false })).visible).toBe(false);
    expect(miniPlayerView(aarti({ state: 'completed', participating: false })).visible).toBe(false);
  });

  it('lists the three titles in selector order with keys 1–3, marking the current one', () => {
    const view = miniPlayerView(aarti({ song: 'jaiLakshmiMata' }));
    expect(view.songs.map((s) => [s.key, s.title, s.current])).toEqual([
      ['1', 'Om Jai Jagdish Hare', false],
      ['2', 'Jai Lakshmi Mata', true],
      ['3', 'Jai Ganesh Deva', false],
    ]);
    expect(view.title).toBe(AARTI_RECORDINGS.jaiLakshmiMata.title);
  });

  it('shows the current song and how far through it the ceremony is', () => {
    const view = miniPlayerView(aarti({ elapsed: 6, duration: 24 }));
    expect(view.progress).toBeCloseTo(0.25);
    expect(view.time).toBe('0:06 / 0:24');
    expect(miniPlayerView(aarti({ elapsed: 30, duration: 24 })).progress).toBe(1);
    expect(miniPlayerView(aarti({ elapsed: 0, duration: 0 })).progress).toBe(0);
  });

  it('offers song choice and nothing else: no pause, seek, repeat or queue', () => {
    expect(Object.keys(miniPlayerView(aarti())).sort()).toEqual(
      ['hints', 'notice', 'progress', 'songs', 'time', 'title', 'visible'].sort(),
    );
    const hints = [...miniPlayerView(aarti()).hints, ...miniPlayerView(aarti(), { paused: true }).hints].join(' ');
    expect(hints).not.toMatch(/pause|seek|repeat|queue|score/i);
  });

  it('says to use the keys while playing and the mouse while paused', () => {
    expect(miniPlayerView(aarti()).hints).toEqual(['1–3: Choose a song']);
    expect(miniPlayerView(aarti(), { paused: true }).hints).toEqual(['Click a song to choose it']);
  });

  it('formats times as m:ss', () => {
    expect([0, 9.9, 61, 3599, -3, Number.NaN].map(formatTime)).toEqual(['0:00', '0:09', '1:01', '59:59', '0:00', '0:00']);
  });
});

describe('mini player model', () => {
  function setup() {
    const bus = createGameEventBus();
    const model = new MiniPlayerModel({ bus });
    return { bus, model };
  }

  it('has nothing to show before the first snapshot', () => {
    expect(setup().model.view).toBeNull();
  });

  it('redraws when something visible changes, not on every frame', () => {
    const { model } = setup();
    model.setAarti(aarti({ elapsed: 1 }));
    const first = model.revision;
    model.setAarti(aarti({ elapsed: 1.0001 }));
    expect(model.revision).toBe(first);
    model.setAarti(aarti({ elapsed: 2 }));
    expect(model.revision).toBeGreaterThan(first);
    const hidden = model.revision;
    model.setAarti(aarti({ participating: false, elapsed: 3 }));
    expect(model.view?.visible).toBe(false);
    model.setAarti(aarti({ participating: false, elapsed: 4 }));
    expect(model.revision).toBe(hidden + 1);
  });

  it('follows pause for its hints', () => {
    const { bus, model } = setup();
    model.setAarti(aarti());
    bus.emit('sessionStarted', {});
    expect(model.view?.hints).toEqual(['1–3: Choose a song']);
    bus.emit('paused', { reason: 'user' });
    expect(model.view?.hints).toEqual(['Click a song to choose it']);
    bus.emit('resumed', {});
    expect(model.view?.hints).toEqual(['1–3: Choose a song']);
  });

  it('explains a failed recording while that song is selected, until it is tried again', () => {
    const { bus, model } = setup();
    model.setAarti(aarti({ song: 'jaiGaneshDeva' }));
    bus.emit('aartiAudioFailed', { song: 'jaiGaneshDeva', message: 'Could not load it' });
    expect(model.view?.notice).toBe('Could not load it');
    // Another song's failure is not this one's.
    bus.emit('aartiAudioFailed', { song: 'jaiLakshmiMata', message: 'Other' });
    expect(model.view?.notice).toBe('Could not load it');
    model.setAarti(aarti({ song: 'omJaiJagdishHare' }));
    expect(model.view?.notice).toBeNull();
    model.setAarti(aarti({ song: 'jaiGaneshDeva' }));
    bus.emit('aartiJoined', { song: 'jaiGaneshDeva', elapsed: 3, playbackId: 4 });
    expect(model.view?.notice).toBeNull();
  });

  it('forgets failures on a fresh session', () => {
    const { bus, model } = setup();
    model.setAarti(aarti());
    bus.emit('aartiAudioFailed', { song: 'omJaiJagdishHare', message: 'Nope' });
    bus.emit('sessionReset', {});
    expect(model.view?.notice).toBeNull();
  });

  it('names songs by catalogue title, in selector order', () => {
    const { model } = setup();
    expect(AARTI_SONG_IDS.map((id) => model.titleOf(id))).toEqual(AARTI_SONG_IDS.map((id) => AARTI_RECORDINGS[id].title));
  });

  it('stops listening once disposed', () => {
    const { bus, model } = setup();
    model.setAarti(aarti());
    model.dispose();
    bus.emit('aartiAudioFailed', { song: 'omJaiJagdishHare', message: 'Late' });
    expect(model.view?.notice).toBeNull();
  });
});
