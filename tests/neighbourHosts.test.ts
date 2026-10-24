import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus, type GameEventName } from '../src/core/events';
import { NEIGHBOUR_HOSTS, type DialogueLine, type HandItem, type HomeId, type HomeInteractable } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType } from '../src/core/types';
import {
  CRACKER_BLOCKED_TEXT,
  doorwayId,
  HeldItems,
  homeDoorways,
  homesResetHooks,
  ITEM_REJECTION_TEXT,
  Locations,
  registerHomesReset,
  type HandCrackers,
} from '../src/homes';
import {
  HOST_DIALOGUE,
  HOST_DIALOGUE_AFTER_AARTI,
  HOSTS_BEHAVIOUR,
  Household,
  Households,
  NeighbourHosts,
  subtitlesFor,
} from '../src/household';
import { applyHomeAction } from '../src/interaction';
import { createFamilyHomeLayout, createNeighbourHomeLayout, neighbourHomeSpots } from '../src/interior';
import { Session } from '../src/session/session';
import { homePromptLines, MEMBER_LABELS, type HomePromptState } from '../src/ui/homePrompts';
import { HudModel } from '../src/ui/hudModel';

const STEP = 1 / 60;
const SONG_LENGTH = 6;
const familyLayout = createFamilyHomeLayout();
const layout = createNeighbourHomeLayout();
const { dialogueDuration, reactionCooldown, fadeDuration } = TUNING.homes;
const { entryDelay } = HOSTS_BEHAVIOUR;
const E = { type: 'interact' } as const;
const CLICK = { type: 'place' } as const;
const OUTBOUND: HandItem = { kind: 'giftBox', box: 'outbound' };
const RETURN_BOX: HandItem = { kind: 'giftBox', box: 'return' };

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

const NEIGHBOUR_TRAY: HomeInteractable = { kind: 'tray', id: 'neighbourHome', position: neighbourHomeSpots(layout).tray! };
const FAMILY_TRAY: HomeInteractable = { kind: 'tray', id: 'familyHome', position: { x: 0, y: 0, z: 0 } };
const person = (id: 'uncle' | 'aunty'): HomeInteractable => ({ kind: 'person', id, position: layout.hosts[id].position });

/** The hosts with the real doors, hands, ceremony and family they share the evening with. */
function setup() {
  const bus = createGameEventBus();
  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const locations = new Locations({ bus, hands });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: () => SONG_LENGTH, location: () => locations.location });
  const family = new Household({ bus, layout: familyLayout });
  const hosts = new NeighbourHosts({ bus, layout, hands });
  const household = new Households([family, hosts]);
  const spoken: DialogueLine[] = [];
  bus.on('householdReacted', ({ line }) => spoken.push(line));
  const events: GameEventName[] = [];
  for (const name of ['sweetsEaten', 'itemRejected', 'itemPickedUp'] as const) bus.on(name, () => events.push(name));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      locations.update(STEP);
      ceremony.update(STEP);
      household.update(STEP);
    }
  };
  const go = (home: HomeId, side: 'enter' | 'exit') => {
    expect(locations.requestTransition(doorwayId(home, side))).toEqual({ ok: true });
    run(fadeDuration + STEP);
  };
  /** Come in and wait out the whole welcome. */
  const visit = () => {
    go('neighbourHome', 'enter');
    run(entryDelay + dialogueDuration * 2 + 0.5);
  };
  const completeAarti = () => {
    go('familyHome', 'enter');
    expect(ceremony.join()).toEqual({ ok: true });
    run(SONG_LENGTH + STEP);
    expect(ceremony.snapshot.state).toBe('completed');
    go('familyHome', 'exit');
  };
  const ctx = { locations, ceremony, hands, household, hosts };
  const said = (member: string) => spoken.filter((l) => l.member === member).map((l) => l.text);
  return { bus, hands, locations, ceremony, family, hosts, household, spoken, events, run, go, visit, completeAarti, ctx, said };
}

const texts = (lines: readonly { text: string }[] | undefined) => (lines ?? []).map((l) => l.text);

describe('neighbour hosts — identities', () => {
  it('is Uncle and Aunty, at home next door in the places the room gives them', () => {
    const { hosts } = setup();
    expect(hosts.members().map((m) => m.id)).toEqual([...NEIGHBOUR_HOSTS]);
    for (const member of hosts.members()) {
      expect(member.home).toBe('neighbourHome');
      expect(member.placement).toEqual(layout.hosts[member.id as 'uncle' | 'aunty']);
      expect(member.line).toBeNull();
    }
  });

  it('keeps the same member objects all session, so identities are stable', () => {
    const { hosts, visit } = setup();
    const before = hosts.members();
    const objects = [...before];
    visit();
    expect(hosts.members()).toBe(before);
    expect([...hosts.members()]).toEqual(objects);
  });
});

