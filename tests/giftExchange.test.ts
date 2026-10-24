import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import type { DialogueLine, GiftBoxSnapshot, GiftHandoverStep, HomeId, HomeInteractable, LocationId } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType } from '../src/core/types';
import {
  FAMILY_GIFT_DIALOGUE,
  GIFT_BEHAVIOUR,
  GIFT_HANDOVER,
  GiftExchange,
  GiftReactions,
  giftVisibility,
  HOST_GIFT_DIALOGUE,
} from '../src/gifts';
import {
  doorwayId,
  HeldItems,
  homesResetHooks,
  Locations,
  pendingModules,
  registerHomesReset,
  type HandCrackers,
} from '../src/homes';
import { heldProp, HOST_DIALOGUE, Household, Households, NeighbourHosts, type HeldProp } from '../src/household';
import { applyHomeAction } from '../src/interaction';
import { createFamilyHomeLayout, createNeighbourHomeLayout, familyHomeSpots } from '../src/interior';
import { FAMILY_SWEETS_DIALOGUE } from '../src/sweets';
import { Session } from '../src/session/session';
import { homePromptLines } from '../src/ui/homePrompts';
import { promptLines } from '../src/ui/hudModel';

const STEP = 1 / 60;
const SONG_LENGTH = 30;
const familyLayout = createFamilyHomeLayout();
const neighbourLayout = createNeighbourHomeLayout();
const { dialogueDuration, fadeDuration } = TUNING.homes;
const E = { type: 'interact' } as const;
/** The whole handover, from the box leaving the player's hands to the return box in them. */
const HANDOVER_TIME = GIFT_HANDOVER.receiving + GIFT_HANDOVER.settingAside + GIFT_HANDOVER.giving;

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
    'giftReceived',
    'giftExchanged',
    'giftPlaced',
    'giftAcknowledged',
    'giftRejected',
    'itemPickedUp',
    'itemReturned',
    'itemDelivered',
    'itemRejected',
  ];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

const place = (boxes: readonly GiftBoxSnapshot[], id: 'outbound' | 'return') => boxes.find((b) => b.id === id)?.place;

/**
 * Every box is drawn in exactly one place: by the gift scene (a spot, Uncle's
 * side table, the family table, the player's hands) or in a host's hands.
 */
function expectEachBoxOnce(boxes: readonly GiftBoxSnapshot[]): void {
  const shown = giftVisibility(boxes);
  const withHost = (id: 'outbound' | 'return') => (place(boxes, id)?.kind === 'host' ? 1 : 0);
  const outbound = [shown.outboundSpot, shown.outboundReceived, shown.held === 'outbound'].filter(Boolean).length;
  const returned = [shown.returnWaiting, shown.returnSpot, shown.returnTable, shown.held === 'return'].filter(Boolean).length;
  expect(outbound + withHost('outbound'), JSON.stringify(boxes)).toBe(1);
  expect(returned + withHost('return'), JSON.stringify(boxes)).toBe(1);
}

/** The gift rules alone, with the player wherever `where` says and aarti ended by hand. */
function setup() {
  const bus = createGameEventBus();
  const crackers = new StubCrackers();
  const hands = new HeldItems({ bus, crackers });
  let where: LocationId = 'familyHome';
  const gifts = new GiftExchange({ bus, hands, location: () => where });
  const log = record(bus);
  const names = () => log.map((entry) => entry.name);
  const goTo = (location: LocationId) => (where = location);
  const completeAarti = () => bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
  /** `seconds` of fixed steps. */
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) gifts.update(STEP);
  };
  /** Carry the outbound box next door and give it to Uncle; with `wait`, see the handover through. */
  const exchange = (wait = true) => {
    goTo('familyHome');
    expect(gifts.pickUp('outbound')).toEqual({ ok: true });
    goTo('neighbourHome');
    expect(gifts.exchange()).toEqual({ ok: true });
    if (wait) run(HANDOVER_TIME + STEP);
  };
  /** Leave Uncle and Aunty's for the street, as the door fade's midpoint does. */
  const walkOut = () => {
    goTo('outdoors');
    bus.emit('locationChanged', { doorway: 'neighbourHome.exit', from: 'neighbourHome', to: 'outdoors' });
  };
  const count = (name: GameEventName) => log.filter((e) => e.name === name).length;
  return { bus, crackers, hands, gifts, log, names, count, goTo, completeAarti, run, exchange, walkOut };
}

