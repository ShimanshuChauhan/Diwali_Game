# Design system

The game's DOM UI (pause menu, start screen, HUD, mini player, subtitles,
debug overlays) shares one set of tokens and components. Read this before
adding or restyling any UI, and change the tokens here rather than writing
new colours or sizes into a file.

| What | Where |
| --- | --- |
| Tokens (CSS custom properties) | [`src/ui/design/tokens.css`](../src/ui/design/tokens.css) |
| Page defaults (`html`, `body`, `#app`, `#status`) | [`src/ui/design/base.css`](../src/ui/design/base.css) |
| Component classes (`.ds-*`) | [`src/ui/design/components.css`](../src/ui/design/components.css) |
| Entry point, linked once from `index.html` | [`src/ui/design/index.css`](../src/ui/design/index.css) |
| TS mirror for inline styles (`DS`) | [`src/ui/design/tokens.ts`](../src/ui/design/tokens.ts) |
| DOM builders for the components | [`src/ui/design/components.ts`](../src/ui/design/components.ts) |
| Guard tests (tokens defined, no stray colours, contrast) | [`tests/designTokens.test.ts`](../tests/designTokens.test.ts) |

`index.html` links `index.css`; Vite bundles the `@import`s into one
stylesheet, and it loads before the game script, so overlays never flash
unstyled. Nothing else should import CSS.

## Theme and principles

**A Diwali night.** The scene is a dark residential lane lit by diyas and
fireworks, so the UI is a deep indigo night with warm cream text and
marigold-gold light. Saffron is for emphasis, a soft coral for anything
blocked or destructive.

1. **The scene is the hero.** Overlays are dark, translucent and quiet; gold
   is the one accent. Never add a second bright colour for decoration.
2. **One accent per view.** Exactly one primary (gold) button per panel: the
   action the player most likely wants (Resume).
3. **Read at a glance.** Body text is cream on indigo (14:1); muted text still
   passes AA. HUD text over the 3D scene always carries the HUD text shadow.
4. **Native controls underneath.** Switches, sliders and segmented controls
   are real `<input>`s restyled, so keyboard, screen readers and form events
   work for free.
5. **Calm motion.** Short fades and lifts only (120–200 ms), all switched off
   under `prefers-reduced-motion`.

## Tokens

All tokens are `--ds-*` custom properties on `:root`. Use semantic tokens
(`--ds-color-text`) in components; the raw palette (`--ds-gold-400`) is for
defining semantic tokens and rare special cases.

### Palette

| Token | Value | Role |
| --- | --- | --- |
| `--ds-indigo-950` | `#0b0a1a` | Night sky, page background |
| `--ds-indigo-900` | `#18142c` | Panel surface |
| `--ds-indigo-800` | `#241c3a` | Raised control (switch track, segmented, key-cap) |
| `--ds-indigo-700` | `#33294f` | Control hover |
| `--ds-indigo-600` | `#4a3c6e` | Key-cap edge, quiet borders |
| `--ds-indigo-500` | `#76679f` | Control borders and slider track (3:1 against panels) |
| `--ds-cream-100` | `#f6e7c8` | Body text |
| `--ds-cream-300` | `#cdbfa6` | Muted text |
| `--ds-gold-400` | `#ffcf70` | Diya gold: the accent, focus ring |
| `--ds-gold-300` | `#ffdc96` | Accent hover |
| `--ds-saffron-500` | `#ff9933` | Emphasis glow |
| `--ds-coral-400` | `#ff8a7a` | Blocked / warning / destructive text |
| `--ds-maroon-900` | `#3c0c0c` | Warning surface base |
| `--ds-ember-950` | `#140a06` | Warm dark surface (subtitles) |
| `--ds-ink-900` | `#2a1606` | Text on gold |

### Semantic colours

