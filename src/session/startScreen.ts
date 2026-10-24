import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';

export interface StartScreenOptions {
  readonly parent: HTMLElement;
  readonly bus: GameEventBus;
  /** Called on click; the click is also the gesture that unlocks audio. */
  readonly onStart: () => void;
  /** Also cover the game while paused. Defaults to true; false when a pause menu does that. */
  readonly showWhenPaused?: boolean;
}

const CONTROLS: readonly [string, string][] = [
  ['WASD', 'move'],
  ['Shift', 'run'],
  ['Mouse', 'look'],
  ['1–5', 'phuljhari · anar · chakri · rocket · ladi'],
  ['Click', 'place'],
  ['E', 'light / interact'],
  ['V', 'switch camera'],
  ['Esc', 'pause'],
];

/**
 * Full-screen overlay shown before the session starts and while paused.
 * Clicking anywhere on it starts or resumes play.
 */
export function createStartScreen(options: StartScreenOptions): Unsubscribe {
  const { parent, bus, onStart, showWhenPaused = true } = options;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:16px',
    'background:rgba(11,10,26,0.72)',
    'cursor:pointer',
    'user-select:none',
    'text-align:center',
  ].join(';');

  const title = document.createElement('h1');
  title.style.cssText = 'margin:0;font-weight:600;color:#ffcf70';
  title.textContent = 'Diwali Celebration';

  const prompt = document.createElement('p');
  prompt.style.cssText = 'margin:0;font-size:18px';

  const controls = document.createElement('dl');
  controls.style.cssText =
    'display:grid;grid-template-columns:auto auto;gap:4px 16px;margin:0;font-size:14px;opacity:0.8';
  for (const [key, action] of CONTROLS) {
    const term = document.createElement('dt');
    term.style.cssText = 'text-align:right;font-weight:600';
    term.textContent = key;
    const detail = document.createElement('dd');
    detail.style.cssText = 'margin:0;text-align:left';
    detail.textContent = action;
    controls.append(term, detail);
  }

  overlay.append(title, prompt, controls);
  parent.appendChild(overlay);

  const show = (text: string): void => {
    prompt.textContent = text;
    overlay.style.display = 'flex';
  };
  const hide = (): void => {
    overlay.style.display = 'none';
  };

  show('Click to begin');
  overlay.addEventListener('click', onStart);
  const unsubscribes = [bus.on('sessionStarted', hide), bus.on('resumed', hide)];
  if (showWhenPaused) unsubscribes.push(bus.on('paused', () => show('Paused — click to resume')));

  return () => {
    overlay.removeEventListener('click', onStart);
    for (const unsubscribe of unsubscribes) unsubscribe();
    overlay.remove();
  };
}
