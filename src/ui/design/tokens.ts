/**
 * TypeScript mirror of tokens.css for inline styles (`element.style.x =
 * DS.color.accent`). Each entry is a `var(--ds-…)` reference, not a copy of
 * the value, so tokens.css stays the single source; a test checks that
 * every name here is defined there. Guide: docs/design-system.md.
 */

const v = <Name extends string>(name: Name): `var(--ds-${Name})` => `var(--ds-${name})`;

export const DS = {
  color: {
    bg: v('color-bg'),
    scrim: v('color-scrim'),
    surface: v('color-surface'),
    surfaceHud: v('color-surface-hud'),
    surfaceRaised: v('color-surface-raised'),
    surfaceWarm: v('color-surface-warm'),
    surfaceDanger: v('color-surface-danger'),
    surfaceAccent: v('color-surface-accent'),
    text: v('color-text'),
    textMuted: v('color-text-muted'),
    textAccent: v('color-text-accent'),
    textDanger: v('color-text-danger'),
    accent: v('color-accent'),
    danger: v('color-danger'),
    border: v('color-border'),
    borderStrong: v('color-border-strong'),
    borderControl: v('color-border-control'),
    track: v('color-track'),
    white: v('white'),
    black: v('black'),
  },
  font: {
    sans: v('font-sans'),
    mono: v('font-mono'),
  },
  text: {
    '2xs': v('text-2xs'),
    xs: v('text-xs'),
    sm: v('text-sm'),
    md: v('text-md'),
    lg: v('text-lg'),
    xl: v('text-xl'),
  },
  weight: {
    regular: v('weight-regular'),
    semibold: v('weight-semibold'),
  },
  space: {
    1: v('space-1'),
    2: v('space-2'),
    3: v('space-3'),
    4: v('space-4'),
    6: v('space-6'),
  },
  radius: {
    sm: v('radius-sm'),
    md: v('radius-md'),
    lg: v('radius-lg'),
    pill: v('radius-pill'),
  },
  shadow: {
    textHud: v('text-shadow-hud'),
  },
  z: {
    floating: v('z-floating'),
    debug: v('z-debug'),
    devtool: v('z-devtool'),
  },
  tracking: {
    eyebrow: v('tracking-eyebrow'),
  },
} as const;
