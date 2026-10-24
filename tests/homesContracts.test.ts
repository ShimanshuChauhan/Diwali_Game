import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Resettable } from '../src/core/contracts';
import { createGameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import {
  AARTI_SONG_IDS,
  FAMILY_MEMBERS,
  LOCATION_IDS,
  NEIGHBOUR_HOSTS,
  type AartiRejection,
  type CrackerHandsRejection,
  type ItemRejection,
  type TransitionRejection,
} from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import {
  HOMES_STATEFUL_MODULES,
  homesResetHooks,
  pendingModules,
  PendingReset,
  registerHomesReset,
} from '../src/homes';
import { Session } from '../src/session/session';

type HomesEventName =
  | 'transitionStarted'
  | 'locationChanged'
  | 'transitionRejected'
  | 'aartiJoined'
  | 'aartiLeft'
  | 'aartiSongChanged'
  | 'aartiCompleted'
  | 'aartiRejected'
  | 'itemPickedUp'
  | 'itemReturned'
  | 'itemRejected'
  | 'itemDelivered'
  | 'crackerBlocked'
  | 'sweetsEaten'
  | 'sweetsOffered'
  | 'giftExchanged'
  | 'giftPlaced'
  | 'giftAcknowledged'
  | 'giftRejected'
  | 'householdReacted';

// One sample payload per expansion event; the mapped type makes a missing or
// mistyped entry a compile error.
const SAMPLES: { readonly [K in HomesEventName]: GameEvents[K] } = {
  transitionStarted: { doorway: 'family-front', from: 'outdoors', to: 'familyHome', duration: 0.6 },
  locationChanged: { doorway: 'family-front', from: 'outdoors', to: 'familyHome' },
  transitionRejected: { doorway: 'family-front', reason: 'carryingPlate' },
  aartiJoined: { song: 'omJaiJagdishHare', elapsed: 42.5, playbackId: 3 },
  aartiLeft: { song: 'omJaiJagdishHare', elapsed: 50 },
  aartiSongChanged: { song: 'jaiGaneshDeva', duration: 240, playbackId: 4 },
  aartiCompleted: { song: 'jaiGaneshDeva', participating: false },
  aartiRejected: { reason: 'ceremonyCompleted' },
  itemPickedUp: { item: { kind: 'sweetsPlate' } },
  itemReturned: { item: { kind: 'giftBox', box: 'return' } },
  itemRejected: { action: 'pickUpPlate', reason: 'handsFull' },
  itemDelivered: { item: { kind: 'giftBox', box: 'outbound' } },
  crackerBlocked: { action: 'igniteHeld', reason: 'carryingPlate' },
  sweetsEaten: {},
  sweetsOffered: { member: 'grandmother' },
  giftExchanged: {},
  giftPlaced: { pendingAcknowledgement: true },
  giftAcknowledged: {},
  giftRejected: { reason: 'alreadyExchanged' },
  householdReacted: { line: { member: 'aunty', text: 'Arre beta, aao aao!', gesture: 'namaste', duration: 3 } },
};

describe('homes events on the game bus', () => {
  const entries = Object.entries(SAMPLES) as [HomesEventName, GameEvents[HomesEventName]][];

  it('covers the events the issue names', () => {
    const required: GameEventName[] = [
      'locationChanged',
      'transitionRejected',
      'aartiJoined',
      'aartiLeft',
      'aartiSongChanged',
      'aartiCompleted',
      'itemPickedUp',
      'itemReturned',
      'itemRejected',
      'sweetsOffered',
      'giftExchanged',
      'giftAcknowledged',
    ];
    expect(Object.keys(SAMPLES)).toEqual(expect.arrayContaining(required));
  });

  it.each(entries)('delivers %s with its payload to its own subscribers only', (name, payload) => {
    const bus = createGameEventBus();
    const listener = vi.fn();
    const other = vi.fn();
    bus.on(name, listener);
    bus.on('sessionReset', other);

    bus.emit(name, payload as never);

    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
    expect(other).not.toHaveBeenCalled();
  });

  it('types payloads at compile time', () => {
    expectTypeOf<GameEvents['transitionRejected']['reason']>().toEqualTypeOf<TransitionRejection>();
    expectTypeOf<GameEvents['aartiRejected']['reason']>().toEqualTypeOf<AartiRejection>();
    expectTypeOf<GameEvents['itemRejected']['reason']>().toEqualTypeOf<ItemRejection>();
    expectTypeOf<GameEvents['crackerBlocked']['reason']>().toEqualTypeOf<CrackerHandsRejection>();
    expectTypeOf<'handsFull' | 'carryingPlate'>().toExtend<ItemRejection>();
    expectTypeOf<'transitionInProgress' | 'carryingPlate'>().toExtend<TransitionRejection>();
    expectTypeOf<'ceremonyCompleted' | 'handsFull'>().toExtend<AartiRejection>();
    expectTypeOf<CrackerHandsRejection>().toExtend<ItemRejection>();
  });
});

describe('homes identities', () => {
  it('has the street and exactly two enterable homes', () => {
    expect(LOCATION_IDS).toEqual(['outdoors', 'familyHome', 'neighbourHome']);
  });

  it('has the three requested aartis', () => {
    expect(AARTI_SONG_IDS).toEqual(['omJaiJagdishHare', 'jaiLakshmiMata', 'jaiGaneshDeva']);
  });

  it('gives the family and neighbour hosts distinct identities', () => {
    const all = [...FAMILY_MEMBERS, ...NEIGHBOUR_HOSTS];
    expect(new Set(all).size).toBe(all.length);
    expect(FAMILY_MEMBERS).toHaveLength(5);
  });
});

describe('homes tuning', () => {
  it('gives every homes value a positive placeholder', () => {
    for (const [key, value] of Object.entries(TUNING.homes)) {
      expect(value, key).toBeGreaterThan(0);
    }
  });

  it('keeps the door fade brief', () => {
    expect(TUNING.homes.fadeDuration).toBeLessThanOrEqual(1.5);
  });

  it('shows a line no longer than its speaker’s cooldown, so lines never overlap', () => {
    expect(TUNING.homes.dialogueDuration).toBeLessThanOrEqual(TUNING.homes.reactionCooldown);
  });
});

class Counter implements Resettable {
  resets = 0;
  reset(): void {
    this.resets += 1;
  }
}

describe('homes session reset', () => {
  it('has a hook for every stateful module, stubbing the unbuilt ones', () => {
    const hooks = homesResetHooks();
    for (const module of HOMES_STATEFUL_MODULES) {
      expect(hooks[module]).toBeInstanceOf(PendingReset);
      expect((hooks[module] as PendingReset).module).toBe(module);
    }
    expect(pendingModules(hooks)).toEqual([...HOMES_STATEFUL_MODULES]);
  });

  it('uses built modules in place of their stubs', () => {
    const ceremony = new Counter();
    const hooks = homesResetHooks({ aartiCeremony: ceremony });
    expect(hooks.aartiCeremony).toBe(ceremony);
    expect(pendingModules(hooks)).not.toContain('aartiCeremony');
  });

  it('resets every expansion module on a fresh session', () => {
    const built = Object.fromEntries(HOMES_STATEFUL_MODULES.map((m) => [m, new Counter()])) as Record<
      (typeof HOMES_STATEFUL_MODULES)[number],
      Counter
    >;
    const session = new Session({ bus: createGameEventBus() });
    registerHomesReset(session, homesResetHooks(built));

    session.start();
    session.reset();

    for (const module of HOMES_STATEFUL_MODULES) expect(built[module].resets, module).toBe(2);
  });

  it('stubs reset harmlessly', () => {
    const session = new Session({ bus: createGameEventBus() });
    registerHomesReset(session, homesResetHooks());
    expect(() => session.start()).not.toThrow();
  });

  it('stops resetting after unregistering', () => {
    const household = new Counter();
    const session = new Session({ bus: createGameEventBus() });
    const unregister = registerHomesReset(session, homesResetHooks({ household }));
    unregister();
    session.reset();
    expect(household.resets).toBe(0);
  });
});

describe('homes rule modules stay renderer-free', () => {
  const sources = import.meta.glob<string>(['../src/homes/*.ts'], { query: '?raw', import: 'default', eager: true });
  const files = Object.entries(sources);

  it('finds the homes files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports neither three nor rapier', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });
});
