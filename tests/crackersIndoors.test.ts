import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { CapacityBudget } from '../src/capacity';
import type { CameraView, HeldItem, Interactable, InteractionModule, PlayerPose } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus } from '../src/core/events';
import { LOCATION_IDS, type HomeId, type LocationId } from '../src/core/homes';
import { qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, type Vec3 } from '../src/core/types';
import { applyCrackerAction, Crackers, crackersAllowed, putOutAtDoors } from '../src/crackers';
import { heldSparklerState, Sparkler } from '../src/crackers/sparkler';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import { doorwayId, HeldItems, Locations } from '../src/homes';
import { HudModel, promptLines, type HudContext } from '../src/ui/hudModel';
import { PHULJHARI_PUT_OUT_TEXT } from '../src/ui/text';
import { FakeAudioContext } from './fakeAudioContext';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const HOMES: readonly HomeId[] = ['familyHome', 'neighbourHome'];
const UNLIT: HeldItem = { id: 'held', type: 'phuljhari', lit: false };
const LIT: HeldItem = { id: 'held', type: 'phuljhari', lit: true };
const EXIT_DOOR: Interactable = { kind: 'door', id: doorwayId('familyHome', 'exit'), position: v(0, 0, 0) };
const PUJA: Interactable = { kind: 'puja', id: 'familyHome', position: v(0, 0, 0) };
const CRACKER_WORDS = /phuljhari|anar|chakri|rocket|cracker|Place|Light/i;

describe('crackers are outdoor-only', () => {
  it('allows crackers outdoors and nowhere else', () => {
    expect(LOCATION_IDS.filter(crackersAllowed)).toEqual(['outdoors']);
  });
});

describe('prompts in a home', () => {
  const contexts: [string, HudContext][] = [
    ['nothing in hand', { interactable: null }],
    ['an unlit phuljhari', { interactable: null, held: UNLIT }],
    ['a lit phuljhari', { interactable: null, held: LIT }],
    ['a valid placement', { interactable: null, placement: { ok: true, reason: null } }],
    ['a refused placement', { interactable: null, placement: { ok: false, reason: 'noSkyClearance' } }],
    ['free hands', { interactable: null, homes: { hands: null } }],
  ];

  it.each(HOMES)('offers no cracker action in %s, whatever is selected', (home) => {
    for (const type of CRACKER_TYPES) {
      for (const [, context] of contexts) expect(promptLines(type, { ...context, location: home })).toEqual([]);
    }
  });

  it('keeps the door and puja prompts', () => {
    const homes = { hands: null, doorway: () => undefined };
    for (const type of CRACKER_TYPES) {
      expect(promptLines(type, { interactable: EXIT_DOOR, homes, location: 'familyHome' })).toEqual([
        { text: 'E: Use the door', blocked: false },
      ]);
      expect(promptLines(type, { interactable: PUJA, homes, location: 'familyHome' })).toEqual([
        { text: 'E: Join aarti', blocked: false },
      ]);
    }
  });

  it('leaves the outdoor prompts as they were', () => {
    for (const type of CRACKER_TYPES) {
      for (const [, context] of contexts) {
        expect(promptLines(type, { ...context, location: 'outdoors' })).toEqual(promptLines(type, context));
      }
    }
    expect(promptLines('phuljhari', { interactable: null, held: UNLIT, location: 'outdoors' })).toEqual([
      { text: 'E: Light phuljhari', blocked: false },
    ]);
    expect(promptLines('rocket', { interactable: null, location: 'outdoors' })).toEqual([
      { text: 'Click: Place rocket', blocked: false },
    ]);
  });

  it('follows the location in HudModel and restores the prompt outdoors', () => {
    const bus = createGameEventBus();
    const hud = new HudModel({ bus, selected: 'phuljhari' });
    bus.emit('sessionStarted', {});
    const context: HudContext = { interactable: null, held: UNLIT, homes: { hands: null } };
    hud.setContext(context);
    expect(hud.prompts.map((l) => l.text)).toEqual(['E: Light phuljhari']);
    bus.emit('locationChanged', { doorway: 'familyHome.enter', from: 'outdoors', to: 'familyHome' });
    hud.setContext(context);
    expect(hud.prompts).toEqual([]);
    // Keys 1–4 still change the selection, silently.
    for (const type of CRACKER_TYPES) {
      bus.emit('crackerSelected', { type });
      hud.setContext(context);
      expect(hud.prompts.some((l) => CRACKER_WORDS.test(l.text))).toBe(false);
    }
    bus.emit('crackerSelected', { type: 'phuljhari' });
    bus.emit('locationChanged', { doorway: 'familyHome.exit', from: 'familyHome', to: 'outdoors' });
    hud.setContext(context);
    expect(hud.prompts.map((l) => l.text)).toEqual(['E: Light phuljhari']);
  });

  it('shows the put-out message', () => {
    const bus = createGameEventBus();
    const hud = new HudModel({ bus });
    bus.emit('phuljhariPutOut', { id: 'held' });
    expect(hud.rejection?.text).toBe(PHULJHARI_PUT_OUT_TEXT);
  });
});