describe('gift exchange — the outbound box', () => {
  it('waits on its spot at home from the start, with no exchange and nothing to acknowledge', () => {
    const { gifts } = setup();
    expect(gifts.boxes()).toEqual([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }]);
    expect(gifts.exchanged).toBe(false);
    expect(gifts.acknowledgement).toBe('none');
  });

  it('is picked up into the hands and can go back on its spot and be picked up again', () => {
    const { gifts, hands, names } = setup();
    expect(gifts.pickUp('outbound')).toEqual({ ok: true });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'hands' });
    expect(gifts.putBack('outbound')).toEqual({ ok: true });
    expect(hands.hands).toBeNull();
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'spot', home: 'familyHome' });
    expect(gifts.pickUp('outbound')).toEqual({ ok: true });
    expect(names()).toEqual(['itemPickedUp', 'itemReturned', 'itemPickedUp']);
  });

  it('only goes back on its own spot, at home', () => {
    const { gifts, goTo, hands, log } = setup();
    gifts.pickUp('outbound');
    goTo('neighbourHome');
    expect(gifts.putBack('outbound')).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
    expect(log.at(-1)).toEqual({ name: 'giftRejected', payload: { reason: 'wrongLocation' } });
  });

  it('cannot be picked up from elsewhere, or twice', () => {
    const { gifts, goTo } = setup();
    goTo('outdoors');
    expect(gifts.pickUp('outbound')).toEqual({ ok: false, reason: 'wrongLocation' });
    goTo('familyHome');
    gifts.pickUp('outbound');
    expect(gifts.pickUp('outbound')).toEqual({ ok: false, reason: 'handsFull' });
  });

  it('stays on its spot when the hands refuse it, and leaves the refusal to the hands', () => {
    const { gifts, hands, names } = setup();
    hands.reserveThali();
    expect(gifts.pickUp('outbound')).toEqual({ ok: false, reason: 'handsFull' });
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'spot', home: 'familyHome' });
    expect(names().filter((n) => n === 'giftRejected')).toEqual([]);
    expect(names()).toContain('itemRejected');
  });

  it('refuses to be put back when it is not in hand', () => {
    const { gifts } = setup();
    expect(gifts.putBack('outbound')).toEqual({ ok: false, reason: 'notHolding' });
    expect(gifts.putBack('return')).toEqual({ ok: false, reason: 'notHolding' });
  });
});

describe('gift exchange — the one special exchange', () => {
  it('happens once: repeats never duplicate a box or restart the exchange', () => {
    const { gifts, hands, names, exchange } = setup();
    exchange();
    const before = names().length;
    for (let i = 0; i < 3; i++) expect(gifts.exchange()).toEqual({ ok: false, reason: 'alreadyExchanged' });
    expect(names().slice(before)).toEqual(['giftRejected', 'giftRejected', 'giftRejected']);
    expect(gifts.boxes()).toHaveLength(2);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    // The outbound box went with the neighbours.
    expect(gifts.pickUp('outbound')).toEqual({ ok: false, reason: 'alreadyExchanged' });
  });

  it('needs the outbound box in hand, next door', () => {
    const { gifts, goTo, hands } = setup();
    goTo('neighbourHome');
    expect(gifts.exchange()).toEqual({ ok: false, reason: 'notHolding' });
    goTo('familyHome');
    gifts.pickUp('outbound');
    expect(gifts.exchange()).toEqual({ ok: false, reason: 'wrongLocation' });
    goTo('outdoors');
    expect(gifts.exchange()).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(gifts.exchanged).toBe(false);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
  });

  it('puts the return box on its console next door, from which it can be picked up again until delivered', () => {
    const { gifts, hands, goTo, exchange } = setup();
    exchange();
    expect(gifts.putBack('return')).toEqual({ ok: true });
    expect(hands.hands).toBeNull();
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'spot', home: 'neighbourHome' });
    goTo('familyHome');
    expect(gifts.pickUp('return')).toEqual({ ok: false, reason: 'wrongLocation' });
    goTo('neighbourHome');
    expect(gifts.pickUp('return')).toEqual({ ok: true });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    // Its spot is next door, not the family's side table.
    goTo('familyHome');
    expect(gifts.putBack('return')).toEqual({ ok: false, reason: 'wrongLocation' });
  });
});

