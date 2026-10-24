import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AartiCeremony, applyAartiAction } from '../src/aarti';
import { stepThali, THALI_REST, type ThaliMotion } from '../src/aarti/thali';
import { AartiAudio } from '../src/audio/aarti/aartiAudio';
import { AARTI_RECORDINGS, type AartiRecording } from '../src/audio/aarti/recordings';
import { AudioEngine } from '../src/audio/audioEngine';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { FixedStep } from '../src/core/fixedStep';
import type { AartiSongId } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType } from '../src/core/types';
import {
  allowedDuringFade,
  doorwayId,
  HeldItems,
  type HandCrackers,
  homesResetHooks,
  Locations,
  registerHomesReset,
} from '../src/homes';
import { Household, subtitlesFor } from '../src/household';
import { createFamilyHomeLayout } from '../src/interior';
import { MovementIntentTracker } from '../src/player';
import { createDomControls, type PointerLockDocument } from '../src/session/domControls';
import { Input } from '../src/session/input';
import { Session } from '../src/session/session';
import { MiniPlayerModel } from '../src/ui/miniPlayer';
import { FakeAudioContext, type FakeSource } from './fakeAudioContext';

/**
 * PRD → Aarti state and timing; Session and performance integration;
 * Acceptance #6. The modules `main.ts` wires for the family home, driven
 * headless through the browser edge: pause and focus loss must freeze the
 * song, the ceremony clock, the family and any door fade together, release
 * held input, and resume all of them in step without layering voices.
 */

const STEP = 1 / 60;
const SECONDS = AARTI_RECORDINGS.omJaiJagdishHare.durationSeconds;
const { fadeDuration } = TUNING.homes;

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

class FakeElement extends EventTarget {
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): Promise<void> {
    this.doc.setLock(this);
    return Promise.resolve();
  }
}

class FakeDocument extends EventTarget implements PointerLockDocument {
  pointerLockElement: unknown = null;
  visibilityState = 'visible';
  focused = true;
  hasFocus(): boolean {
    return this.focused;
  }
  exitPointerLock(): void {
    this.setLock(null);
  }
  setLock(element: unknown): void {
    this.pointerLockElement = element;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

function event(type: string, fields: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), fields);
}

