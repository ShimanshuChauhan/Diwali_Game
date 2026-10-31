import type { Unsubscribe } from '../core/eventBus';
import { DS } from '../ui/design/tokens';
import { perfLines, type PerfSnapshot } from './perfMonitor';

/** Key that shows and hides the overlay. */
export const PERF_OVERLAY_KEY = 'F3';
/** Text refreshes a few times a second, not every frame. */
const REFRESH_SECONDS = 0.25;

interface KeyLike extends Event {
  readonly code: string;
}

export interface PerfOverlayOptions {
  readonly parent: HTMLElement;
  /** Receives the toggle key; typed structurally for tests. */
  readonly win: EventTarget;
  readonly sample: () => PerfSnapshot;
  readonly visible?: boolean;
}

export interface PerfOverlay {
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  /** Per rendered frame, with the real delta; cheap while hidden. */
  frame(deltaSeconds: number): void;
  dispose: Unsubscribe;
}

/**
 * Toggleable perf overlay (F3): FPS, frame time, draw calls, particles,
 * lights, voices and placed/lit crackers against their budgets.
 */
export function createPerfOverlay(options: PerfOverlayOptions): PerfOverlay {
  const { parent, win, sample } = options;
  const doc = parent.ownerDocument;
  const panel = doc.createElement('pre');
  panel.className = 'perf-overlay';
  panel.setAttribute('aria-live', 'off');
  panel.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'margin:0',
    'padding:8px 10px',
    'border-radius:6px',
    'background:rgba(11,10,26,0.78)',
    `color:${DS.color.textAccent}`,
    `font:${DS.text.xs}/1.35 ${DS.font.mono}`,
    'pointer-events:none',
    `z-index:${DS.z.debug}`,
  ].join(';');
  parent.appendChild(panel);

  let visible = false;
  let untilRefresh = 0;
  const refresh = (): void => {
    panel.textContent = perfLines(sample()).join('\n');
    untilRefresh = REFRESH_SECONDS;
  };
  const setVisible = (next: boolean): void => {
    visible = next;
    panel.style.display = visible ? 'block' : 'none';
    if (visible) refresh();
  };
  setVisible(options.visible ?? false);

  const onKey = (event: Event): void => {
    const key = event as KeyLike;
    if (key.code !== PERF_OVERLAY_KEY) return;
    event.preventDefault();
    setVisible(!visible);
  };
  win.addEventListener('keydown', onKey);

  return {
    get visible() {
      return visible;
    },
    setVisible,
    frame(deltaSeconds) {
      if (!visible) return;
      untilRefresh -= deltaSeconds;
      if (untilRefresh <= 0) refresh();
    },
    dispose() {
      win.removeEventListener('keydown', onKey);
      panel.remove();
    },
  };
}
