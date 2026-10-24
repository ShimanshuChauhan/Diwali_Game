import { createAudioControls, type AudioSettings } from '../audio/controls';
import type { QualityModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { QUALITY_LEVELS } from '../core/quality';
import type { QualityLevel } from '../core/types';
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

const BUTTON = [
  'padding:8px 18px',
  'border-radius:6px',
  'border:1px solid #ffcf70',
  'background:rgba(255,207,112,0.12)',
  'color:inherit',
  'font:inherit',
  'cursor:pointer',
].join(';');

/**
 * Escape pause menu: resume, controls help, sound, quality and restart.
 * Shown on `paused` and hidden on `resumed`/`sessionStarted`; the start
 * screen covers the session before it begins.
 */
export function createPauseMenu(options: PauseMenuOptions): Unsubscribe {
  const { parent, bus, onResume, onRestart, audio, quality } = options;
  const doc = parent.ownerDocument;
  const unbinds: (() => void)[] = [];

  const overlay = doc.createElement('div');
  overlay.className = 'pause-menu';
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'background:rgba(11,10,26,0.72)',
  ].join(';');

  const panel = doc.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Paused');
  panel.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'gap:14px',
    'min-width:320px',
    'max-width:min(480px, calc(100vw - 32px))',
    'padding:24px',
    'border-radius:10px',
    'background:rgba(24,20,44,0.95)',
  ].join(';');

  const title = doc.createElement('h2');
  title.style.cssText = 'margin:0;font-weight:600;color:#ffcf70;text-align:center';
  title.textContent = 'Paused';

  const resume = doc.createElement('button');
  resume.type = 'button';
  resume.style.cssText = BUTTON;
  resume.textContent = 'Resume';
  resume.addEventListener('click', onResume);

  const help = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.style.cursor = 'pointer';
  summary.textContent = 'Controls';
  const list = doc.createElement('dl');
  list.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:8px 0 0;font-size:14px';
  for (const [key, action] of CONTROLS_HELP) {
    const term = doc.createElement('dt');
    term.style.fontWeight = '600';
    term.textContent = key;
    const detail = doc.createElement('dd');
    detail.style.margin = '0';
    detail.textContent = action;
    list.append(term, detail);
  }
  help.append(summary, list);

  panel.append(title, resume, help);

  if (audio) panel.appendChild(createAudioControls(doc, audio));

  if (quality) {
    const select = doc.createElement('select');
    for (const level of QUALITY_LEVELS) {
      const option = doc.createElement('option');
      option.value = level;
      option.textContent = QUALITY_LABELS[level];
      select.appendChild(option);
    }
    const label = doc.createElement('label');
    label.append('Quality ', select);
    panel.appendChild(label);
    unbinds.push(bindQualitySelect(select, quality));
  }

  const restart = doc.createElement('button');
  restart.type = 'button';
  restart.style.cssText = BUTTON;
  restart.textContent = 'Restart fresh celebration';
  restart.addEventListener('click', onRestart);
  panel.appendChild(restart);

  overlay.appendChild(panel);
  parent.appendChild(overlay);

  const show = (): void => {
    overlay.style.display = 'flex';
  };
  const hide = (): void => {
    overlay.style.display = 'none';
  };
  unbinds.push(bus.on('paused', show), bus.on('resumed', hide), bus.on('sessionStarted', hide));

  return () => {
    for (const unbind of unbinds.splice(0)) unbind();
    resume.removeEventListener('click', onResume);
    restart.removeEventListener('click', onRestart);
    overlay.remove();
  };
}
