import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { HeldItem, Interactable } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import {
  FAMILY_MEMBERS,
  type DialogueLine,
  type FamilyMemberId,
  type Gesture,
  type HomeInteractable,
  type ReactionCause,
} from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { CrackerType } from '../src/core/types';
import { doorwayId, HeldItems, ITEM_REJECTION_TEXT, Locations, TRANSITION_REJECTION_TEXT, type HandCrackers } from '../src/homes';
import { FAMILY_DIALOGUE, Household, subtitlesFor } from '../src/household';
import { applyHomeAction } from '../src/interaction';
import { createFamilyHomeLayout, InteriorAssets } from '../src/interior';
import { Session } from '../src/session/session';
import {
  BITE_TIME,
  biteScale,
  FAMILY_SWEETS_DIALOGUE,
  SWEETS_BEHAVIOUR,
  SWEETS_DIALOGUE,
  SweetsReactions,
  SweetsScene,
  sweetsVisibility,
  trayPieces,
} from '../src/sweets';
import { homePromptLines } from '../src/ui/homePrompts';
import { HudModel } from '../src/ui/hudModel';

const STEP = 1 / 60;
const SONG_LENGTH = 6;
const layout = createFamilyHomeLayout();
const { dialogueDuration, reactionCooldown, fadeDuration } = TUNING.homes;
const SWEETS_CAUSES = ['ateSweets', 'sweetsOffered'] as const satisfies readonly ReactionCause[];

const E = { type: 'interact' } as const;
const CLICK = { type: 'place' } as const;
const target = (kind: string) => layout.interactions.find((i) => i.target.kind === kind)!.target as HomeInteractable;
const TRAY = target('tray');
const EXIT = target('door');
const person = (id: FamilyMemberId): Interactable => ({ kind: 'person', id, position: layout.seats[id].position });

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

/** The sweets with the real ceremony, hands, doors and family they follow. */
function setup() {
  const bus = createGameEventBus();
  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const locations = new Locations({ bus, hands });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: () => SONG_LENGTH, location: () => locations.location });
  const household = new Household({ bus, layout, dialogue: FAMILY_SWEETS_DIALOGUE });
  const reactions = new SweetsReactions({ bus, household });
  const hud = new HudModel({ bus });
  const ctx = { locations, ceremony, hands, household };
  const spoken: DialogueLine[] = [];
  bus.on('householdReacted', ({ line }) => spoken.push(line));
  const step = () => {
    locations.update(STEP);
    ceremony.update(STEP);
    household.update(STEP);
    reactions.update(STEP);
    hud.update(STEP);
  };
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) step();
  };
  const go = (side: 'enter' | 'exit') => {
    expect(locations.requestTransition(doorwayId('familyHome', side)).ok).toBe(true);
    run(fadeDuration + STEP);
  };
  /** In, through aarti, and settled with the family until they have finished speaking. */
  const afterAarti = () => {
    go('enter');
    expect(ceremony.join().ok).toBe(true);
    run(SONG_LENGTH + 1);
    expect(ceremony.snapshot.state).toBe('completed');
    run(60);
    expect(household.state).toBe('seated');
    spoken.length = 0;
  };
  return { bus, hands, locations, ceremony, household, reactions, hud, ctx, spoken, step, run, go, afterAarti };
}

const linesOf = (cause: ReactionCause, member: FamilyMemberId) => SWEETS_DIALOGUE[cause]![member]!;
const textsOf = (cause: ReactionCause, member: FamilyMemberId) => linesOf(cause, member).map((l) => l.text);