| Token | Use for |
| --- | --- |
| `--ds-color-bg` | Page background |
| `--ds-color-scrim` | Full-screen dim layer behind menus |
| `--ds-color-surface` | Panels and cards |
| `--ds-color-surface-hud` | HUD chips over the scene (hotbar slots) |
| `--ds-color-surface-raised` / `-hover` | Control backgrounds and their hover |
| `--ds-color-surface-warm` | Subtitle rows |
| `--ds-color-surface-danger` | Rejection toast, danger button hover |
| `--ds-color-surface-accent` / `-hover` | Secondary button fill |
| `--ds-color-text` / `-muted` | Body text / secondary text |
| `--ds-color-text-accent` | Titles, section headings, highlighted names |
| `--ds-color-text-danger` | Blocked prompts and warnings |
| `--ds-color-text-on-accent` | Text on a gold fill |
| `--ds-color-accent` / `-hover` | Selected state, primary fill, slider fill |
| `--ds-color-border` / `-strong` | Hairlines between rows / outlines of buttons and HUD panels |
| `--ds-color-border-control` | Outline of inputs (switch, segmented, select) |
| `--ds-color-border-key` | Key-cap edge |
| `--ds-color-border-danger` | Danger button outline |
| `--ds-color-track` | Unfilled slider track |
| `--ds-color-diya-wash` | Warm light at a panel's top edge |

### Typography

Font: `--ds-font-sans` (system UI stack), `--ds-font-mono` for key-caps and
debug readouts.

| Token | Size | Use for |
| --- | --- | --- |
| `--ds-text-2xs` | 11px | Eyebrows, section headings, hotbar key numbers |
| `--ds-text-xs` | 12px | Key-caps, debug overlays, small notices |
| `--ds-text-sm` | 13px | Secondary text, list rows, hints, hotbar labels |
| `--ds-text-md` | 15px | Body, buttons, HUD prompts |
| `--ds-text-lg` | 18px | Lead text, large buttons |
| `--ds-text-xl` | 24px | Panel titles |
| `--ds-text-2xl` | 32px | Screen titles |

Weights `--ds-weight-regular` (400), `--ds-weight-semibold` (600),
`--ds-weight-bold` (700); line heights `--ds-leading-tight` (1.2) for
headings, `--ds-leading-normal` (1.45) for text; `--ds-tracking-eyebrow`
(0.08em) for uppercase labels.

### Spacing, radii, shadows

| Token | Value | | Token | Value | Use for |
| --- | --- | --- | --- | --- | --- |
| `--ds-space-1` | 4px | | `--ds-radius-sm` | 4px | Key-caps, segment pills |
| `--ds-space-2` | 8px | | `--ds-radius-md` | 6px | Buttons, inputs, HUD chips |
| `--ds-space-3` | 12px | | `--ds-radius-lg` | 10px | Panels |
| `--ds-space-4` | 16px | | `--ds-radius-pill` | 999px | Switches, slider thumbs |
| `--ds-space-5` | 20px | | | | |
| `--ds-space-6` | 24px | | | | |
| `--ds-space-8` | 32px | | | | |

Spacing is a 4px grid: 4–8 inside a control, 12 between related items, 24
between sections and as panel padding.

| Token | Use for |
| --- | --- |
| `--ds-shadow-panel` | Lift a panel off the scene |
| `--ds-shadow-control` | Key-caps and slider thumbs |
| `--ds-glow-diya` | Warm halo around panels |
| `--ds-glow-accent` | Primary button hover |
| `--ds-text-shadow-hud` | Any text drawn straight over the 3D scene |
| `--ds-text-shadow-glow` | Screen titles |

### Layers, motion, focus, layout