describe('gift exchange — the handover', () => {
  it('takes the box into Uncle’s hands, sets it aside and hands the return box back, in about four seconds', () => {
    const { bus, gifts, hands, log, goTo, run } = setup();
    gifts.pickUp('outbound');
    goTo('neighbourHome');
    const seen: { event: string; boxes: readonly GiftBoxSnapshot[]; hands: unknown; step: GiftHandoverStep | null }[] = [];
    for (const event of ['itemDelivered', 'giftReceived', 'itemPickedUp', 'giftExchanged'] as const) {
      bus.on(event, () => seen.push({ event, boxes: gifts.boxes(), hands: hands.hands, step: gifts.handover?.step ?? null }));
    }
    expect(gifts.exchange()).toEqual({ ok: true });
    // At once: the box is Uncle's and the player's hands are empty, kept for the return box.
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'host', host: 'uncle' });
    expect(place(gifts.boxes(), 'return')).toBeUndefined();
    expect(hands.hands).toBeNull();
    expect(hands.crackerBlock()).toBe('midHandover');
    expect(gifts.handover).toEqual({ host: 'uncle', step: 'receiving', stepTime: 0, elapsed: 0 });
    expect(gifts.exchanged).toBe(false);

    // Thanking, then setting it down: still in his hands until it is on the side table.
    run(GIFT_HANDOVER.receiving - 0.1);
    expect(gifts.handover?.step).toBe('receiving');
    run(0.2);
    expect(gifts.handover?.step).toBe('settingAside');
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'host', host: 'uncle' });
    // The family's box down on the side table, the return box up in his hands.
    run(GIFT_HANDOVER.settingAside);
    expect(gifts.handover?.step).toBe('giving');
    expect(place(gifts.boxes(), 'outbound')).toEqual({ kind: 'delivered' });
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'host', host: 'uncle' });
    expect(hands.hands).toBeNull();
    // Held out, then in the player's hands.
    run(GIFT_HANDOVER.giving - 0.2);
    expect(gifts.handover?.step).toBe('giving');
    run(0.1 + STEP);
    expect(gifts.handover).toBeNull();
    expect(gifts.exchanged).toBe(true);
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'hands' });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    expect(hands.crackerBlock()).toBe('carryingGift');
    expect(HANDOVER_TIME).toBeGreaterThanOrEqual(3);
    expect(HANDOVER_TIME).toBeLessThanOrEqual(5);

    // Each event already sees its own move recorded.
    expect(seen.map((s) => [s.event, s.step])).toEqual([
      ['itemDelivered', 'receiving'],
      ['giftReceived', 'receiving'],
      ['itemPickedUp', null],
      ['giftExchanged', null],
    ]);
    expect(place(seen[0]!.boxes, 'outbound')).toEqual({ kind: 'host', host: 'uncle' });
    expect(seen[0]!.hands).toBeNull();
    expect(place(seen[2]!.boxes, 'return')).toEqual({ kind: 'hands' });
    expect(seen[3]!.hands).toEqual({ kind: 'giftBox', box: 'return' });
    expect(log.filter((e) => e.name === 'giftReceived')).toEqual([{ name: 'giftReceived', payload: { host: 'uncle' } }]);
  });

  it('keeps every box in exactly one place at every step', () => {
    const { gifts, run, exchange } = setup();
    expectEachBoxOnce(gifts.boxes());
    exchange(false);
    while (gifts.handover) {
      expectEachBoxOnce(gifts.boxes());
      run(STEP);
    }
    expectEachBoxOnce(gifts.boxes());
  });

  it('happens once: giving again during the handover neither restarts it nor adds a box', () => {
    const { gifts, hands, count, run, exchange } = setup();
    exchange(false);
    run(1);
    const elapsed = gifts.handover!.elapsed;
    for (let i = 0; i < 3; i++) expect(gifts.exchange()).toEqual({ ok: false, reason: 'alreadyExchanged' });
    // Nor can the box be taken back off him, or the return box off the side table early.
    expect(gifts.pickUp('outbound')).toEqual({ ok: false, reason: 'alreadyExchanged' });
    expect(gifts.putBack('outbound')).toEqual({ ok: false, reason: 'notHolding' });
    expect(gifts.handover!.elapsed).toBe(elapsed);
    run(HANDOVER_TIME);
    expect(count('giftReceived')).toBe(1);
    expect(count('giftExchanged')).toBe(1);
    expect(gifts.boxes()).toHaveLength(2);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
  });

  it('runs on the fixed step alone, so a pause freezes it where it is', () => {
    const { gifts, run, exchange } = setup();
    exchange(false);
    run(1);
    const frozen = { ...gifts.handover! };
    const boxes = gifts.boxes();
    for (let i = 0; i < 600; i++) {
      gifts.update(0);
      gifts.update(-STEP);
      gifts.update(Number.NaN);
    }
    expect(gifts.handover).toEqual(frozen);
    expect(gifts.boxes()).toBe(boxes);
    run(HANDOVER_TIME - 1 + STEP);
    expect(gifts.exchanged).toBe(true);
  });

  it.each(['receiving', 'settingAside', 'giving'] as const)(
    'walking out while %s completes it at once: the player leaves with the return box',
    (step) => {
      const { gifts, hands, count, run, exchange, walkOut } = setup();
      exchange(false);
      while (gifts.handover?.step !== step) run(STEP);
      run(0.2);
      walkOut();
      expect(gifts.handover).toBeNull();
      expect(gifts.exchanged).toBe(true);
      expect(gifts.boxes()).toEqual([
        { id: 'outbound', place: { kind: 'delivered' } },
        { id: 'return', place: { kind: 'hands' } },
      ]);
      expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
      expect(count('giftExchanged')).toBe(1);
      // Nothing more happens later, nor on walking out again.
      run(HANDOVER_TIME);
      walkOut();
      expect(count('giftExchanged')).toBe(1);
      expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    },
  );

  it('a fresh session mid-handover puts the box back home and frees the hands', () => {
    const { gifts, hands, count, goTo, run, exchange } = setup();
    exchange(false);
    run(GIFT_HANDOVER.receiving + GIFT_HANDOVER.settingAside + 0.1);
    gifts.reset();
    hands.reset();
    expect(gifts.handover).toBeNull();
    expect(gifts.exchanged).toBe(false);
    expect(gifts.boxes()).toEqual([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }]);
    expect(hands.hands).toBeNull();
    expect(hands.crackerBlock()).toBeNull();
    run(HANDOVER_TIME);
    expect(count('giftExchanged')).toBe(0);
    // And the new session's exchange runs in full.
    goTo('familyHome');
    exchange();
    expect(count('giftReceived')).toBe(2);
    expect(count('giftExchanged')).toBe(1);
  });

  it('should the hands no longer wait for it, leaves the return box on its console rather than lose it', () => {
    const { gifts, hands, count, run, exchange } = setup();
    exchange(false);
    run(1);
    hands.reset();
    hands.take({ kind: 'sweetsPlate' });
    run(HANDOVER_TIME);
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'spot', home: 'neighbourHome' });
    expect(hands.hands).toEqual({ kind: 'sweetsPlate' });
    expect(count('giftExchanged')).toBe(1);
    expectEachBoxOnce(gifts.boxes());
  });
});

