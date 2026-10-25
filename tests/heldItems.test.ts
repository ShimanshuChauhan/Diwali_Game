import { describe, expect, it } from 'vitest';
import type { GameAction, SelectSlot } from '../src/core/actions';
import type { CameraView, Interactable, InteractionModule, PlayerPose } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import type { CrackerHandsRejection, HandItem, ItemRejection, ReturnSpot } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, type CrackerType, type Vec3 } from '../src/core/types';
import { CapacityBudget } from '../src/capacity';
import { qualityProfile } from '../src/core/quality';
import { applyCrackerAction, Crackers } from '../src/crackers';
import {
  CRACKER_BLOCKED_TEXT,
  HeldItems,
  homesResetHooks,
  ITEM_REJECTION_TEXT,
  pendingModules,
  registerHomesReset,
  returnSpotFor,
} from '../src/homes';
import { Session } from '../src/session/session';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const STEP = 1 / 60;
const { fuse, activeDuration } = TUNING.crackers;

const PLATE: HandItem = { kind: 'sweetsPlate' };
const OUTBOUND: HandItem = { kind: 'giftBox', box: 'outbound' };
const RETURN_BOX: HandItem = { kind: 'giftBox', box: 'return' };
const THALI: HandItem = { kind: 'thali' };

/** Every item that can occupy the hands, with the reason it blocks crackers. */
const ITEMS: readonly (readonly [string, HandItem, CrackerHandsRejection])[] = [
  ['sweets plate', PLATE, 'carryingPlate'],
  ['outbound gift box', OUTBOUND, 'carryingGift'],
  ['return gift box', RETURN_BOX, 'carryingGift'],
  ['thali', THALI, 'holdingThali'],
];

type Logged = { [K in GameEventName]: { name: K; payload: GameEvents[K] } }[GameEventName];

function record(bus: GameEventBus): Logged[] {
  const log: Logged[] = [];
  const names: GameEventName[] = [
    'crackerSelected',
    'crackerPlaced',
    'placementRejected',
    'fuseLit',
    'ignitionRejected',
    'crackerActive',
    'crackerFinished',
    'crackerBlocked',
    'itemPickedUp',
    'itemReturned',
    'itemDelivered',
    'itemRejected',
    'sweetsEaten',
    'sweetsOffered',
  ];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

function setup(initialSelection: CrackerType = 'anar') {
  const bus = createGameEventBus();
  const log = record(bus);
  const crackers = new Crackers({ bus, random: () => 0.5, handPosition: () => v(0, 1.1, 0), initialSelection });
  const hands = new HeldItems({ bus, crackers });
  const names = () => log.map((e) => e.name);
  const clear = () => (log.length = 0);
  const step = (seconds: number) => {
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) crackers.update(STEP);
  };
  const serveTray = () => bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
  return { bus, log, names, clear, crackers, hands, step, serveTray };
}

/** Put `item` in the hands the way its owning module would. */
function hold(s: ReturnType<typeof setup>, item: HandItem): void {
  if (item.kind === 'sweetsPlate') {
    s.serveTray();
    expect(s.hands.pickUpPlate()).toEqual({ ok: true });
  } else if (item.kind === 'thali') {
    expect(s.hands.reserveThali()).toEqual({ ok: true });
  } else {
    expect(s.hands.take(item)).toEqual({ ok: true });
  }
}

function lastRejection(log: Logged[]): GameEvents['itemRejected'] | undefined {
  const entries = log.filter((e) => e.name === 'itemRejected');
  return entries.at(-1)?.payload as GameEvents['itemRejected'] | undefined;
}