| Token | Value | Use for |
| --- | --- | --- |
| `--ds-z-floating` | 5 | Aarti mini player: must sit above the pause scrim so its song buttons take clicks while paused |
| `--ds-z-debug` | 10 | Perf overlay (F3) |
| `--ds-z-devtool` | 1000 | Sound board and other `?dev` panels |
| `--ds-duration-fast` | 120ms (0 when reduced) | Hover, press, switch |
| `--ds-duration-base` | 200ms (0 when reduced) | Panel entrance |
| `--ds-ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Every transition |
| `--ds-focus-ring-width` / `-color` / `-offset` | 2px / gold / 2px | The single focus ring |
| `--ds-panel-width` | 760px | Pause panel at full width |
| `--ds-control-height` | 36px | Buttons, switch rows, selects |

Full-screen overlays without a z token (door fade, HUD, start screen, pause
menu) stay at `z-index: auto` and stack in the order `main.ts` creates them;
keep it that way unless you add a token for the new layer.

## Components

Build them with the helpers in `components.ts` where one exists; they emit
exactly the markup below.

### Scrim and panel

```html
<div class="ds-scrim" hidden>
  <div class="ds-panel ds-stack" role="dialog" aria-modal="true" aria-label="Paused">
    <header class="ds-panel__header">
      <p class="ds-eyebrow">Diwali Celebration</p>
      <h2 class="ds-panel__title">Paused</h2>
      <p class="ds-panel__lead">The lane waits while you take a break.</p>
    </header>
    <div class="ds-panel__body">…two columns ≥ 720px, one below…</div>
    <hr class="ds-divider" aria-hidden="true" />
    <footer class="ds-panel__footer">…</footer>
  </div>
</div>
```

Toggle the `hidden` attribute to show and hide. The panel scrolls inside
the viewport on short screens. `.ds-panel--narrow` caps it at 420px.
`.ds-stack` stacks children with `--ds-stack-gap` (default 16px).

### Buttons

```ts
button(doc, 'Resume', { variant: 'primary', size: 'lg', block: true });
```

```html
<button type="button" class="ds-btn ds-btn--primary ds-btn--lg ds-btn--block">Resume</button>
```

| Variant | Class | Use for |
| --- | --- | --- |
| Primary | `ds-btn--primary` | The one main action of a view |
| Secondary | `ds-btn--secondary` | Other actions |
| Ghost | `ds-btn--ghost` | Low-priority actions, inline in text |
| Danger | `ds-btn--danger` | Actions that throw progress away (Restart) |

States: hover brightens the fill or border, active presses down 1px,
`:focus-visible` shows the gold ring, `:disabled` fades to 50%. Modifiers:
`ds-btn--lg` (44px tall), `ds-btn--block` (full width). Always set
`type="button"`.

### Toggle switch

```ts
const { root, input } = toggleSwitch(doc, 'Mute');
```

```html
<label class="ds-switch">
  <span class="ds-switch__label">Mute</span>
  <input type="checkbox" role="switch" class="ds-switch__input" />
  <span class="ds-switch__track" aria-hidden="true"></span>
</label>
```

A real checkbox covers the whole row (click anywhere, Space toggles);
`checked` turns the track gold. Listen for `change`.

### Slider

```ts
const volume = slider(doc, 'Volume', { min: 0, max: 100, format: (v) => `${v}%` });
// after setting volume.input.value from code:
volume.refresh();
```

```html
<label class="ds-field">
  <span class="ds-field__row">
    <span class="ds-field__label">Volume</span>
    <span class="ds-field__value" aria-hidden="true">80%</span>
  </span>
  <input type="range" class="ds-slider" style="--ds-slider-fill: 80%" aria-valuetext="80%" />
</label>
```

The filled part of the track follows `--ds-slider-fill`; the helper keeps it
and the readout in step on `input`.

### Segmented control

```ts
const { root, inputs } = segmented(doc, 'Quality', [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]);
```

```html
<div class="ds-segmented" role="radiogroup" aria-label="Quality">
  <label class="ds-segmented__option">
    <input type="radio" name="ds-segmented-1" value="low" class="ds-segmented__input" />
    <span class="ds-segmented__label">Low</span>
  </label>
  …
</div>
```

Radios sharing a name: Tab enters the group, arrow keys move the choice and
fire `change`. Use it for 2–4 short options. To drive something that
expects a `<select>`, wrap the radios in `RadioGroupSelect`
(`src/ui/pauseMenu.ts`). For longer lists use `.ds-select` on a native
`<select>`.

### Key-cap

```ts
keyCap(doc, 'E');
```

```html
<kbd class="ds-kbd">E</kbd>
```

For keys and mouse inputs alike (`WASD`, `Shift`, `Click`, `1–5`, `Space`).
Write the key as the player sees it on the keyboard.

### Section heading and section

```html
<section class="ds-section">
  <h3 class="ds-section-heading">Controls</h3>
  …
