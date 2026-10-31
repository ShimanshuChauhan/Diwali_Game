import { describe, expect, it, vi } from 'vitest';
import type { AudioSettings } from '../src/audio/controls';
import { createGameEventBus } from '../src/core/events';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import type { QualityLevel } from '../src/core/types';
import { controlsList } from '../src/ui/design/components';
import { createPauseMenu, RadioGroupSelect } from '../src/ui/pauseMenu';
import { CONTROLS_HELP, QUALITY_LABELS, RESTART_TEXT } from '../src/ui/text';
import { byClass, byTag, FakeDocument, FakeElement, findAll, keyEvent } from './fakeDom';

function audioSettings(): AudioSettings & { muted: boolean; masterGain: number } {
  return {
    muted: false,
    masterGain: 0.8,
    setMuted: vi.fn(function (this: { muted: boolean }, muted: boolean) {
      this.muted = muted;
    }),
    setMasterGain: vi.fn(function (this: { masterGain: number }, gain: number) {
      this.masterGain = gain;
    }),
  };
}

function setup(level: QualityLevel = 'medium') {
  const doc = new FakeDocument();
  const bus = createGameEventBus();
  const onResume = vi.fn();
  const onRestart = vi.fn();
  const audio = audioSettings();
  const quality = {
    profile: qualityProfile(level),
    setLevel: vi.fn((next: QualityLevel) => {
      quality.profile = qualityProfile(next);
    }),
  };
  const dispose = createPauseMenu({
    parent: doc.body as unknown as HTMLElement,
    bus,
    onResume,
    onRestart,
    audio,
    quality,
  });
  const overlay = byClass(doc.body, 'pause-menu')[0]!;
  const one = (name: string): FakeElement => {
    const [found] = byClass(overlay, name);
    if (!found) throw new Error(`no .${name}`);
    return found;
  };
  return { doc, bus, onResume, onRestart, audio, quality, dispose, overlay, one };
}

describe('pause menu: structure', () => {
  it('is a hidden modal dialog until the game pauses', () => {
    const { overlay, one } = setup();
    expect(overlay.hidden).toBe(true);
    expect(overlay.classList.contains('ds-scrim')).toBe(true);
    const panel = one('pause-menu__panel');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBe('Paused');
    expect(byTag(panel, 'h2')[0]!.textContent).toBe('Paused');
  });

  it('leads with Resume, then controls and settings, and ends with Restart', () => {
    const { one } = setup();
    const panel = one('pause-menu__panel');
    const parts = ['pause-menu__resume', 'pause-menu__controls', 'audio-controls', 'pause-menu__quality', 'pause-menu__restart'];
    const order = findAll(panel, (element) => parts.some((name) => element.classList.contains(name))).map((element) =>
      parts.find((name) => element.classList.contains(name)),
    );
    expect(order).toEqual(parts);
    expect(one('pause-menu__resume').classList.contains('ds-btn--primary')).toBe(true);
    expect(one('pause-menu__resume').dataset.action).toBe('resume');
    expect(one('pause-menu__restart').dataset.action).toBe('restart');
    for (const button of byTag(panel, 'button')) expect(button.type).toBe('button');
  });

  it('lists every CONTROLS_HELP entry as a key-cap row, in order', () => {
    const { one } = setup();
    const rows = byClass(one('pause-menu__controls'), 'ds-list-row');
    expect(rows.map((row) => byClass(row, 'ds-kbd')[0]!.textContent)).toEqual(CONTROLS_HELP.map(([key]) => key));
    expect(rows.map((row) => byTag(row, 'dd')[0]!.textContent)).toEqual(CONTROLS_HELP.map(([, action]) => action));
    expect(rows.map((row) => row.dataset.key)).toEqual(CONTROLS_HELP.map(([key]) => key));
  });

  it('renders a new row from data alone', () => {
    const doc = new FakeDocument();
    const list = controlsList(doc as unknown as Document, [...CONTROLS_HELP, ['Space', 'Jump']]) as unknown as FakeElement;
    const last = byClass(list, 'ds-list-row').at(-1)!;
    expect(last.dataset.key).toBe('Space');
    expect(byClass(last, 'ds-kbd')[0]!.textContent).toBe('Space');
    expect(byTag(last, 'dd')[0]!.textContent).toBe('Jump');
  });
});

