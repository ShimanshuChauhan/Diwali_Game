import { describe, expect, it } from 'vitest';
import { AartiCeremony } from '../src/aarti';
import type { HeldItem } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { FAMILY_MEMBERS, type DialogueLine, type FamilyMemberId, type HouseholdActivity } from '../src/core/homes';
import { TUNING } from '../src/core/tuning';
import type { Aabb, CrackerType, Vec3 } from '../src/core/types';
import { doorwayId, HeldItems, type HandCrackers, homesResetHooks, Locations, registerHomesReset } from '../src/homes';
import { FAMILY_DIALOGUE, Household, HOUSEHOLD_BEHAVIOUR, subtitlesFor } from '../src/household';
import { createFamilyHomeLayout } from '../src/interior';
import { Session } from '../src/session/session';

const STEP = 1 / 60;
const SONG_LENGTH = 6;
const layout = createFamilyHomeLayout();
const { inviteInterval, dialogueDuration, reactionCooldown, fadeDuration } = TUNING.homes;
const { entryDelay } = HOUSEHOLD_BEHAVIOUR;

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

/** The household with the real ceremony, hands and doors it follows. */
function setup() {
  const bus = createGameEventBus();
  const hands = new HeldItems({ bus, crackers: new StubCrackers() });
  const locations = new Locations({ bus, hands });
  const ceremony = new AartiCeremony({ bus, hands, durationOf: () => SONG_LENGTH, location: () => locations.location });
  const household = new Household({ bus, layout });
  const spoken: DialogueLine[] = [];
  bus.on('householdReacted', ({ line }) => spoken.push(line));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      locations.update(STEP);
      ceremony.update(STEP);
      household.update(STEP);
    }
  };
  const go = (side: 'enter' | 'exit') => {
    expect(locations.requestTransition(doorwayId('familyHome', side)).ok).toBe(true);
    run(fadeDuration + STEP);
  };
  const activities = () =>
    Object.fromEntries(household.views().map((v) => [v.id, v.activity])) as Record<FamilyMemberId, HouseholdActivity>;
  const at = (id: FamilyMemberId) => household.get(id)!.placement;
  return { bus, hands, locations, ceremony, household, spoken, run, go, activities, at };
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('household — identities', () => {
  it('is mother, father, one sibling and two grandparents, all at home', () => {
    const { household } = setup();
    expect(household.members().map((m) => m.id)).toEqual([...FAMILY_MEMBERS]);
    expect(household.members().every((m) => m.home === 'familyHome')).toBe(true);
  });

  it('keeps the same member objects for the whole session, so identities are stable', () => {
    const { household, go, ceremony, run } = setup();
    const before = household.views();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 1);
    expect(household.views()).toBe(before);
    expect(household.views().map((v) => v.id)).toEqual([...FAMILY_MEMBERS]);
  });
});