describe('hand state', () => {
  it('starts with the selected ground cracker in hand', () => {
    const { hands } = setup('anar');
    expect(hands.state).toEqual({ kind: 'cracker', type: 'anar' });
    expect(hands.hands).toBeNull();
    expect(hands.crackerBlock()).toBeNull();
  });

  it('holds an unlit, then lit, phuljhari as a sparkler', () => {
    const { hands, crackers } = setup('phuljhari');
    expect(hands.state).toEqual({ kind: 'sparkler', lit: false });
    crackers.igniteHeld();
    expect(hands.state).toEqual({ kind: 'sparkler', lit: true });
  });

  it('is empty once the phuljhari burns out', () => {
    const { hands, crackers, step } = setup('phuljhari');
    crackers.igniteHeld();
    step(fuse.phuljhari + activeDuration.phuljhari + 0.1);
    expect(hands.state).toEqual({ kind: 'empty' });
  });

  it.each(ITEMS)('shows a carried %s instead of any cracker', (_name, item, reason) => {
    const s = setup('phuljhari');
    hold(s, item);
    expect(s.hands.state).toEqual(item);
    expect(s.hands.hands).toEqual(item);
    expect(s.hands.crackerBlock()).toBe(reason);
  });
});

describe('taking an item', () => {
  it.each(ITEMS)('takes a %s over a selected ground cracker, keeping the selection', (_name, item) => {
    const s = setup('rocket');
    s.clear();
    hold(s, item);
    expect(s.crackers.selected).toBe('rocket');
    expect(s.names()).toContain('itemPickedUp');
    expect(s.log.find((e) => e.name === 'itemPickedUp')?.payload).toEqual({ item });
    expect(s.names()).not.toContain('crackerSelected');
  });

  it.each(ITEMS)('puts an unlit phuljhari away for a %s without burning it', (_name, item) => {
    const s = setup('phuljhari');
    s.clear();
    hold(s, item);
    expect(s.crackers.held).toBeNull();
    expect(s.crackers.selected).toBe('phuljhari');
    expect(s.crackers.litCount).toBe(0);
    expect(s.names()).not.toContain('crackerFinished');
  });

  it.each(ITEMS)('refuses a %s while a lit phuljhari is in hand', (_name, item) => {
    const s = setup('phuljhari');
    s.serveTray();
    s.crackers.igniteHeld();
    const result =
      item.kind === 'sweetsPlate' ? s.hands.pickUpPlate() : item.kind === 'thali' ? s.hands.reserveThali() : s.hands.take(item);
    expect(result).toEqual({ ok: false, reason: 'sparklerLit' });
    expect(s.hands.hands).toBeNull();
    expect(s.crackers.held?.lit).toBe(true);
    expect(lastRejection(s.log)).toEqual({ action: item.kind === 'sweetsPlate' ? 'pickUpPlate' : 'take', reason: 'sparklerLit' });
  });

  it('takes an item once a lit phuljhari is switched away', () => {
    const s = setup('phuljhari');
    s.crackers.igniteHeld();
    s.crackers.select('anar');
    expect(s.hands.take(OUTBOUND)).toEqual({ ok: true });
  });

  it('takes an item with empty hands after a phuljhari burns out', () => {
    const s = setup('phuljhari');
    s.crackers.igniteHeld();
    s.step(fuse.phuljhari + activeDuration.phuljhari + 0.1);
    expect(s.hands.take(OUTBOUND)).toEqual({ ok: true });
    s.hands.release('giftBox');
    // Nothing was put away, so nothing comes back.
    expect(s.hands.state).toEqual({ kind: 'empty' });
  });

  it.each(ITEMS)('holds only one item: a carried %s refuses every other', (_name, carried, reason) => {
    for (const [, other] of ITEMS) {
      const s = setup();
      s.serveTray();
      hold(s, carried);
      s.clear();
      const result =
        other.kind === 'sweetsPlate' ? s.hands.pickUpPlate() : other.kind === 'thali' ? s.hands.reserveThali() : s.hands.take(other);
      expect(result).toEqual({ ok: false, reason });
      expect(s.hands.hands).toEqual(carried);
      expect(s.names()).toEqual(['itemRejected']);
    }
  });
});

