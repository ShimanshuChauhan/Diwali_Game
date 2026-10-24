import { describe, expect, it } from 'vitest';
import { AartiCeremony, type AartiCeremonyOptions } from '../src/aarti';
import { AARTI_RECORDINGS } from '../src/audio/aarti/recordings';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import { AARTI_SONG_IDS, type AartiSongId, type LocationId } from '../src/core/homes';
import type { CrackerType } from '../src/core/types';
import { HeldItems, type HandCrackers, homesResetHooks, pendingModules, registerHomesReset } from '../src/homes';
import { Session } from '../src/session/session';

const STEP = 1 / 60;

/** Short, distinct lengths so tests run in few steps and can tell songs apart. */
const DURATIONS: Record<AartiSongId, number> = { omJaiJagdishHare: 3, jaiLakshmiMata: 5, jaiGaneshDeva: 4 };

/** A cracker selection with nothing in hand, enough for the hands to arbitrate. */
class StubCrackers implements HandCrackers {
  selected: CrackerType = 'anar';
  held: HeldItem | null = null;
  select(type: CrackerType): void {
    this.selected = type;
  }
  putAway(): void {
    this.held = null;
  }
}

type Logged = { [K in GameEventName]: { name: K; payload: GameEvents[K] } }[GameEventName];

function record(bus: GameEventBus): Logged[] {
  const log: Logged[] = [];
  const names: GameEventName[] = [
    'aartiJoined',
    'aartiLeft',
    'aartiSongChanged',
    'aartiCompleted',
    'aartiRejected',
    'itemPickedUp',
    'itemReturned',
  ];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

function setup(options: Partial<AartiCeremonyOptions> = {}) {
  const bus = createGameEventBus();
  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: (song) => DURATIONS[song], ...options });
  const log = record(bus);
  const names = () => log.map((entry) => entry.name);
  return { bus, hands, ceremony, log, names };
}

/** Advance by `seconds` of unpaused time in fixed steps. */
function run(ceremony: AartiCeremony, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) ceremony.update(STEP);
}

describe('AartiCeremony — waiting', () => {
  it('starts gathered and waiting, with no time passing however long the invitation stands', () => {
    const { ceremony, hands, log } = setup();
    run(ceremony, 60);
    expect(ceremony.snapshot).toEqual({
      state: 'waiting',
      participating: false,
      song: 'omJaiJagdishHare',
      elapsed: 0,
      duration: DURATIONS.omJaiJagdishHare,
      circling: false,
      playbackId: 0,
    });
    expect(hands.hands).toBeNull();
    expect(log).toEqual([]);
  });

  it('refuses leaving, song changes and circling before anyone joins', () => {
    const { ceremony, log } = setup();
    expect(ceremony.leave()).toEqual({ ok: false, reason: 'notParticipating' });
    expect(ceremony.selectSong('jaiGaneshDeva')).toEqual({ ok: false, reason: 'notParticipating' });
    expect(ceremony.setCircling(true)).toEqual({ ok: false, reason: 'notParticipating' });
    expect(log.map((entry) => entry.payload)).toEqual([
      { reason: 'notParticipating' },
      { reason: 'notParticipating' },
      { reason: 'notParticipating' },
    ]);
    expect(ceremony.snapshot.song).toBe('omJaiJagdishHare');
  });

  it('uses the bundled catalogue durations by default', () => {
    const bus = createGameEventBus();
    const ceremony = new AartiCeremony({ bus, hands: new HeldItems({ bus, crackers: new StubCrackers() }) });
    expect(ceremony.snapshot.duration).toBe(AARTI_RECORDINGS.omJaiJagdishHare.durationSeconds);
  });
});

