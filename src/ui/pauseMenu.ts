import { createAudioControls, type AudioSettings } from '../audio/controls';
import type { QualityModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { QUALITY_LEVELS } from '../core/quality';
import type { QualityLevel } from '../core/types';
import { button, controlsList, divider, el, sectionHeading, segmented } from './design/components';
import { CONTROLS_HELP, QUALITY_LABELS } from './text';

export type QualitySettings = Pick<QualityModule, 'profile' | 'setLevel'>;

export interface QualitySelect extends EventTarget {
  value: string;
}

function isQualityLevel(value: string): value is QualityLevel {
  return (QUALITY_LEVELS as readonly string[]).includes(value);
}

/**
 * Keep a quality `<select>` (option values `low`/`medium`/`high`) and the
 * quality setting in step. Typed structurally so tests can pass a plain
 * `EventTarget`. Returns an unbind function.
 */
export function bindQualitySelect(select: QualitySelect, quality: QualitySettings): () => void {
  select.value = quality.profile.level;
  const onChange = (): void => {
    if (isQualityLevel(select.value)) {
      if (select.value !== quality.profile.level) quality.setLevel(select.value);
    } else {
      select.value = quality.profile.level;
    }
  };
  select.addEventListener('change', onChange);
  return () => select.removeEventListener('change', onChange);
}

/** Radio-like inputs: what a segmented control is made of. */
export interface RadioInput extends EventTarget {
  readonly value: string;
  checked: boolean;
}

/**
 * Present a group of radios as one `QualitySelect`: `value` is the checked
 * radio's value, and a pick fires `change` on the group. Lets the segmented
 * quality control reuse `bindQualitySelect`.
 */
export class RadioGroupSelect extends EventTarget implements QualitySelect {
  private readonly forward = (): void => {
    this.dispatchEvent(new Event('change'));
  };

  constructor(private readonly radios: readonly RadioInput[]) {
    super();
    for (const radio of radios) radio.addEventListener('change', this.forward);
  }

  get value(): string {
    return this.radios.find((radio) => radio.checked)?.value ?? '';
  }

  set value(next: string) {
    for (const radio of this.radios) radio.checked = radio.value === next;
  }

  dispose(): void {
    for (const radio of this.radios) radio.removeEventListener('change', this.forward);
  }
}

export interface PauseMenuOptions {
  readonly parent: HTMLElement;
  readonly bus: GameEventBus;
  /** Re-capture the pointer and carry on; called from a click, so it is a gesture. */
  readonly onResume: () => void;
  /** Throw away this celebration and start a fresh one. */
  readonly onRestart: () => void;
  readonly audio?: AudioSettings;
  readonly quality?: QualitySettings;
}

interface KeyLike extends Event {
  readonly key?: string;
  readonly shiftKey?: boolean;
}

/**
 * Escape pause menu: resume, controls help, sound, quality and restart,
 * built from the design system (docs/design-system.md). Shown on `paused`
 * and hidden on `resumed`/`sessionStarted`; the start screen covers the
 * session before it begins.
 *
 * Keyboard: Resume takes focus when the menu opens, Tab stays inside the
 * panel, and keys pressed in the menu stop there so game bindings (which
 * would otherwise swallow Space, digits and so on) never see them. Focus is
 * dropped on close so a later key cannot press a hidden button.
 */
export function createPauseMenu(options: PauseMenuOptions): Unsubscribe {
  const { parent, bus, onResume, onRestart, audio, quality } = options;
  const doc = parent.ownerDocument;
  const unbinds: (() => void)[] = [];

  const overlay = el(doc, 'div', 'pause-menu ds-scrim');
  overlay.hidden = true;

  const panel = el(doc, 'div', 'pause-menu__panel ds-panel ds-stack');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Paused');

  const header = el(doc, 'header', 'ds-panel__header');
  header.append(
    el(doc, 'p', 'ds-eyebrow', 'Diwali Celebration'),
    el(doc, 'h2', 'ds-panel__title', 'Paused'),
    el(doc, 'p', 'ds-panel__lead', 'The lane waits while you take a break.'),
  );

  const resume = button(doc, 'Resume', { variant: 'primary', size: 'lg', block: true, className: 'pause-menu__resume' });
  resume.dataset.action = 'resume';
  resume.addEventListener('click', onResume);

  // Controls: one row per CONTROLS_HELP entry, so a new binding is one line in text.ts.
  const help = el(doc, 'section', 'pause-menu__controls ds-section');
  help.append(sectionHeading(doc, 'Controls'), controlsList(doc, CONTROLS_HELP));

  const settings = el(doc, 'div', 'pause-menu__settings ds-stack');
  settings.style.setProperty('--ds-stack-gap', 'var(--ds-space-6)');
  if (audio) settings.appendChild(createAudioControls(doc, audio));

  if (quality) {
    const section = el(doc, 'fieldset', 'pause-menu__quality ds-section');
    const control = segmented(
      doc,
      'Quality',
      QUALITY_LEVELS.map((level) => ({ value: level, label: QUALITY_LABELS[level] })),
    );
    section.append(
      sectionHeading(doc, 'Quality', 'legend'),
      control.root,
      el(doc, 'p', 'ds-hint', 'Lower it if the fireworks stutter.'),
    );
    settings.appendChild(section);
    const group = new RadioGroupSelect(control.inputs);
    unbinds.push(bindQualitySelect(group, quality), () => group.dispose());
  }

  const body = el(doc, 'div', 'ds-panel__body');
  body.append(help, settings);

  const restart = button(doc, 'Restart fresh celebration', { variant: 'danger', className: 'pause-menu__restart' });
  restart.dataset.action = 'restart';
  restart.addEventListener('click', onRestart);
  const footer = el(doc, 'footer', 'ds-panel__footer');
  footer.append(el(doc, 'p', 'ds-hint', 'Starts the evening over from the beginning.'), restart);

  panel.append(header, resume, body, divider(doc), footer);
  overlay.appendChild(panel);
  parent.appendChild(overlay);

  const onKey = (event: KeyLike): void => {
    event.stopPropagation();
    if (event.type !== 'keydown' || event.key !== 'Tab') return;
    // Resume and Restart are the first and last stops; wrap between them.
    const active = doc.activeElement;
    const leaving = event.shiftKey ? active === resume : active === restart;
    if (leaving || !panel.contains(active)) {
      event.preventDefault();
      (event.shiftKey && panel.contains(active) ? restart : resume).focus();
    }
  };
  overlay.addEventListener('keydown', onKey);
  overlay.addEventListener('keyup', onKey);

  const show = (): void => {
    overlay.hidden = false;
    resume.focus({ preventScroll: true });
  };
  const hide = (): void => {
    const active = doc.activeElement as HTMLElement | null;
    if (active && overlay.contains(active)) active.blur();
    overlay.hidden = true;
  };
  unbinds.push(bus.on('paused', show), bus.on('resumed', hide), bus.on('sessionStarted', hide));

  return () => {
    for (const unbind of unbinds.splice(0)) unbind();
    resume.removeEventListener('click', onResume);
    restart.removeEventListener('click', onRestart);
    overlay.removeEventListener('keydown', onKey);
    overlay.removeEventListener('keyup', onKey);
    overlay.remove();
  };
}