describe('gift exchange — the family acknowledgement', () => {
  it('waits on the table while aarti is still to finish, then fires once when it does', () => {
    const { gifts, hands, log, goTo, exchange, completeAarti } = setup();
    exchange();
    goTo('familyHome');
    expect(gifts.placeOnTable()).toEqual({ ok: true });
    expect(hands.hands).toBeNull();
    expect(gifts.acknowledgement).toBe('pending');
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'table' });
    expect(log.slice(-2)).toEqual([
      { name: 'itemDelivered', payload: { item: { kind: 'giftBox', box: 'return' } } },
      { name: 'giftPlaced', payload: { pendingAcknowledgement: true } },
    ]);
    completeAarti();
    expect(gifts.acknowledgement).toBe('done');
    expect(place(gifts.boxes(), 'return')).toEqual({ kind: 'delivered' });
    expect(log.at(-1)).toEqual({ name: 'giftAcknowledged', payload: {} });
    completeAarti();
    expect(log.filter((e) => e.name === 'giftAcknowledged')).toHaveLength(1);
  });

  it('fires on placement once aarti is over', () => {
    const { gifts, names, goTo, exchange, completeAarti } = setup();
    completeAarti();
    exchange();
    goTo('familyHome');
    const before = names().length;
    expect(gifts.placeOnTable()).toEqual({ ok: true });
    expect(names().slice(before)).toEqual(['itemDelivered', 'giftPlaced', 'giftAcknowledged']);
    expect(gifts.acknowledgement).toBe('done');
  });

  it('reports a placement made after aarti as not pending', () => {
    const { gifts, log, goTo, exchange, completeAarti } = setup();
    exchange();
    completeAarti();
    goTo('familyHome');
    gifts.placeOnTable();
    expect(log.find((e) => e.name === 'giftPlaced')?.payload).toEqual({ pendingAcknowledgement: false });
  });

  it('is delivered afterwards: not picked up again, not placed again, not acknowledged again', () => {
    const { gifts, names, goTo, exchange, completeAarti } = setup();
    exchange();
    goTo('familyHome');
    gifts.placeOnTable();
    expect(gifts.pickUp('return')).toEqual({ ok: false, reason: 'alreadyDelivered' });
    completeAarti();
    expect(gifts.pickUp('return')).toEqual({ ok: false, reason: 'alreadyDelivered' });
    expect(gifts.placeOnTable()).toEqual({ ok: false, reason: 'alreadyDelivered' });
    expect(gifts.exchange()).toEqual({ ok: false, reason: 'alreadyExchanged' });
    expect(names().filter((n) => n === 'giftAcknowledged')).toHaveLength(1);
  });

  it('needs the return box in hand, at home', () => {
    const { gifts, goTo, exchange, hands } = setup();
    expect(gifts.placeOnTable()).toEqual({ ok: false, reason: 'notHolding' });
    exchange();
    expect(gifts.placeOnTable()).toEqual({ ok: false, reason: 'wrongLocation' });
    goTo('outdoors');
    expect(gifts.placeOnTable()).toEqual({ ok: false, reason: 'wrongLocation' });
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    expect(gifts.acknowledgement).toBe('none');
  });

  it('does not acknowledge anything when aarti ends with no box on the table', () => {
    const { gifts, names, exchange, completeAarti } = setup();
    exchange();
    completeAarti();
    expect(gifts.acknowledgement).toBe('none');
    expect(names()).not.toContain('giftAcknowledged');
  });
});

