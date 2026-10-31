import { describe, expect, it } from 'vitest';
import { AartiCeremony, applyAartiAction, facePuja, holdStill, slotForSong, songForSlot } from '../src/aarti';
import type { GameAction } from '../src/core/actions';
import type { HeldItem, MovementIntent } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus } from '../src/core/events';
import { AARTI_SONG_IDS, type AartiSongId } from '../src/core/homes';
import type { CrackerType } from '../src/core/types';
import { HeldItems, type HandCrackers } from '../src/homes';
import { Input } from '../src/session/input';

const STEP = 1 / 60;

/** Short, distinct lengths so tests run in few steps and can tell songs apart. */
const DURATIONS: Record<AartiSongId, number> = { omJaiJagdishHare: 3, jaiLakshmiMata: 5, jaiGaneshDeva: 4 };

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

function setup() {
  const bus: GameEventBus = createGameEventBus();
  const crackers = new StubCrackers();
  const hands = new HeldItems({ bus, crackers });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: (song) => DURATIONS[song] });
  /** Feed actions as the game loop does; returns which ones aarti used. */
  const route = (...actions: GameAction[]) => actions.map((action) => applyAartiAction(action, ceremony));
  return { bus, crackers, hands, ceremony, route };
}

function run(ceremony: AartiCeremony, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) ceremony.update(STEP);
}

const PASS_THROUGH: readonly GameAction[] = [
  { type: 'move', forward: 1, right: 0 },
  { type: 'run', active: true },
  { type: 'look', dx: 40, dy: -10 },
  { type: 'toggleCamera' },
  { type: 'pause' },
];

describe('aarti participation — outside aarti', () => {
  it('leaves every action to the rest of the game', () => {
    const { route, ceremony } = setup();
    const all: GameAction[] = [
      ...PASS_THROUGH,
      { type: 'select', slot: 1 },
      { type: 'place' },
      { type: 'placeReleased' },
      { type: 'interact' },
      { type: 'jump' },
    ];
    expect(route(...all)).toEqual(all.map(() => false));
    expect(ceremony.snapshot).toMatchObject({ state: 'waiting', participating: false, circling: false });
  });

  it('after leaving, click and E go back to crackers and doors', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    route({ type: 'interact' });
    expect(route({ type: 'place' }, { type: 'interact' }, { type: 'select', slot: 2 })).toEqual([false, false, false]);
  });
});

describe('aarti participation — holding the thali', () => {
  it('holding click circles the thali and letting go rests it', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    expect(route({ type: 'place' })).toEqual([true]);
    expect(ceremony.snapshot.circling).toBe(true);
    expect(route({ type: 'placeReleased' })).toEqual([true]);
    expect(ceremony.snapshot.circling).toBe(false);
  });

  it('the song plays on at the same pace whether the thali circles or rests', () => {
    const circled = setup();
    const rested = setup();
    for (const { ceremony } of [circled, rested]) ceremony.join();
    circled.route({ type: 'place' });
    run(circled.ceremony, 1.5);
    run(rested.ceremony, 1.5);
    circled.route({ type: 'placeReleased' });
    run(circled.ceremony, 0.5);
    run(rested.ceremony, 0.5);
    expect(circled.ceremony.snapshot.elapsed).toBeCloseTo(2, 5);
    expect(circled.ceremony.snapshot).toMatchObject({ state: 'running', participating: true, duration: 3 });
    expect({ ...circled.ceremony.snapshot, circling: false }).toEqual(rested.ceremony.snapshot);
  });

  it('there is nothing to score or fail: never circling still completes the full song', () => {
    const { ceremony } = setup();
    ceremony.join();
    run(ceremony, 3 + STEP);
    expect(ceremony.snapshot).toMatchObject({ state: 'completed', participating: false });
    expect(Object.keys(ceremony.snapshot).sort()).toEqual(
      ['circling', 'duration', 'elapsed', 'participating', 'playbackId', 'song', 'state'].sort(),
    );
  });

  it('a click from the hold is never a cracker placement', () => {
    const { route, ceremony, crackers } = setup();
    ceremony.join();
    expect(route({ type: 'place' }, { type: 'placeReleased' })).toEqual([true, true]);
    expect(crackers.held).toBeNull();
  });
});

describe('aarti participation — looking round', () => {
  it('look, camera, pause and the movement keys pass through untouched', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    expect(route(...PASS_THROUGH)).toEqual(PASS_THROUGH.map(() => false));
    expect(ceremony.snapshot).toMatchObject({ participating: true, circling: false });
  });

  it('swallows a jump while taking part, and holdStill drops one already asked for', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    expect(route({ type: 'jump' })).toEqual([true]);
    expect(holdStill({ forward: 0, right: 0, run: false, jump: true, yaw: 0 }, ceremony.snapshot).jump).toBe(false);
  });

  it('holds the player still while taking part, keeping the run state', () => {
    const walking: MovementIntent = { forward: 1, right: -1, run: true, yaw: 1.2 };
    expect(holdStill(walking, { participating: true })).toEqual({ forward: 0, right: 0, run: true, jump: false, yaw: 1.2 });
    expect(holdStill(walking, { participating: false })).toBe(walking);
  });

  it('keeps the body facing the puja while the view looks round', () => {
    const looking: MovementIntent = { forward: 0, right: 0, run: false, yaw: 2.4 };
    expect(holdStill(looking, { participating: true }, 0.3).yaw).toBe(0.3);
    // Away from aarti the body follows the view again.
    expect(holdStill(looking, { participating: false }, 0.3).yaw).toBe(2.4);
  });

  it('joining turns the body to look straight at the puja', () => {
    const puja = { x: -2.5, y: 0, z: -7.5 };
    // Yaw 0 looks down -Z, so a puja straight north is yaw 0 and one to the east is -π/2.
    expect(facePuja({ x: -2.5, y: 0, z: -6 }, puja, 1)).toBeCloseTo(0);
    expect(facePuja({ x: -4, y: 0, z: -7.5 }, puja, 1)).toBeCloseTo(-Math.PI / 2);
    expect(facePuja({ x: -3, y: 0, z: -6 }, puja, 1)).toBeCloseTo(Math.atan2(-0.5, 1.5));
    // Standing right on it, or with no puja, keeps the given yaw.
    expect(facePuja(puja, puja, 1)).toBe(1);
    expect(facePuja({ x: 0, y: 0, z: 0 }, undefined, 1)).toBe(1);
  });

  it('a player who leaves while still holding W walks off at once', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    const walking: MovementIntent = { forward: 1, right: 0, run: false, yaw: 0 };
    expect(holdStill(walking, ceremony.snapshot).forward).toBe(0);
    route({ type: 'interact' });
    expect(holdStill(walking, ceremony.snapshot).forward).toBe(1);
  });
});

