import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import type { DialogueLine, GiftBoxSnapshot, HomeId, HomeInteractable, LocationId } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType } from '../src/core/types';
import {
  FAMILY_GIFT_DIALOGUE,
  GIFT_BEHAVIOUR,
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
import { HOST_DIALOGUE, Household, Households, NeighbourHosts } from '../src/household';
import { applyHomeAction } from '../src/interaction';
import { createFamilyHomeLayout, createNeighbourHomeLayout, familyHomeSpots } from '../src/interior';
import { FAMILY_SWEETS_DIALOGUE } from '../src/sweets';
import { Session } from '../src/session/session';
import { homePromptLines } from '../src/ui/homePrompts';

const STEP = 1 / 60;
const SONG_LENGTH = 30;
const familyLayout = createFamilyHomeLayout();
const neighbourLayout = createNeighbourHomeLayout();
const { dialogueDuration, fadeDuration } = TUNING.homes;
const E = { type: 'interact' } as const;

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
  /** Carry the outbound box next door and hand it over. */
  const exchange = () => {
    goTo('familyHome');
    expect(gifts.pickUp('outbound')).toEqual({ ok: true });
    goTo('neighbourHome');
    expect(gifts.exchange()).toEqual({ ok: true });
  };
  return { bus, crackers, hands, gifts, log, names, goTo, completeAarti, exchange };
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
  it('atomically consumes the outbound box, records the exchange and fills the hands with the return box', () => {
    const { bus, gifts, hands, log, goTo } = setup();
    gifts.pickUp('outbound');
    goTo('neighbourHome');
    const seen: { event: string; exchanged: boolean; boxes: readonly GiftBoxSnapshot[]; hands: unknown }[] = [];
    for (const event of ['itemDelivered', 'itemPickedUp', 'giftExchanged'] as const) {
      bus.on(event, () => seen.push({ event, exchanged: gifts.exchanged, boxes: gifts.boxes(), hands: hands.hands }));
    }
    expect(gifts.exchange()).toEqual({ ok: true });
    // Every listener already sees the finished swap: never both boxes, never neither.
    for (const s of seen) {
      expect(s.exchanged).toBe(true);
      expect(place(s.boxes, 'outbound')).toEqual({ kind: 'delivered' });
      expect(place(s.boxes, 'return')).toEqual({ kind: 'hands' });
      expect(s.hands).toEqual({ kind: 'giftBox', box: 'return' });
    }
    expect(seen.map((s) => s.event)).toEqual(['itemDelivered', 'itemPickedUp', 'giftExchanged']);
    expect(log.slice(-3)).toEqual([
      { name: 'itemDelivered', payload: { item: { kind: 'giftBox', box: 'outbound' } } },
      { name: 'itemPickedUp', payload: { item: { kind: 'giftBox', box: 'return' } } },
      { name: 'giftExchanged', payload: {} },
    ]);
  });

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
      returnSpot: false,
      returnTable: false,
      held: null,
    });
    expect(giftVisibility([{ id: 'outbound', place: { kind: 'hands' } }])).toMatchObject({ outboundSpot: false, held: 'outbound' });
    const exchanged = (place: GiftBoxSnapshot['place']): GiftBoxSnapshot[] => [
      { id: 'outbound', place: { kind: 'delivered' } },
      { id: 'return', place },
    ];
    expect(giftVisibility(exchanged({ kind: 'hands' }))).toEqual({
      outboundSpot: false,
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
  const hosts = new NeighbourHosts({ bus, layout: neighbourLayout, hands, dialogue: { ...HOST_DIALOGUE, ...HOST_GIFT_DIALOGUE } });
  const household = new Households([family, hosts]);
  const gifts = new GiftExchange({ bus, hands, location: () => locations.location });
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
  const giftLines = (cause: 'giftExchanged' | 'giftAcknowledged') => {
    const catalogue = cause === 'giftExchanged' ? HOST_GIFT_DIALOGUE : FAMILY_GIFT_DIALOGUE;
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
    press(host('aunty'));
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

  it('Uncle and Aunty each answer the gift once, one after the other, even mid-welcome', () => {
    const { go, run, press, giftLines, spoken, hosts } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    // Straight in, before Uncle's welcome has finished.
    run(1.5);
    press(host('uncle'));
    let most = 0;
    for (let t = 0; t < dialogueDuration * 6; t += STEP) {
      run(STEP);
      most = Math.max(most, hosts.members().filter((m) => m.line !== null).length);
    }
    expect(giftLines('giftExchanged').map((l) => l.member)).toEqual(GIFT_BEHAVIOUR.exchangeSpeakers);
    // The welcome still happened, and never two lines up at once next door.
    expect(spoken.filter((l) => l.member === 'uncle' || l.member === 'aunty').length).toBeGreaterThan(2);
    expect(most).toBe(1);
  });

  it('repeat interactions with the return box in hand greet rather than exchange again', () => {
    const { go, press, gifts, count, hands } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('aunty'));
    press(host('aunty'));
    press(host('uncle'));
    expect(count('giftExchanged')).toBe(1);
    expect(gifts.boxes()).toHaveLength(2);
    expect(hands.hands).toEqual({ kind: 'giftBox', box: 'return' });
  });

  it('the return box goes back on the console next door and is picked up again there', () => {
    const { go, press, gifts, hands } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('aunty'));
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
    expect(count('giftExchanged')).toBe(2);
    run(1);
  });
});

describe('gift reactions — pacing', () => {
  it('drops the neighbours’ thanks if the player walks out before they finish', () => {
    const { go, run, press, reactions, giftLines } = evening();
    go('familyHome', 'enter');
    press(familyGiftSpot);
    go('familyHome', 'exit');
    go('neighbourHome', 'enter');
    press(host('uncle'));
    go('neighbourHome', 'exit');
    expect(reactions.pending).toEqual([]);
    go('neighbourHome', 'enter');
    run(dialogueDuration * 6);
    expect(giftLines('giftExchanged').length).toBeLessThan(GIFT_BEHAVIOUR.exchangeSpeakers.length);
  });

  it('has a line for every speaker in each gift moment', () => {
    for (const member of GIFT_BEHAVIOUR.exchangeSpeakers) {
      expect(HOST_GIFT_DIALOGUE.giftExchanged?.[member]?.length).toBeGreaterThan(0);
    }
    for (const member of GIFT_BEHAVIOUR.acknowledgementSpeakers) {
      expect(FAMILY_GIFT_DIALOGUE.giftAcknowledged?.[member]?.length).toBeGreaterThan(0);
    }
  });
});

describe('gift prompts', () => {
  it('offers the handover only before the exchange', () => {
    const outbound = { kind: 'giftBox', box: 'outbound' } as const;
    expect(homePromptLines(host('aunty'), { hands: outbound, exchanged: false })).toEqual([
      { text: 'E: Give the gift box to Aunty', blocked: false },
    ]);
    expect(homePromptLines(host('aunty'), { hands: null, exchanged: true })).toEqual([
      { text: 'E: Greet Aunty', blocked: false },
    ]);
  });

  it('offers to set the return box on the sweets table', () => {
    expect(homePromptLines(familyTray, { hands: { kind: 'giftBox', box: 'return' } })).toEqual([
      { text: 'E: Place the return gift on the sweets table', blocked: false },
    ]);
  });
});