describe('sweets — the tray follows aarti', () => {
  it('keeps the tray bare and refuses eating or a plate until aarti completes, saying why', () => {
    const s = setup();
    s.go('enter');
    expect(applyHomeAction(E, TRAY, s.ctx)).toBe(true);
    expect(s.hud.rejection?.text).toBe(ITEM_REJECTION_TEXT.trayNotServed);
    applyHomeAction(CLICK, TRAY, s.ctx);
    expect(s.hands.hands).toBeNull();
    expect(homePromptLines(TRAY, { hands: null, trayServed: s.hands.trayServed })).toEqual([
      { text: ITEM_REJECTION_TEXT.trayNotServed, blocked: true },
    ]);
    expect(sweetsVisibility({ served: s.hands.trayServed, carrying: false }).tray).toBe(false);
  });

  it('is not served while aarti runs or after the player leaves it part-way', () => {
    const s = setup();
    s.go('enter');
    s.ceremony.join();
    s.run(SONG_LENGTH / 2);
    expect(s.hands.eat()).toEqual({ ok: false, reason: 'trayNotServed' });
    s.ceremony.leave();
    expect(s.hands.eat()).toEqual({ ok: false, reason: 'trayNotServed' });
    expect(s.hands.pickUpPlate()).toEqual({ ok: false, reason: 'trayNotServed' });
  });

  it('is served once aarti completes, then offers eating and a plate', () => {
    const s = setup();
    s.afterAarti();
    expect(s.hands.trayServed).toBe(true);
    expect(sweetsVisibility({ served: true, carrying: false })).toEqual({
      tray: true,
      tablePlate: true,
      heldPlate: false,
      plateSweets: true,
    });
    expect(homePromptLines(TRAY, { hands: null, trayServed: true }).map((l) => l.text)).toEqual([
      'E: Eat sweets',
      'Click: Take a plate to share',
    ]);
  });

  it('serves the tray even when aarti completes with the player away', () => {
    const s = setup();
    s.go('enter');
    s.ceremony.join();
    s.ceremony.leave();
    s.go('exit');
    s.run(SONG_LENGTH + 1);
    expect(s.ceremony.snapshot.state).toBe('completed');
    expect(s.hands.trayServed).toBe(true);
  });
});

describe('sweets — unlimited eating and sharing', () => {
  it('eats from the tray as often as the player likes, with no supply to run out', () => {
    const s = setup();
    s.afterAarti();
    let eaten = 0;
    s.bus.on('sweetsEaten', () => eaten++);
    for (let i = 0; i < 500; i++) {
      expect(applyHomeAction(E, TRAY, s.ctx)).toBe(true);
      if (i % 10 === 0) s.step();
    }
    expect(eaten).toBe(500);
    expect(s.hud.rejection).toBeNull();
  });

  it('eats from the tray with the plate in hand too', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    expect(s.hands.hands).toEqual({ kind: 'sweetsPlate' });
    expect(s.hands.eat()).toEqual({ ok: true });
  });

  it('offers the plate to every family member, again and again, and keeps it in hand', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    const offered: FamilyMemberId[] = [];
    s.bus.on('sweetsOffered', ({ member }) => offered.push(member));
    for (let round = 0; round < 40; round++) {
      for (const id of FAMILY_MEMBERS) expect(applyHomeAction(E, person(id), s.ctx)).toBe(true);
      s.run(0.25);
    }
    expect(offered).toHaveLength(40 * FAMILY_MEMBERS.length);
    expect(s.hands.hands).toEqual({ kind: 'sweetsPlate' });
    expect(s.hud.rejection).toBeNull();
  });

  it('takes a fresh plate after putting it back, as often as wanted', () => {
    const s = setup();
    s.afterAarti();
    for (let i = 0; i < 20; i++) {
      applyHomeAction(CLICK, TRAY, s.ctx);
      expect(s.hands.hands).toEqual({ kind: 'sweetsPlate' });
      applyHomeAction(E, TRAY, s.ctx);
      expect(s.hands.hands).toBeNull();
    }
  });

  it('has nothing to offer without the plate', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(E, person('father'), s.ctx);
    expect(s.hud.rejection?.text).toBe(ITEM_REJECTION_TEXT.notHolding);
  });
});