describe('household — gathered, with a gentle invitation', () => {
  it('starts gathered at the puja corner, each in their place facing the shrine', () => {
    const { household, activities, at } = setup();
    expect(household.state).toBe('gathered');
    for (const id of FAMILY_MEMBERS) {
      expect(activities()[id]).toBe('gathered');
      expect(at(id)).toEqual(layout.gathering[id]);
    }
  });

  it('says nothing while the player is outside, however long they stay out', () => {
    const { spoken, run } = setup();
    run(inviteInterval * 3);
    expect(spoken).toEqual([]);
  });

  it('calls the player over shortly after they come in, then only every invite interval', () => {
    const { spoken, run, go } = setup();
    go('enter');
    // The family notices from the fade's midpoint, when the player is inside.
    run(entryDelay - fadeDuration - 0.1);
    expect(spoken).toHaveLength(0);
    run(0.6);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.member).toBe('mother');
    run(inviteInterval - 1);
    expect(spoken).toHaveLength(1);
    run(1.2);
    expect(spoken).toHaveLength(2);
    // A different member each time, so the call does not nag in one voice.
    expect(spoken[1]!.member).not.toBe(spoken[0]!.member);
  });

  it('never counts down: invitations keep the same gap and the ceremony keeps waiting', () => {
    const { spoken, run, go, ceremony } = setup();
    go('enter');
    run(entryDelay + inviteInterval * 6 + 1);
    expect(spoken).toHaveLength(7);
    expect(ceremony.snapshot.state).toBe('waiting');
    expect(ceremony.snapshot.elapsed).toBe(0);
    for (const line of spoken) expect(line.text).not.toMatch(/\d/);
  });

  it('shows each invitation for a bounded time, one line at a time', () => {
    const { household, run, go } = setup();
    go('enter');
    run(entryDelay + 0.1);
    const speaking = () => household.views().filter((v) => v.line !== null);
    expect(speaking()).toHaveLength(1);
    expect(speaking()[0]!.line!.duration).toBe(dialogueDuration);
    run(dialogueDuration);
    expect(speaking()).toHaveLength(0);
  });

  it('starts calling again on each return, not while the player is away', () => {
    const { spoken, run, go } = setup();
    go('enter');
    run(entryDelay + 0.1);
    go('exit');
    run(inviteInterval * 2);
    expect(spoken).toHaveLength(1);
    go('enter');
    run(entryDelay + 0.1);
    expect(spoken).toHaveLength(2);
  });

  it('stops inviting once aarti starts', () => {
    const { spoken, run, go, ceremony } = setup();
    go('enter');
    run(entryDelay + 0.1);
    expect(ceremony.join().ok).toBe(true);
    expect(ceremony.leave().ok).toBe(true);
    run(SONG_LENGTH - 1);
    expect(spoken).toHaveLength(1);
  });

  it('offers only Hinglish lines without countdowns or hurry', () => {
    for (const id of FAMILY_MEMBERS) {
      const lines = FAMILY_DIALOGUE.invite?.[id] ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.text).not.toMatch(/\d|jaldi|hurry|abhi ke abhi/i);
    }
  });
});

describe('household — during aarti', () => {
  it('prays, claps and rings the bell once the player joins, and nobody sings', () => {
    const { household, run, go, ceremony, activities } = setup();
    go('enter');
    expect(ceremony.join().ok).toBe(true);
    run(STEP);
    expect(household.state).toBe('aarti');
    const now = Object.values(activities());
    expect(now).toContain('praying');
    expect(now).toContain('clapping');
    expect(now.filter((a) => a === 'ringingBell')).toHaveLength(1);
    expect(now.every((a) => ['praying', 'clapping', 'ringingBell'].includes(a))).toBe(true);
  });

  it('stays put at the puja corner through the ceremony', () => {
    const { run, go, ceremony, at } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH - 1);
    for (const id of FAMILY_MEMBERS) expect(flat(at(id).position, layout.gathering[id].position)).toBe(0);
  });

  it('carries on with aarti when the player leaves it, and when they step outside', () => {
    const { household, run, go, ceremony, activities } = setup();
    go('enter');
    ceremony.join();
    run(1);
    ceremony.leave();
    go('exit');
    run(1);
    expect(household.state).toBe('aarti');
    expect(Object.values(activities())).toContain('ringingBell');
  });

  it('moves Mummy between clapping and folded hands as the ceremony goes on', () => {
    const bus = createGameEventBus();
    const household = new Household({ bus, layout, location: 'familyHome' });
    bus.emit('aartiJoined', { song: 'omJaiJagdishHare', elapsed: 0, playbackId: 1 });
    const seen = new Set<HouseholdActivity>();
    for (let i = 0; i < (HOUSEHOLD_BEHAVIOUR.aartiSwap * 3) / STEP; i++) {
      household.update(STEP);
      seen.add(household.get('mother')!.activity);
    }
    expect([...seen].sort()).toEqual(['clapping', 'praying']);
  });
});