/** Microtasks and instant loads settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type PauseWay = 'escape' | 'hiddenTab' | 'windowBlur';

async function setup() {
  const bus = createGameEventBus();
  const session = new Session({ bus });
  const input = new Input({ bus, enabled: false });
  const doc = new FakeDocument();
  const element = new FakeElement(doc);
  const win = new EventTarget();
  const controls = createDomControls({ input, session, bus, element, doc, win });

  const ctx = new FakeAudioContext();
  const engine = new AudioEngine({ bus, createContext: () => ctx.asAudioContext(), random: () => 0.5 });
  await engine.unlock();
  const decoded = new Set<unknown>();
  const recordingSources = () => ctx.sources.filter((source) => decoded.has(source.buffer));
  const sounding = () => recordingSources().filter((source) => source.sounding);
  const loadBuffer = (recording: AartiRecording) => {
    const buffer = ctx.createBuffer(1, Math.round(recording.durationSeconds * ctx.sampleRate), ctx.sampleRate);
    decoded.add(buffer);
    return Promise.resolve(buffer as unknown as AudioBuffer);
  };

  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const locations = new Locations({ bus, hands });
  const aartiAudio = new AartiAudio({
    bus,
    output: () => engine.musicOutput,
    onPlaybackEnded: (id) => ceremony.playbackEnded(id),
    loadBuffer,
  });
  const ceremony = new AartiCeremony({
    bus,
    hands,
    location: () => locations.location,
    durationOf: (song) => aartiAudio.durationOf(song),
  });
  const household = new Household({ bus, layout: createFamilyHomeLayout() });
  registerHomesReset(session, homesResetHooks({ heldItems: hands, locations, aartiCeremony: ceremony, aartiAudio, household }));
  const miniPlayer = new MiniPlayerModel({ bus });
  const movement = new MovementIntentTracker();
  const loop = new FixedStep({ step: STEP, maxSteps: 5 });
  let thali: ThaliMotion = THALI_REST;

  const counts = { completed: 0, arrived: 0, paused: [] as string[] };
  bus.on('aartiCompleted', () => counts.completed++);
  bus.on('locationChanged', () => counts.arrived++);
  bus.on('paused', ({ reason }) => counts.paused.push(reason));

  /** One rendered frame, in `main.ts`'s order; the audio clock runs only while its context does. */
  const frame = (delta = STEP) => {
    if (ctx.state === 'running') ctx.currentTime += delta;
    for (const action of input.drainActions()) {
      if (locations.controlsLocked && !allowedDuringFade(action)) continue;
      if (applyAartiAction(action, ceremony)) continue;
      if (action.type === 'pause') session.pause('user');
      else movement.apply(action);
    }
    const { steps } = loop.advance(session.paused ? 0 : delta);
    for (let i = 0; i < steps; i++) {
      locations.update(STEP);
      ceremony.update(STEP);
      household.update(STEP);
    }
    const aarti = ceremony.snapshot;
    aartiAudio.sync(aarti);
    const shown = session.paused ? 0 : delta;
    thali = aarti.participating ? stepThali(thali, aarti.circling, shown) : THALI_REST;
    miniPlayer.setAarti(aarti);
  };
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) frame();
  };

  /** Everything pause must hold still, deep-copied so later frames cannot change it. */
  const frozen = () =>
    JSON.parse(
      JSON.stringify({
        aarti: ceremony.snapshot,
        family: household.views(),
        phase: household.state,
        subtitles: subtitlesFor(household.members(), 'familyHome'),
        fade: locations.transition,
        opacity: locations.fadeOpacity,
        location: locations.location,
        thali,
        audioClock: ctx.currentTime,
      }),
    ) as unknown;

  const pause = (way: PauseWay) => {
    if (way === 'hiddenTab') {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    } else if (way === 'windowBlur') {
      doc.focused = false;
      win.dispatchEvent(new Event('blur'));
    }
    // The browser drops pointer lock either way; Escape does only that.
    doc.exitPointerLock();
  };
  /** Back to the tab, then the player's own click on Resume. */
  const resume = async () => {
    doc.visibilityState = 'visible';
    doc.focused = true;
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(session.state).toBe('paused');
    controls.requestStart();
    expect(session.state).toBe('running');
    await tick();
  };

  const enterHome = () => {
    expect(locations.requestTransition(doorwayId('familyHome', 'enter')).ok).toBe(true);
    run(fadeDuration + STEP);
    expect(locations.location).toBe('familyHome');
  };
  const joinAarti = async () => {
    expect(ceremony.join().ok).toBe(true);
    frame();
    await tick();
    frame();
    expect(sounding()).toHaveLength(1);
  };
  const start = async () => {
    controls.requestStart();
    expect(session.state).toBe('running');
    enterHome();
    await joinAarti();
  };

  /** Where in its buffer the one sounding recording is now. */
  const playhead = (source: FakeSource) => source.startOffset + ctx.currentTime - source.startedAt!;
  const thaliMotion = () => thali;

  return {
    bus,
    session,
    input,
    doc,
    element,
    win,
    controls,
    ctx,
    hands,
    locations,
    ceremony,
    household,
    miniPlayer,
    movement,
    counts,
    recordingSources,
    sounding,
    frame,
    run,
    frozen,
    pause,
    resume,
    start,
    enterHome,
    joinAarti,
    playhead,
    thaliMotion,
  };
}