describe('freeing the hands', () => {
  it.each(ITEMS)('brings a put-away phuljhari back when a %s is released', (_name, item) => {
    const s = setup('phuljhari');
    hold(s, item);
    s.clear();
    s.hands.release(item.kind);
    expect(s.hands.hands).toBeNull();
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
    expect(s.names()).toEqual(['itemReturned', 'crackerSelected']);
  });

  it('returns to the selected ground cracker without re-selecting it', () => {
    const s = setup('chakri');
    hold(s, THALI);
    s.clear();
    s.hands.release('thali');
    expect(s.hands.state).toEqual({ kind: 'cracker', type: 'chakri' });
    expect(s.names()).toEqual(['itemReturned']);
  });

  it('ignores releasing something not in hand', () => {
    const s = setup();
    hold(s, OUTBOUND);
    s.clear();
    s.hands.release('thali');
    s.hands.release('sweetsPlate');
    expect(s.hands.hands).toEqual(OUTBOUND);
    expect(s.log).toEqual([]);
  });
});

describe('designated return spots', () => {
  const SPOTS: readonly (readonly [HandItem, ReturnSpot])[] = [
    [PLATE, { item: 'sweetsPlate', home: 'familyHome' }],
    [OUTBOUND, { item: 'giftBox', home: 'familyHome' }],
    [RETURN_BOX, { item: 'giftBox', home: 'neighbourHome' }],
  ];

  it('keeps the plate home and each box in the home it came from', () => {
    for (const [item, spot] of SPOTS) expect(returnSpotFor(item)).toEqual(spot);
    expect(returnSpotFor(THALI)).toBeNull();
  });

  it.each(SPOTS)('puts %o back on its own spot', (item, spot) => {
    const s = setup('phuljhari');
    hold(s, item);
    s.clear();
    expect(s.hands.returnTo(spot)).toEqual({ ok: true });
    expect(s.hands.hands).toBeNull();
    expect(s.log[0]).toEqual({ name: 'itemReturned', payload: { item } });
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
  });

  it.each(SPOTS)('refuses to put %o on any other spot', (item, own) => {
    const others: ReturnSpot[] = [
      { item: 'sweetsPlate', home: 'familyHome' },
      { item: 'sweetsPlate', home: 'neighbourHome' },
      { item: 'giftBox', home: 'familyHome' },
      { item: 'giftBox', home: 'neighbourHome' },
      { item: 'thali', home: 'familyHome' },
    ].filter((spot) => spot.item !== own.item || spot.home !== own.home) as ReturnSpot[];
    for (const spot of others) {
      const s = setup();
      hold(s, item);
      expect(s.hands.returnTo(spot)).toEqual({ ok: false, reason: 'wrongReturnSpot' });
      expect(s.hands.hands).toEqual(item);
      expect(lastRejection(s.log)).toEqual({ action: 'returnItem', reason: 'wrongReturnSpot' });
    }
  });

  it('has nothing to return with empty hands', () => {
    const s = setup();
    expect(s.hands.returnTo({ item: 'giftBox', home: 'familyHome' })).toEqual({ ok: false, reason: 'notHolding' });
    expect(lastRejection(s.log)).toEqual({ action: 'returnItem', reason: 'notHolding' });
  });

  it('leaves the thali to the ceremony rather than a spot', () => {
    const s = setup();
    hold(s, THALI);
    expect(s.hands.returnTo({ item: 'thali', home: 'familyHome' })).toEqual({ ok: false, reason: 'holdingThali' });
    expect(s.hands.hands).toEqual(THALI);
  });

  it('returns the plate to the sweets table', () => {
    const s = setup();
    hold(s, PLATE);
    expect(s.hands.returnPlate()).toEqual({ ok: true });
    expect(s.hands.hands).toBeNull();
  });

  it.each([
    ['empty hands', null],
    ['a gift box', OUTBOUND],
    ['the thali', THALI],
  ] as const)('has no plate to return with %s', (_name, item) => {
    const s = setup();
    if (item) hold(s, item);
    expect(s.hands.returnPlate()).toEqual({ ok: false, reason: 'notHolding' });
    expect(s.hands.hands).toEqual(item);
    expect(lastRejection(s.log)).toEqual({ action: 'returnPlate', reason: 'notHolding' });
  });
});