describe('household — after aarti', () => {
  it('walks everyone to their seat while the player watches, serving the tray on the way', () => {
    const { household, run, go, ceremony, activities, at } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + STEP);
    expect(ceremony.snapshot.state).toBe('completed');
    expect(household.state).toBe('settling');

    let served = false;
    let walked = false;
    for (let t = 0; t < 60 && household.state !== 'seated'; t += STEP) {
      run(STEP);
      served ||= activities().mother === 'serving';
      walked ||= household.views().some((v) => v.walking);
    }
    expect(walked).toBe(true);
    expect(served).toBe(true);
    expect(household.state).toBe('seated');
    for (const id of FAMILY_MEMBERS) {
      expect(activities()[id]).toBe('seated');
      expect(at(id)).toEqual(layout.seats[id]);
    }
  });

  it('serves from the serving spot beside the sweets table, and welcomes the player to it', () => {
    const { household, run, go, ceremony, spoken } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + STEP);
    spoken.length = 0;
    while (household.get('mother')!.activity !== 'serving') run(STEP);
    const mother = household.get('mother')!;
    expect(flat(mother.placement.position, layout.serving.position)).toBeLessThan(1e-6);
    expect(mother.placement.yaw).toBeCloseTo(layout.serving.yaw);
    expect(spoken.map((l) => l.member)).toContain('mother');
  });

  it('seats the family even when aarti completes while the player is away (completion while absent)', () => {
    const { bus, household, run, go, ceremony, activities, at, locations } = setup();
    go('enter');
    ceremony.join();
    run(1);
    ceremony.leave();
    go('exit');
    expect(locations.location).toBe('outdoors');
    run(SONG_LENGTH);
    expect(ceremony.snapshot.state).toBe('completed');
    // Logical state only: nobody saw the walk, so it is already done.
    expect(household.state).toBe('seated');
    for (const id of FAMILY_MEMBERS) {
      expect(activities()[id]).toBe('seated');
      expect(at(id)).toEqual(layout.seats[id]);
    }
    // Coming back in finds them seated, and someone says hello.
    const spoken: string[] = [];
    bus.on('householdReacted', ({ line }) => spoken.push(line.member));
    go('enter');
    expect(Object.values(activities()).every((a) => a === 'seated')).toBe(true);
    run(entryDelay + 0.1);
    expect(spoken).toHaveLength(1);
  });

  it('finishes the walk at once if the player steps out halfway through it', () => {
    const { household, run, go, ceremony, activities } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 1);
    expect(household.state).toBe('settling');
    go('exit');
    expect(household.state).toBe('seated');
    expect(Object.values(activities()).every((a) => a === 'seated')).toBe(true);
  });

  it('takes turns talking while seated, and stays seated for the rest of the session', () => {
    const { household, run, go, ceremony } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 40);
    expect(household.state).toBe('seated');
    const talkers = new Set<string>();
    for (let t = 0; t < HOUSEHOLD_BEHAVIOUR.chatTurn * 6; t += STEP) {
      run(STEP);
      for (const v of household.views()) if (v.talking && !v.line) talkers.add(v.id);
      expect(household.views().filter((v) => v.talking && !v.line).length).toBeLessThanOrEqual(1);
      expect(household.views().every((v) => v.activity === 'seated')).toBe(true);
    }
    expect(talkers.size).toBe(FAMILY_MEMBERS.length);
  });

  it('settles only once however often completion is reported', () => {
    const { bus, household, run, go, ceremony } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 40);
    expect(household.state).toBe('seated');
    bus.emit('aartiCompleted', { song: 'omJaiJagdishHare', participating: false });
    expect(household.state).toBe('seated');
    expect(household.views().every((v) => v.activity === 'seated')).toBe(true);
  });

  it('keeps each walk to open floor, off every piece of furniture but the seat itself', () => {
    const furniture = layout.solids.filter((s) => s.kind === 'furniture');
    const inBox = (p: Vec3, b: Aabb, pad: number) =>
      p.x > b.min.x - pad && p.x < b.max.x + pad && p.z > b.min.z - pad && p.z < b.max.z + pad;
    for (const id of FAMILY_MEMBERS) {
      const seat = layout.seats[id].position;
      const points = [layout.gathering[id].position, ...layout.routes[id]];
      // Every leg but the last step onto the seat.
      for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i]!, points[i + 1]!];
        for (let k = 0; k <= 40; k++) {
          const p = { x: a.x + ((b.x - a.x) * k) / 40, y: 0, z: a.z + ((b.z - a.z) * k) / 40 };
          for (const solid of furniture) expect(inBox(p, solid.box, 0.2), `${id} leg ${i} crosses ${solid.id}`).toBe(false);
        }
      }
      expect(flat(points.at(-1)!, seat)).toBeLessThan(1.5);
    }
    expect(layout.routes.mother.some((p) => flat(p, layout.serving.position) < 1e-6)).toBe(true);
  });
});