function only(list: FakeSource[]): FakeSource {
  expect(list).toHaveLength(1);
  return list[0]!;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const WAYS: readonly PauseWay[] = ['escape', 'hiddenTab', 'windowBlur'];

describe('pause and focus — freezing', () => {
  it.each(WAYS)('%s freezes song, ceremony, family and thali together', async (way) => {
    const t = await setup();
    await t.start();
    t.element.dispatchEvent(event('mousedown', { button: 0 }));
    t.run(3);
    expect(t.ceremony.snapshot.circling).toBe(true);
    expect(t.household.state).toBe('aarti');

    t.pause(way);
    expect(t.session.state).toBe('paused');
    expect(t.counts.paused).toEqual([way === 'escape' ? 'user' : 'focusLost']);
    t.frame();
    const before = t.frozen();
    // A long while away, at any frame rate.
    t.run(20);
    for (let i = 0; i < 30; i++) t.frame(0.5);

    expect(t.frozen()).toEqual(before);
    expect(t.ctx.state).toBe('suspended');
    expect(t.sounding()).toHaveLength(0);
    expect(t.ceremony.snapshot.elapsed).toBeCloseTo(3, 1);
    expect(t.counts.completed).toBe(0);
    // Still taking part: pause neither leaves aarti nor drops the thali.
    expect(t.ceremony.snapshot.participating).toBe(true);
    expect(t.hands.hands?.kind).toBe('thali');
  });

  it('returning to the tab or window does not resume by itself; only the player can', async () => {
    const t = await setup();
    await t.start();
    t.pause('hiddenTab');
    t.doc.visibilityState = 'visible';
    t.doc.dispatchEvent(new Event('visibilitychange'));
    t.win.dispatchEvent(new Event('focus'));
    t.run(2);
    expect(t.session.state).toBe('paused');
    expect(t.sounding()).toHaveLength(0);
    t.controls.requestStart();
    expect(t.session.state).toBe('running');
  });

  it('a song cannot finish while paused, even past its length; it completes once after resuming', async () => {
    const t = await setup();
    await t.start();
    t.run(SECONDS - 0.5);
    t.pause('windowBlur');
    t.run(SECONDS * 2);
    expect(t.ceremony.snapshot.state).toBe('running');
    expect(t.household.state).toBe('aarti');
    expect(t.counts.completed).toBe(0);

    await t.resume();
    t.run(1);
    expect(t.counts.completed).toBe(1);
    expect(t.ceremony.snapshot.state).toBe('completed');
    expect(t.household.state).not.toBe('aarti');
    expect(t.sounding()).toHaveLength(0);
  });
});

describe('pause and focus — resuming in step', () => {
  it.each(WAYS)('after %s, playback seeks to the ceremony offset and stays with it', async (way) => {
    const t = await setup();
    await t.start();
    t.run(5);
    t.pause(way);
    t.run(10);
    const elapsed = t.ceremony.snapshot.elapsed;

    await t.resume();
    expect(t.ctx.state).toBe('running');
    t.frame();
    const source = only(t.sounding());
    expect(source.startOffset).toBeCloseTo(elapsed + STEP, 5);
    t.run(3);
    expect(t.ceremony.snapshot.elapsed).toBeCloseTo(elapsed + 3 + STEP, 1);
    expect(only(t.sounding())).toBe(source);
    expect(Math.abs(t.playhead(source) - t.ceremony.snapshot.elapsed)).toBeLessThan(2 * STEP);
  });

  it('never layers voices across repeated pauses, and each resume starts exactly one source', async () => {
    const t = await setup();
    await t.start();
    for (let cycle = 0; cycle < 6; cycle++) {
      const created = t.recordingSources().length;
      t.run(0.5);
      t.pause(WAYS[cycle % WAYS.length]!);
      for (let i = 0; i < 30; i++) {
        t.frame();
        expect(t.sounding()).toHaveLength(0);
      }
      await t.resume();
      for (let i = 0; i < 30; i++) {
        t.frame();
        expect(t.sounding()).toHaveLength(1);
      }
      expect(t.recordingSources()).toHaveLength(created + 1);
      expect(t.ceremony.snapshot.participating).toBe(true);
    }
    expect(t.ceremony.snapshot.elapsed).toBeCloseTo(6 * 1, 1);
  });

  it('family activity picks up from where it froze', async () => {
    const t = await setup();
    await t.start();
    t.run(2);
    const times = () => t.household.views().map((v) => v.activityTime);
    const at = times();
    t.pause('escape');
    t.run(5);
    expect(times()).toEqual(at);
    await t.resume();
    t.run(1);
    for (const [i, time] of times().entries()) expect(time).not.toBe(at[i]);
    expect(t.household.state).toBe('aarti');
  });
});

describe('pause and focus — held input', () => {
  it.each(WAYS)('the thali is not stuck circling after %s and the return', async (way) => {
    const t = await setup();
    await t.start();
    t.element.dispatchEvent(event('mousedown', { button: 0 }));
    t.run(1);
    expect(t.ceremony.snapshot.circling).toBe(true);
    expect(t.thaliMotion().sweep).toBeGreaterThan(0.9);

    t.pause(way);
    expect(t.ceremony.snapshot.circling).toBe(false);
    t.run(2);
    await t.resume();
    t.run(2);
    // Resting, and gliding back to rest rather than frozen mid-circle.
    expect(t.ceremony.snapshot.circling).toBe(false);
    expect(t.thaliMotion().sweep).toBe(0);
    // The button let go only now, after the return: still nothing to undo.
    t.doc.dispatchEvent(event('mouseup', { button: 0 }));
    t.frame();
    expect(t.ceremony.snapshot.circling).toBe(false);

    // A fresh hold circles again, and its release rests the thali.
    t.element.dispatchEvent(event('mousedown', { button: 0 }));
    t.frame();
    expect(t.ceremony.snapshot.circling).toBe(true);
    t.doc.dispatchEvent(event('mouseup', { button: 0 }));
    t.frame();
    expect(t.ceremony.snapshot.circling).toBe(false);
  });

  it('a held movement key is released by focus loss and does not walk the player on return', async () => {
    const t = await setup();
    t.controls.requestStart();
    t.win.dispatchEvent(event('keydown', { code: 'KeyW' }));
    t.frame();
    expect(t.movement.intent(0).forward).toBe(1);
    t.pause('windowBlur');
    t.win.dispatchEvent(event('keyup', { code: 'KeyW' }));
    await t.resume();
    t.frame();
    expect(t.movement.intent(0)).toMatchObject({ forward: 0, right: 0, run: false });
  });
});

describe('pause and focus — door fades', () => {
  it.each([
    ['fading out', 0.25],
    ['fading in', 0.75],
  ])('a pause while %s freezes the fade and it finishes cleanly after resuming', async (_phase, fraction) => {
    const t = await setup();
    t.controls.requestStart();
    t.win.dispatchEvent(event('keydown', { code: 'KeyW' }));
    expect(t.locations.requestTransition(doorwayId('familyHome', 'enter')).ok).toBe(true);
    t.run(fadeDuration * fraction);
    const arrivedBefore = t.counts.arrived;
    t.pause('hiddenTab');
    t.frame();
    const before = t.frozen();
    t.run(5);
    expect(t.frozen()).toEqual(before);
    expect(t.locations.controlsLocked).toBe(true);
    expect(t.counts.arrived).toBe(arrivedBefore);

    await t.resume();
    t.run(fadeDuration);
    expect(t.locations.transition).toBeNull();
    expect(t.locations.controlsLocked).toBe(false);
    expect(t.locations.location).toBe('familyHome');
    expect(t.counts.arrived).toBe(1);
    // The key held through the fade was let go by the pause, not carried in.
    expect(t.movement.intent(0).forward).toBe(0);
  });
});

describe('pause and focus — mini player and other UI focus', () => {
  it('choosing a song while paused neither resumes nor leaves; the new song starts from zero on resume', async () => {
    const t = await setup();
    await t.start();
    t.run(4);
    t.pause('escape');
    t.frame();
    expect(t.miniPlayer.view?.visible).toBe(true);
    expect(t.miniPlayer.view?.hints).toEqual(['Click a song to choose it']);

    // The panel's click calls `selectSong` (main.ts); the press and focus traffic around it go nowhere.
    t.doc.dispatchEvent(event('mousedown', { button: 0 }));
    expect(t.ceremony.selectSong('jaiLakshmiMata').ok).toBe(true);
    t.doc.dispatchEvent(event('mouseup', { button: 0 }));
    t.win.dispatchEvent(new Event('focus'));
    t.run(2);

    expect(t.session.state).toBe('paused');
    expect(t.ceremony.snapshot).toMatchObject({ participating: true, song: 'jaiLakshmiMata', elapsed: 0, circling: false });
    expect(t.hands.hands?.kind).toBe('thali');
    expect(t.sounding()).toHaveLength(0);
    expect(t.miniPlayer.view?.title).toBe(AARTI_RECORDINGS.jaiLakshmiMata.title);

    await t.resume();
    t.frame();
    const source = only(t.sounding());
    expect(source.startOffset).toBeCloseTo(STEP, 5);
    expect((source.buffer as AudioBuffer).duration).toBeCloseTo(AARTI_RECORDINGS.jaiLakshmiMata.durationSeconds, 2);
  });

  it('switching songs back and forth while paused still leaves one voice on resume', async () => {
    const t = await setup();
    await t.start();
    t.pause('escape');
    for (const song of ['jaiGaneshDeva', 'jaiLakshmiMata', 'omJaiJagdishHare', 'jaiGaneshDeva'] as AartiSongId[]) {
      t.ceremony.selectSong(song);
      t.frame();
      await tick();
      t.frame();
    }
    expect(t.sounding()).toHaveLength(0);
    await t.resume();
    t.run(1);
    expect(only(t.sounding()).startOffset).toBeCloseTo(STEP, 5);
    expect(t.ceremony.snapshot.song).toBe('jaiGaneshDeva');
  });

  it('restarting from the pause menu is silent until the player resumes', async () => {
    const t = await setup();
    await t.start();
    t.pause('escape');
    t.session.reset();
    t.frame();
    expect(t.ceremony.snapshot.state).toBe('waiting');
    expect(t.sounding()).toHaveLength(0);
    await t.resume();
    t.run(1);
    expect(t.sounding()).toHaveLength(0);
    expect(t.locations.location).toBe('outdoors');
  });
});
