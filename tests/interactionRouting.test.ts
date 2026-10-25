import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { CameraView, CrackerSnapshot, HeldItem, Interactable, WorldModule } from '../src/core/contracts';
import { createGameEventBus, type GameEventBus, type GameEventName, type GameEvents } from '../src/core/events';
import type {
  AartiSnapshot,
  CommandResult,
  GiftBoxId,
  GiftBoxSnapshot,
  GiftRejection,
  HandItem,
  HomeInteractable,
  HouseholdMemberId,
  HouseholdMemberSnapshot,
  LocationId,
  ReactionCause,
} from '../src/core/homes';
import { FAMILY_MEMBERS, NEIGHBOUR_HOSTS } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType, Vec3 } from '../src/core/types';
import { createLayout } from '../src/world';
import { ENTERABLE_HOUSES } from '../src/world/layout';
import {
  CRACKER_BLOCKED_TEXT,
  HeldItems,
  HOME_ENTRANCES,
  homeDoorways,
  ITEM_REJECTION_TEXT,
  Locations,
  TRANSITION_REJECTION_TEXT,
  type HandCrackers,
} from '../src/homes';
import { applyHomeAction, HOME_SPOTS, Interaction, type HomeActionContext } from '../src/interaction';
import { DOOR_HINTS, homePromptLines, MEMBER_LABELS, type HomePromptState } from '../src/ui/homePrompts';
import { HudModel, promptLines } from '../src/ui/hudModel';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const UP = v(0, 1, 0);
const STEP = 1 / 60;
const NORTH = v(0, 0, -1);
const SOUTH = v(0, 0, 1);
const EAST = v(1, 0, 0);
const WEST = v(-1, 0, 0);

const PLATE: HandItem = { kind: 'sweetsPlate' };
const OUTBOUND: HandItem = { kind: 'giftBox', box: 'outbound' };
const RETURN_BOX: HandItem = { kind: 'giftBox', box: 'return' };
const THALI: HandItem = { kind: 'thali' };

const DOORWAYS = homeDoorways();
const FAMILY = HOME_SPOTS.familyHome;
const NEIGHBOUR = HOME_SPOTS.neighbourHome;
const FAMILY_DOOR = HOME_ENTRANCES.familyHome;

function flatWorld(diyas: { id: string; position: Vec3 }[] = []): WorldModule {
  return {
    bounds: { min: v(-50, -1, -50), max: v(50, 20, 150) },
    spawn: v(0, 0, 0),
    doorways: [],
    diyaSites: diyas,
    neighbourAreas: [],
    surfaceBelow: (p) => ({ point: v(p.x, 0, p.z), normal: UP, supportsPlacement: true }),
    isClear: () => true,
    clearanceAbove: (_p, max) => max,
  };
}

function cracker(id: string, position: Vec3): CrackerSnapshot {
  return { id, type: 'anar', state: 'placed', position, stateTime: 0 };
}

function member(id: HouseholdMemberId, position: Vec3): HouseholdMemberSnapshot {
  const home = (NEIGHBOUR_HOSTS as readonly string[]).includes(id) ? 'neighbourHome' : 'familyHome';
  return { id, home, activity: 'idle', placement: { position, yaw: 0 }, line: null };
}

function aarti(overrides: Partial<AartiSnapshot> = {}): AartiSnapshot {
  return {
    state: 'waiting',
    participating: false,
    song: 'omJaiJagdishHare',
    elapsed: 0,
    duration: 60,
    circling: false,
    playbackId: 0,
    ...overrides,
  };
}

/** A mutable homes scene the interaction module reads through its options. */
interface Scene {
  location: LocationId;
  feet: Vec3;
  hands: HandItem | null;
  aarti: AartiSnapshot;
  members: HouseholdMemberSnapshot[];
  gifts: GiftBoxSnapshot[];
  crackers: CrackerSnapshot[];
}

function scene(overrides: Partial<Scene> = {}, diyas: { id: string; position: Vec3 }[] = []) {
  const s: Scene = {
    location: 'outdoors',
    feet: v(0, 0, 0),
    hands: null,
    aarti: aarti(),
    members: [],
    gifts: [
      { id: 'outbound', place: { kind: 'spot', home: 'familyHome' } },
      { id: 'return', place: { kind: 'delivered' } },
    ],
    crackers: [],
    ...overrides,
  };
  const interaction = new Interaction({
    world: flatWorld(diyas),
    crackers: () => s.crackers,
    playerPosition: () => s.feet,
    location: () => s.location,
    doorways: () => DOORWAYS,
    members: () => s.members,
    hands: () => s.hands,
    aarti: () => s.aarti,
    gifts: () => s.gifts,
  });
  const find = (forward: Vec3 = NORTH): Interactable | null => interaction.findInteractable(view(s.feet, forward));
  return { s, interaction, find };
}