describe('AartiCeremony — joining', () => {
  it('starts the selected song from zero once, reserving the hands for the thali', () => {
    const { ceremony, hands, log } = setup();
    expect(ceremony.join()).toEqual({ ok: true });
    expect(hands.hands).toEqual({ kind: 'thali' });
    expect(hands.crackerBlock()).toBe('holdingThali');
    expect(ceremony.snapshot).toMatchObject({ state: 'running', participating: true, elapsed: 0, duration: 3 });
    expect(log).toEqual([
      { name: 'itemPickedUp', payload: { item: { kind: 'thali' } } },
      { name: 'aartiJoined', payload: { song: 'omJaiJagdishHare', elapsed: 0, playbackId: 1 } },
    ]);

    run(ceremony, 1);
    expect(ceremony.join()).toEqual({ ok: false, reason: 'alreadyParticipating' });
    expect(ceremony.snapshot.elapsed).toBeCloseTo(1);
    expect(log.filter((entry) => entry.name === 'aartiJoined')).toHaveLength(1);
  });

  it('asks for the carried item to be returned first, leaving the ceremony waiting', () => {
    const { ceremony, hands } = setup();
    hands.take({ kind: 'giftBox', box: 'outbound' });
    expect(ceremony.join()).toEqual({ ok: false, reason: 'handsFull' });
    expect(ceremony.snapshot).toMatchObject({ state: 'waiting', participating: false, playbackId: 0 });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });

    hands.returnTo({ item: 'giftBox', home: 'familyHome' });
    expect(ceremony.join()).toEqual({ ok: true });
  });

  it('only joins in the family home when it knows the location', () => {
    let location: LocationId = 'neighbourHome';
    const { ceremony, hands } = setup({ location: () => location });
    expect(ceremony.join()).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(hands.hands).toBeNull();
    location = 'familyHome';
    expect(ceremony.join()).toEqual({ ok: true });
  });

  it('will not commit to a song whose length is unknown, and leaves the hands free', () => {
    const durations: Partial<Record<AartiSongId, number>> = {};
    const { ceremony, hands } = setup({ durationOf: (song) => durations[song] ?? null });
    expect(ceremony.join()).toEqual({ ok: false, reason: 'songUnavailable' });
    expect(ceremony.snapshot).toMatchObject({ state: 'waiting', duration: 0 });
    expect(hands.hands).toBeNull();

    durations.omJaiJagdishHare = 7;
    expect(ceremony.join()).toEqual({ ok: true });
    expect(ceremony.snapshot.duration).toBe(7);
  });
});

describe('AartiCeremony — thali circling', () => {
  it('hold and release never change elapsed time or duration', () => {
    const plain = setup();
    const circled = setup();
    plain.ceremony.join();
    circled.ceremony.join();
    for (let i = 0; i < 105; i++) {
      circled.ceremony.setCircling(i % 30 < 15);
      plain.ceremony.update(STEP);
      circled.ceremony.update(STEP);
    }
    const { circling: _a, ...plainTiming } = plain.ceremony.snapshot;
    const { circling: _b, ...circledTiming } = circled.ceremony.snapshot;
    expect(circledTiming).toEqual(plainTiming);
    expect(circled.ceremony.snapshot.circling).toBe(true);
  });

  it('rests on pause and when the player leaves; resting is always allowed', () => {
    const { bus, ceremony } = setup();
    ceremony.join();
    ceremony.setCircling(true);
    bus.emit('paused', { reason: 'focusLost' });
    expect(ceremony.snapshot.circling).toBe(false);

    ceremony.setCircling(true);
    ceremony.leave();
    expect(ceremony.snapshot.circling).toBe(false);
    expect(ceremony.setCircling(false)).toEqual({ ok: true });
  });
});

describe('AartiCeremony — leaving and rejoining', () => {
  it('leaving puts down the thali and stops playback while time keeps running', () => {
    const { ceremony, hands, log } = setup();
    ceremony.join();
    run(ceremony, 1);
    log.length = 0;

    expect(ceremony.leave()).toEqual({ ok: true });
    expect(hands.hands).toBeNull();
    expect(hands.crackerBlock()).toBeNull();
    expect(ceremony.snapshot).toMatchObject({ state: 'running', participating: false, playbackId: 2 });
    expect(log.map((entry) => entry.name)).toEqual(['itemReturned', 'aartiLeft']);
    expect(log[1]?.payload).toMatchObject({ song: 'omJaiJagdishHare' });

    run(ceremony, 1);
    expect(ceremony.snapshot.elapsed).toBeCloseTo(2);
    expect(ceremony.leave()).toEqual({ ok: false, reason: 'notParticipating' });
  });

  it('rejoining starts playback at the accumulated offset with a fresh playback id', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    run(ceremony, 0.5);
    ceremony.leave();
    run(ceremony, 1);

    expect(ceremony.join()).toEqual({ ok: true });
    const joins = log.filter((entry) => entry.name === 'aartiJoined').map((entry) => entry.payload);
    expect(joins).toHaveLength(2);
    expect(joins[1]?.song).toBe('omJaiJagdishHare');
    expect(joins[1]?.elapsed).toBeCloseTo(1.5);
    expect(joins[1]?.playbackId).toBe(3);
    expect(ceremony.snapshot).toMatchObject({ participating: true, duration: 3 });
  });
});

