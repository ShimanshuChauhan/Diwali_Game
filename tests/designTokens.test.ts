import { describe, expect, it } from 'vitest';
import baseCss from '../src/ui/design/base.css?raw';
import componentsCss from '../src/ui/design/components.css?raw';
import tokensCss from '../src/ui/design/tokens.css?raw';
import { DS } from '../src/ui/design/tokens';

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = stripComments(tokensCss);
const COMPONENTS = stripComments(componentsCss);
const BASE = stripComments(baseCss);

/** Custom properties a component sets on itself rather than reading from tokens.css. */
const LOCAL = new Set(['--ds-slider-fill', '--ds-stack-gap']);

const defined = new Set([...TOKENS.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
const used = (css: string): string[] => [...css.matchAll(/var\((--ds-[a-z0-9-]+)/g)].map((match) => match[1]!);

function hex(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, 'i').exec(TOKENS);
  if (!match) throw new Error(`${name} is not a hex token`);
  return match[1]!;
}

function luminance(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('every DS reference in tokens.ts is defined in tokens.css', () => {
    const references = Object.values(DS).flatMap((group) => Object.values(group) as string[]);
    for (const reference of references) {
      const name = /^var\((--ds-[a-z0-9-]+)\)$/.exec(reference)?.[1];
      expect(name, reference).toBeDefined();
      expect(defined.has(name!), name).toBe(true);
    }
  });

  it('every var(--ds-…) in the stylesheets is defined', () => {
    for (const name of [...used(TOKENS), ...used(COMPONENTS), ...used(BASE)]) {
      if (!LOCAL.has(name)) expect(defined.has(name), name).toBe(true);
    }
  });

  it('components and page styles take every colour from tokens', () => {
    for (const css of [COMPONENTS, BASE]) {
      expect(css).not.toMatch(/:\s*[^;]*#[0-9a-f]{3,8}\b/i);
      expect(css).not.toMatch(/rgba?\(/);
    }
  });

  it('text pairs meet WCAG AA (4.5:1) on the panel and night surfaces', () => {
    for (const text of ['--ds-cream-100', '--ds-cream-300', '--ds-gold-400', '--ds-coral-400']) {
      for (const surface of ['--ds-indigo-950', '--ds-indigo-900', '--ds-indigo-800']) {
        expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast('--ds-ink-900', '--ds-gold-400')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('--ds-ink-900', '--ds-gold-300')).toBeGreaterThanOrEqual(4.5);
  });

  it('control borders and the focus ring meet 3:1 against the panel (WCAG 1.4.11)', () => {
    for (const edge of ['--ds-indigo-500', '--ds-gold-400']) {
      for (const surface of ['--ds-indigo-950', '--ds-indigo-900']) {
        expect(contrast(edge, surface), `${edge} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