function view(feet: Vec3, forward: Vec3): CameraView {
  return {
    mode: 'firstPerson',
    position: v(feet.x, feet.y + TUNING.player.eyeHeight, feet.z),
    forward,
    yaw: 0,
    pitch: 0,
  };
}

/** `distance` metres from `p` in direction `dir`, on the ground. */
function from(p: Vec3, dir: Vec3, distance: number): Vec3 {
  return v(p.x + dir.x * distance, p.y, p.z + dir.z * distance);
}

const facingYaw = (yaw: number): Vec3 => v(-Math.sin(yaw), 0, -Math.cos(yaw));

describe('nearest interactable: doors', () => {
  it('offers a home front door from the street within door reach, when facing it', () => {
    const { s, find } = scene({ feet: from(FAMILY_DOOR.street.door, EAST, 1) });
    expect(find(WEST)).toEqual({ kind: 'door', id: 'familyHome.enter', position: FAMILY_DOOR.street.door });
    expect(find(EAST)).toBeNull();
    s.feet = from(HOME_ENTRANCES.neighbourHome.street.door, WEST, 1);
    expect(find(EAST)).toMatchObject({ kind: 'door', id: 'neighbourHome.enter' });
  });

  it('uses door reach rather than the cracker range', () => {
    const doorRange = TUNING.homes.doorRange;
    const feet = from(FAMILY_DOOR.street.door, EAST, doorRange + 0.1);
    const { s, find } = scene({ feet });
    expect(find(WEST)).toBeNull();
    // A cracker at the same distance is still within its larger range.
    s.crackers = [cracker('c1', from(feet, WEST, doorRange + 0.1))];
    expect(find(WEST)).toMatchObject({ kind: 'cracker', id: 'c1' });
  });

  it('offers only the doors on the player side', () => {
    const inside = from(FAMILY_DOOR.interior.door, NORTH, 1);
    const { s, find } = scene({ feet: inside, location: 'familyHome' });
    expect(find(SOUTH)).toMatchObject({ kind: 'door', id: 'familyHome.exit' });
    s.location = 'outdoors';
    expect(find(SOUTH)).toBeNull();
  });

  it('does not face a door prompt straight after coming through it', () => {
    for (const doorway of DOORWAYS) {
      const { find } = scene({ feet: doorway.arrival.position, location: doorway.destination });
      expect(find(facingYaw(doorway.arrival.yaw))?.kind, doorway.id).not.toBe('door');
    }
  });

  it('keeps the nearest of crackers, diyas and doors outdoors', () => {
    const feet = from(FAMILY_DOOR.street.door, EAST, 1.2);
    const nearer = from(feet, WEST, 0.8);
    const farther = from(feet, WEST, 1.5);
    const withCracker = scene({ feet, crackers: [cracker('c1', nearer)] });
    expect(withCracker.find(WEST)).toMatchObject({ kind: 'cracker', id: 'c1' });
    const withDiya = scene({ feet }, [{ id: 'd1', position: farther }]);
    expect(withDiya.find(WEST)).toMatchObject({ kind: 'door', id: 'familyHome.enter' });
  });
});

describe('door hints from the lane', () => {
  const NEIGHBOUR_DOOR = HOME_ENTRANCES.neighbourHome.street.door;
  const hint = (feet: Vec3, forward: Vec3, location: LocationId = 'outdoors') =>
    scene({ feet, location }).interaction.findDoorHint(view(feet, forward))?.id ?? null;

  it('names an open door the player looks at from mid-lane, beyond door reach', () => {
    const feet = v(0, 0, FAMILY_DOOR.street.door.z);
    const { find } = scene({ feet });
    expect(find(WEST)).toBeNull();
    expect(hint(feet, WEST)).toBe('familyHome.enter');
    expect(hint(v(0, 0, NEIGHBOUR_DOOR.z), EAST)).toBe('neighbourHome.enter');
    // From the spawn, a few metres up the lane, a glance across picks it up too.
    expect(hint(v(0, 0, 5), v(-1, 0, -0.1))).toBe('familyHome.enter');
  });

  it('stays quiet looking away, from far off, in door reach and indoors', () => {
    const feet = v(0, 0, FAMILY_DOOR.street.door.z);
    expect(hint(feet, SOUTH)).toBeNull();
    expect(hint(feet, EAST)).toBeNull();
    expect(hint(from(FAMILY_DOOR.street.door, NORTH, TUNING.homes.doorHintRange + 0.5), SOUTH)).toBeNull();
    const close = from(FAMILY_DOOR.street.door, EAST, 1);
    expect(hint(close, WEST)).toBeNull();
    expect(scene({ feet: close }).find(WEST)).toMatchObject({ kind: 'door', id: 'familyHome.enter' });
    const inside = from(FAMILY_DOOR.interior.door, NORTH, 4);
    expect(hint(inside, SOUTH, 'familyHome')).toBeNull();
  });

  it('never offers or hints at the shut doors of the other houses', () => {
    const shut = createLayout().doorways.filter((d) => !ENTERABLE_HOUSES.some((h) => d.id === `${h}.doorway`));
    expect(shut.length).toBeGreaterThan(0);
    for (const zone of shut) {
      // Standing in the doorway zone, facing the door; then a few metres back.
      const towards = zone.centre.x > 0 ? EAST : zone.centre.x < 0 ? WEST : zone.centre.z < -30 ? NORTH : SOUTH;
      const back = v(-towards.x, 0, -towards.z);
      const { find } = scene({ feet: zone.centre });
      expect(find(towards), zone.id).toBeNull();
      expect(hint(from(zone.centre, back, 3), towards), zone.id).toBeNull();
    }
  });
});

