import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { controlsList, el } from '../ui/design/components';

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
  ['Space', 'jump'],
  ['Mouse', 'look'],
  ['1–5', 'phuljhari · anar · chakri · rocket · ladi'],
  ['` / 0', 'bare hands'],
  ['Wheel', 'cycle items'],
  ['H', 'holster / last cracker'],
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

  // Styled by the design system (docs/design-system.md): a scrim with the title, prompt and key hints.
  const overlay = el(document, 'div', 'start-screen ds-scrim ds-screen');
  const title = el(document, 'h1', 'ds-screen__title', 'Diwali Celebration');
  const prompt = el(document, 'p', 'ds-screen__prompt');
  const controls = controlsList(document, CONTROLS, { compact: true });

  overlay.append(title, prompt, controls);
  parent.appendChild(overlay);

  const show = (text: string): void => {
    prompt.textContent = text;
    overlay.hidden = false;
  };
  const hide = (): void => {
    overlay.hidden = true;
  };

  show('Click to begin');
  overlay.addEventListener('click', onStart);
  const unsubscribes = [bus.on('sessionStarted', hide), bus.on('resumed', hide)];
  if (showWhenPaused) unsubscribes.push(bus.on('paused', () => show('Paused. Click to resume')));

  return () => {
    overlay.removeEventListener('click', onStart);
    for (const unsubscribe of unsubscribes) unsubscribe();
    overlay.remove();
  };
}