describe('pause menu: showing and hiding', () => {
  it('shows on paused with Resume focused, and hides on resumed or a new session', () => {
    const { bus, doc, overlay, one } = setup();
    bus.emit('paused', { reason: 'user' });
    expect(overlay.hidden).toBe(false);
    expect(doc.activeElement).toBe(one('pause-menu__resume'));

    bus.emit('resumed', {});
    expect(overlay.hidden).toBe(true);
    bus.emit('paused', { reason: 'focusLost' });
    expect(overlay.hidden).toBe(false);
    bus.emit('sessionStarted', {});
    expect(overlay.hidden).toBe(true);
  });

  it('drops focus on close, so a later key cannot press a hidden button', () => {
    const { bus, doc, one } = setup();
    bus.emit('paused', { reason: 'user' });
    one('pause-menu__restart').focus();
    bus.emit('resumed', {});
    expect(doc.activeElement).toBe(doc.body);
  });

  it('Resume calls its handler; Restart only after the confirm', () => {
    const { bus, onResume, onRestart, one } = setup();
    bus.emit('paused', { reason: 'user' });
    one('pause-menu__resume').click();
    expect(onResume).toHaveBeenCalledOnce();
    one('pause-menu__restart').click();
    expect(onRestart).not.toHaveBeenCalled();
    one('pause-menu__confirm-restart').click();
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('dispose removes the menu and stops listening', () => {
    const { bus, doc, dispose, overlay, onResume, one } = setup();
    const resume = one('pause-menu__resume');
    dispose();
    expect(byClass(doc.body, 'pause-menu')).toHaveLength(0);
    bus.emit('paused', { reason: 'user' });
    expect(overlay.hidden).toBe(true);
    resume.click();
    expect(onResume).not.toHaveBeenCalled();
  });
});

describe('pause menu: restart confirm', () => {
  function asking() {
    const menu = setup();
    menu.bus.emit('paused', { reason: 'user' });
    menu.one('pause-menu__restart').click();
    return menu;
  }

  it('asks inline instead of restarting, with focus on Cancel', () => {
    const { doc, onRestart, one } = asking();
    expect(onRestart).not.toHaveBeenCalled();
    const confirm = one('pause-menu__confirm');
    expect(confirm.hidden).toBe(false);
    expect(confirm.getAttribute('role')).toBe('group');
    expect(one('pause-menu__footer').hidden).toBe(true);
    expect(byClass(confirm, 'ds-confirm__message')[0]!.textContent).toBe(RESTART_TEXT.confirm);
    expect(confirm.getAttribute('aria-labelledby')).toBe(byClass(confirm, 'ds-confirm__message')[0]!.id);

    const cancel = one('pause-menu__cancel');
    const restart = one('pause-menu__confirm-restart');
    expect(cancel.textContent).toBe('Cancel');
    expect(cancel.classList.contains('ds-btn--secondary')).toBe(true);
    expect(cancel.dataset.action).toBe('cancel-restart');
    expect(restart.textContent).toBe('Restart');
    expect(restart.classList.contains('ds-btn--danger')).toBe(true);
    expect(restart.dataset.action).toBe('confirm-restart');
    expect(doc.activeElement).toBe(cancel);
  });

  it('Cancel backs out and returns focus to Restart', () => {
    const { doc, onRestart, one } = asking();
    one('pause-menu__cancel').click();
    expect(onRestart).not.toHaveBeenCalled();
    expect(one('pause-menu__confirm').hidden).toBe(true);
    expect(one('pause-menu__footer').hidden).toBe(false);
    expect(doc.activeElement).toBe(one('pause-menu__restart'));
  });

  it('Escape backs out too, without reaching the game', () => {
    const { doc, onRestart, one } = asking();
    const game = vi.fn();
    doc.addEventListener('keydown', game);
    const escape = keyEvent('keydown', 'Escape');
    one('pause-menu__cancel').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(game).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(one('pause-menu__confirm').hidden).toBe(true);
    expect(doc.activeElement).toBe(one('pause-menu__restart'));
  });

  it('confirming restarts once and puts the footer back', () => {
    const { onRestart, one } = asking();
    one('pause-menu__confirm-restart').click();
    expect(onRestart).toHaveBeenCalledOnce();
    expect(one('pause-menu__confirm').hidden).toBe(true);
    expect(one('pause-menu__footer').hidden).toBe(false);
  });

  it('closing or resuming the menu resets the confirm', () => {
    const { bus, doc, one } = asking();
    bus.emit('resumed', {});
    expect(one('pause-menu__confirm').hidden).toBe(true);
    bus.emit('paused', { reason: 'user' });
    expect(one('pause-menu__footer').hidden).toBe(false);
    expect(doc.activeElement).toBe(one('pause-menu__resume'));

    one('pause-menu__restart').click();
    bus.emit('sessionStarted', {});
    expect(one('pause-menu__confirm').hidden).toBe(true);
    expect(one('pause-menu__footer').hidden).toBe(false);
  });

  it('wraps Tab between Resume and the confirm\'s Restart while asking', () => {
    const { doc, one } = asking();
    const resume = one('pause-menu__resume');
    const restart = one('pause-menu__confirm-restart');

    restart.focus();
    const forward = keyEvent('keydown', 'Tab');
    restart.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(resume);

    const back = keyEvent('keydown', 'Tab', { shiftKey: true });
    resume.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(restart);
  });

  it('Escape does nothing special when not asking', () => {
    const { bus, doc, one } = setup();
    bus.emit('paused', { reason: 'user' });
    const escape = keyEvent('keydown', 'Escape');
    one('pause-menu__resume').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(doc.activeElement).toBe(one('pause-menu__resume'));
  });
});

describe('pause menu: keyboard', () => {
  it('keeps keys pressed in the menu away from the game bindings', () => {
    const { bus, doc, one } = setup();
    const game = vi.fn();
    doc.addEventListener('keydown', game);
    doc.addEventListener('keyup', game);
    bus.emit('paused', { reason: 'user' });
    const resume = one('pause-menu__resume');
    resume.dispatchEvent(keyEvent('keydown', ' ', { code: 'Space' }));
    resume.dispatchEvent(keyEvent('keyup', ' ', { code: 'Space' }));
    resume.dispatchEvent(keyEvent('keydown', '1', { code: 'Digit1' }));
    expect(game).not.toHaveBeenCalled();

    // Outside the menu, keys reach the game as before.
    doc.body.dispatchEvent(keyEvent('keydown', 'w', { code: 'KeyW' }));
    expect(game).toHaveBeenCalledOnce();
  });

  it('wraps Tab between Resume and Restart', () => {
    const { bus, doc, one } = setup();
    bus.emit('paused', { reason: 'user' });
    const resume = one('pause-menu__resume');
    const restart = one('pause-menu__restart');

    restart.focus();
    const forward = keyEvent('keydown', 'Tab');
    restart.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(resume);

    const back = keyEvent('keydown', 'Tab', { shiftKey: true });
    resume.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(restart);

    // In the middle, the browser moves focus as usual.
    const mute = byClass(one('audio-controls'), 'ds-switch__input')[0]!;
    mute.focus();
    const middle = keyEvent('keydown', 'Tab');
    mute.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    expect(doc.activeElement).toBe(mute);
  });
});

describe('pause menu: settings', () => {
  it('sound: a mute switch and a volume slider bound to the audio settings', () => {
    const { audio, one } = setup();
    const sound = one('audio-controls');
    expect(byTag(sound, 'legend')[0]!.textContent).toBe('Sound');
    const mute = byClass(sound, 'ds-switch__input')[0]!;
    expect(mute.type).toBe('checkbox');
    expect(mute.getAttribute('role')).toBe('switch');
    expect(mute.checked).toBe(false);

    mute.checked = true;
    mute.dispatchEvent(new Event('change', { bubbles: true }));
    expect(audio.muted).toBe(true);

    const volume = byClass(sound, 'ds-slider')[0]!;
    expect(volume.type).toBe('range');
    expect(volume.value).toBe('80');
    expect(byClass(sound, 'ds-field__value')[0]!.textContent).toBe('80%');
    expect(volume.style.getPropertyValue('--ds-slider-fill')).toBe('80.0%');

    volume.value = '35';
    volume.dispatchEvent(new Event('input', { bubbles: true }));
    expect(audio.masterGain).toBeCloseTo(0.35);
    // Raising the volume while muted unmutes, as before.
    expect(audio.muted).toBe(false);
    expect(byClass(sound, 'ds-field__value')[0]!.textContent).toBe('35%');
    expect(volume.getAttribute('aria-valuetext')).toBe('35%');
  });

  it('quality: a segmented control showing the current level and applying a pick', () => {
    const { quality, one } = setup('medium');
    const section = one('pause-menu__quality');
    const group = byClass(section, 'ds-segmented')[0]!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radios = byClass(section, 'ds-segmented__input');
    expect(radios.map((radio) => radio.value)).toEqual([...QUALITY_LEVELS]);
    expect(byClass(section, 'ds-segmented__label').map((label) => label.textContent)).toEqual(
      QUALITY_LEVELS.map((level) => QUALITY_LABELS[level]),
    );
    expect(radios.map((radio) => radio.checked)).toEqual([false, true, false]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);

    for (const radio of radios) radio.checked = radio.value === 'high';
    radios[2]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(quality.setLevel).toHaveBeenCalledExactlyOnceWith('high');
    expect(quality.profile.level).toBe('high');
  });
});

describe('RadioGroupSelect', () => {
  function radios(values: readonly string[]) {
    return values.map((value) => Object.assign(new EventTarget(), { value, checked: false }));
  }

  it('reads and writes the checked radio and forwards change', () => {
    const inputs = radios(['low', 'medium', 'high']);
    const group = new RadioGroupSelect(inputs);
    expect(group.value).toBe('');
    group.value = 'low';
    expect(inputs.map((radio) => radio.checked)).toEqual([true, false, false]);

    const onChange = vi.fn();
    group.addEventListener('change', onChange);
    inputs[1]!.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledOnce();

    group.dispose();
    inputs[2]!.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledOnce();
  });
});
