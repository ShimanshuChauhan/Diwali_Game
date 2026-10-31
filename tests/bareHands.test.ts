import { describe, expect, it, vi } from 'vitest';
import { applyAartiAction } from '../src/aarti';
import { applyBaltiAction, BaltiBlast } from '../src/balti';
import { cycleSelection, ITEM_CYCLE, type GameAction, type HandSelection } from '../src/core/actions';
import type { CameraView, Interactable, InteractionModule, PlayerPose } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { CRACKER_TYPES, type Vec3 } from '../src/core/types';
import { applyCrackerAction, Crackers } from '../src/crackers';
import { allowedDuringFade, HeldItems } from '../src/homes';
import { applyHomeAction } from '../src/interaction';
import { bindingFor, KEY_BINDINGS, WHEEL_STEP } from '../src/session/bindings';
import { createDomControls, type PointerLockDocument } from '../src/session/domControls';
import { Input } from '../src/session/input';
import { Session } from '../src/session/session';
import { HudModel, promptLines, SWITCH_TOAST_SECONDS } from '../src/ui/hudModel';
import { CONTROLS_HELP } from '../src/ui/text';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const BARE: GameAction = { type: 'bareHands' };
const HOLSTER: GameAction = { type: 'holster' };
const NEXT: GameAction = { type: 'cycleItem', step: 1 };
const PREVIOUS: GameAction = { type: 'cycleItem', step: -1 };

function setup(initialSelection?: HandSelection) {
  const bus = createGameEventBus();
  const crackers = new Crackers({ bus, random: () => 0.5, handPosition: () => v(0, 1.1, 0), initialSelection });
  const hands = new HeldItems({ bus, crackers });
  const selected: HandSelection[] = [];
  const blocked: string[] = [];
  const rejected: string[] = [];
  bus.on('crackerSelected', ({ type }) => selected.push(type));
  bus.on('crackerBlocked', ({ reason }) => blocked.push(reason));
  bus.on('placementRejected', ({ reason }) => rejected.push(reason));
  bus.on('ignitionRejected', ({ reason }) => rejected.push(reason));
  let target: Interactable | null = null;
  const validatePlacement = vi.fn<InteractionModule['validatePlacement']>(({ type, target: at }) => ({
    ok: true,
    preview: { type, position: at },
  }));
  const interaction: InteractionModule = {
    findInteractable: () => target,
    validatePlacement,
    previewPlacement: validatePlacement,
  } as unknown as InteractionModule;
  const pose: PlayerPose = { position: v(0, 0, 0), yaw: 0, velocity: v(0, 0, 0) } as unknown as PlayerPose;
  const view: CameraView = { mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, -0.6, -0.8), yaw: 0, pitch: 0 };
  const ctx = { crackers, interaction, bus, pose: () => pose, view: () => view, hands };
  const route = (...actions: GameAction[]) => actions.map((action) => applyCrackerAction(action, ctx));
  const aim = (next: Interactable | null) => (target = next);
  return { bus, crackers, hands, selected, blocked, rejected, route, aim, validatePlacement };
}

describe('the item cycle', () => {
  it('puts bare hands first, before the five crackers in key order', () => {
    expect(ITEM_CYCLE).toEqual([null, ...CRACKER_TYPES]);
  });

  it('steps both ways and wraps round through bare hands', () => {
    expect(cycleSelection(null, 1)).toBe('phuljhari');
    expect(cycleSelection('anar', 1)).toBe('chakri');
    expect(cycleSelection('ladi', 1)).toBeNull();
    expect(cycleSelection(null, -1)).toBe('ladi');
    expect(cycleSelection('phuljhari', -1)).toBeNull();
  });
});

describe('bare-hands bindings', () => {
  it('binds ` and 0 to bare hands and H to the holster, leaving 1–5 as they were', () => {
    expect(bindingFor('Backquote')).toEqual({ kind: 'press', action: BARE });
    expect(bindingFor('Digit0')).toEqual({ kind: 'press', action: BARE });
    expect(bindingFor('KeyH')).toEqual({ kind: 'press', action: HOLSTER });
    for (const slot of [1, 2, 3, 4, 5] as const) {
      expect(bindingFor(`Digit${slot}`)).toEqual({ kind: 'press', action: { type: 'select', slot } });
    }
  });

  it('gives every bound key one action, none of them shared with a movement key', () => {
    const codes = Object.keys(KEY_BINDINGS);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ['Backquote', 'Digit0', 'KeyH']) expect(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyV']).not.toContain(code);
  });

  it('is listed in the controls help', () => {
    const keys = CONTROLS_HELP.map(([key]) => key);
    expect(keys).toEqual(expect.arrayContaining(['` or 0', 'Wheel', 'H']));
  });
});

