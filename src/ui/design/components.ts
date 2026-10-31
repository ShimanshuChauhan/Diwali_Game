/**
 * DOM builders for the design system's components (components.css). Each
 * returns plain elements with the `ds-*` classes and accessible markup, so
 * UI code composes them instead of hand-writing styles. They touch only
 * `Document` and elements, never the game. Guide: docs/design-system.md.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonOptions {
  readonly variant?: ButtonVariant;
  readonly size?: 'md' | 'lg';
  /** Stretch to the container's width. */
  readonly block?: boolean;
  readonly className?: string;
}

/** One row of a key-hint list: the key (or mouse input) and what it does. */
export type ControlRow = readonly [key: string, action: string];

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(doc: Document, label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const { variant = 'secondary', size = 'md', block = false, className } = options;
  const classes = ['ds-btn', `ds-btn--${variant}`];
  if (size === 'lg') classes.push('ds-btn--lg');
  if (block) classes.push('ds-btn--block');
  if (className) classes.push(className);
  const element = el(doc, 'button', classes.join(' '), label);
  element.type = 'button';
  return element;
}

/** A key-cap such as `E`, `Space` or `WASD`. */
export function keyCap(doc: Document, key: string): HTMLElement {
  return el(doc, 'kbd', 'ds-kbd', key);
}

export function sectionHeading(doc: Document, text: string, tag: 'h3' | 'legend' = 'h3'): HTMLElement {
  return el(doc, tag, 'ds-section-heading', text);
}

/** A decorative rule between groups. */
export function divider(doc: Document): HTMLElement {
  const rule = el(doc, 'hr', 'ds-divider');
  rule.setAttribute('aria-hidden', 'true');
  return rule;
}

/**
 * Key hints as a `<dl>`, one `.ds-list-row` per entry, in the order given.
 * Rows are plain data: add one to the list and it appears here.
 */
export function controlsList(doc: Document, rows: readonly ControlRow[], options: { compact?: boolean } = {}): HTMLElement {
  const list = el(doc, 'dl', options.compact ? 'ds-list ds-list--compact' : 'ds-list');
  for (const [key, action] of rows) {
    const row = el(doc, 'div', 'ds-list-row');
    row.dataset.key = key;
    const term = el(doc, 'dt');
    term.appendChild(keyCap(doc, key));
    row.append(term, el(doc, 'dd', undefined, action));
    list.appendChild(row);
  }
  return list;
}

export interface SwitchParts {
  readonly root: HTMLLabelElement;
  /** A real checkbox: `checked` and `change` work as usual. */
  readonly input: HTMLInputElement;
}

/** A toggle switch: a labelled checkbox with `role="switch"`. */
export function toggleSwitch(doc: Document, label: string): SwitchParts {
  const root = el(doc, 'label', 'ds-switch');
  const input = el(doc, 'input', 'ds-switch__input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  const track = el(doc, 'span', 'ds-switch__track');
  track.setAttribute('aria-hidden', 'true');
  root.append(el(doc, 'span', 'ds-switch__label', label), input, track);
  return { root, input };
}

export interface SliderOptions {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Readout beside the label, e.g. `(v) => `${v}%``. Omit for none. */
  readonly format?: (value: number) => string;
}

export interface SliderParts {
  readonly root: HTMLLabelElement;
  readonly input: HTMLInputElement;
  /** Redraw the fill and readout after setting `input.value` from code. */
  refresh(): void;
}

/** A labelled range slider whose track fills up to the value. */
export function slider(doc: Document, label: string, options: SliderOptions = {}): SliderParts {
  const { min = 0, max = 100, step = 1, format } = options;
  const root = el(doc, 'label', 'ds-field');
  const row = el(doc, 'span', 'ds-field__row');
  row.appendChild(el(doc, 'span', 'ds-field__label', label));
  const readout = el(doc, 'span', 'ds-field__value');
  readout.setAttribute('aria-hidden', 'true');
  if (format) row.appendChild(readout);

  const input = el(doc, 'input', 'ds-slider');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  root.append(row, input);

  const refresh = (): void => {
    const value = Number(input.value);
    const fraction = max > min && Number.isFinite(value) ? (value - min) / (max - min) : 0;
    input.style.setProperty('--ds-slider-fill', `${(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(1)}%`);
    if (format) {
      readout.textContent = format(value);
      input.setAttribute('aria-valuetext', format(value));
    }
  };
  input.addEventListener('input', refresh);
  refresh();
  return { root, input, refresh };
}

export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedParts {
  readonly root: HTMLElement;
  readonly inputs: readonly HTMLInputElement[];
}

let segmentedGroups = 0;

/**
 * A segmented control: native radios sharing a name, so arrow keys move
 * the choice and each pick fires `change` on its radio.
 */
export function segmented(doc: Document, label: string, options: readonly SegmentedOption[]): SegmentedParts {
  const root = el(doc, 'div', 'ds-segmented');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', label);
  const name = `ds-segmented-${++segmentedGroups}`;
  const inputs = options.map((option) => {
    const item = el(doc, 'label', 'ds-segmented__option');
    const input = el(doc, 'input', 'ds-segmented__input');
    input.type = 'radio';
    input.name = name;
    input.value = option.value;
    item.append(input, el(doc, 'span', 'ds-segmented__label', option.label));
    root.appendChild(item);
    return input;
  });
  return { root, inputs };
}

export interface ConfirmParts {
  /** `.ds-confirm`, a labelled group; toggle `hidden` to show it. */
  readonly root: HTMLElement;
  readonly confirm: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

let confirmGroups = 0;

/**
 * An inline confirm: a question and two buttons, Cancel then the danger
 * action. Shown in place of the button that asked, so no browser dialog.
 */
export function confirmPrompt(
  doc: Document,
  message: string,
  labels: { readonly confirm: string; readonly cancel: string },
): ConfirmParts {
  const root = el(doc, 'div', 'ds-confirm');
  root.setAttribute('role', 'group');
  const text = el(doc, 'p', 'ds-confirm__message', message);
  text.id = `ds-confirm-${++confirmGroups}`;
  root.setAttribute('aria-labelledby', text.id);
  const actions = el(doc, 'div', 'ds-confirm__actions');
  const cancel = button(doc, labels.cancel, { variant: 'secondary' });
  const confirm = button(doc, labels.confirm, { variant: 'danger' });
  actions.append(cancel, confirm);
  root.append(text, actions);
  return { root, confirm, cancel };
}