describe('nearest interactable: inside homes', () => {
  it('leaves crackers and diyas to the street', () => {
    const feet = from(FAMILY.tray!, WEST, 4);
    const { find } = scene({ feet, location: 'familyHome', crackers: [cracker('c1', from(feet, NORTH, 1))] }, [
      { id: 'd1', position: from(feet, NORTH, 1.2) },
    ]);
    expect(find(NORTH)).toBeNull();
  });

  it('offers the puja corner until aarti completes', () => {
    const { s, find } = scene({ feet: from(FAMILY.puja!, SOUTH, 1.5), location: 'familyHome' });
    expect(find(NORTH)).toEqual({ kind: 'puja', id: 'familyHome', position: FAMILY.puja });
    s.aarti = aarti({ state: 'running' });
    expect(find(NORTH)?.kind).toBe('puja');
    s.aarti = aarti({ state: 'completed' });
    expect(find(NORTH)).toBeNull();
  });

  it('keeps the puja as the only target while taking part, wherever the player looks', () => {
    const { find } = scene({
      feet: from(FAMILY_DOOR.interior.door, NORTH, 0.8),
      location: 'familyHome',
      hands: THALI,
      aarti: aarti({ state: 'running', participating: true }),
    });
    // Right by the exit door and facing it, yet E can only leave aarti.
    expect(find(SOUTH)).toMatchObject({ kind: 'puja', id: 'familyHome' });
  });

  it('picks the nearer of the tray and the puja, at the spots interiors pass in', () => {
    const feet = { current: v(0.2, 0, 0) };
    const interaction = new Interaction({
      world: flatWorld(),
      playerPosition: () => feet.current,
      location: () => 'familyHome',
      spots: { familyHome: { puja: v(-0.6, 0, -1), tray: v(0.6, 0, -1) }, neighbourHome: {} },
    });
    expect(interaction.findInteractable(view(feet.current, NORTH))).toMatchObject({ kind: 'tray', id: 'familyHome' });
    feet.current = v(-0.2, 0, 0);
    expect(interaction.findInteractable(view(feet.current, NORTH))).toMatchObject({ kind: 'puja' });
  });

  it('offers family members only while the plate is carried', () => {
    const feet = from(FAMILY.tray!, SOUTH, 1.5);
    const { s, find } = scene({ location: 'familyHome', feet, members: [member('mother', from(feet, WEST, 1))] });
    expect(find(WEST)).toBeNull();
    s.hands = PLATE;
    expect(find(WEST)).toMatchObject({ kind: 'person', id: 'mother' });
    s.hands = OUTBOUND;
    expect(find(WEST)).toBeNull();
  });

  it('always offers uncle and aunty in their own home, and only there', () => {
    const feet = v(40, 0, 95);
    const { s, find } = scene({ location: 'neighbourHome', feet, members: [member('aunty', from(feet, NORTH, 1))] });
    expect(find()).toMatchObject({ kind: 'person', id: 'aunty' });
    s.location = 'familyHome';
    expect(find()).toBeNull();
  });

  it('picks the nearest person', () => {
    const feet = v(40, 0, 95);
    const { find } = scene({
      location: 'neighbourHome',
      feet,
      members: [member('uncle', from(feet, NORTH, 1.5)), member('aunty', from(feet, NORTH, 0.9))],
    });
    expect(find()?.id).toBe('aunty');
  });

  it('offers a gift spot while its box rests there or is carried', () => {
    const atFamilySpot = from(FAMILY.giftSpot!, SOUTH, 1);
    const { s, find } = scene({ location: 'familyHome', feet: atFamilySpot });
    expect(find()).toEqual({
      kind: 'returnSpot',
      id: 'giftBox@familyHome',
      item: 'giftBox',
      home: 'familyHome',
      position: FAMILY.giftSpot,
    });
    s.gifts = [
      { id: 'outbound', place: { kind: 'hands' } },
      { id: 'return', place: { kind: 'delivered' } },
    ];
    s.hands = OUTBOUND;
    expect(find()).toMatchObject({ kind: 'returnSpot', home: 'familyHome' });
    // The return box belongs next door, not on the family spot.
    s.hands = RETURN_BOX;
    expect(find()).toBeNull();
    s.hands = null;
    expect(find()).toBeNull();
  });

  it('offers the neighbour spot for the return box only', () => {
    const feet = from(NEIGHBOUR.giftSpot!, SOUTH, 1);
    const { s, find } = scene({ location: 'neighbourHome', feet, hands: OUTBOUND });
    s.gifts = [{ id: 'outbound', place: { kind: 'hands' } }];
    expect(find()).toBeNull();
    s.hands = RETURN_BOX;
    expect(find()).toMatchObject({ kind: 'returnSpot', id: 'giftBox@neighbourHome', home: 'neighbourHome' });
    s.hands = null;
    s.gifts = [{ id: 'return', place: { kind: 'spot', home: 'neighbourHome' } }];
    expect(find()).toMatchObject({ kind: 'returnSpot', home: 'neighbourHome' });
  });

  it('returns the same object while the home target is unchanged', () => {
    const { find } = scene({ feet: from(FAMILY.puja!, SOUTH, 1), location: 'familyHome' });
    const first = find();
    expect(first?.kind).toBe('puja');
    expect(find()).toBe(first);
  });
});