describe('AartiCeremony — song change', () => {
  it('resets elapsed time to zero and takes the new recording’s full duration', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    run(ceremony, 2);
    expect(ceremony.selectSong('jaiLakshmiMata')).toEqual({ ok: true });
    expect(ceremony.snapshot).toMatchObject({ song: 'jaiLakshmiMata', elapsed: 0, duration: 5, playbackId: 2 });
    expect(log.at(-1)).toEqual({
      name: 'aartiSongChanged',
      payload: { song: 'jaiLakshmiMata', duration: 5, playbackId: 2 },
    });

    // Past the old song's end: still running on the new song's timeline.
    run(ceremony, 4);
    expect(ceremony.snapshot.state).toBe('running');
    run(ceremony, 1.1);
    expect(ceremony.snapshot.state).toBe('completed');
  });

  it('can extend the gathering by switching repeatedly', () => {
    const { ceremony } = setup();
    ceremony.join();
    for (const song of ['jaiGaneshDeva', 'jaiLakshmiMata', 'omJaiJagdishHare', 'jaiGaneshDeva'] as const) {
      run(ceremony, 2.5);
      expect(ceremony.selectSong(song)).toEqual({ ok: true });
    }
    expect(ceremony.snapshot).toMatchObject({ state: 'running', song: 'jaiGaneshDeva', elapsed: 0, duration: 4 });
  });

  it('is only for participants', () => {
    const { ceremony } = setup();
    ceremony.join();
    run(ceremony, 1);
    ceremony.leave();
    expect(ceremony.selectSong('jaiGaneshDeva')).toEqual({ ok: false, reason: 'notParticipating' });
    expect(ceremony.snapshot.song).toBe('omJaiJagdishHare');
    expect(ceremony.snapshot.elapsed).toBeCloseTo(1);
  });

  it('keeps the current song when the new one is unknown or unavailable', () => {
    const { ceremony, log } = setup({ durationOf: (song) => (song === 'jaiGaneshDeva' ? null : DURATIONS[song]) });
    ceremony.join();
    run(ceremony, 1);
    const before = ceremony.snapshot;

    expect(ceremony.selectSong('jaiGaneshDeva')).toEqual({ ok: false, reason: 'songUnavailable' });
    expect(ceremony.selectSong('bhajan' as AartiSongId)).toEqual({ ok: false, reason: 'unknownSong' });
    expect(ceremony.snapshot).toEqual(before);
    expect(log.filter((entry) => entry.name === 'aartiSongChanged')).toEqual([]);
  });

  it('choosing the song already playing changes nothing', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    run(ceremony, 1);
    const before = ceremony.snapshot;
    expect(ceremony.selectSong('omJaiJagdishHare')).toEqual({ ok: true });
    expect(ceremony.snapshot).toEqual(before);
    expect(log.at(-1)?.name).toBe('aartiJoined');
  });

  it('accepts every song in the selector', () => {
    const { ceremony } = setup();
    ceremony.join();
    for (const song of [...AARTI_SONG_IDS].reverse()) {
      expect(ceremony.selectSong(song)).toEqual({ ok: true });
      expect(ceremony.snapshot).toMatchObject({ song, duration: DURATIONS[song] });
    }
  });
});

describe('AartiCeremony — completion', () => {
  it('completes once at the full duration while participating, releasing the thali', () => {
    const { ceremony, hands, log, names } = setup();
    ceremony.join();
    ceremony.setCircling(true);
    run(ceremony, 2.9);
    expect(ceremony.snapshot.state).toBe('running');
    run(ceremony, 0.2);

    expect(ceremony.snapshot).toMatchObject({
      state: 'completed',
      participating: false,
      circling: false,
      elapsed: 3,
      duration: 3,
      playbackId: 2,
    });
    expect(hands.hands).toBeNull();
    expect(hands.trayServed).toBe(true);
    expect(names().slice(-2)).toEqual(['itemReturned', 'aartiCompleted']);
    expect(log.at(-1)?.payload).toEqual({ song: 'omJaiJagdishHare', participating: true });
  });

  it('completes while the player is away, without touching their hands', () => {
    const { ceremony, hands, log } = setup();
    ceremony.join();
    run(ceremony, 1);
    ceremony.leave();
    hands.take({ kind: 'giftBox', box: 'outbound' });
    run(ceremony, 2.5);

    expect(ceremony.snapshot).toMatchObject({ state: 'completed', participating: false });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
    expect(log.at(-1)).toEqual({
      name: 'aartiCompleted',
      payload: { song: 'omJaiJagdishHare', participating: false },
    });
  });

  it('is idempotent and cannot be rejoined, restarted or changed', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    run(ceremony, 10);
    const after = ceremony.snapshot;
    run(ceremony, 10);
    expect(ceremony.snapshot).toEqual(after);

    expect(ceremony.join()).toEqual({ ok: false, reason: 'ceremonyCompleted' });
    expect(ceremony.selectSong('jaiLakshmiMata')).toEqual({ ok: false, reason: 'ceremonyCompleted' });
    expect(ceremony.playbackEnded(after.playbackId)).toBe(false);
    expect(ceremony.snapshot).toEqual(after);
    expect(log.filter((entry) => entry.name === 'aartiCompleted')).toHaveLength(1);
  });

  it('ignores zero, negative and non-finite steps', () => {
    const { ceremony } = setup();
    ceremony.join();
    for (const dt of [0, -1, Number.NaN]) ceremony.update(dt);
    expect(ceremony.snapshot.elapsed).toBe(0);
  });
});