describe('gift box identity', () => {
  it.each([OUTBOUND, RETURN_BOX])('keeps %o the same box across return and re-pickup', (box) => {
    const s = setup();
    const spot = returnSpotFor(box)!;
    for (let i = 0; i < 3; i++) {
      expect(s.hands.take(box)).toEqual({ ok: true });
      expect(s.hands.hands).toEqual(box);
      expect(s.hands.returnTo(spot)).toEqual({ ok: true });
    }
    const returned = s.log.filter((e) => e.name === 'itemReturned').map((e) => e.payload);
    const picked = s.log.filter((e) => e.name === 'itemPickedUp').map((e) => e.payload);
    expect(returned).toEqual([{ item: box }, { item: box }, { item: box }]);
    expect(picked).toEqual([{ item: box }, { item: box }, { item: box }]);
  });

  it('cannot put the return box back on the outbound box’s spot', () => {
    const s = setup();
    s.hands.take(RETURN_BOX);
    expect(s.hands.returnTo({ item: 'giftBox', home: 'familyHome' })).toEqual({ ok: false, reason: 'wrongReturnSpot' });
    expect(s.hands.hands).toEqual(RETURN_BOX);
  });
});

describe('delivering', () => {
  it('swaps the outbound box for the return box in one step', () => {
    const s = setup('phuljhari');
    hold(s, OUTBOUND);
    s.clear();
    expect(s.hands.deliver('giftBox', RETURN_BOX)).toEqual({ ok: true });
    expect(s.hands.hands).toEqual(RETURN_BOX);
    // The hands are never free in between, so the phuljhari stays away.
    expect(s.crackers.held).toBeNull();
    expect(s.log).toEqual([
      { name: 'itemDelivered', payload: { item: OUTBOUND } },
      { name: 'itemPickedUp', payload: { item: RETURN_BOX } },
    ]);
  });

  it('consumes a delivered box and frees the hands', () => {
    const s = setup('phuljhari');
    hold(s, OUTBOUND);
    s.hands.deliver('giftBox', RETURN_BOX);
    s.clear();
    expect(s.hands.deliver('giftBox')).toEqual({ ok: true });
    expect(s.hands.hands).toBeNull();
    expect(s.names()).toEqual(['itemDelivered', 'crackerSelected']);
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
  });

  it('cannot deliver what is not in hand', () => {
    const s = setup();
    expect(s.hands.deliver('giftBox', RETURN_BOX)).toEqual({ ok: false, reason: 'notHolding' });
    hold(s, PLATE);
    expect(s.hands.deliver('giftBox')).toEqual({ ok: false, reason: 'notHolding' });
    expect(s.hands.hands).toEqual(PLATE);
    expect(lastRejection(s.log)).toEqual({ action: 'deliver', reason: 'notHolding' });
  });
});