describe('household — reactions', () => {
  it('gives one line per member at a time and waits out the cooldown', () => {
    const { household, run } = setup();
    const first = household.react('father', 'invite');
    expect(first).not.toBeNull();
    expect(household.react('father', 'invite')).toBeNull();
    run(dialogueDuration + 0.1);
    expect(household.get('father')!.line).toBeNull();
    if (reactionCooldown > dialogueDuration + 0.1) expect(household.react('father', 'invite')).toBeNull();
    run(Math.max(reactionCooldown, dialogueDuration));
    const second = household.react('father', 'invite');
    expect(second).not.toBeNull();
    // Variations rotate rather than repeat.
    expect(second!.text).not.toBe(first!.text);
  });

  it('lets different members speak at once without queueing anyone', () => {
    const { household } = setup();
    expect(household.react('mother', 'invite')).not.toBeNull();
    expect(household.react('grandfather', 'invite')).not.toBeNull();
    expect(household.views().filter((v) => v.line).length).toBe(2);
  });

  it('stays quiet for a cause it has no lines for, and for people not in the family', () => {
    const { household, spoken } = setup();
    expect(household.react('mother', 'giftExchanged')).toBeNull();
    expect(household.react('uncle', 'welcome')).toBeNull();
    expect(spoken).toEqual([]);
  });

  it('gives every member their own distinct lines', () => {
    for (const cause of ['invite', 'welcome'] as const) {
      const texts = FAMILY_MEMBERS.flatMap((id) => (FAMILY_DIALOGUE[cause]?.[id] ?? []).map((l) => l.text));
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('captions the lines spoken where the player is, with the speaker named', () => {
    const { household, run, go } = setup();
    go('enter');
    run(entryDelay + 0.1);
    const lines = subtitlesFor(household.members(), 'familyHome');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.speaker).toBe('Mummy');
    expect(subtitlesFor(household.members(), 'outdoors')).toEqual([]);
  });
});

describe('household — time and reset', () => {
  it('freezes with the paused simulation: no steps, no change', () => {
    const { household, run, go, ceremony } = setup();
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 1);
    const before = household.views().map((v) => ({ ...v.placement.position, activityTime: v.activityTime }));
    household.update(0);
    household.update(Number.NaN);
    expect(household.views().map((v) => ({ ...v.placement.position, activityTime: v.activityTime }))).toEqual(before);
  });

  it('gathers everyone again, quiet, on a fresh session', () => {
    const { bus, hands, locations, ceremony, household, run, go, activities, at } = setup();
    const session = new Session({ bus });
    registerHomesReset(session, homesResetHooks({ heldItems: hands, locations, aartiCeremony: ceremony, household }));
    go('enter');
    ceremony.join();
    run(SONG_LENGTH + 40);
    household.react('sibling', 'welcome');
    expect(household.state).toBe('seated');

    session.reset();
    expect(household.state).toBe('gathered');
    for (const id of FAMILY_MEMBERS) {
      expect(activities()[id]).toBe('gathered');
      expect(at(id)).toEqual(layout.gathering[id]);
      expect(household.get(id)!.line).toBeNull();
    }
    // Back outdoors: no invitation until the player comes in again.
    const spoken: string[] = [];
    bus.on('householdReacted', ({ line }) => spoken.push(line.member));
    run(inviteInterval * 2);
    expect(spoken).toEqual([]);
    go('enter');
    run(entryDelay + 0.1);
    expect(spoken).toEqual(['mother']);
  });
});
