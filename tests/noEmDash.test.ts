import { describe, expect, it } from 'vitest';

/**
 * The writing rule in docs/design-system.md: no em dashes in anything the
 * player reads or hears as a subtitle. Scans the string literals of the
 * modules that hold that wording; comments are not user-facing and are
 * skipped.
 */

const EM_DASH = '—';

const sources = import.meta.glob<string>(
  [
    '../src/ui/text.ts',
    '../src/ui/homePrompts.ts',
    '../src/ui/pauseMenu.ts',
    '../src/ui/hud.ts',
    '../src/ui/hudModel.ts',
    '../src/ui/miniPlayer.ts',
    '../src/session/startScreen.ts',
    '../src/homes/heldItems.ts',
    '../src/homes/locations.ts',
    '../src/audio/controls.ts',
    '../src/audio/soundBoard.ts',
    '../src/main.ts',
    '../src/**/dialogue.ts',
    '../src/**/*Dialogue.ts',
    '../src/**/reactions.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * The text inside string and template literals, one entry per literal.
 * A small scanner: enough for these modules, which keep regex literals out
 * of their wording.
 */
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      found.push(source.slice(i + 1, j));
      i = j + 1;
    } else {
      i++;
    }
  }
  return found;
}

describe('player-facing text', () => {
  it('finds the modules it guards', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(15);
  });

  it.each(Object.entries(sources))('%s has no em dash in its strings', (_path, source) => {
    expect(stringLiterals(source).filter((text) => text.includes(EM_DASH))).toEqual([]);
  });

  it('the scanner catches a dash in a string but not in a comment', () => {
    const sample = `// a comment — fine\nconst a = 'Hands full — no';\n/* also — fine */ const b = \`x\`;`;
    expect(stringLiterals(sample).filter((text) => text.includes(EM_DASH))).toEqual(['Hands full — no']);
  });
});