describe('handing over to be answered', () => {
  it('empties the hands but keeps them spoken for until the answer is received', () => {
    const s = setup('phuljhari');
    hold(s, OUTBOUND);
    s.clear();
    expect(s.hands.handOver('giftBox')).toEqual({ ok: true });
    expect(s.hands.hands).toBeNull();
    expect(s.hands.state).toEqual({ kind: 'empty' });
    expect(s.hands.crackerBlock()).toBe('midHandover');
    // The put-away phuljhari waits: it would only be put away again.
    expect(s.crackers.held).toBeNull();
    expect(s.log).toEqual([{ name: 'itemDelivered', payload: { item: OUTBOUND } }]);
    s.clear();
    expect(s.hands.receive(RETURN_BOX)).toEqual({ ok: true });
    expect(s.hands.hands).toEqual(RETURN_BOX);
    expect(s.hands.crackerBlock()).toBe('carryingGift');
    expect(s.log).toEqual([{ name: 'itemPickedUp', payload: { item: RETURN_BOX } }]);
    // Free for real once the return box is delivered: the phuljhari comes back.
    s.hands.deliver('giftBox');
    expect(s.hands.crackerBlock()).toBeNull();
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
  });

  it('takes nothing else and eats nothing meanwhile', () => {
    const s = setup();
    hold(s, OUTBOUND);
    s.hands.handOver('giftBox');
    s.serveTray();
    expect(s.hands.take(PLATE)).toEqual({ ok: false, reason: 'midHandover' });
    expect(s.hands.pickUpPlate()).toEqual({ ok: false, reason: 'midHandover' });
    expect(s.hands.reserveThali()).toEqual({ ok: false, reason: 'midHandover' });
    expect(s.hands.eat()).toEqual({ ok: false, reason: 'midHandover' });
    expect(lastRejection(s.log)).toEqual({ action: 'eat', reason: 'midHandover' });
    expect(s.hands.hands).toBeNull();
  });

  it('blocks every cracker action meanwhile, with its own prompt', () => {
    const s = setup('phuljhari');
    hold(s, OUTBOUND);
    s.hands.handOver('giftBox');
    s.clear();
    const ctx = { ...controls(s), hands: s.hands };
    expect(applyCrackerAction(SELECT(1 as SelectSlot), ctx)).toBe(true);
    expect(applyCrackerAction(PLACE, ctx)).toBe(true);
    expect(s.names()).toEqual(['crackerBlocked', 'crackerBlocked']);
    expect(s.log.map((e) => e.payload)).toEqual([
      { action: 'select', reason: 'midHandover' },
      { action: 'igniteHeld', reason: 'midHandover' },
    ]);
    expect(s.crackers.held).toBeNull();
    expect(CRACKER_BLOCKED_TEXT.midHandover).toMatch(/return gift/);
  });

  it('hands over only what is held, and receives only an answer', () => {
    const s = setup();
    expect(s.hands.handOver('giftBox')).toEqual({ ok: false, reason: 'notHolding' });
    expect(s.hands.receive(RETURN_BOX)).toEqual({ ok: false, reason: 'notHolding' });
    hold(s, PLATE);
    expect(s.hands.handOver('giftBox')).toEqual({ ok: false, reason: 'notHolding' });
    expect(s.hands.receive(RETURN_BOX)).toEqual({ ok: false, reason: 'handsFull' });
    expect(s.hands.hands).toEqual(PLATE);
  });

  it('is forgotten by a fresh session: free, unblocked hands', () => {
    const s = setup();
    hold(s, OUTBOUND);
    s.hands.handOver('giftBox');
    s.hands.reset();
    expect(s.hands.crackerBlock()).toBeNull();
    expect(s.hands.receive(RETURN_BOX)).toEqual({ ok: false, reason: 'notHolding' });
    expect(s.hands.take(PLATE)).toEqual({ ok: true });
  });
});

describe('the thali', () => {
  it('is reserved over a selected cracker and blocks crackers until released', () => {
    const s = setup('phuljhari');
    expect(s.hands.reserveThali()).toEqual({ ok: true });
    expect(s.hands.crackerBlock()).toBe('holdingThali');
    s.hands.release('thali');
    expect(s.hands.crackerBlock()).toBeNull();
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
  });

  it.each([
    [PLATE, 'carryingPlate'],
    [OUTBOUND, 'carryingGift'],
    [RETURN_BOX, 'carryingGift'],
  ] as const)('cannot be joined while carrying %o until it is returned', (item, reason) => {
    const s = setup();
    hold(s, item);
    expect(s.hands.reserveThali()).toEqual({ ok: false, reason });
    expect(s.hands.returnTo(returnSpotFor(item)!)).toEqual({ ok: true });
    expect(s.hands.reserveThali()).toEqual({ ok: true });
  });

  it('cannot be reserved twice', () => {
    const s = setup();
    hold(s, THALI);
    expect(s.hands.reserveThali()).toEqual({ ok: false, reason: 'holdingThali' });
  });
});

