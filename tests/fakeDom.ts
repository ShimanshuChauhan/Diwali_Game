/**
 * A minimal DOM for UI tests, which run in Node: elements with children,
 * attributes, classes, dataset, inline style, focus and bubbling events.
 * Only what the menus use; cast to `Document`/`HTMLElement` at the edge.
 */

type Child = FakeElement | string;

class FakeStyle {
  cssText = '';
  private readonly properties = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? '';
  }
}

export class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly childNodes: Child[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  className = '';
  hidden = false;
  // Form-control fields, plain properties as far as the tests care.
  type = '';
  value = '';
  checked = false;
  name = '';
  min = '';
  max = '';
  step = '';

  constructor(
    readonly ownerDocument: FakeDocument,
    tag: string,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get classList(): { contains(name: string): boolean } {
    return { contains: (name) => this.className.split(/\s+/).includes(name) };
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child): child is FakeElement => typeof child !== 'string');
  }

  get textContent(): string {
    return this.childNodes.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(text: string) {
    this.replaceChildren(text);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: Child[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild<T extends Child>(node: T): T {
    if (typeof node !== 'string') {
      node.remove();
      node.parentNode = this;
    }
    this.childNodes.push(node);
    return node;
  }
  replaceChildren(...nodes: Child[]): void {
    for (const child of this.childNodes.splice(0)) if (typeof child !== 'string') child.parentNode = null;
    this.append(...nodes);
  }
  remove(): void {
    const parent = this.parentNode;
    if (parent instanceof FakeElement) parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node: unknown): boolean {
    for (let at = node; at instanceof FakeElement; at = at.parentNode) if (at === this) return true;
    return false;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  click(): void {
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }

  /** Dispatch here, then bubble through the ancestors to the document unless stopped. */
  override dispatchEvent(event: Event): boolean {
    let stopped = false;
    const stop = event.stopPropagation.bind(event);
    event.stopPropagation = () => {
      stopped = true;
      stop();
    };
    let node: EventTarget | null = this;
    while (node) {
      EventTarget.prototype.dispatchEvent.call(node, event);
      if (stopped || !event.bubbles) break;
      node = node instanceof FakeElement ? node.parentNode : null;
    }
    return !event.defaultPrevented;
  }
}

export class FakeDocument extends EventTarget {
  body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    super();
    this.body = new FakeElement(this, 'body');
    this.body.parentNode = this;
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
}

/** Every element under `root` (itself included) that passes `test`, in document order. */
export function findAll(root: FakeElement, test: (element: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (element: FakeElement): void => {
    if (test(element)) found.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return found;
}

export function byClass(root: FakeElement, name: string): FakeElement[] {
  return findAll(root, (element) => element.classList.contains(name));
}

export function byTag(root: FakeElement, tag: string): FakeElement[] {
  return findAll(root, (element) => element.tagName === tag.toUpperCase());
}

/** A key event as a browser would send it: it bubbles and can be cancelled. */
export function keyEvent(
  type: 'keydown' | 'keyup',
  key: string,
  options: { readonly code?: string; readonly shiftKey?: boolean } = {},
): Event {
  const { code = key, shiftKey = false } = options;
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { key, code, shiftKey });
}