describe('home prompts per state', () => {
  const door = (id: string): HomeInteractable => ({ kind: 'door', id, position: v(0, 0, 0) });
  const puja: HomeInteractable = { kind: 'puja', id: 'familyHome', position: FAMILY.puja! };
  const tray: HomeInteractable = { kind: 'tray', id: 'familyHome', position: FAMILY.tray! };
  const spot = (home: 'familyHome' | 'neighbourHome'): HomeInteractable => ({
    kind: 'returnSpot',
    id: `giftBox@${home}`,
    item: 'giftBox',
    home,
    position: v(0, 0, 0),
  });
  const person = (id: HouseholdMemberId): HomeInteractable => ({ kind: 'person', id, position: v(0, 0, 0) });
  const state = (overrides: Partial<HomePromptState> = {}): HomePromptState => ({
    hands: null,
    trayServed: false,
    aarti: aarti(),
    doorway: (id) => DOORWAYS.find((d) => d.id === id),
    ...overrides,
  });
  const texts = (target: HomeInteractable, s: HomePromptState) => homePromptLines(target, s).map((l) => l.text);

  it('says where each door leads', () => {
    expect(texts(door('familyHome.enter'), state())).toEqual(['E: Enter home']);
    expect(texts(door('neighbourHome.enter'), state())).toEqual(['E: Visit Uncle and Aunty']);
    expect(texts(door('familyHome.exit'), state())).toEqual(['E: Step outside']);
    expect(texts(door('neighbourHome.exit'), state({ hands: RETURN_BOX }))).toEqual(['E: Step outside']);
  });

  it('asks for the plate back before leaving the family home', () => {
    expect(homePromptLines(door('familyHome.exit'), state({ hands: PLATE }))).toEqual([
      { text: TRANSITION_REJECTION_TEXT.carryingPlate, blocked: true },
    ]);
  });

  it('offers to join, rejoin, then hold to circle and leave aarti', () => {
    expect(texts(puja, state())).toEqual(['E: Join aarti']);
    expect(texts(puja, state({ aarti: aarti({ state: 'running' }) }))).toEqual(['E: Rejoin aarti']);
    const taking = state({ hands: THALI, aarti: aarti({ state: 'running', participating: true }) });
    expect(homePromptLines(puja, taking)).toEqual([
      { text: 'Hold click: Circle the thali', blocked: false },
      { text: 'E: Leave aarti', blocked: false },
    ]);
    expect(texts(puja, state({ aarti: aarti({ state: 'completed' }) }))).toEqual([]);
  });

  it('asks to put down a carried item, or let a lit phuljhari burn out, before joining', () => {
    for (const hands of [PLATE, OUTBOUND, RETURN_BOX]) {
      const lines = homePromptLines(puja, state({ hands }));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.blocked).toBe(true);
      expect(lines[0]!.text).toMatch(/before joining aarti/);
    }
    expect(homePromptLines(puja, state({ sparklerLit: true }))).toEqual([
      { text: ITEM_REJECTION_TEXT.sparklerLit, blocked: true },
    ]);
  });

  it('serves the tray only after aarti, then offers eating and a plate', () => {
    expect(homePromptLines(tray, state())).toEqual([{ text: ITEM_REJECTION_TEXT.trayNotServed, blocked: true }]);
    expect(homePromptLines(tray, state({ trayServed: true }))).toEqual([
      { text: 'E: Eat sweets', blocked: false },
      { text: 'Click: Take a plate to share', blocked: false },
    ]);
    expect(homePromptLines(tray, state({ trayServed: true, sparklerLit: true }))[1]).toEqual({
      text: ITEM_REJECTION_TEXT.sparklerLit,
      blocked: true,
    });
  });

  it('takes back the plate and the return box at the tray', () => {
    expect(texts(tray, state({ trayServed: true, hands: PLATE }))).toEqual(['E: Put the plate back']);
    // The return box may be set down before aarti; the family reacts afterwards.
    expect(texts(tray, state({ hands: RETURN_BOX }))).toEqual(['E: Place the return gift on the sweets table']);
    expect(homePromptLines(tray, state({ trayServed: true, hands: OUTBOUND }))).toEqual([
      { text: CRACKER_BLOCKED_TEXT.carryingGift, blocked: true },
    ]);
  });

  it('picks up and puts back each gift box at its own spot', () => {
    expect(texts(spot('familyHome'), state())).toEqual(['E: Pick up the gift box']);
    expect(texts(spot('neighbourHome'), state())).toEqual(['E: Pick up the return gift']);
    expect(texts(spot('familyHome'), state({ hands: OUTBOUND }))).toEqual(['E: Put the gift box back']);
    expect(texts(spot('neighbourHome'), state({ hands: RETURN_BOX }))).toEqual(['E: Put the return gift back']);
    expect(homePromptLines(spot('familyHome'), state({ hands: RETURN_BOX }))).toEqual([
      { text: ITEM_REJECTION_TEXT.wrongReturnSpot, blocked: true },
    ]);
    expect(homePromptLines(spot('familyHome'), state({ hands: PLATE }))).toEqual([
      { text: ITEM_REJECTION_TEXT.handsFull, blocked: true },
    ]);
  });

  it('offers sweets to each family member by name while carrying the plate', () => {
    for (const id of FAMILY_MEMBERS) {
      expect(texts(person(id), state({ hands: PLATE }))).toEqual([`E: Offer sweets to ${MEMBER_LABELS[id]}`]);
      expect(texts(person(id), state())).toEqual([]);
    }
  });

  it('greets uncle and aunty, and offers the gift box until it is exchanged', () => {
    expect(texts(person('aunty'), state())).toEqual(['E: Greet Aunty']);
    expect(texts(person('uncle'), state({ hands: OUTBOUND }))).toEqual(['E: Give the gift box to Uncle']);
    expect(texts(person('uncle'), state({ hands: OUTBOUND, exchanged: true }))).toEqual(['E: Greet Uncle']);
    expect(texts(person('uncle'), state({ hands: RETURN_BOX }))).toEqual(['E: Greet Uncle']);
  });

  it('says plainly that an enterable door goes in', () => {
    for (const id of ['familyHome.enter', 'neighbourHome.enter']) {
      expect(texts(door(id), state())[0], id).toMatch(/^E: (Enter|Visit) /);
    }
  });

  it('shows a quiet hint for an open door ahead, only with nothing in reach', () => {
    const hinted = (doorHint: LocationId, interactable: Interactable | null = null) =>
      promptLines('anar', { interactable, homes: state({ doorHint }) });
    expect(hinted('familyHome')[0]).toEqual({ text: DOOR_HINTS.familyHome, blocked: false, hint: true });
    expect(hinted('neighbourHome')[0]).toEqual({ text: DOOR_HINTS.neighbourHome, blocked: false, hint: true });
    // The usual cracker line still follows it.
    expect(hinted('familyHome').map((l) => l.text)).toEqual([DOOR_HINTS.familyHome, 'Click: Place anar']);
    expect(promptLines('anar', { interactable: null, homes: state({ doorHint: 'familyHome', hands: OUTBOUND }) })).toEqual([
      { text: DOOR_HINTS.familyHome, blocked: false, hint: true },
    ]);
    const diya: Interactable = { kind: 'diya', id: 'd1', position: v(0, 0, -1) };
    expect(hinted('familyHome', diya).some((l) => l.hint)).toBe(false);
    expect(hinted('familyHome', door('familyHome.enter')).map((l) => l.text)).toEqual(['E: Enter home']);
    expect(promptLines('anar', { interactable: null, homes: state({ doorHint: null }) }).some((l) => l.hint)).toBe(false);
  });

  it('routes home targets through the HUD prompt', () => {
    expect(promptLines('anar', { interactable: puja, homes: state() })).toEqual([
      { text: 'E: Join aarti', blocked: false },
    ]);
    // Without the homes state the HUD has nothing to say about a home target.
    expect(promptLines('anar', { interactable: puja })).toEqual([]);
  });

  it('keeps cracker prompts unchanged with free hands', () => {
    const anar: Interactable = { kind: 'cracker', id: 'c1', position: v(0, 0, -1) };
    const homes = state();
    expect(promptLines('rocket', { interactable: anar, interactableType: 'anar', homes })).toEqual(
      promptLines('rocket', { interactable: anar, interactableType: 'anar' }),
    );
    const free = promptLines('phuljhari', { interactable: null, homes });
    expect(free).toEqual(promptLines('phuljhari', { interactable: null }));
  });

  it('shows the return-or-deliver prompt for crackers while carrying something', () => {
    const anar: Interactable = { kind: 'cracker', id: 'c1', position: v(0, 0, -1) };
    const diya: Interactable = { kind: 'diya', id: 'd1', position: v(0, 0, -1) };
    const carrying = state({ hands: OUTBOUND });
    expect(promptLines('anar', { interactable: anar, interactableType: 'anar', homes: carrying })).toEqual([
      { text: CRACKER_BLOCKED_TEXT.carryingGift, blocked: true },
    ]);
    const aiming = { interactable: null, placement: { ok: true, reason: null }, homes: carrying };
    expect(promptLines('anar', aiming)).toEqual([]);
    expect(promptLines('phuljhari', { interactable: null, homes: carrying })).toEqual([]);
    expect(promptLines('anar', { interactable: diya, homes: carrying })).toEqual([
      { text: 'E: Light diya', blocked: false },
    ]);
  });
});