describe('the mouse wheel', () => {
  it('cycles once per notch: down to the next item, up to the previous', () => {
    const input = new Input();
    input.wheel(WHEEL_STEP);
    input.wheel(-WHEEL_STEP);
    expect(input.drainActions()).toEqual([NEXT, PREVIOUS]);
  });

  it('adds up small trackpad deltas, steps at most once per event and restarts when turned back', () => {
    const input = new Input();
    input.wheel(WHEEL_STEP / 2);
    expect(input.drainActions()).toEqual([]);
    input.wheel(WHEEL_STEP / 2);
    expect(input.drainActions()).toEqual([NEXT]);
    input.wheel(WHEEL_STEP * 5);
    expect(input.drainActions()).toEqual([NEXT]);
    input.wheel(WHEEL_STEP * 0.8);
    input.wheel(-WHEEL_STEP * 0.8);
    expect(input.drainActions()).toEqual([]);
  });

  it('is ignored while input is off', () => {
    const input = new Input({ enabled: false });
    input.wheel(WHEEL_STEP * 2);
    input.setEnabled(true);
    expect(input.drainActions()).toEqual([]);
  });

  it('reaches Input from the canvas only while the pointer is locked, and never scrolls the page', () => {
    class FakeDocument extends EventTarget implements PointerLockDocument {
      pointerLockElement: unknown = null;
      visibilityState = 'visible';
      hasFocus = () => true;
      exitPointerLock = () => this.lock(null);
      lock(element: unknown) {
        this.pointerLockElement = element;
        this.dispatchEvent(new Event('pointerlockchange'));
      }
    }
    const bus = createGameEventBus();
    const doc = new FakeDocument();
    const element = Object.assign(new EventTarget(), { requestPointerLock: () => doc.lock(element) });
    const input = new Input({ bus, enabled: false });
    createDomControls({ input, session: new Session({ bus }), bus, element, doc, win: new EventTarget() });
    const wheel = (deltaY: number, deltaMode = 0) =>
      Object.assign(new Event('wheel', { cancelable: true }), { deltaY, deltaMode });

    element.dispatchEvent(wheel(120));
    expect(input.drainActions()).toEqual([]);
    element.requestPointerLock();
    const notch = wheel(120);
    element.dispatchEvent(notch);
    expect(notch.defaultPrevented).toBe(true);
    // Firefox reports lines rather than pixels.
    element.dispatchEvent(wheel(-3, 1));
    expect(input.drainActions()).toEqual([NEXT, PREVIOUS]);
  });
});