describe('sweets', () => {
  it('serves the tray only once aarti completes', () => {
    const s = setup();
    expect(s.hands.trayServed).toBe(false);
    expect(s.hands.pickUpPlate()).toEqual({ ok: false, reason: 'trayNotServed' });
    expect(s.hands.eat()).toEqual({ ok: false, reason: 'trayNotServed' });
    expect(lastRejection(s.log)).toEqual({ action: 'eat', reason: 'trayNotServed' });
    s.serveTray();
    expect(s.hands.trayServed).toBe(true);
    expect(s.hands.eat()).toEqual({ ok: true });
    expect(s.hands.pickUpPlate()).toEqual({ ok: true });
  });

  it('eats from the tray without limit, with free hands or the plate', () => {
    const s = setup();
    s.serveTray();
    for (let i = 0; i < 50; i++) expect(s.hands.eat()).toEqual({ ok: true });
    s.hands.pickUpPlate();
    expect(s.hands.eat()).toEqual({ ok: true });
    expect(s.log.filter((e) => e.name === 'sweetsEaten')).toHaveLength(51);
  });

  it.each([
    [OUTBOUND, 'carryingGift'],
    [THALI, 'holdingThali'],
  ] as const)('cannot eat while holding %o', (item, reason) => {
    const s = setup();
    s.serveTray();
    hold(s, item);
    expect(s.hands.eat()).toEqual({ ok: false, reason });
  });

  it('offers from the carried plate without limit', () => {
    const s = setup();
    hold(s, PLATE);
    for (let i = 0; i < 20; i++) expect(s.hands.offer('grandmother')).toEqual({ ok: true });
    expect(s.hands.offer('sibling')).toEqual({ ok: true });
    const offered = s.log.filter((e) => e.name === 'sweetsOffered');
    expect(offered).toHaveLength(21);
    expect(offered.at(-1)?.payload).toEqual({ member: 'sibling' });
    expect(s.hands.hands).toEqual(PLATE);
  });

  it.each([
    ['empty hands', null],
    ['a gift box', OUTBOUND],
  ] as const)('has nothing to offer with %s', (_name, item) => {
    const s = setup();
    s.serveTray();
    if (item) hold(s, item);
    expect(s.hands.offer('mother')).toEqual({ ok: false, reason: 'notHolding' });
    expect(lastRejection(s.log)).toEqual({ action: 'offer', reason: 'notHolding' });
  });
});

// ── Cracker action gating ─────────────────────────────────────────────────

function controls(s: ReturnType<typeof setup>, interactable: Interactable | null = null) {
  const pose: PlayerPose = { position: v(0, 0, 0), yaw: 0, grounded: true };
  const view: CameraView = { mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, -0.5, -1), yaw: 0, pitch: 0 };
  const interaction: InteractionModule = {
    findInteractable: () => interactable,
    validatePlacement: (request) => ({ ok: true, preview: { type: request.type, position: request.target } }),
  };
  return { crackers: s.crackers, bus: s.bus, interaction, pose: () => pose, view: () => view, hands: s.hands };
}

const SELECT = (slot: SelectSlot): GameAction => ({ type: 'select', slot });
const PLACE: GameAction = { type: 'place' };
const INTERACT: GameAction = { type: 'interact' };