describe('gift exchange — fresh session', () => {
  it('reset puts the outbound box back and clears the exchange, the pending acknowledgement and aarti', () => {
    const { gifts, names, goTo, exchange, completeAarti } = setup();
    exchange();
    goTo('familyHome');
    gifts.placeOnTable();
    gifts.reset();
    expect(gifts.boxes()).toEqual([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }]);
    expect(gifts.exchanged).toBe(false);
    expect(gifts.acknowledgement).toBe('none');
    // Nothing was pending any more, so a later aarti acknowledges nothing.
    const before = names().length;
    completeAarti();
    expect(names().slice(before)).toEqual([]);
  });

  it('forgets aarti too, so a box placed in the new session waits for the new aarti', () => {
    const { gifts, hands, exchange, goTo, completeAarti } = setup();
    completeAarti();
    gifts.reset();
    hands.reset();
    exchange();
    goTo('familyHome');
    gifts.placeOnTable();
    expect(gifts.acknowledgement).toBe('pending');
  });

  it('is cleared by the session reset along with the hands', () => {
    const { bus, gifts, hands, goTo, exchange } = setup();
    const session = new Session({ bus });
    const hooks = homesResetHooks({ heldItems: hands, giftExchange: gifts });
    registerHomesReset(session, hooks);
    expect(pendingModules(hooks)).not.toContain('giftExchange');
    exchange();
    session.reset();
    expect(hands.hands).toBeNull();
    expect(gifts.exchanged).toBe(false);
    goTo('familyHome');
    expect(gifts.pickUp('outbound')).toEqual({ ok: true });
  });

  it('stops listening for aarti once disposed', () => {
    const { gifts, exchange, goTo, completeAarti } = setup();
    exchange();
    goTo('familyHome');
    gifts.placeOnTable();
    gifts.dispose();
    completeAarti();
    expect(gifts.acknowledgement).toBe('pending');
  });
});

describe('gift exchange — presentation', () => {
  it('shows each box in exactly one place, keeping the acknowledged return box on the table', () => {
    expect(giftVisibility([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }])).toEqual({
      outboundSpot: true,
      outboundReceived: false,
      returnWaiting: true,
      returnSpot: false,
      returnTable: false,
      held: null,
    });
    expect(giftVisibility([{ id: 'outbound', place: { kind: 'hands' } }])).toMatchObject({ outboundSpot: false, held: 'outbound' });
    // In Uncle's hands it is the household scene's to draw; the return box still waits on his side table.
    expect(giftVisibility([{ id: 'outbound', place: { kind: 'host', host: 'uncle' } }])).toEqual({
      outboundSpot: false,
      outboundReceived: false,
      returnWaiting: true,
      returnSpot: false,
      returnTable: false,
      held: null,
    });
    const exchanged = (place: GiftBoxSnapshot['place']): GiftBoxSnapshot[] => [
      { id: 'outbound', place: { kind: 'delivered' } },
      { id: 'return', place },
    ];
    // The family's box down on the side table as the return box comes up off it.
    expect(giftVisibility(exchanged({ kind: 'host', host: 'uncle' }))).toEqual({
      outboundSpot: false,
      outboundReceived: true,
      returnWaiting: false,
      returnSpot: false,
      returnTable: false,
      held: null,
    });
    expect(giftVisibility(exchanged({ kind: 'hands' }))).toEqual({
      outboundSpot: false,
      outboundReceived: true,
      returnWaiting: false,
      returnSpot: false,
      returnTable: false,
      held: 'return',
    });
    expect(giftVisibility(exchanged({ kind: 'spot', home: 'neighbourHome' }))).toMatchObject({ returnSpot: true, held: null });
    expect(giftVisibility(exchanged({ kind: 'table' }))).toMatchObject({ returnTable: true, returnSpot: false });
    expect(giftVisibility(exchanged({ kind: 'delivered' }))).toMatchObject({ returnTable: true, held: null });
  });
});

// ── The whole round trip, with the real doors, ceremony, household and routing ──

const familyGiftSpot: HomeInteractable = {
  kind: 'returnSpot',
  id: 'giftBox@familyHome',
  item: 'giftBox',
  home: 'familyHome',
  position: familyHomeSpots(familyLayout).giftSpot!,
};
const neighbourGiftSpot: HomeInteractable = {
  kind: 'returnSpot',
  id: 'giftBox@neighbourHome',
  item: 'giftBox',
  home: 'neighbourHome',
  position: neighbourLayout.giftSpot,
};
const familyTray: HomeInteractable = { kind: 'tray', id: 'familyHome', position: familyHomeSpots(familyLayout).tray! };
const puja: HomeInteractable = { kind: 'puja', id: 'familyHome', position: familyHomeSpots(familyLayout).puja! };
const host = (id: 'uncle' | 'aunty'): HomeInteractable => ({
  kind: 'person',
  id,
  position: neighbourLayout.hosts[id].position,
});