describe('neighbour hosts — welcome on every visit', () => {
  it('says nothing while the player is elsewhere', () => {
    const { spoken, run, go } = setup();
    run(30);
    go('familyHome', 'enter');
    run(30);
    expect(spoken.filter((l) => l.member === 'uncle' || l.member === 'aunty')).toEqual([]);
  });

  it('has Uncle recognise the player and ask after the family, then Aunty offer mithai', () => {
    const { spoken, run, go, hosts } = setup();
    go('neighbourHome', 'enter');
    expect(hosts.views().every((h) => h.activity === 'greeting')).toBe(true);
    // The player arrived at the fade's midpoint, half a fade ago.
    run(entryDelay - fadeDuration / 2 - 0.1);
    expect(spoken).toEqual([]);
    run(0.2);
    expect(spoken.map((l) => l.member)).toEqual(['uncle']);
    expect(texts(HOST_DIALOGUE.welcome?.uncle)).toContain(spoken[0]!.text);
    // Aunty waits for him to finish rather than talking over him.
    run(dialogueDuration - 0.3);
    expect(spoken.map((l) => l.member)).toEqual(['uncle']);
    run(0.5);
    expect(spoken.map((l) => l.member)).toEqual(['uncle', 'aunty']);
    expect(spoken[1]!.gesture).toBe('offerMithai');
    expect(hosts.welcoming).toBe(false);
  });

  it('asks after the family in every greeting Uncle has, before and after aarti', () => {
    const family = /Mummy|Papa|Dadi|Dadaji|Chhotu|[Gg]har/;
    for (const line of [...texts(HOST_DIALOGUE.welcome?.uncle), ...texts(HOST_DIALOGUE_AFTER_AARTI.welcome?.uncle)]) {
      expect(line).toMatch(family);
    }
    for (const line of [...texts(HOST_DIALOGUE.welcome?.aunty), ...texts(HOST_DIALOGUE_AFTER_AARTI.welcome?.aunty)]) {
      expect(line).toMatch(/mithai|ladoo|katli|[Ll]o\b/i);
    }
  });

  it('never makes the welcome depend on a gift', () => {
    for (const catalogue of [HOST_DIALOGUE, HOST_DIALOGUE_AFTER_AARTI]) {
      for (const lines of Object.values(catalogue)) {
        for (const line of Object.values(lines ?? {}).flat()) expect(line!.text).not.toMatch(/gift|tohfa|uphaar/i);
      }
    }
  });

  it('welcomes the player on every visit, as many visits as they make', () => {
    const { hosts, said, visit, go } = setup();
    for (let i = 0; i < 12; i++) {
      visit();
      go('neighbourHome', 'exit');
    }
    expect(hosts.visits).toBe(12);
    expect(said('uncle')).toHaveLength(12);
    expect(said('aunty')).toHaveLength(12);
    // Lines rotate rather than repeating the same one each time.
    expect(new Set(said('uncle')).size).toBe(texts(HOST_DIALOGUE.welcome?.uncle).length);
  });

  it('still welcomes a quick in-and-out, once the hosts are free to speak again', () => {
    const { said, run, go } = setup();
    go('neighbourHome', 'enter');
    run(entryDelay + 0.1);
    expect(said('uncle')).toHaveLength(1);
    go('neighbourHome', 'exit');
    go('neighbourHome', 'enter');
    run(entryDelay);
    // Uncle is still mid-line from a moment ago: the greeting waits rather than being skipped.
    expect(said('uncle')).toHaveLength(1);
    run(reactionCooldown + dialogueDuration + 0.5);
    expect(said('uncle')).toHaveLength(2);
    expect(said('aunty')).toHaveLength(1);
  });

  it('drops a welcome the player walks out of, without speaking to an empty room', () => {
    const { spoken, run, go, hosts } = setup();
    go('neighbourHome', 'enter');
    run(0.1);
    go('neighbourHome', 'exit');
    run(30);
    expect(spoken).toEqual([]);
    expect(hosts.welcoming).toBe(false);
    expect(hosts.views().every((h) => h.activity === 'idle')).toBe(true);
  });

  it('welcomes a player carrying the gift box just the same', () => {
    const { hands, said, visit } = setup();
    expect(hands.take(OUTBOUND)).toEqual({ ok: true });
    visit();
    expect(said('uncle')).toHaveLength(1);
    expect(said('aunty')).toHaveLength(1);
  });
});