describe('cracker actions while carrying an item', () => {
  it.each(ITEMS)('blocks selecting any cracker while carrying a %s', (_name, item, reason) => {
    const s = setup('anar');
    hold(s, item);
    for (let slot = 1; slot <= CRACKER_TYPES.length; slot++) {
      s.clear();
      expect(applyCrackerAction(SELECT(slot as SelectSlot), controls(s))).toBe(true);
      expect(s.log).toEqual([{ name: 'crackerBlocked', payload: { action: 'select', reason } }]);
    }
    expect(s.crackers.selected).toBe('anar');
    expect(s.crackers.held).toBeNull();
    expect(s.hands.hands).toEqual(item);
  });

  it.each(ITEMS)('blocks placing a ground cracker while carrying a %s', (_name, item, reason) => {
    const s = setup('chakri');
    hold(s, item);
    s.clear();
    expect(applyCrackerAction(PLACE, controls(s))).toBe(true);
    expect(s.log).toEqual([{ name: 'crackerBlocked', payload: { action: 'place', reason } }]);
    expect(s.crackers.list()).toHaveLength(0);
  });

  it.each(ITEMS)('blocks lighting a placed cracker while carrying a %s', (_name, item, reason) => {
    const s = setup('anar');
    const placed = s.crackers.place({ type: 'anar', position: v(0, 0, -1) });
    if (!placed.ok) throw new Error(placed.reason);
    hold(s, item);
    s.clear();
    const target: Interactable = { kind: 'cracker', id: placed.id, position: v(0, 0, -1) };
    expect(applyCrackerAction(INTERACT, controls(s, target))).toBe(true);
    expect(s.log).toEqual([{ name: 'crackerBlocked', payload: { action: 'ignite', reason } }]);
    expect(s.crackers.get(placed.id)?.state).toBe('placed');
  });

  it.each(ITEMS)('blocks lighting the phuljhari by click while carrying a %s', (_name, item, reason) => {
    const s = setup('phuljhari');
    hold(s, item);
    s.clear();
    expect(applyCrackerAction(PLACE, controls(s))).toBe(true);
    expect(s.log).toEqual([{ name: 'crackerBlocked', payload: { action: 'igniteHeld', reason } }]);
    expect(s.crackers.litCount).toBe(0);
  });

  it.each(ITEMS)('blocks lighting a phuljhari in hand by E while carrying a %s', (_name, _item, reason) => {
    // The hands normally put the phuljhari away; gate it even if one is still there.
    const s = setup('phuljhari');
    s.clear();
    const ctx = { ...controls(s), hands: { crackerBlock: () => reason } };
    expect(applyCrackerAction(INTERACT, ctx)).toBe(true);
    expect(s.log).toEqual([{ name: 'crackerBlocked', payload: { action: 'igniteHeld', reason } }]);
    expect(s.crackers.held?.lit).toBe(false);
  });

  it('gives each blocking reason a return-or-deliver prompt', () => {
    expect(CRACKER_BLOCKED_TEXT.carryingPlate).toMatch(/plate/);
    expect(CRACKER_BLOCKED_TEXT.carryingGift).toMatch(/gift box/);
    expect(CRACKER_BLOCKED_TEXT.holdingThali).toMatch(/leave aarti/);
    for (const text of Object.values(ITEM_REJECTION_TEXT)) expect(text.length).toBeGreaterThan(0);
    const reasons: ItemRejection[] = ['handsFull', 'sparklerLit', 'trayNotServed', 'notHolding', 'wrongReturnSpot', 'outOfReach'];
    for (const reason of reasons) expect(ITEM_REJECTION_TEXT[reason]).toBeDefined();
  });

  it('allows every cracker action again once the hands are free', () => {
    const s = setup('phuljhari');
    hold(s, OUTBOUND);
    s.hands.returnTo(returnSpotFor(OUTBOUND)!);
    s.clear();
    const ctx = controls(s);
    applyCrackerAction(PLACE, ctx);
    expect(s.crackers.held?.lit).toBe(true);
    applyCrackerAction(SELECT(2), ctx);
    applyCrackerAction(PLACE, ctx);
    const placed = s.crackers.list()[0]!;
    applyCrackerAction(INTERACT, controls(s, { kind: 'cracker', id: placed.id, position: placed.position }));
    expect(s.names()).not.toContain('crackerBlocked');
    expect(s.names()).toEqual(expect.arrayContaining(['fuseLit', 'crackerSelected', 'crackerPlaced']));
    expect(s.crackers.get(placed.id)?.state).toBe('fuseBurning');
  });

  it('acts as before without a hands gate', () => {
    const s = setup('anar');
    const { hands: _ignored, ...ctx } = controls(s);
    applyCrackerAction(PLACE, ctx);
    expect(s.crackers.list()).toHaveLength(1);
  });
});

