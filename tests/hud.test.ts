import { describe, expect, it, vi } from 'vitest';
import type { Interactable } from '../src/core/contracts';
import { createGameEventBus } from '../src/core/events';
import { qualityProfile } from '../src/core/quality';
import { CRACKER_TYPES, type CameraMode, type QualityLevel } from '../src/core/types';
import { HudModel, promptLines, REJECTION_SECONDS, type HudContext } from '../src/ui/hudModel';
import { bindQualitySelect } from '../src/ui/pauseMenu';
import { IGNITION_REJECTION_TEXT, PLACEMENT_REJECTION_TEXT, rejectionText } from '../src/ui/text';

const DIYA: Interactable = { kind: 'diya', id: 'diya-1', position: { x: 0, y: 0, z: 0 } };
const ANAR: Interactable = { kind: 'cracker', id: 'c1', position: { x: 1, y: 0, z: 0 } };
const NOTHING: HudContext = { interactable: null };

function running(options: ConstructorParameters<typeof HudModel>[0] = {}) {
  const bus = createGameEventBus();
  const hud = new HudModel({ bus, ...options });
  bus.emit('sessionStarted', {});
  return { bus, hud };
}

function texts(hud: HudModel): string[] {
  return hud.prompts.map((line) => line.text);
}

describe('rejection text', () => {
  const entries = [
    ...Object.entries(PLACEMENT_REJECTION_TEXT).map(([reason, text]) => ['placement', reason, text] as const),
    ...Object.entries(IGNITION_REJECTION_TEXT).map(([reason, text]) => ['ignition', reason, text] as const),
  ];

  it.each(entries)('%s %s reads as a sentence', (_kind, reason, text) => {
    expect(text.length).toBeGreaterThan(8);
    expect(text.length).toBeLessThanOrEqual(64);
    expect(text[0]).toMatch(/[A-Z]/);
    // No identifier leaks into the message.
    expect(text).not.toContain(reason);
    expect(text).not.toMatch(/[a-z][A-Z]/);
  });

  it('covers every placement and ignition reason', () => {
    expect(Object.keys(PLACEMENT_REJECTION_TEXT).sort()).toEqual(
      [
        'blockedByGeometry',
        'capacity',
        'handheldOnly',
        'nearDoorway',
        'nearNeighbour',
        'noSkyClearance',
        'outOfReach',
        'unsupportedSurface',
      ].sort(),
    );
    expect(Object.keys(IGNITION_REJECTION_TEXT).sort()).toEqual(['alreadyLit', 'capacity', 'notFound', 'outOfReach']);
  });

  it('words shared reasons for placing or lighting', () => {
    expect(rejectionText('capacity', 'placement')).toBe(PLACEMENT_REJECTION_TEXT.capacity);
    expect(rejectionText('capacity', 'ignition')).toBe(IGNITION_REJECTION_TEXT.capacity);
    expect(rejectionText('outOfReach', 'ignition')).not.toBe(rejectionText('outOfReach', 'placement'));
    // Ignition-only reasons are found whatever kind is asked for.
    expect(rejectionText('alreadyLit')).toBe(IGNITION_REJECTION_TEXT.alreadyLit);
  });
});

