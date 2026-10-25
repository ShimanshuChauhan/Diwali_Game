import { CRACKER_TYPES } from '../core/types';
import type { HudModel } from './hudModel';
import { CRACKER_LABELS } from './text';

const ACCENT = '#ffcf70';
const BLOCKED = '#ff8a7a';

export interface HudView {
  /** Redraw if the model changed since the last call; cheap otherwise. */
  sync(): void;
  dispose(): void;
}

function style(element: HTMLElement, rules: readonly string[]): void {
  element.style.cssText = rules.join(';');
}

/**
 * DOM overlay for the HUD: hotbar of the five crackers with the selection
 * highlighted, a first-person crosshair, contextual prompt lines and a
 * fading rejection message. It never takes pointer events, so clicks still
 * reach the canvas.
 */
export function createHud(parent: HTMLElement, model: HudModel): HudView {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'hud';
  style(root, ['position:fixed', 'inset:0', 'pointer-events:none', 'user-select:none']);

  // A plus sign with a dark outline, readable over both bright bursts and dark walls.
  const crosshair = doc.createElement('div');
  style(crosshair, ['position:absolute', 'left:50%', 'top:50%', 'width:0', 'height:0']);
  const bars: [number, number][] = [
    [22, 3],
    [3, 22],
  ];
  for (const [width, height] of bars) {
    const bar = doc.createElement('div');
    style(bar, [
      'position:absolute',
      `width:${width}px`,
      `height:${height}px`,
      `margin:${-height / 2}px 0 0 ${-width / 2}px`,
      'border-radius:2px',
      'background:#fff',
      'box-shadow:0 0 0 1.5px rgba(0,0,0,0.7)',
      'opacity:0.9',
    ]);
    crosshair.appendChild(bar);
  }

  const prompts = doc.createElement('div');
  style(prompts, [
    'position:absolute',
    'left:50%',
    'top:calc(50% + 28px)',
    'transform:translateX(-50%)',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:4px',
    'font-size:15px',
    'text-shadow:0 1px 3px #000',
    'white-space:nowrap',
  ]);

  const rejection = doc.createElement('div');
  rejection.setAttribute('role', 'status');
  style(rejection, [
    'position:absolute',
    'left:50%',
    'bottom:96px',
    'transform:translateX(-50%)',
    'padding:6px 14px',
    'border-radius:6px',
    'background:rgba(60,12,12,0.78)',
    `color:${BLOCKED}`,
    'font-size:15px',
    'white-space:nowrap',
  ]);

  const hotbar = doc.createElement('div');
  style(hotbar, [
    'position:absolute',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'display:flex',
    'gap:8px',
  ]);
  const slots = CRACKER_TYPES.map((type, i) => {
    const slot = doc.createElement('div');
    style(slot, [
      'min-width:84px',
      'padding:6px 10px',
      'border-radius:6px',
      'background:rgba(11,10,26,0.7)',
      'border:2px solid transparent',
      'font-size:13px',
      'text-align:center',
    ]);
    const key = doc.createElement('div');
    style(key, ['font-size:11px', 'opacity:0.7']);
    key.textContent = String(i + 1);
    slot.append(key, CRACKER_LABELS[type]);
    hotbar.appendChild(slot);
    return slot;
  });

  root.append(crosshair, prompts, rejection, hotbar);
  parent.appendChild(root);

  let drawn = -1;
  const sync = (): void => {
    if (model.revision === drawn) return;
    drawn = model.revision;

    root.style.display = model.visible ? 'block' : 'none';
    crosshair.style.display = model.crosshairVisible ? 'block' : 'none';
    hotbar.style.display = model.hotbarVisible ? 'flex' : 'none';

    CRACKER_TYPES.forEach((type, i) => {
      const selected = type === model.selected;
      const slot = slots[i]!;
      slot.style.borderColor = selected ? ACCENT : 'transparent';
      slot.style.color = selected ? ACCENT : '';
    });

    prompts.replaceChildren(
      ...model.prompts.map((line) => {
        const element = doc.createElement('div');
        element.textContent = line.text;
        if (line.blocked) element.style.color = BLOCKED;
        if (line.hint) style(element, ['font-size:13px', 'font-style:italic', 'opacity:0.8']);
        return element;
      }),
    );

    const message = model.rejection;
    rejection.textContent = message?.text ?? '';
    rejection.style.display = message ? 'block' : 'none';
  };
  sync();

  return {
    sync,
    dispose() {
      root.remove();
    },
  };
}