describe('AartiCeremony — playback identity', () => {
  it('the current recording ending completes the ceremony, even a little ahead of the clock', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    run(ceremony, 2.95);
    expect(ceremony.playbackEnded(ceremony.snapshot.playbackId)).toBe(true);
    expect(ceremony.snapshot).toMatchObject({ state: 'completed', elapsed: 3 });
    expect(log.filter((entry) => entry.name === 'aartiCompleted')).toHaveLength(1);
  });

  it('a stale end callback cannot complete a replacement song', () => {
    const { ceremony } = setup();
    ceremony.join();
    const firstSong = ceremony.snapshot.playbackId;
    run(ceremony, 2.9);
    ceremony.selectSong('jaiLakshmiMata');
    run(ceremony, 0.2);

    expect(ceremony.playbackEnded(firstSong)).toBe(false);
    expect(ceremony.snapshot).toMatchObject({ state: 'running', song: 'jaiLakshmiMata' });
    expect(ceremony.snapshot.elapsed).toBeCloseTo(0.2);
  });

  it('a callback from before leaving, rejoining or a reset is ignored', () => {
    const { ceremony, hands } = setup();
    ceremony.join();
    const beforeLeave = ceremony.snapshot.playbackId;
    ceremony.leave();
    expect(ceremony.playbackEnded(beforeLeave)).toBe(false);
    expect(ceremony.playbackEnded(ceremony.snapshot.playbackId)).toBe(false);

    ceremony.join();
    const beforeReset = ceremony.snapshot.playbackId;
    expect(beforeReset).toBeGreaterThan(beforeLeave);
    // A fresh session resets the hands alongside the ceremony.
    hands.reset();
    ceremony.reset();
    ceremony.join();
    expect(ceremony.playbackEnded(beforeReset)).toBe(false);
    expect(ceremony.snapshot.state).toBe('running');
  });

  it('bumps the playback id on every restart of playback and never otherwise', () => {
    const { ceremony } = setup();
    const ids = [ceremony.snapshot.playbackId];
    const note = () => ids.push(ceremony.snapshot.playbackId);
    ceremony.join();
    note();
    ceremony.setCircling(true);
    run(ceremony, 0.5);
    note();
    ceremony.selectSong('jaiGaneshDeva');
    note();
    ceremony.leave();
    note();
    ceremony.join();
    note();
    run(ceremony, 5);
    note();
    expect(ids).toEqual([0, 1, 1, 2, 3, 4, 5]);
  });
});

describe('AartiCeremony — fresh session', () => {
  it('reset clears progress back to a waiting ceremony with the first song', () => {
    const { ceremony, log } = setup();
    ceremony.join();
    ceremony.selectSong('jaiGaneshDeva');
    run(ceremony, 10);
    expect(ceremony.snapshot.state).toBe('completed');
    const completedId = ceremony.snapshot.playbackId;
    log.length = 0;

    ceremony.reset();
    expect(ceremony.snapshot).toEqual({
      state: 'waiting',
      participating: false,
      song: 'omJaiJagdishHare',
      elapsed: 0,
      duration: DURATIONS.omJaiJagdishHare,
      circling: false,
      playbackId: completedId + 1,
    });
    expect(log).toEqual([]);
    run(ceremony, 10);
    expect(ceremony.snapshot.elapsed).toBe(0);
    expect(ceremony.join()).toEqual({ ok: true });
  });

  it('the session reset clears the ceremony and the thali together', () => {
    const { bus, hands, ceremony } = setup();
    const session = new Session({ bus });
    const hooks = homesResetHooks({ heldItems: hands, aartiCeremony: ceremony });
    registerHomesReset(session, hooks);
    expect(pendingModules(hooks)).not.toContain('aartiCeremony');

    ceremony.join();
    run(ceremony, 1);
    session.reset();
    expect(ceremony.snapshot).toMatchObject({ state: 'waiting', participating: false, elapsed: 0 });
    expect(hands.hands).toBeNull();
    expect(ceremony.join()).toEqual({ ok: true });
  });

  it('stops listening for pauses once disposed', () => {
    const { bus, ceremony } = setup();
    ceremony.join();
    ceremony.setCircling(true);
    ceremony.dispose();
    bus.emit('paused', { reason: 'user' });
    expect(ceremony.snapshot.circling).toBe(true);
  });
});