describe('neighbour hosts — no-gift greeting before and after aarti', () => {
  it('greets with free hands while aarti still waits at home', () => {
    const { ceremony, hands, said, visit, run, ctx } = setup();
    expect(ceremony.snapshot.state).toBe('waiting');
    expect(hands.hands).toBeNull();
    visit();
    expect(said('uncle')).toHaveLength(1);
    expect(texts(HOST_DIALOGUE.welcome?.uncle)).toContain(said('uncle')[0]);
    // Greeting them again works too, once they are free to speak.
    run(reactionCooldown);
    expect(applyHomeAction(E, person('aunty'), ctx)).toBe(true);
    expect(said('aunty')).toHaveLength(2);
  });

  it('greets with free hands while aarti is running at home', () => {
    const { ceremony, said, visit, go } = setup();
    go('familyHome', 'enter');
    ceremony.join();
    ceremony.leave();
    go('familyHome', 'exit');
    expect(ceremony.snapshot.state).toBe('running');
    visit();
    expect(said('uncle')).toHaveLength(1);
    expect(said('aunty')).toHaveLength(1);
  });

  it('greets with free hands once aarti is over, asking how it went', () => {
    const { hands, said, visit, completeAarti, ctx } = setup();
    completeAarti();
    expect(hands.hands).toBeNull();
    visit();
    expect(texts(HOST_DIALOGUE_AFTER_AARTI.welcome?.uncle)).toContain(said('uncle')[0]);
    expect(texts(HOST_DIALOGUE_AFTER_AARTI.welcome?.aunty)).toContain(said('aunty')[0]);
    expect(applyHomeAction(E, person('uncle'), ctx)).toBe(true);
    expect(said('uncle')).toHaveLength(2);
  });

  it('greets when the ceremony finishes while the player is visiting next door', () => {
    const { ceremony, said, run, go, visit } = setup();
    go('familyHome', 'enter');
    ceremony.join();
    ceremony.leave();
    go('familyHome', 'exit');
    visit();
    run(SONG_LENGTH);
    expect(ceremony.snapshot.state).toBe('completed');
    go('neighbourHome', 'exit');
    visit();
    expect(said('uncle')).toHaveLength(2);
    expect(texts(HOST_DIALOGUE_AFTER_AARTI.welcome?.uncle)).toContain(said('uncle')[1]);
  });
});

describe('neighbour hosts — mithai', () => {
  it('lets the player eat at any point in the evening, independent of the family tray', () => {
    const { hands, hosts, events, go, visit, completeAarti, ctx } = setup();
    visit();
    // Aarti has not happened: the family tray is not served, but next door it does not matter.
    expect(hands.trayServed).toBe(false);
    expect(applyHomeAction(E, NEIGHBOUR_TRAY, ctx)).toBe(true);
    expect(hosts.mithaiEaten).toBe(1);
    expect(events).toEqual([]);
    go('neighbourHome', 'exit');
    completeAarti();
    visit();
    expect(hosts.eatMithai()).toEqual({ ok: true });
    expect(hosts.mithaiEaten).toBe(2);
  });

  it('is unlimited, and stays off the family tray’s events', () => {
    const { hosts, events, visit, run } = setup();
    visit();
    for (let i = 0; i < 50; i++) {
      expect(hosts.eatMithai()).toEqual({ ok: true });
      run(0.5);
    }
    expect(hosts.mithaiEaten).toBe(50);
    expect(events).not.toContain('sweetsEaten');
  });

  it('answers eating with one line at a time, bounded by the cooldown', () => {
    const { hosts, spoken, visit, run } = setup();
    visit();
    run(reactionCooldown);
    const before = spoken.length;
    for (let i = 0; i < 10; i++) hosts.eatMithai();
    // Aunty answers, then Uncle; nobody queues or talks twice.
    expect(spoken.slice(before).map((l) => l.member)).toEqual(['aunty', 'uncle']);
    for (const line of spoken.slice(before)) expect(texts(HOST_DIALOGUE.ateSweets?.[line.member])).toContain(line.text);
    for (let i = 0; i < 20; i++) {
      hosts.eatMithai();
      run(1);
    }
    const lines = spoken.slice(before);
    for (const id of NEIGHBOUR_HOSTS) {
      const count = lines.filter((l) => l.member === id).length;
      expect(count, id).toBeLessThanOrEqual(Math.ceil(20 / reactionCooldown) + 1);
    }
  });

  it('asks for the gift box to be delivered or put down first, and works only next door', () => {
    const { bus, hands, hosts, visit, go } = setup();
    const hud = new HudModel({ bus });
    expect(hosts.eatMithai()).toEqual({ ok: false, reason: 'outOfReach' });
    hands.take(OUTBOUND);
    visit();
    expect(hosts.eatMithai()).toEqual({ ok: false, reason: 'carryingGift' });
    expect(hud.rejection?.text).toBe(ITEM_REJECTION_TEXT.carryingGift);
    hands.release('giftBox');
    expect(hosts.eatMithai()).toEqual({ ok: true });
    go('neighbourHome', 'exit');
    expect(hosts.eatMithai()).toEqual({ ok: false, reason: 'outOfReach' });
  });

  it('never hands out the family’s sharing plate from the neighbour’s table', () => {
    const { hands, events, visit, completeAarti, ctx } = setup();
    completeAarti();
    visit();
    events.length = 0;
    expect(applyHomeAction(CLICK, NEIGHBOUR_TRAY, ctx)).toBe(true);
    expect(hands.hands).toBeNull();
    expect(events).not.toContain('itemPickedUp');
  });

  it('leaves the family tray as it was: served after aarti only', () => {
    const { hands, events, ctx } = setup();
    applyHomeAction(E, FAMILY_TRAY, ctx);
    expect(events).toEqual(['itemRejected']);
    expect(hands.trayServed).toBe(false);
  });
});