function evening() {
  const bus = createGameEventBus();
  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const locations = new Locations({ bus, hands });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: () => SONG_LENGTH, location: () => locations.location });
  const family = new Household({ bus, layout: familyLayout, dialogue: { ...FAMILY_SWEETS_DIALOGUE, ...FAMILY_GIFT_DIALOGUE } });
  const gifts = new GiftExchange({ bus, hands, location: () => locations.location });
  const hosts = new NeighbourHosts({ bus, layout: neighbourLayout, hands, gifts, dialogue: { ...HOST_DIALOGUE, ...HOST_GIFT_DIALOGUE } });
  const household = new Households([family, hosts]);
  const reactions = new GiftReactions({ bus, household, location: () => locations.location });
  const session = new Session({ bus });
  registerHomesReset(session, homesResetHooks({ heldItems: hands, locations, aartiCeremony: ceremony, household, giftExchange: gifts }));
  session.register(reactions);

  const spoken: DialogueLine[] = [];
  bus.on('householdReacted', ({ line }) => spoken.push(line));
  const log = record(bus);
  const count = (name: GameEventName) => log.filter((e) => e.name === name).length;
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      locations.update(STEP);
      ceremony.update(STEP);
      gifts.update(STEP);
      household.update(STEP);
      reactions.update(STEP);
    }
  };
  const go = (home: HomeId, side: 'enter' | 'exit') => {
    expect(locations.requestTransition(doorwayId(home, side))).toEqual({ ok: true });
    run(fadeDuration + STEP);
  };
  const ctx = { locations, ceremony, hands, gifts, household, hosts };
  const press = (target: HomeInteractable) => expect(applyHomeAction(E, target, ctx)).toBe(true);
  const giftLines = (cause: 'giftReceived' | 'giftExchanged' | 'giftAcknowledged') => {
    const catalogue = cause === 'giftAcknowledged' ? FAMILY_GIFT_DIALOGUE : HOST_GIFT_DIALOGUE;
    const texts = new Set(Object.values(catalogue[cause] ?? {}).flatMap((v) => (v ?? []).map((l) => l.text)));
    return spoken.filter((l) => texts.has(l.text));
  };
  /** From the street: take the box from home, hand it over next door, come back in with the return box. */
  const roundTrip = () => {
    go('familyHome', 'enter');
    press(familyGiftSpot);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    expect(gifts.handover).not.toBeNull();
    run(HANDOVER_TIME + STEP);
    expect(gifts.exchanged).toBe(true);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    run(dialogueDuration * 4);
    go('neighbourHome', 'exit');
    go('familyHome', 'enter');
  };
  return { bus, hands, locations, ceremony, family, hosts, gifts, reactions, session, spoken, log, count, run, go, press, giftLines, roundTrip };
}