// ── routing ──────────────────────────────────────────────────────────────

/** A cracker selection with nothing lit in hand, enough for the hands to arbitrate. */
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
    'transitionStarted',
    'transitionRejected',
    'aartiJoined',
    'aartiLeft',
    'aartiRejected',
    'itemPickedUp',
    'itemReturned',
    'itemRejected',
    'crackerBlocked',
    'sweetsEaten',
    'sweetsOffered',
  ];
  for (const name of names) bus.on(name, (payload) => log.push({ name, payload } as Logged));
  return log;
}

const OK = { ok: true } as const;

/** Records the gift and household calls; the real modules arrive with #61 and #66. */
class FakeGifts {
  readonly calls: string[] = [];
  pickUp(box: GiftBoxId): CommandResult<GiftRejection> {
    this.calls.push(`pickUp:${box}`);
    return OK;
  }
  putBack(box: GiftBoxId): CommandResult<GiftRejection> {
    this.calls.push(`putBack:${box}`);
    return OK;
  }
  exchange(): CommandResult<GiftRejection> {
    this.calls.push('exchange');
    return OK;
  }
  placeOnTable(): CommandResult<GiftRejection> {
    this.calls.push('placeOnTable');
    return OK;
  }
}

function homes() {
  const bus = createGameEventBus();
  const log = record(bus);
  const crackers = new StubCrackers();
  const hands = new HeldItems({ bus, crackers });
  const locations = new Locations({ bus, hands });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: () => 30 });
  const gifts = new FakeGifts();
  const reactions: [HouseholdMemberId, ReactionCause][] = [];
  const household = {
    react(id: HouseholdMemberId, cause: ReactionCause) {
      reactions.push([id, cause]);
      return null;
    },
  };
  const hud = new HudModel({ bus });
  const ctx: HomeActionContext = { locations, ceremony, hands, gifts, household };
  const names = () => log.map((e) => e.name);
  return { bus, log, names, crackers, hands, locations, ceremony, gifts, reactions, hud, ctx };
}