describe('sweets — Hinglish reactions, distinct per member', () => {
  it('gives every family member a small set of lines for eating and for being offered sweets', () => {
    for (const cause of SWEETS_CAUSES) {
      for (const id of FAMILY_MEMBERS) {
        const lines = linesOf(cause, id);
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it('never shares a line between members, causes or variations', () => {
    const all = SWEETS_CAUSES.flatMap((cause) => FAMILY_MEMBERS.flatMap((id) => textsOf(cause, id)));
    expect(new Set(all).size).toBe(all.length);
    const invitesAndWelcomes = Object.values(FAMILY_DIALOGUE).flatMap((byMember) =>
      Object.values(byMember ?? {}).flatMap((lines) => lines!.map((l) => l.text)),
    );
    for (const text of all) expect(invitesAndWelcomes).not.toContain(text);
  });

  it('gives each member their own mix of gestures: affection, teasing and blessings', () => {
    const gestures = (id: FamilyMemberId) =>
      [...new Set(SWEETS_CAUSES.flatMap((cause) => linesOf(cause, id).map((l) => l.gesture)))].sort().join(',');
    const sets = FAMILY_MEMBERS.map(gestures);
    expect(new Set(sets).size).toBe(FAMILY_MEMBERS.length);
    const has = (id: FamilyMemberId, g: Gesture) => gestures(id).split(',').includes(g);
    expect(has('mother', 'cheekPinch')).toBe(true);
    expect(has('sibling', 'tease')).toBe(true);
    expect(has('grandmother', 'blessing')).toBe(true);
    expect(has('grandmother', 'hug')).toBe(true);
    expect(has('grandfather', 'blessing')).toBe(true);
  });

  it('speaks Hinglish: romanised Hindi, short enough to read at a glance', () => {
    const hindi = /\b(beta|bachche|hai|hain|ho|khao|kha|lo|le|mera|mere|mujhe|main|aur|ek|bas|toh|kya|na|se|ke|ki|ko|ka|mein|tha|mat|hoon)\b/i;
    for (const cause of SWEETS_CAUSES) {
      for (const id of FAMILY_MEMBERS) {
        for (const { text } of linesOf(cause, id)) {
          expect(text).toMatch(hindi);
          expect(text).toMatch(/^[\x20-\x7e]+$/);
          expect(text.length).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it('answers an offer from the member offered to, with one of their own lines and gestures', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    for (const id of FAMILY_MEMBERS) {
      applyHomeAction(E, person(id), s.ctx);
      const line = s.spoken.at(-1)!;
      expect(line.member).toBe(id);
      expect(linesOf('sweetsOffered', id)).toContainEqual({ text: line.text, gesture: line.gesture });
      expect(s.household.get(id)!.line).toEqual(line);
    }
    expect(subtitlesFor(s.household.members(), 'familyHome').map((l) => l.speaker)).toEqual([
      'Mummy',
      'Papa',
      'Chhotu',
      'Dadi',
      'Dadaji',
    ]);
  });

  it('rotates through a member’s variations rather than repeating one', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    const said: string[] = [];
    for (let i = 0; i < 3; i++) {
      applyHomeAction(E, person('grandmother'), s.ctx);
      said.push(s.spoken.at(-1)!.text);
      s.run(Math.max(reactionCooldown, dialogueDuration) + STEP);
    }
    expect(said).toEqual(textsOf('sweetsOffered', 'grandmother'));
  });

  it('has someone in the family remark on the player eating, in turn', () => {
    const s = setup();
    s.afterAarti();
    const speakers: FamilyMemberId[] = [];
    for (let i = 0; i < SWEETS_BEHAVIOUR.eatCommentOrder.length; i++) {
      s.hands.eat();
      const line = s.spoken.at(-1)!;
      speakers.push(line.member as FamilyMemberId);
      expect(textsOf('ateSweets', line.member as FamilyMemberId)).toContain(line.text);
      s.run(SWEETS_BEHAVIOUR.eatCommentGap + STEP);
    }
    expect(speakers).toEqual([...SWEETS_BEHAVIOUR.eatCommentOrder]);
  });
});

describe('sweets — reactions are bounded', () => {
  it('shows each line for the dialogue duration, never queued or overlapping per member', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    const seconds = 30;
    let upFrames = 0;
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      // Offering every frame: the plate is unlimited, the answers are not.
      applyHomeAction(E, person('mother'), s.ctx);
      s.step();
      if (s.household.get('mother')!.line) upFrames++;
    }
    const lines = s.spoken.filter((l) => l.member === 'mother');
    const gap = Math.max(reactionCooldown, dialogueDuration);
    expect(lines.length).toBeLessThanOrEqual(Math.ceil(seconds / gap));
    expect(lines.length).toBeGreaterThanOrEqual(Math.floor(seconds / gap) - 1);
    for (const line of lines) expect(line.duration).toBe(dialogueDuration);
    // On screen at most the lines' total duration: nothing waits in a queue to play later.
    expect(upFrames * STEP).toBeLessThanOrEqual(lines.length * dialogueDuration + STEP);
    // Once the offers stop, the last line clears and nothing follows.
    const said = s.spoken.length;
    s.run(dialogueDuration + STEP);
    expect(s.household.get('mother')!.line).toBeNull();
    s.run(30);
    expect(s.spoken.length).toBe(said);
  });

  it('paces remarks on eating, and never starts one over someone else speaking', () => {
    const s = setup();
    s.afterAarti();
    const overlaps: number[] = [];
    s.bus.on('householdReacted', ({ line }) => {
      if (!textsOf('ateSweets', line.member as FamilyMemberId).includes(line.text)) return;
      overlaps.push(s.household.members().filter((m) => m.line !== null).length);
    });
    const seconds = 60;
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      s.hands.eat();
      s.step();
    }
    expect(overlaps.length).toBeGreaterThan(1);
    expect(overlaps.length).toBeLessThanOrEqual(Math.ceil(seconds / SWEETS_BEHAVIOUR.eatCommentGap));
    expect(overlaps.every((speaking) => speaking === 1)).toBe(true);
  });

  it('holds an eating remark while a family member is answering an offer', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    applyHomeAction(E, person('father'), s.ctx);
    const said = s.spoken.length;
    s.hands.eat();
    expect(s.spoken.length).toBe(said);
    s.run(dialogueDuration + STEP);
    s.hands.eat();
    expect(s.spoken.length).toBe(said + 1);
  });

  it('starts the remarks afresh on reset', () => {
    const s = setup();
    s.afterAarti();
    s.hands.eat();
    expect(s.spoken.at(-1)!.member).toBe(SWEETS_BEHAVIOUR.eatCommentOrder[0]);
    s.run(Math.max(reactionCooldown, dialogueDuration) + STEP);
    s.reactions.reset();
    s.hands.eat();
    expect(s.spoken.at(-1)!.member).toBe(SWEETS_BEHAVIOUR.eatCommentOrder[0]);
  });

  it('resets with the session and stops listening once disposed', () => {
    const bus = createGameEventBus();
    const session = new Session({ bus });
    const household = new Household({ bus, layout, dialogue: FAMILY_SWEETS_DIALOGUE, location: 'familyHome' });
    const reactions = new SweetsReactions({ bus, household });
    session.register(reactions);
    const spoken: DialogueLine[] = [];
    bus.on('householdReacted', ({ line }) => spoken.push(line));
    bus.emit('sweetsEaten', {});
    expect(spoken).toHaveLength(1);
    session.reset();
    household.reset();
    bus.emit('sweetsEaten', {});
    expect(spoken).toHaveLength(2);
    reactions.dispose();
    household.reset();
    bus.emit('sweetsEaten', {});
    expect(spoken).toHaveLength(2);
  });
});

describe('sweets — the plate stays in the family home', () => {
  it('blocks the exit door while the plate is carried, with a clear prompt', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    expect(homePromptLines(EXIT, { hands: s.hands.hands, doorway: (id) => s.locations.doorway(id) })).toEqual([
      { text: TRANSITION_REJECTION_TEXT.carryingPlate, blocked: true },
    ]);
    expect(applyHomeAction(E, EXIT, s.ctx)).toBe(true);
    expect(s.hud.rejection?.text).toBe(TRANSITION_REJECTION_TEXT.carryingPlate);
    expect(TRANSITION_REJECTION_TEXT.carryingPlate).toMatch(/sweets table/);
    s.run(fadeDuration * 2);
    expect(s.locations.location).toBe('familyHome');
    expect(s.hands.hands).toEqual({ kind: 'sweetsPlate' });
  });

  it('lets the player leave once the plate is back on the sweets table', () => {
    const s = setup();
    s.afterAarti();
    applyHomeAction(CLICK, TRAY, s.ctx);
    applyHomeAction(E, TRAY, s.ctx);
    expect(s.hands.hands).toBeNull();
    applyHomeAction(E, EXIT, s.ctx);
    s.run(fadeDuration + STEP);
    expect(s.locations.location).toBe('outdoors');
  });
});

describe('sweets — presentation', () => {
  function scene() {
    const bus = createGameEventBus();
    const parent = new THREE.Group();
    const view = new SweetsScene({ layout, parent, assets: new InteriorAssets(), bus });
    const tray = () => parent.getObjectByName('sweets.tray.ladoo')!;
    const plate = () => parent.getObjectByName('sweets.plate')!;
    return { bus, parent, view, tray, plate };
  }

  it('shows one plate, on the table or in the hands, and sweets only once served', () => {
    expect(sweetsVisibility({ served: false, carrying: false })).toEqual({
      tray: false,
      tablePlate: true,
      heldPlate: false,
      plateSweets: false,
    });
    expect(sweetsVisibility({ served: true, carrying: true })).toEqual({
      tray: true,
      tablePlate: false,
      heldPlate: true,
      plateSweets: true,
    });
  });

  it('lays the tray’s ladoos and barfi on top of the brass tray', () => {
    const tray = layout.decor.find((d) => d.id === 'sweets.tray')!.box;
    const pieces = trayPieces(tray);
    expect(pieces).toHaveLength(9);
    expect(new Set(pieces.map((p) => p.kind))).toEqual(new Set(['ladoo', 'barfi']));
    for (const { position } of pieces) {
      expect(position.x).toBeGreaterThan(tray.min.x);
      expect(position.x).toBeLessThan(tray.max.x);
      expect(position.z).toBeGreaterThan(tray.min.z);
      expect(position.z).toBeLessThan(tray.max.z);
      expect(position.y).toBe(tray.max.y);
    }
  });

  it('draws the tray bare until served, and the plate on its spot until carried', () => {
    const s = scene();
    expect(s.tray().visible).toBe(false);
    expect(s.plate().visible).toBe(true);
    const spot = layout.decor.find((d) => d.id === 'sweets.plateSpot')!.box;
    expect(s.plate().position.x).toBeCloseTo((spot.min.x + spot.max.x) / 2);
    expect(s.plate().position.y).toBeCloseTo(spot.max.y);

    s.view.frame(STEP, { served: true, carrying: false });
    expect(s.tray().visible).toBe(true);

    const center = { x: 1, y: 1.2, z: -3 };
    s.view.frame(STEP, { served: true, carrying: true }, { center, yaw: 0.5 });
    expect(s.plate().position.toArray()).toEqual([1, 1.2, -3]);
    expect(s.plate().rotation.y).toBeCloseTo(0.5);

    s.view.frame(STEP, { served: true, carrying: false }, { center, yaw: 0.5 });
    expect(s.plate().position.x).toBeCloseTo((spot.min.x + spot.max.x) / 2);
  });

  it('takes a bite out of the tray that grows straight back', () => {
    expect(biteScale(0)).toBe(0);
    expect(biteScale(BITE_TIME / 2)).toBeCloseTo(0.5);
    expect(biteScale(BITE_TIME)).toBe(1);
    const s = scene();
    s.view.frame(STEP, { served: true, carrying: false });
    const mesh = s.tray() as THREE.InstancedMesh;
    const scaleOf = (i: number) => {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(i, m);
      return new THREE.Vector3().setFromMatrixScale(m).x;
    };
    expect(scaleOf(0)).toBeCloseTo(1);
    s.bus.emit('sweetsEaten', {});
    expect(scaleOf(0)).toBeLessThan(0.01);
    for (let t = 0; t < BITE_TIME + 0.1; t += STEP) s.view.frame(STEP, { served: true, carrying: false });
    expect(scaleOf(0)).toBeCloseTo(1);
  });

  it('costs a handful of draw calls and frees its geometry on dispose', () => {
    const s = scene();
    let meshes = 0;
    s.parent.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
    });
    expect(meshes).toBeLessThanOrEqual(8);
    s.view.dispose();
    expect(s.parent.children).toHaveLength(0);
  });
});