describe('gift round trip — through the homes', () => {
  it('a no-gift visit still gets the neighbours’ welcome, and no special exchange', () => {
    const { go, run, press, spoken, count, gifts } = evening();
    go('neighbourHome', 'enter');
    run(5);
    press(host('uncle'));
    expect(spoken.some((l) => l.member === 'uncle')).toBe(true);
    expect(count('giftExchanged')).toBe(0);
    expect(gifts.exchanged).toBe(false);
  });

  it('Uncle takes the box, thanks the player holding it, sets it down and hands the return box back; Aunty adds a word', () => {
    const { go, run, press, giftLines, spoken, hosts, gifts, hands } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    // Straight in, mid-welcome: Uncle is still speaking.
    run(1.5);
    expect(hosts.members().some((m) => m.line !== null)).toBe(true);
    press(host('uncle'));
    const view = (id: 'uncle' | 'aunty') => hosts.views().find((v) => v.id === id)!;
    // The welcome gives way at once.
    expect(hosts.members().filter((m) => m.line !== null)).toEqual([]);
    expect(view('uncle').activity).toBe('receivingGift');
    const uncleHolds: (HeldProp | null)[] = [];
    let thanksHolding: HeldProp | null | undefined;
    let most = 0;
    for (let t = 0; t < dialogueDuration * 6; t += STEP) {
      run(STEP);
      const uncle = heldProp(view('uncle'));
      if (uncleHolds.at(-1) !== uncle) uncleHolds.push(uncle);
      // What Uncle holds is exactly where the boxes are.
      const boxes = gifts.boxes();
      expect(uncle === 'outboundBox', `${t}`).toBe(place(boxes, 'outbound')?.kind === 'host');
      expect(uncle === 'returnBox', `${t}`).toBe(place(boxes, 'return')?.kind === 'host');
      // Nobody holds out mithai through the gift moment.
      expect(heldProp(view('aunty'))).not.toBe('plate');
      expect(uncle).not.toBe('plate');
      if (thanksHolding === undefined && giftLines('giftReceived').length > 0) thanksHolding = uncle;
      most = Math.max(most, hosts.members().filter((m) => m.line !== null).length);
    }
    expect(uncleHolds).toEqual(['outboundBox', 'returnBox', null]);
    // Uncle thanks the player holding their box, then Aunty speaks once he has handed the return box over.
    expect(thanksHolding).toBe('outboundBox');
    expect(giftLines('giftReceived').map((l) => l.member)).toEqual(GIFT_BEHAVIOUR.receiveSpeakers);
    expect(giftLines('giftExchanged').map((l) => l.member)).toEqual(GIFT_BEHAVIOUR.exchangeSpeakers);
    expect(spoken.indexOf(giftLines('giftExchanged')[0]!)).toBeGreaterThan(spoken.indexOf(giftLines('giftReceived')[0]!));
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    // Both back at ease, hands unfolded, rather than held in the welcome's namaste.
    expect(view('uncle').activity).toBe('idle');
    expect(view('aunty').activity).toBe('idle');
    // Never two lines up at once next door.
    expect(most).toBe(1);
  });

  it('turns Uncle to his side table only while he sets the box down', () => {
    const { go, run, press, hosts, gifts } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    const uncle = () => hosts.views().find((v) => v.id === 'uncle')!;
    const yaws = new Set<number>();
    while (gifts.handover) {
      run(STEP);
      if (gifts.handover?.step === 'settingAside') expect(uncle().placement.yaw).toBeCloseTo(neighbourLayout.sideTable.yaw);
      yaws.add(uncle().placement.yaw);
    }
    expect(uncle().placement.yaw).toBeCloseTo(neighbourLayout.hosts.uncle.yaw);
    expect(yaws.size).toBe(2);
  });

  it('keeps Aunty’s mithai for after the handover', () => {
    const { go, run, press, hosts, gifts, log } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    expect(hosts.eatMithai()).toEqual({ ok: false, reason: 'midHandover' });
    expect(log.at(-1)).toEqual({ name: 'itemRejected', payload: { action: 'eat', reason: 'midHandover' } });
    run(HANDOVER_TIME + STEP);
    expect(gifts.handover).toBeNull();
    // The return box fills the hands now, which keeps them from the mithai as any box does.
    expect(hosts.eatMithai()).toEqual({ ok: false, reason: 'carryingGift' });
  });

  it('repeat interactions during and after the handover never exchange again', () => {
    const { go, run, press, gifts, count, hands, spoken } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    // Aunty only greets: the box is Uncle's to take.
    press(host('aunty'));
    expect(gifts.handover).toBeNull();
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'outbound' });
    press(host('uncle'));
    const said = spoken.length;
    for (let i = 0; i < 4; i++) {
      run(0.5);
      press(host('uncle'));
      press(host('aunty'));
    }
    // Watching the handover: nobody greets over it, nothing restarts it.
    expect(spoken.slice(said).map((l) => l.member)).toEqual(['uncle']);
    run(HANDOVER_TIME);
    press(host('aunty'));
    press(host('uncle'));
    expect(count('giftReceived')).toBe(1);
    expect(count('giftExchanged')).toBe(1);
    expect(gifts.boxes()).toHaveLength(2);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
  });

  it('the return box goes back on the console next door and is picked up again there', () => {
    const { go, run, press, gifts, hands } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    run(HANDOVER_TIME + STEP);
    press(neighbourGiftSpot);
    expect(hands.hands).toBeNull();
    expect(gifts.boxes().find((b) => b.id === 'return')?.place).toEqual({ kind: 'spot', home: 'neighbourHome' });
    press(neighbourGiftSpot);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
  });

  it('placed during aarti, the family acknowledges it once aarti ends offscreen — when the player is next home', () => {
    const { go, run, press, ceremony, gifts, count, giftLines, hands, roundTrip } = evening();
    go('familyHome', 'enter');
    press(puja);
    expect(ceremony.snapshot.state).toBe('running');
    // E leaves aarti; the family keeps singing.
    press(puja);
    expect(ceremony.snapshot.participating).toBe(false);
    go('familyHome', 'exit');
    roundTrip();
    expect(ceremony.snapshot.state).toBe('running');
    press(familyTray);
    expect(hands.hands).toBeNull();
    expect(gifts.acknowledgement).toBe('pending');
    expect(count('giftAcknowledged')).toBe(0);

    // Off to the street while the song plays out.
    go('familyHome', 'exit');
    run(SONG_LENGTH);
    expect(ceremony.snapshot.state).toBe('completed');
    expect(count('giftAcknowledged')).toBe(1);
    expect(gifts.acknowledgement).toBe('done');
    // Nobody at home to hear it yet.
    run(dialogueDuration * 4);
    expect(giftLines('giftAcknowledged')).toEqual([]);

    go('familyHome', 'enter');
    run(dialogueDuration * 12);
    expect(giftLines('giftAcknowledged').map((l) => l.member)).toEqual(GIFT_BEHAVIOUR.acknowledgementSpeakers);
    expect(count('giftAcknowledged')).toBe(1);
  });

  it('placed after aarti, the family acknowledges it on placement', () => {
    const { go, run, press, ceremony, count, giftLines, roundTrip } = evening();
    go('familyHome', 'enter');
    press(puja);
    run(SONG_LENGTH + STEP);
    expect(ceremony.snapshot.state).toBe('completed');
    go('familyHome', 'exit');
    roundTrip();
    press(familyTray);
    expect(count('giftAcknowledged')).toBe(1);
    run(dialogueDuration * 12);
    expect(giftLines('giftAcknowledged').map((l) => l.member)).toEqual(GIFT_BEHAVIOUR.acknowledgementSpeakers);
  });

  it('later visits stay open after the exchange, with greetings and mithai', () => {
    const { go, run, press, roundTrip, hosts, hands } = evening();
    roundTrip();
    press(familyTray);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    run(5);
    expect(hands.hands).toBeNull();
    expect(hosts.eatMithai()).toEqual({ ok: true });
  });

  it('a fresh session clears the boxes, the exchange, the pending acknowledgement and queued lines', () => {
    const { go, run, press, session, gifts, reactions, count, roundTrip, locations } = evening();
    roundTrip();
    press(familyTray);
    expect(gifts.acknowledgement).toBe('pending');
    session.reset();
    expect(locations.location).toBe('outdoors');
    expect(gifts.exchanged).toBe(false);
    expect(gifts.acknowledgement).toBe('none');
    expect(gifts.boxes()).toEqual([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }]);
    expect(reactions.pending).toEqual([]);
    // The new session's exchange is available again.
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    run(HANDOVER_TIME + STEP);
    expect(count('giftExchanged')).toBe(2);
  });

  it('a fresh session mid-handover clears it with everything else', () => {
    const { go, run, press, session, gifts, hands, hosts, reactions, count, locations } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    run(2.5);
    session.reset();
    expect(locations.location).toBe('outdoors');
    expect(gifts.handover).toBeNull();
    expect(gifts.boxes()).toEqual([{ id: 'outbound', place: { kind: 'spot', home: 'familyHome' } }]);
    expect(hands.hands).toBeNull();
    expect(hands.crackerBlock()).toBeNull();
    expect(hosts.views().map((v) => v.activity)).toEqual(['idle', 'idle']);
    expect(reactions.pending).toEqual([]);
    run(HANDOVER_TIME);
    expect(count('giftExchanged')).toBe(0);
  });
});