const E = { type: 'interact' } as const;
const CLICK = { type: 'place' } as const;
const at = (target: HomeInteractable): Interactable => target;
const DOOR_IN = at({ kind: 'door', id: 'familyHome.enter', position: FAMILY_DOOR.street.door });
const DOOR_OUT = at({ kind: 'door', id: 'familyHome.exit', position: FAMILY_DOOR.interior.door });
const PUJA = at({ kind: 'puja', id: 'familyHome', position: FAMILY.puja! });
const TRAY = at({ kind: 'tray', id: 'familyHome', position: FAMILY.tray! });
const FAMILY_SPOT = at({
  kind: 'returnSpot',
  id: 'giftBox@familyHome',
  item: 'giftBox',
  home: 'familyHome',
  position: FAMILY.giftSpot!,
});
const person = (id: HouseholdMemberId) => at({ kind: 'person', id, position: v(0, 0, 0) });

describe('home action routing', () => {
  it('leaves crackers, diyas, nothing and other actions to the cracker controls', () => {
    const { ctx, names } = homes();
    expect(applyHomeAction(E, { kind: 'cracker', id: 'c1', position: v(0, 0, 0) }, ctx)).toBe(false);
    expect(applyHomeAction(E, { kind: 'diya', id: 'd1', position: v(0, 0, 0) }, ctx)).toBe(false);
    expect(applyHomeAction(E, null, ctx)).toBe(false);
    expect(applyHomeAction(CLICK, null, ctx)).toBe(false);
    expect(applyHomeAction(CLICK, DOOR_IN, ctx)).toBe(false);
    expect(applyHomeAction({ type: 'select', slot: 2 }, PUJA, ctx)).toBe(false);
    expect(names()).toEqual([]);
  });

  it('opens a door with E, through the fade', () => {
    const { ctx, locations, names } = homes();
    expect(applyHomeAction(E, DOOR_IN, ctx)).toBe(true);
    expect(names()).toEqual(['transitionStarted']);
    locations.update(1);
    expect(locations.location).toBe('familyHome');
  });

  it('refuses the exit door with the plate in hand, and the HUD says why', () => {
    const { bus, ctx, hands, locations, hud } = homes();
    applyHomeAction(E, DOOR_IN, ctx);
    locations.update(1);
    bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
    applyHomeAction(CLICK, TRAY, ctx);
    expect(hands.hands).toEqual(PLATE);
    expect(applyHomeAction(E, DOOR_OUT, ctx)).toBe(true);
    expect(locations.location).toBe('familyHome');
    expect(hud.rejection?.text).toBe(TRANSITION_REJECTION_TEXT.carryingPlate);
  });

  it('joins aarti at the puja, then E leaves and click stays with the thali', () => {
    const { ctx, ceremony, hands, names } = homes();
    expect(applyHomeAction(E, PUJA, ctx)).toBe(true);
    expect(ceremony.snapshot).toMatchObject({ state: 'running', participating: true });
    expect(hands.hands).toEqual(THALI);
    // Taking part, click never reaches the crackers, so no blocked-cracker message.
    expect(applyHomeAction(CLICK, null, ctx)).toBe(true);
    expect(names()).not.toContain('crackerBlocked');
    // E leaves whatever is nearest.
    expect(applyHomeAction(E, DOOR_OUT, ctx)).toBe(true);
    expect(ceremony.snapshot).toMatchObject({ state: 'running', participating: false });
    expect(hands.hands).toBeNull();
    expect(names()).toEqual(['itemPickedUp', 'aartiJoined', 'itemReturned', 'aartiLeft']);
    expect(applyHomeAction(E, PUJA, ctx)).toBe(true);
    expect(ceremony.snapshot.participating).toBe(true);
  });

  it('refuses to join with a gift box in hand and shows the item-specific prompt', () => {
    const { ctx, hands, ceremony, hud } = homes();
    hands.take(OUTBOUND);
    applyHomeAction(E, PUJA, ctx);
    expect(ceremony.snapshot.participating).toBe(false);
    expect(hud.rejection?.text).toBe(CRACKER_BLOCKED_TEXT.carryingGift);
  });

  it('eats, takes a plate and returns it at the tray once aarti is done', () => {
    const { bus, ctx, hands, hud, log } = homes();
    applyHomeAction(E, TRAY, ctx);
    expect(log.at(-1)).toEqual({ name: 'itemRejected', payload: { action: 'eat', reason: 'trayNotServed' } });
    expect(hud.rejection?.text).toBe(ITEM_REJECTION_TEXT.trayNotServed);

    bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
    applyHomeAction(E, TRAY, ctx);
    applyHomeAction(E, TRAY, ctx);
    expect(log.filter((e) => e.name === 'sweetsEaten')).toHaveLength(2);

    expect(applyHomeAction(CLICK, TRAY, ctx)).toBe(true);
    expect(hands.hands).toEqual(PLATE);
    // With the plate in hand, click goes on to the crackers' hands check.
    expect(applyHomeAction(CLICK, TRAY, ctx)).toBe(false);
    applyHomeAction(E, TRAY, ctx);
    expect(hands.hands).toBeNull();
  });

  it('offers the plate to a family member, unlimited', () => {
    const { bus, ctx, log } = homes();
    bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
    applyHomeAction(CLICK, TRAY, ctx);
    for (let i = 0; i < 3; i++) applyHomeAction(E, person('grandmother'), ctx);
    expect(log.filter((e) => e.name === 'sweetsOffered').map((e) => e.payload)).toEqual([
      { member: 'grandmother' },
      { member: 'grandmother' },
      { member: 'grandmother' },
    ]);
  });

  it('sets the return box on the sweets table', () => {
    const { ctx, hands, gifts } = homes();
    hands.take(RETURN_BOX);
    applyHomeAction(E, TRAY, ctx);
    expect(gifts.calls).toEqual(['placeOnTable']);
  });

  it('picks up and puts back the gift box at its spot', () => {
    const { ctx, hands, gifts } = homes();
    applyHomeAction(E, FAMILY_SPOT, ctx);
    hands.take(OUTBOUND);
    applyHomeAction(E, FAMILY_SPOT, ctx);
    expect(gifts.calls).toEqual(['pickUp:outbound', 'putBack:outbound']);
  });

  it('puts a box back through the hands while there is no gift module, refusing the wrong spot', () => {
    const { ctx, hands, log } = homes();
    const handsOnly: HomeActionContext = { ...ctx, gifts: undefined };
    hands.take(RETURN_BOX);
    applyHomeAction(E, FAMILY_SPOT, handsOnly);
    expect(log.at(-1)).toEqual({ name: 'itemRejected', payload: { action: 'returnItem', reason: 'wrongReturnSpot' } });
    hands.release('giftBox');
    hands.take(OUTBOUND);
    applyHomeAction(E, FAMILY_SPOT, handsOnly);
    expect(hands.hands).toBeNull();
  });

  it('gives the gift box to the neighbours, or greets them', () => {
    const { ctx, hands, gifts, reactions } = homes();
    applyHomeAction(E, person('aunty'), ctx);
    hands.take(OUTBOUND);
    applyHomeAction(E, person('uncle'), ctx);
    expect(reactions).toEqual([['aunty', 'welcome']]);
    expect(gifts.calls).toEqual(['exchange']);
  });

  it('takes E at a door ahead of the held phuljhari', () => {
    const { ctx, crackers } = homes();
    crackers.selected = 'phuljhari';
    crackers.held = { id: 'held', type: 'phuljhari', lit: false };
    expect(applyHomeAction(E, DOOR_IN, ctx)).toBe(true);
    expect(crackers.held.lit).toBe(false);
  });
});