describe('bare hands', () => {
  it('is how a session starts: nothing in hand, the phuljhari remembered for the holster', () => {
    const { crackers, hands } = setup();
    expect(crackers.selected).toBeNull();
    expect(crackers.held).toBeNull();
    expect(crackers.lastCracker).toBe('phuljhari');
    expect(hands.state).toEqual({ kind: 'empty' });
  });

  it('puts the phuljhari away, finishing a lit one early', () => {
    const { bus, crackers, route, selected } = setup('phuljhari');
    const finished: string[] = [];
    bus.on('crackerFinished', ({ reason }) => finished.push(reason));
    crackers.igniteHeld();
    expect(route(BARE)).toEqual([true]);
    expect(crackers.selected).toBeNull();
    expect(crackers.held).toBeNull();
    expect(finished).toEqual(['completed']);
    expect(selected).toEqual([null]);
  });

  it('the wheel steps through every item and back round to bare hands', () => {
    const { crackers, route, selected } = setup();
    route(...ITEM_CYCLE.map(() => NEXT));
    expect(selected).toEqual([...CRACKER_TYPES, null]);
    expect(crackers.selected).toBeNull();
    route(PREVIOUS);
    expect(crackers.selected).toBe('ladi');
    route(NEXT, NEXT);
    expect(crackers.selected).toBe('phuljhari');
    expect(crackers.held).not.toBeNull();
  });

  it('H holsters the cracker in hand and takes the same one out again', () => {
    const { crackers, route } = setup();
    route(HOLSTER);
    expect(crackers.selected).toBe('phuljhari');
    route({ type: 'select', slot: 4 }, HOLSTER);
    expect(crackers.selected).toBeNull();
    expect(crackers.lastCracker).toBe('rocket');
    route(HOLSTER);
    expect(crackers.selected).toBe('rocket');
    // The memory survives bare hands chosen by key and by wheel.
    route(BARE, HOLSTER);
    expect(crackers.selected).toBe('rocket');
    route(PREVIOUS, PREVIOUS, PREVIOUS, PREVIOUS, HOLSTER);
    expect(crackers.selected).toBe('phuljhari');
  });

  it('forgets the last cracker on a fresh session', () => {
    const { bus, crackers, route } = setup();
    route({ type: 'select', slot: 3 }, BARE);
    bus.emit('sessionReset', {});
    expect(crackers.selected).toBeNull();
    expect(crackers.lastCracker).toBe('phuljhari');
  });

  it('click places and lights nothing, with no refusal on screen', () => {
    const { crackers, route, rejected, blocked, validatePlacement } = setup();
    expect(route({ type: 'place' }, { type: 'interact' })).toEqual([true, true]);
    expect(crackers.list()).toEqual([]);
    expect(validatePlacement).not.toHaveBeenCalled();
    expect(rejected).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it('E still lights a cracker already placed', () => {
    const { crackers, route, aim } = setup('anar');
    route({ type: 'place' });
    const [anar] = crackers.list();
    route(BARE);
    aim({ kind: 'cracker', id: anar!.id, position: anar!.position });
    route({ type: 'interact' });
    expect(crackers.get(anar!.id)?.state).toBe('fuseBurning');
  });

  it('is refused like any switch while a plate is carried, and stays bare after it', () => {
    const { bus, crackers, hands, route, blocked, selected } = setup();
    bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
    expect(hands.pickUpPlate().ok).toBe(true);
    route(HOLSTER, NEXT, BARE);
    expect(blocked).toEqual(['carryingPlate', 'carryingPlate', 'carryingPlate']);
    expect(hands.returnPlate().ok).toBe(true);
    expect(crackers.selected).toBeNull();
    expect(selected).toEqual([]);
  });

  it('counts as empty hands for doors, people, the tray and the balti', () => {
    const { crackers, hands } = setup();
    expect(crackers.selected).toBeNull();
    expect(hands.hands).toBeNull();

    const requestTransition = vi.fn(() => ({ ok: true as const }));
    const react = vi.fn();
    const ctx = { locations: { requestTransition }, hands, household: { react } };
    const door: Interactable = { kind: 'door', id: 'familyHome.enter', position: v(0, 0, 0) };
    expect(applyHomeAction({ type: 'interact' }, door, ctx)).toBe(true);
    expect(requestTransition).toHaveBeenCalledWith('familyHome.enter');
    const person = { kind: 'person', id: 'neighbourAunty', position: v(0, 0, 0) } as unknown as Interactable;
    expect(applyHomeAction({ type: 'interact' }, person, ctx)).toBe(true);
    expect(react).toHaveBeenCalled();

    // The balti asks for free hands; bare hands are free.
    const blast = new BaltiBlast({ spot: v(0, 0, 0), random: () => 0.5 });
    const balti = { balti: blast, feet: () => v(0, 0, 1.2), forward: () => v(0, 0, -1), busy: () => hands.hands !== null };
    expect(applyBaltiAction({ type: 'interact' }, balti)).toBe(true);
    expect(blast.phase).toBe('bombPlaced');
  });

  it('switching is dropped during a door fade and used up doing nothing in aarti', () => {
    for (const action of [BARE, HOLSTER, NEXT]) expect(allowedDuringFade(action)).toBe(false);
    const setCircling = vi.fn();
    const ceremony = {
      snapshot: { participating: true },
      leave: vi.fn(),
      selectSong: vi.fn(),
      setCircling,
    } as unknown as Parameters<typeof applyAartiAction>[1];
    for (const action of [BARE, HOLSTER, NEXT]) expect(applyAartiAction(action, ceremony)).toBe(true);
    expect(ceremony.leave).not.toHaveBeenCalled();
    expect(ceremony.selectSong).not.toHaveBeenCalled();
  });
});

describe('bare hands on the HUD', () => {
  function running() {
    const bus = createGameEventBus();
    const hud = new HudModel({ bus });
    bus.emit('sessionStarted', {});
    return { bus, hud };
  }

  it('prompts nothing to light or place, but still offers what is in reach', () => {
    expect(promptLines(null, { interactable: null })).toEqual([]);
    const anar: Interactable = { kind: 'cracker', id: 'c1', position: v(0, 0, -1) };
    expect(promptLines(null, { interactable: anar, interactableType: 'anar' })).toEqual([
      { text: 'E: Light anar', blocked: false },
    ]);
    const diya: Interactable = { kind: 'diya', id: 'd1', position: v(0, 0, -1) };
    expect(promptLines(null, { interactable: diya }).map((l) => l.text)).toEqual(['E: Light diya']);
  });

  it('names a switch in a short toast, and stays quiet for the same selection again', () => {
    const { bus, hud } = running();
    expect(hud.selected).toBeNull();
    bus.emit('crackerSelected', { type: 'anar' });
    expect(hud.toast?.text).toBe('Anar');
    bus.emit('crackerSelected', { type: null });
    expect(hud.toast?.text).toBe('Bare hands');
    hud.update(SWITCH_TOAST_SECONDS + 0.1);
    expect(hud.toast).toBeNull();
    bus.emit('crackerSelected', { type: null });
    expect(hud.toast).toBeNull();
  });

  it('shows no toast in a home, where the hotbar hides', () => {
    const { bus, hud } = running();
    bus.emit('locationChanged', { doorway: 'familyHome.enter', from: 'outdoors', to: 'familyHome' });
    bus.emit('crackerSelected', { type: 'rocket' });
    expect(hud.selected).toBe('rocket');
    expect(hud.toast).toBeNull();
  });
});