describe('the held stick in a home', () => {
  it('is hidden indoors and shown again outdoors', () => {
    const sparkler = new Sparkler();
    const show = (held: HeldItem | null, location: LocationId) => {
      sparkler.update(v(0, 1, 0), new THREE.Vector3(0, 1, 0), heldSparklerState(held, 0, location));
      return sparkler.object.visible;
    };
    expect(show(UNLIT, 'outdoors')).toBe(true);
    for (const home of HOMES) {
      expect(show(UNLIT, home)).toBe(false);
      expect(show(LIT, home)).toBe(false);
      expect(heldSparklerState(LIT, 0.5, home)).toEqual({ held: false, lit: false, progress: 0.5 });
    }
    expect(show(UNLIT, 'outdoors')).toBe(true);
    expect(heldSparklerState(LIT, 0.5, 'outdoors')).toEqual({ held: true, lit: true, progress: 0.5 });
    expect(show(null, 'outdoors')).toBe(false);
    sparkler.dispose();
  });
});

function controls(crackers: Crackers, bus: GameEventBus, place: { location: LocationId }) {
  const pose: PlayerPose = { position: v(0, 0, 0), yaw: 0, grounded: true };
  const view: CameraView = { mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, 0, -1), yaw: 0, pitch: 0 };
  const interaction: InteractionModule = {
    findInteractable: () => null,
    validatePlacement: (request) => ({ ok: true, preview: { type: request.type, position: request.target } }),
  };
  return { crackers, bus, interaction, pose: () => pose, view: () => view, location: () => place.location };
}

describe('cracker actions in a home', () => {
  it.each(HOMES)('click and E light nothing and place nothing in %s', (home) => {
    for (const type of CRACKER_TYPES) {
      const bus = createGameEventBus();
      const events: string[] = [];
      for (const name of ['crackerPlaced', 'fuseLit', 'placementRejected', 'ignitionRejected'] as const) {
        bus.on(name, () => events.push(name));
      }
      const crackers = new Crackers({ bus, initialSelection: type });
      const ctx = controls(crackers, bus, { location: home });
      expect(applyCrackerAction({ type: 'place' }, ctx)).toBe(true);
      expect(applyCrackerAction({ type: 'interact' }, ctx)).toBe(true);
      expect(crackers.list()).toEqual([]);
      expect(crackers.held?.lit ?? false).toBe(false);
      expect(crackers.litCount).toBe(0);
      expect(events).toEqual([]);
    }
  });

  it('still changes the selection with 1–4, and lights again once outdoors', () => {
    const bus = createGameEventBus();
    const crackers = new Crackers({ bus, initialSelection: 'anar' });
    const place = { location: 'familyHome' as LocationId };
    const ctx = controls(crackers, bus, place);
    applyCrackerAction({ type: 'select', slot: 1 }, ctx);
    expect(crackers.selected).toBe('phuljhari');
    applyCrackerAction({ type: 'interact' }, ctx);
    expect(crackers.held).toMatchObject({ lit: false });
    place.location = 'outdoors';
    applyCrackerAction({ type: 'interact' }, ctx);
    expect(crackers.held).toMatchObject({ lit: true });
  });
});