describe('accepted crackers while carrying an item', () => {
  it('lets already lit crackers run their full lifecycle', () => {
    const s = setup('anar');
    const placed = s.crackers.place({ type: 'anar', position: v(0, 0, -1) });
    if (!placed.ok) throw new Error(placed.reason);
    s.crackers.ignite(placed.id);
    hold(s, PLATE);
    s.step(fuse.anar + 0.05);
    expect(s.crackers.get(placed.id)?.state).toBe('active');
    s.step(activeDuration.anar);
    expect(s.crackers.get(placed.id)).toBeUndefined();
    expect(s.log.filter((e) => e.name === 'crackerFinished').map((e) => e.payload)).toEqual([
      { id: placed.id, type: 'anar', reason: 'completed' },
    ]);
  });

  it('keeps capacity accounting: a put-away phuljhari and blocked actions use no capacity', () => {
    const bus = createGameEventBus();
    const capacity = new CapacityBudget({
      crackers: () => crackers,
      bus,
      quality: qualityProfile('medium'),
      effects: () => ({ activeEffects: 0, liveParticles: 0, dynamicLights: 0 }),
      voices: () => 0,
    });
    const crackers = new Crackers({ bus, admission: capacity, random: () => 0.5, initialSelection: 'anar' });
    const hands = new HeldItems({ bus, crackers });
    expect(crackers.place({ type: 'anar', position: v(1, 0, 0) }).ok).toBe(true);
    capacity.update(STEP);
    const before = capacity.stats;

    crackers.select('phuljhari');
    expect(hands.take(OUTBOUND)).toEqual({ ok: true });
    const ctx = {
      crackers,
      bus,
      interaction: {
        findInteractable: () => null,
        validatePlacement: () => ({ ok: true, preview: { type: 'anar', position: v(2, 0, 0) } }),
      } satisfies InteractionModule,
      pose: () => ({ position: v(0, 0, 0), yaw: 0, grounded: true }),
      view: () => ({ mode: 'firstPerson', position: v(0, 1.6, 0), forward: v(0, 0, -1), yaw: 0, pitch: 0 }) as CameraView,
      hands,
    };
    applyCrackerAction(PLACE, ctx);
    applyCrackerAction(SELECT(2), ctx);
    applyCrackerAction(PLACE, ctx);
    capacity.update(STEP);

    expect(crackers.list()).toHaveLength(1);
    expect(crackers.litCount).toBe(0);
    expect(capacity.stats.rejectedPlacements).toBe(before.rejectedPlacements);
    expect(capacity.stats.rejectedIgnitions).toBe(before.rejectedIgnitions);
  });
});

describe('fresh session', () => {
  it('frees the hands and clears the tray on reset', () => {
    const s = setup('phuljhari');
    hold(s, PLATE);
    s.clear();
    s.hands.reset();
    expect(s.hands.hands).toBeNull();
    expect(s.hands.trayServed).toBe(false);
    expect(s.hands.crackerBlock()).toBeNull();
    expect(s.log).toEqual([]);
  });

  it('resets through the homes hooks with the crackers', () => {
    const s = setup('phuljhari');
    const session = new Session({ bus: s.bus });
    const hooks = homesResetHooks({ heldItems: s.hands });
    expect(pendingModules(hooks)).not.toContain('heldItems');
    registerHomesReset(session, hooks);
    session.start();
    hold(s, OUTBOUND);

    session.reset();

    expect(s.hands.hands).toBeNull();
    expect(s.hands.trayServed).toBe(false);
    expect(s.hands.state).toEqual({ kind: 'sparkler', lit: false });
    // A later release has nothing stale to bring back.
    s.clear();
    s.hands.release('giftBox');
    expect(s.log).toEqual([]);
  });

  it('stops serving after dispose', () => {
    const s = setup();
    s.hands.dispose();
    s.serveTray();
    expect(s.hands.trayServed).toBe(false);
  });
});