describe('gift reactions — pacing', () => {
  it('walking out mid-handover leaves with the return box and drops the rest of the moment', () => {
    const { go, run, press, reactions, giftLines, gifts, hands, count } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    go('neighbourHome', 'exit');
    expect(gifts.handover).toBeNull();
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
    expect(count('giftExchanged')).toBe(1);
    expect(reactions.pending).toEqual([]);
    go('neighbourHome', 'enter');
    run(dialogueDuration * 6);
    expect(giftLines('giftExchanged')).toEqual([]);
  });

  it('has a line for every speaker in each gift moment, none of them holding out mithai', () => {
    for (const member of GIFT_BEHAVIOUR.receiveSpeakers) {
      expect(HOST_GIFT_DIALOGUE.giftReceived?.[member]?.length).toBeGreaterThan(0);
    }
    for (const lines of [...Object.values(HOST_GIFT_DIALOGUE.giftReceived ?? {}), ...Object.values(HOST_GIFT_DIALOGUE.giftExchanged ?? {})]) {
      for (const line of lines ?? []) expect(line.gesture).not.toBe('offerMithai');
    }
    for (const member of GIFT_BEHAVIOUR.exchangeSpeakers) {
      expect(HOST_GIFT_DIALOGUE.giftExchanged?.[member]?.length).toBeGreaterThan(0);
    }
    for (const member of GIFT_BEHAVIOUR.acknowledgementSpeakers) {
      expect(FAMILY_GIFT_DIALOGUE.giftAcknowledged?.[member]?.length).toBeGreaterThan(0);
    }
  });
});

describe('gift prompts', () => {
  it('offers the handover to Uncle, only before the exchange, and nothing while it runs', () => {
    const outbound = { kind: 'giftBox', box: 'outbound' } as const;
    expect(homePromptLines(host('uncle'), { hands: outbound, exchanged: false })).toEqual([
      { text: 'E: Give the gift box to Uncle', blocked: false },
    ]);
    expect(homePromptLines(host('aunty'), { hands: outbound, exchanged: false })).toEqual([
      { text: 'E: Greet Aunty', blocked: false },
      { text: 'Give the gift box to Uncle', blocked: true },
    ]);
    expect(homePromptLines(host('uncle'), { hands: null, handingOver: true })).toEqual([]);
    const neighbourTray: HomeInteractable = { kind: 'tray', id: 'neighbourHome', position: neighbourLayout.hosts.aunty.position };
    expect(homePromptLines(neighbourTray, { hands: null, handingOver: true })).toEqual([
      { text: 'Uncle is handing you the return gift — just a moment', blocked: true },
    ]);
    expect(homePromptLines(host('aunty'), { hands: null, exchanged: true })).toEqual([
      { text: 'E: Greet Aunty', blocked: false },
    ]);
  });

  it('offers no phuljhari while the hands wait for the return box', () => {
    expect(promptLines('phuljhari', { interactable: null, homes: { hands: null } })).toEqual([
      { text: 'E: Light phuljhari', blocked: false },
    ]);
    expect(promptLines('phuljhari', { interactable: null, homes: { hands: null, handingOver: true } })).toEqual([]);
  });

  it('offers to set the return box on the sweets table', () => {
    expect(homePromptLines(familyTray, { hands: { kind: 'giftBox', box: 'return' } })).toEqual([
      { text: 'E: Place the return gift on the sweets table', blocked: false },
    ]);
  });
});