describe('a phuljhari at the door', () => {
  const ENTER: Record<HomeId, string> = {
    familyHome: doorwayId('familyHome', 'enter'),
    neighbourHome: doorwayId('neighbourHome', 'enter'),
  };

  async function setup(initialSelection: 'phuljhari' | 'anar' = 'phuljhari') {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({ bus, createContext: () => ctx.asAudioContext(), profile: qualityProfile('low') });
    await audio.unlock();
    const hand = v(0, 1.1, 0);
    const effects = new FireworksEffects(bus, { quality: qualityProfile('medium'), handPosition: () => hand });
    const capacity = new CapacityBudget({
      crackers: () => crackers,
      bus,
      quality: qualityProfile('medium'),
      effects: () => effects.stats,
      voices: () => audio.activeVoices,
    });
    const crackers = new Crackers({ bus, admission: capacity, random: () => 0.5, handPosition: () => hand, initialSelection });
    const hands = new HeldItems({ bus, crackers });
    const locations = new Locations({ bus, hands });
    putOutAtDoors(bus, crackers);
    const hud = new HudModel({ bus });
    bus.emit('sessionStarted', {});
    const finished: string[] = [];
    bus.on('crackerFinished', ({ id }) => finished.push(id));
    const step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        crackers.update(STEP);
        effects.update(STEP);
        capacity.update(STEP);
        locations.update(STEP);
      }
    };
    const go = (doorway: string) => {
      expect(locations.requestTransition(doorway).ok).toBe(true);
      step(TUNING.homes.fadeDuration + STEP);
    };
    return { bus, audio, effects, capacity, crackers, hands, locations, hud, finished, step, go };
  }

  it.each(HOMES)('puts a lit one out as the fade into %s starts', async (home) => {
    const s = await setup();
    const id = s.crackers.held!.id;
    expect(s.crackers.igniteHeld().ok).toBe(true);
    s.step(TUNING.crackers.fuse.phuljhari + 0.5);
    expect(s.crackers.heldProgress).toBeGreaterThan(0);
    expect(s.effects.stats.activeEffects).toBeGreaterThan(0);
    expect(s.audio.activeVoices).toBeGreaterThan(0);

    expect(s.locations.requestTransition(ENTER[home]).ok).toBe(true);
    // At once, before the screen goes black.
    expect(s.finished).toEqual([id]);
    expect(s.crackers.litCount).toBe(0);
    expect(s.capacity.stats.resources.litCrackers.used).toBe(0);
    expect(s.audio.activeVoices).toBe(0);
    expect(s.hud.rejection?.text).toBe(PHULJHARI_PUT_OUT_TEXT);
    // A fresh, unlit one in hand, kept out of sight indoors.
    expect(s.crackers.held).toMatchObject({ lit: false });
    expect(s.crackers.held!.id).not.toBe(id);

    s.step(TUNING.homes.fadeDuration + 2);
    expect(s.locations.location).toBe(home);
    expect(s.effects.stats.activeEffects).toBe(0);
    expect(s.effects.stats.liveParticles).toBe(0);
    expect(heldSparklerState(s.crackers.held, s.crackers.heldProgress, s.locations.location).held).toBe(false);
    expect(s.finished).toEqual([id]);

    // Back outside: the unlit stick is in hand again and lights as usual; nothing old comes back.
    s.go(doorwayId(home, 'exit'));
    expect(heldSparklerState(s.crackers.held, 0, s.locations.location)).toMatchObject({ held: true, lit: false });
    expect(s.crackers.igniteHeld().ok).toBe(true);
    expect(s.finished).toEqual([id]);
  });

  it('keeps an unlit one in hand, quietly', async () => {
    const s = await setup();
    const id = s.crackers.held!.id;
    s.go(ENTER.familyHome);
    expect(s.crackers.held).toEqual({ id, type: 'phuljhari', lit: false });
    expect(s.finished).toEqual([]);
    expect(s.hud.rejection).toBeNull();
    expect(heldSparklerState(s.crackers.held, 0, s.locations.location).held).toBe(false);
    s.go(doorwayId('familyHome', 'exit'));
    expect(heldSparklerState(s.crackers.held, 0, s.locations.location).held).toBe(true);
  });

  it('leaves ground crackers burning outside', async () => {
    const s = await setup('anar');
    const placed = s.crackers.place({ type: 'anar', position: v(0, 0, -5) });
    if (!placed.ok) throw new Error(placed.reason);
    s.crackers.ignite(placed.id);
    s.go(ENTER.familyHome);
    expect(s.finished).toEqual([]);
    expect(s.crackers.get(placed.id)?.state).toMatch(/fuseBurning|active/);
    expect(s.crackers.litCount).toBe(1);
    expect(s.hud.rejection).toBeNull();
  });

  it('does nothing on the way out', async () => {
    const s = await setup();
    s.go(ENTER.neighbourHome);
    const id = s.crackers.held!.id;
    s.locations.requestTransition(doorwayId('neighbourHome', 'exit'));
    expect(s.crackers.held?.id).toBe(id);
    expect(s.hud.rejection).toBeNull();
  });

  it('starts the next session as usual after a put-out', async () => {
    const s = await setup();
    s.crackers.igniteHeld();
    s.go(ENTER.familyHome);
    s.bus.emit('sessionReset', {});
    s.locations.reset();
    s.hands.reset();
    expect(s.crackers.held).toMatchObject({ lit: false });
    expect(s.crackers.litCount).toBe(0);
    expect(s.hud.rejection).toBeNull();
    expect(s.hud.prompts).toEqual([]);
    expect(s.crackers.igniteHeld().ok).toBe(true);
  });
});
