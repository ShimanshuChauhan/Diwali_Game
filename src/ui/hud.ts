import { ITEM_CYCLE } from '../core/actions';
import type { HudModel } from './hudModel';
import { DS } from './design/tokens';
import { BARE_HANDS_LABEL, CRACKER_LABELS } from './text';

const ACCENT = DS.color.accent;
const BLOCKED = DS.color.textDanger;

export interface HudView {
  /** Redraw if the model changed since the last call; cheap otherwise. */
  sync(): void;
  dispose(): void;
}

function style(element: HTMLElement, rules: readonly string[]): void {
  element.style.cssText = rules.join(';');
}

/** An open palm for the bare-hands slot, drawn in the text colour so it follows the highlight. */
const HAND_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px">' +
  '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10 4a1.5 1.5 0 0 1 3 0v6-4.5a1.5 1.5 0 0 1 3 0V12v-3.5a1.5 1.5 0 0 1 3 0V15' +
  'a7 7 0 0 1-7 7h-.5a6.5 6.5 0 0 1-5.3-2.8L3.6 15.3a1.6 1.6 0 0 1 2.5-2L7 14.5"/></svg>';

/**
 * DOM overlay for the HUD: hotbar of bare hands and the five crackers with
 * the selection highlighted, a short toast naming a new selection, a
 * first-person crosshair, contextual prompt lines and a fading rejection
 * message. It never takes pointer events, so clicks still
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
      `background:${DS.color.white}`,
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
    `gap:${DS.space[1]}`,
    `font-size:${DS.text.md}`,
    `text-shadow:${DS.shadow.textHud}`,
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
    `border-radius:${DS.radius.md}`,
    `background:${DS.color.surfaceDanger}`,
    `color:${BLOCKED}`,
    `font-size:${DS.text.md}`,
    'white-space:nowrap',
  ]);

  // Names the new selection just above the hotbar, quieter than a refusal.
  const toast = doc.createElement('div');
  style(toast, [
    'position:absolute',
    'left:50%',
    'bottom:72px',
    'transform:translateX(-50%)',
    'padding:3px 12px',
    `border-radius:${DS.radius.md}`,
    `background:${DS.color.surfaceHud}`,
    `color:${ACCENT}`,
    `font-size:${DS.text.md}`,
    'white-space:nowrap',
  ]);

  const hotbar = doc.createElement('div');
  style(hotbar, [
    'position:absolute',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'display:flex',
    `gap:${DS.space[2]}`,
  ]);
  const slots = ITEM_CYCLE.map((type, i) => {
    const slot = doc.createElement('div');
    style(slot, [
      'min-width:84px',
      'padding:6px 10px',
      `border-radius:${DS.radius.md}`,
      `background:${DS.color.surfaceHud}`,
      'border:2px solid transparent',
      `font-size:${DS.text.sm}`,
      'text-align:center',
    ]);
    const key = doc.createElement('div');
    style(key, [`font-size:${DS.text['2xs']}`, 'opacity:0.7']);
    // Bare hands are on the key left of 1; the crackers keep 1–5.
    key.textContent = type === null ? '`' : String(i);
    if (type === null) {
      // Fixed markup, no player text.
      const icon = doc.createElement('span');
      icon.innerHTML = HAND_ICON;
      slot.append(key, icon, BARE_HANDS_LABEL);
    }
    else slot.append(key, CRACKER_LABELS[type]);
    hotbar.appendChild(slot);
    return slot;
  });

  root.append(crosshair, prompts, rejection, toast, hotbar);
  parent.appendChild(root);

  let drawn = -1;
  const sync = (): void => {
    if (model.revision === drawn) return;
    drawn = model.revision;

    root.style.display = model.visible ? 'block' : 'none';
    crosshair.style.display = model.crosshairVisible ? 'block' : 'none';
    hotbar.style.display = model.hotbarVisible ? 'flex' : 'none';

    ITEM_CYCLE.forEach((type, i) => {
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
        if (line.hint) style(element, [`font-size:${DS.text.sm}`, 'font-style:italic', 'opacity:0.8']);
        return element;
      }),
    );

    // A refusal takes the space; the toast only names a switch that went through.
    const named = model.rejection ? null : model.toast;
    toast.textContent = named?.text ?? '';
    toast.style.display = named && model.hotbarVisible ? 'block' : 'none';

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