describe('aarti participation — choosing a song', () => {
  it('1–3 pick the songs in mini-player order; 4 does nothing', () => {
    expect([1, 2, 3, 4].map((slot) => songForSlot(slot as 1 | 2 | 3 | 4))).toEqual([...AARTI_SONG_IDS, null]);
    for (const song of AARTI_SONG_IDS) expect(songForSlot(slotForSong(song))).toBe(song);
  });

  it('switching starts the new song from the beginning and keeps the player in aarti', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    run(ceremony, 1);
    expect(route({ type: 'select', slot: 2 })).toEqual([true]);
    expect(ceremony.snapshot).toMatchObject({ song: 'jaiLakshmiMata', elapsed: 0, duration: 5, participating: true });
  });

  it('choosing a song neither circles nor rests the thali, nor leaves', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    route({ type: 'place' });
    route({ type: 'select', slot: 3 }, { type: 'select', slot: 4 }, { type: 'select', slot: 3 });
    expect(ceremony.snapshot).toMatchObject({ song: 'jaiGaneshDeva', participating: true, circling: true });
  });

  it('re-choosing the playing song does not restart it', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    run(ceremony, 1);
    route({ type: 'select', slot: 1 });
    expect(ceremony.snapshot.elapsed).toBeCloseTo(1, 5);
  });

  it('number keys do not reach the cracker selection while taking part', () => {
    const { route, ceremony, crackers } = setup();
    ceremony.join();
    const before = crackers.selected;
    route({ type: 'select', slot: 1 });
    expect(crackers.selected).toBe(before);
  });
});

describe('aarti participation — leaving and rejoining', () => {
  it('E puts the thali down, frees the hands and stops the circling', () => {
    const { route, ceremony, hands } = setup();
    ceremony.join();
    route({ type: 'place' });
    expect(hands.hands).toEqual({ kind: 'thali' });
    expect(route({ type: 'interact' })).toEqual([true]);
    expect(ceremony.snapshot).toMatchObject({ state: 'running', participating: false, circling: false });
    expect(hands.hands).toBeNull();
  });

  it('a release arriving after leaving is harmless and is not taken from the game', () => {
    const { route, ceremony } = setup();
    ceremony.join();
    route({ type: 'place' }, { type: 'interact' });
    expect(route({ type: 'placeReleased' })).toEqual([false]);
    expect(ceremony.snapshot.circling).toBe(false);
  });

  it('browser walkthrough, headless: join, look, hold, release, switch, leave, rejoin at the right place', () => {
    const { route, ceremony } = setup();
    expect(ceremony.join().ok).toBe(true);
    route({ type: 'look', dx: 120, dy: 0 });
    route({ type: 'place' });
    run(ceremony, 0.5);
    route({ type: 'placeReleased' });
    route({ type: 'select', slot: 2 });
    run(ceremony, 1);
    route({ type: 'interact' });
    run(ceremony, 2); // the family carries on without the player
    expect(ceremony.snapshot).toMatchObject({ participating: false, song: 'jaiLakshmiMata' });
    expect(ceremony.snapshot.elapsed).toBeCloseTo(3, 5);
    expect(ceremony.join().ok).toBe(true);
    expect(ceremony.snapshot).toMatchObject({ participating: true, song: 'jaiLakshmiMata', circling: false });
    expect(ceremony.snapshot.elapsed).toBeCloseTo(3, 5);
  });
});

describe('aarti participation — from raw input', () => {
  function drive() {
    const ctx = setup();
    const input = new Input();
    const pump = () => input.drainActions().map((action) => applyAartiAction(action, ctx.ceremony));
    return { ...ctx, input, pump };
  }

  it('mouse down circles and mouse up rests', () => {
    const { input, pump, ceremony } = drive();
    ceremony.join();
    input.mouseDown(0);
    pump();
    expect(ceremony.snapshot.circling).toBe(true);
    input.mouseUp(0);
    pump();
    expect(ceremony.snapshot.circling).toBe(false);
  });

  it('losing focus mid-hold leaves the thali resting, not stuck circling', () => {
    const { input, pump, ceremony, bus } = drive();
    ceremony.join();
    input.mouseDown(0);
    pump();
    input.setEnabled(false); // focus lost: held input is released
    bus.emit('paused', { reason: 'focusLost' });
    expect(ceremony.snapshot.circling).toBe(false);
    input.setEnabled(true);
    pump();
    // The button came up while away; nothing restarts the circle.
    input.mouseUp(0);
    pump();
    expect(ceremony.snapshot.circling).toBe(false);
  });
});