describe('contextual prompts', () => {
  it('offers to light a nearby diya or placed cracker', () => {
    expect(promptLines('rocket', { interactable: DIYA })[0]).toEqual({ text: 'E: Light diya', blocked: false });
    expect(promptLines('rocket', { interactable: ANAR, interactableType: 'anar' })[0]?.text).toBe('E: Light anar');
    expect(promptLines('rocket', { interactable: ANAR })[0]?.text).toBe('E: Light cracker');
  });

  it('offers to place the selected ground cracker', () => {
    expect(promptLines('rocket', NOTHING)).toEqual([{ text: 'Click: Place rocket', blocked: false }]);
    expect(promptLines('chakri', { interactable: null, placement: { ok: true, reason: null } })).toEqual([
      { text: 'Click: Place chakri', blocked: false },
    ]);
  });

  it('shows both E and click actions together', () => {
    expect(promptLines('anar', { interactable: DIYA }).map((l) => l.text)).toEqual([
      'E: Light diya',
      'Click: Place anar',
    ]);
  });

  it('explains an invalid placement instead of the click prompt', () => {
    const lines = promptLines('rocket', { interactable: null, placement: { ok: false, reason: 'noSkyClearance' } });
    expect(lines).toEqual([{ text: PLACEMENT_REJECTION_TEXT.noSkyClearance, blocked: true }]);
  });

  it('shows only the E prompt when aiming at an unlit cracker that blocks placement', () => {
    const lines = promptLines('chakri', {
      interactable: ANAR,
      interactableType: 'anar',
      placement: { ok: false, reason: 'blockedByGeometry' },
    });
    expect(lines).toEqual([{ text: 'E: Light anar', blocked: false }]);
  });

  it('offers to light the held phuljhari until it is lit', () => {
    expect(promptLines('phuljhari', { interactable: null, held: { id: 'held', type: 'phuljhari', lit: false } })).toEqual([
      { text: 'E: Light phuljhari', blocked: false },
    ]);
    expect(promptLines('phuljhari', { interactable: null, held: { id: 'held', type: 'phuljhari', lit: true } })).toEqual([]);
    // A nearby target takes E, so the held prompt steps aside.
    expect(promptLines('phuljhari', { interactable: DIYA }).map((l) => l.text)).toEqual(['E: Light diya']);
  });

  it.each<CameraMode>(['firstPerson', 'thirdPerson'])('appear the same in %s', (mode) => {
    const { bus, hud } = running();
    bus.emit('cameraModeChanged', { mode });
    for (const type of CRACKER_TYPES) {
      bus.emit('crackerSelected', { type });
      for (const context of [NOTHING, { interactable: DIYA }, { interactable: ANAR, interactableType: 'anar' as const }]) {
        hud.setContext(context);
        expect(hud.prompts).toEqual(promptLines(type, context));
        expect(hud.prompts.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('HudModel', () => {
  it('starts hidden behind the start screen and shows once the session runs', () => {
    const bus = createGameEventBus();
    const hud = new HudModel({ bus });
    expect(hud.visible).toBe(false);
    expect(hud.crosshairVisible).toBe(false);
    bus.emit('sessionStarted', {});
    expect(hud.visible).toBe(true);
    expect(hud.crosshairVisible).toBe(true);
  });

  it('follows cracker selection on the hotbar', () => {
    const { bus, hud } = running();
    expect(hud.selected).toBe('phuljhari');
    bus.emit('crackerSelected', { type: 'rocket' });
    expect(hud.selected).toBe('rocket');
  });

  it('shows the crosshair in first-person only', () => {
    const { bus, hud } = running();
    bus.emit('cameraModeChanged', { mode: 'thirdPerson' });
    expect(hud.crosshairVisible).toBe(false);
    expect(hud.visible).toBe(true);
    bus.emit('cameraModeChanged', { mode: 'firstPerson' });
    expect(hud.crosshairVisible).toBe(true);
  });

  it('swaps the cracker hotbar for the aarti mini player while taking part', () => {
    const { bus, hud } = running();
    const aarti = {
      state: 'running',
      participating: true,
      song: 'omJaiJagdishHare',
      elapsed: 0,
      duration: 24,
      circling: false,
      playbackId: 1,
    } as const;
    expect(hud.hotbarVisible).toBe(true);
    const before = hud.revision;
    hud.setContext({ interactable: null, homes: { hands: { kind: 'thali' }, aarti } });
    expect(hud.hotbarVisible).toBe(false);
    expect(hud.revision).toBeGreaterThan(before);
    hud.setContext({ interactable: null, homes: { hands: null, aarti: { ...aarti, participating: false } } });
    expect(hud.hotbarVisible).toBe(true);
    hud.setContext({ interactable: null, homes: { hands: { kind: 'thali' }, aarti } });
    bus.emit('sessionReset', {});
    expect(hud.hotbarVisible).toBe(true);
  });

  it('hides while paused and returns on resume', () => {
    const { bus, hud } = running();
    bus.emit('paused', { reason: 'user' });
    expect(hud.visible).toBe(false);
    expect(hud.crosshairVisible).toBe(false);
    bus.emit('resumed', {});
    expect(hud.visible).toBe(true);
  });

  it('shows placement and ignition rejections with readable text, then fades them', () => {
    const { bus, hud } = running();
    bus.emit('placementRejected', { type: 'rocket', reason: 'capacity' });
    expect(hud.rejection?.text).toBe(PLACEMENT_REJECTION_TEXT.capacity);

    bus.emit('ignitionRejected', { id: 'c1', reason: 'capacity' });
    expect(hud.rejection?.text).toBe(IGNITION_REJECTION_TEXT.capacity);

    hud.update(REJECTION_SECONDS - 0.1);
    expect(hud.rejection).not.toBeNull();
    hud.update(0.2);
    expect(hud.rejection).toBeNull();
  });

  it('restarts the fade when a rejection repeats', () => {
    const { bus, hud } = running();
    bus.emit('placementRejected', { type: 'anar', reason: 'nearDoorway' });
    hud.update(REJECTION_SECONDS - 0.5);
    bus.emit('placementRejected', { type: 'anar', reason: 'nearDoorway' });
    hud.update(1);
    expect(hud.rejection?.text).toBe(PLACEMENT_REJECTION_TEXT.nearDoorway);
  });

  it('only bumps its revision when something visible changes', () => {
    const { bus, hud } = running();
    hud.setContext({ interactable: DIYA });
    const before = hud.revision;
    hud.setContext({ interactable: DIYA });
    hud.setContext({ interactable: { ...DIYA } });
    bus.emit('crackerSelected', { type: 'phuljhari' });
    expect(hud.revision).toBe(before);

    bus.emit('placementRejected', { type: 'anar', reason: 'outOfReach' });
    const shown = hud.revision;
    expect(shown).toBeGreaterThan(before);
    hud.update(0.1);
    expect(hud.revision).toBe(shown);
  });

  it('supports a fixed prompt through the UiModule contract', () => {
    const hud = new HudModel();
    hud.showPrompt('E: Light diya');
    expect(texts(hud)).toEqual(['E: Light diya']);
    hud.showPrompt(null);
    expect(hud.prompts).toEqual([]);
  });

  it('clears selection, prompt and message on a fresh session', () => {
    const { bus, hud } = running();
    bus.emit('crackerSelected', { type: 'chakri' });
    hud.setContext(NOTHING);
    bus.emit('placementRejected', { type: 'chakri', reason: 'nearNeighbour' });
    bus.emit('sessionReset', {});
    expect(hud.selected).toBe('phuljhari');
    expect(hud.prompts).toEqual([]);
    expect(hud.rejection).toBeNull();
  });

  it('stops listening once disposed', () => {
    const { bus, hud } = running();
    hud.dispose();
    bus.emit('crackerSelected', { type: 'rocket' });
    expect(hud.selected).toBe('phuljhari');
  });
});

describe('bindQualitySelect', () => {
  function setup(level: QualityLevel) {
    const select = Object.assign(new EventTarget(), { value: '' });
    const quality = {
      profile: qualityProfile(level),
      setLevel: vi.fn((next: QualityLevel) => {
        quality.profile = qualityProfile(next);
      }),
    };
    const unbind = bindQualitySelect(select, quality);
    return { select, quality, unbind };
  }

  it('shows the current level and applies a new one', () => {
    const { select, quality } = setup('medium');
    expect(select.value).toBe('medium');
    select.value = 'low';
    select.dispatchEvent(new Event('change'));
    expect(quality.setLevel).toHaveBeenCalledExactlyOnceWith('low');
    expect(quality.profile.level).toBe('low');
  });

  it('ignores unknown values and unchanged levels', () => {
    const { select, quality } = setup('high');
    select.value = 'ultra';
    select.dispatchEvent(new Event('change'));
    expect(select.value).toBe('high');
    select.value = 'high';
    select.dispatchEvent(new Event('change'));
    expect(quality.setLevel).not.toHaveBeenCalled();
  });

  it('unbinds', () => {
    const { select, quality, unbind } = setup('medium');
    unbind();
    select.value = 'low';
    select.dispatchEvent(new Event('change'));
    expect(quality.setLevel).not.toHaveBeenCalled();
  });
});