describe('neighbour hosts — prompts and captions', () => {
  const state = (overrides: Partial<HomePromptState> = {}): HomePromptState => ({
    hands: null,
    trayServed: false,
    doorway: (id) => homeDoorways().find((d) => d.id === id),
    ...overrides,
  });
  const promptTexts = (target: HomeInteractable, s: HomePromptState) => homePromptLines(target, s).map((l) => l.text);

  it('offers mithai at the neighbour’s table before and after aarti, with no plate to take', () => {
    expect(promptTexts(NEIGHBOUR_TRAY, state())).toEqual(['E: Have mithai']);
    expect(promptTexts(NEIGHBOUR_TRAY, state({ trayServed: true }))).toEqual(['E: Have mithai']);
  });

  it('asks for the hands to be freed while a box is carried', () => {
    for (const box of [OUTBOUND, RETURN_BOX]) {
      expect(homePromptLines(NEIGHBOUR_TRAY, state({ hands: box }))).toEqual([
        { text: CRACKER_BLOCKED_TEXT.carryingGift, blocked: true },
      ]);
    }
  });

  it('offers to greet Uncle and Aunty with or without a gift', () => {
    expect(promptTexts(person('uncle'), state())).toEqual(['E: Greet Uncle']);
    expect(promptTexts(person('aunty'), state({ trayServed: true }))).toEqual(['E: Greet Aunty']);
  });

  it('captions the hosts only next door, by name', () => {
    const { household, visit, run } = setup();
    visit();
    expect(subtitlesFor(household.members(), 'neighbourHome')).toEqual([]);
    household.react('uncle', 'welcome');
    run(reactionCooldown + 0.1);
    expect(household.react('uncle', 'welcome')).not.toBeNull();
    expect(subtitlesFor(household.members(), 'neighbourHome')).toEqual([
      { speaker: MEMBER_LABELS.uncle, text: household.members().find((m) => m.id === 'uncle')!.line!.text },
    ]);
    expect(subtitlesFor(household.members(), 'familyHome')).toEqual([]);
  });
});

describe('households together', () => {
  it('lists the family and the hosts as one stable roster', () => {
    const { household, family, hosts } = setup();
    const roster = household.members();
    expect(roster.map((m) => m.id)).toEqual([...family.members(), ...hosts.members()].map((m) => m.id));
    expect(household.members()).toBe(roster);
  });

  it('sends each reaction to the household the member belongs to', () => {
    const { household, spoken } = setup();
    expect(household.react('aunty', 'welcome')?.member).toBe('aunty');
    expect(household.react('mother', 'invite')?.member).toBe('mother');
    expect(household.react('aunty', 'invite')).toBeNull();
    expect(spoken.map((l) => l.member)).toEqual(['aunty', 'mother']);
  });

  it('freezes with the paused simulation: no steps, no welcome', () => {
    const { hosts, spoken, go, locations } = setup();
    expect(locations.requestTransition(doorwayId('neighbourHome', 'enter')).ok).toBe(true);
    for (let i = 0; i < 60; i++) locations.update(STEP);
    for (let i = 0; i < 600; i++) hosts.update(0);
    expect(spoken).toEqual([]);
    expect(hosts.welcoming).toBe(true);
    go('neighbourHome', 'exit');
  });

  it('starts fresh on a new session: no visits, mithai or lines, and before-aarti greetings again', () => {
    const { bus, locations, ceremony, hands, household, hosts, said, visit, completeAarti, go } = setup();
    const session = new Session({ bus });
    registerHomesReset(session, homesResetHooks({ locations, aartiCeremony: ceremony, heldItems: hands, household }));
    completeAarti();
    visit();
    hosts.eatMithai();
    session.reset();
    expect(hosts.visits).toBe(0);
    expect(hosts.mithaiEaten).toBe(0);
    expect(hosts.members().every((m) => m.line === null)).toBe(true);
    expect(locations.location).toBe('outdoors');
    const before = said('uncle').length;
    visit();
    expect(texts(HOST_DIALOGUE.welcome?.uncle)[0]).toBe(said('uncle')[before]);
    go('neighbourHome', 'exit');
  });
});