describe('HUD rejection feedback for the homes', () => {
  it('words held-item, cracker-hands, transition and aarti refusals', () => {
    const { bus, hud } = homes();
    bus.emit('crackerBlocked', { action: 'place', reason: 'carryingPlate' });
    expect(hud.rejection?.text).toBe(CRACKER_BLOCKED_TEXT.carryingPlate);
    bus.emit('transitionRejected', { doorway: 'familyHome.exit', reason: 'carryingPlate' });
    expect(hud.rejection?.text).toBe(TRANSITION_REJECTION_TEXT.carryingPlate);
    bus.emit('itemRejected', { action: 'eat', reason: 'trayNotServed' });
    expect(hud.rejection?.text).toBe(ITEM_REJECTION_TEXT.trayNotServed);
    bus.emit('aartiRejected', { reason: 'ceremonyCompleted' });
    expect(hud.rejection?.text).toBe('Aarti is done for this evening');
    // `handsFull` keeps the held-items message, which names the item.
    bus.emit('aartiRejected', { reason: 'handsFull' });
    expect(hud.rejection?.text).toBe('Aarti is done for this evening');
  });
});

describe('a walk through the homes', () => {
  it('enters, joins and leaves aarti, and exits again', () => {
    const { ctx, locations, ceremony } = homes();
    const s = {
      feet: from(FAMILY_DOOR.street.door, EAST, 1),
      hands: () => ctx.hands?.hands ?? null,
    };
    const interaction = new Interaction({
      world: flatWorld(),
      playerPosition: () => s.feet,
      location: () => locations.location,
      doorways: () => DOORWAYS,
      hands: s.hands,
      aarti: () => ceremony.snapshot,
    });
    const press = (forward: Vec3) => {
      const target = interaction.findInteractable(view(s.feet, forward));
      expect(applyHomeAction(E, target, ctx)).toBe(true);
      for (let i = 0; i < 60; i++) {
        locations.update(STEP);
        ceremony.update(STEP);
      }
    };

    press(WEST);
    expect(locations.location).toBe('familyHome');
    s.feet = from(FAMILY.puja!, SOUTH, 1);
    press(NORTH);
    expect(ceremony.snapshot.participating).toBe(true);
    press(SOUTH);
    expect(ceremony.snapshot.participating).toBe(false);
    s.feet = from(FAMILY_DOOR.interior.door, NORTH, 1);
    press(SOUTH);
    expect(locations.location).toBe('outdoors');
    // Ceremony time kept running throughout.
    expect(ceremony.snapshot.elapsed).toBeGreaterThan(2);
  });
});