</section>

<fieldset class="ds-section">
  <legend class="ds-section-heading">Sound</legend>
  …
</fieldset>
```

Uppercase gold eyebrow with a hairline to the right. Use a `fieldset` +
`legend` when the section groups form controls.

### List rows (controls list)

```ts
controlsList(doc, [['WASD', 'Move'], ['Space', 'Jump']]);
```

```html
<dl class="ds-list">
  <div class="ds-list-row" data-key="WASD">
    <dt><kbd class="ds-kbd">WASD</kbd></dt>
    <dd>Move</dd>
  </div>
</dl>
```

`ds-list--compact` drops the separators and tightens the rows (start
screen).

### Inline confirm

```ts
const ask = confirmPrompt(doc, 'Restart the evening? Your progress resets.', {
  confirm: 'Restart',
  cancel: 'Cancel',
});
```

```html
<div class="ds-confirm" role="group" aria-labelledby="ds-confirm-1" hidden>
  <p class="ds-confirm__message" id="ds-confirm-1">Restart the evening? Your progress resets.</p>
  <div class="ds-confirm__actions">
    <button type="button" class="ds-btn ds-btn--secondary">Cancel</button>
    <button type="button" class="ds-btn ds-btn--danger">Restart</button>
  </div>
</div>
```

For an action that throws progress away. Never use the browser's
`confirm()`. Show it in place of the button that asked (hide that row,
unhide this one) and:

- move focus to **Cancel**, the safe choice;
- back out on Cancel or Escape, and return focus to the button that asked;
- reset it whenever the panel closes, so the panel always reopens plain.

Write the question as a short sentence with the consequence after it, and
name the danger button with the verb (`Restart`), not `OK` or `Yes`.

### Divider, eyebrow, hint

`<hr class="ds-divider" aria-hidden="true">` fades in and out at the edges.
`.ds-eyebrow` is small uppercase muted text above a title. `.ds-hint` is a
muted explanatory line under a control.

### Start screen

`.ds-scrim.ds-screen` with `.ds-screen__title` (glowing gold) and
`.ds-screen__prompt` (gently pulsing, steady under reduced motion), then a
compact controls list.

## The pause menu

`src/ui/pauseMenu.ts` composes the components above:

1. Header: eyebrow, "Paused" title, lead line.
2. **Resume**: the primary, full-width button, focused when the menu opens.
3. Body, two columns on wide screens:
   - **Controls**: one row per entry of `CONTROLS_HELP` in `src/ui/text.ts`.
   - **Sound** (`createAudioControls` in `src/audio/controls.ts`): mute switch, volume slider.
   - **Quality**: Low / Medium / High segmented control.
4. Footer: **Restart fresh celebration** (danger) with an explanation.
   Clicking it swaps the footer for an inline confirm ("Restart the
   evening? Your progress resets.", Cancel and Restart); only the confirm's
   Restart calls `onRestart`.

Hooks code and tests rely on: `.pause-menu` (overlay, `hidden` while
closed), `.pause-menu__panel` (`role="dialog"`), `.pause-menu__resume` /
`.pause-menu__restart` (also `data-action="resume"` / `"restart"`),
`.pause-menu__footer`, `.pause-menu__confirm` with `.pause-menu__cancel` /
`.pause-menu__confirm-restart` (`data-action="cancel-restart"` /
`"confirm-restart"`), `.pause-menu__controls`, `.audio-controls`, `.pause-menu__quality`, and
`.ds-list-row[data-key]` per control. Behaviour is covered by
`tests/pauseMenu.test.ts`.

**Adding a control hint** (e.g. a new key binding): add one
`[key, action]` row to `CONTROLS_HELP` in `src/ui/text.ts` (and to
`CONTROLS` in `src/session/startScreen.ts` if the start screen should show
it). No menu code changes.

## Writing

Rules for every player-facing string: UI labels, prompts, rejections,
hints, the pause panel and this document's examples.

- **No em dashes** (the long dash, U+2014). Use a comma, colon, full stop
  or parentheses instead: `Paused. Click to resume`.
  `tests/noEmDash.test.ts` fails if one appears in the wording modules.
- **Plain and direct.** Say what happens or what to do, with no filler:
  `Too far away to light: move closer`, not `Oops! Looks like you might be
  a little too far away`.
- **Sentence case** for labels, buttons and headings (`Restart fresh
  celebration`); section headings are uppercased by CSS, so write them in
  sentence case too.
- **Keys as the player sees them**: `E`, `Space`, `Shift`, `WASD`, `1–5`
  (an en dash for ranges is fine).
- **Short.** Prompts and rejections fit on one line at 15px over the scene;
  hints under a control are one sentence.
- Keep wording in data modules (`src/ui/text.ts`, `src/ui/homePrompts.ts`)
  rather than inline in DOM code, so it can be reviewed and tested in one
  place.

## Accessibility rules

- **Contrast.** Text meets WCAG AA (4.5:1) on every panel surface; control
  borders, slider tracks and the focus ring meet 3:1 (WCAG 1.4.11).
  `tests/designTokens.test.ts` checks the palette pairs, so a token change
  that breaks contrast fails CI.
- **Focus.** Everything interactive shows the gold `:focus-visible` ring;
  never remove it without a replacement.
- **Keyboard.** Menus focus their main action when they open, keep Tab
  inside while modal, and stop key events at their root so game bindings
  (which `preventDefault` keys such as Space, digits and Escape) do not
  swallow them. Drop focus when a menu closes so a later key cannot press a
  hidden button.
- **Semantics.** Use native elements (`button`, `input`, `fieldset`,
  `legend`, `dl`). Dialogs get `role="dialog"`, `aria-modal` and a label.
  Decorative parts get `aria-hidden="true"`.
- **Targets.** Controls are at least 36px tall (`--ds-control-height`).
- **Motion.** Use the duration tokens; they become 0 under
  `prefers-reduced-motion`. Loop animations must be disabled there too.
- **Small screens.** Panels fit the viewport and scroll inside; grids
  collapse to one column below 720px.

## Do and don't

| Do | Don't |
| --- | --- |
| `color: var(--ds-color-text-accent)` / `DS.color.textAccent` | `color: #ffcf70` |
| Add a token when a value has a role | Copy a hex into a second file |
| One primary button per view | Several gold buttons competing |
| Real inputs with `ds-*` classes | `div`s with click handlers |
| Keep `type="button"` on buttons | Rely on the default `submit` |
| Text shadow on text over the scene | Bare text straight on the canvas |
| Toggle `hidden` to show/hide overlays | Animate `display` |

## Adding a new UI element

1. Look for an existing component above; compose it with the
   `components.ts` helpers.
2. If you need new styling, add a `.ds-*` class to `components.css` using
   only tokens, with hover, active, `:focus-visible` and disabled states,
   and document it here with markup.
3. For inline styles in TS (HUD-style elements whose values change per
   frame), use `DS` from `src/ui/design/tokens.ts`, never literals. Add the
   entry to `DS` if it is missing.
4. Keep hooks code depends on (classes, `data-*`) separate from `ds-*`
   presentation classes, so restyling never breaks behaviour.
5. Add a test with the fake DOM in `tests/fakeDom.ts`, as
   `tests/pauseMenu.test.ts` does.

## Changing or adding a token

1. Edit `src/ui/design/tokens.css`. Put raw colours in the palette, then
   point a semantic token at them.
2. If TS needs it, add a `var()` reference to `DS` in `tokens.ts` (never the
   value itself).
3. Update the tables in this document.
4. Run `npx vitest run tests/designTokens.test.ts`: it fails if a reference
   is undefined, a stylesheet uses a literal colour, or contrast drops below
   AA.
