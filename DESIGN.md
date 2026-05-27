# hark — design system

Single-source-of-truth for the visual language. Tokens live in
`web/src/styles/design.css`. Component styles in `design.css` + `extras.css`
must reference these tokens — never literal px values for radii, durations,
or easings.

## Dials (locked)

- **DESIGN_VARIANCE = 2/10.** The system is restrained and consistent on
  purpose. New surfaces match what's already there. Don't introduce a new
  card style, a new chip variant, or a new color when an existing token
  fits.
- **MOTION_INTENSITY = 3/10.** Motion is quiet. The only intentional
  ongoing animation is the status pulse (`@keyframes pulse`) on live /
  busy / waiting / current-task indicators — it's signal, not decoration.
  Everything else animates only on state change and resolves under 300ms.
- **VISUAL_DENSITY = 7/10.** Hark is a dev power-tool surfacing live state
  across many sessions. Density is the point. Padding scales should be
  read as "this is already as airy as it gets."

## Tokens

### Color

Two themes, picked at `:root` via `[data-theme]`, never mid-page:

- **Default (dark).** `--ink-0..3` for surfaces, `--fg-0..4` for text.
- **Paper (light).** Same role names, inverted values.

Five accent hues with matching `-soft` 14–18% variants:
`--amber`, `--jade`, `--indigo`, `--coral`, `--plum`. Exactly one accent
is active at a time, selected via `[data-accent]` and exposed as
`--accent` / `--accent-soft`. Components never reference an accent hue
directly — they reference `--accent`.

Semantic roles:
- `--jade` = idle / good / done.
- `--amber` = waiting / warning / running.
- `--coral` = error / dead / destructive.
- `--indigo` = informational metadata, git branch chip.
- `--plum` = agent, web, OAuth.

### Radius

| Token         | px  | Used for                                            |
|---------------|-----|-----------------------------------------------------|
| `--radius-sm` | 6   | tiny chips, diff lines, glyph wells                  |
| `--radius`    | 10  | buttons, search inputs, default cards                |
| `--radius-md` | 12  | menus and popovers (slash menu, attach menu)         |
| `--radius-lg` | 14  | bubbles, narrow-mode modals, prompt-panel cards      |
| `--radius-2xl`| 18  | full-size modals, composer, capture / paste / trust  |
| `--radius-xl` | 20  | reserved for hero / question card embellishment      |

### Spacing

`--s-1..s-9` = 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22 / 28. Use these for new
work. Existing component paddings on the design system surfaces
parameterise the density toggle via `--pad-y` and `--pad-x`.

### Typography

Three families:
- `--sans` Geist — body and UI.
- `--mono` Geist Mono — metadata, eyebrows, timestamps, keyboard hints.
- `--serif` Instrument Serif italic — display: brand mark, question
  titles, hero metrics, modal headings.

Roles (concrete sizes — see `--t-*` tokens in `design.css`):

| Token             | px    | Used for                                        |
|-------------------|-------|-------------------------------------------------|
| `--t-display`     | 26    | `.q-title`, `.brand`, hero modal headings        |
| `--t-display-sm`  | 20    | `.pp-question-text`                              |
| `--t-body`        | 14.5  | assistant lines, body copy in cards              |
| `--t-body-sm`     | 13    | denser body copy, side rail content              |
| `--t-meta`        | 12    | metadata rows                                    |
| `--t-mono`        | 11.5  | code, paths, branch chips                        |
| `--t-mono-sm`     | 10.5  | dot-separated meta, condensed mono               |
| `--t-eyebrow`     | 10    | uppercase tracked labels (`section-label`, etc.) |

### Shadows

One shadow token — `--shadow-card`. Variants for hover / selected states
extend it inline (focus ring uses `0 0 0 4px var(--accent-soft)`). Don't
invent new shadow values.

## Motion

### Easings

| Token              | Curve                                  | When to use                              |
|--------------------|----------------------------------------|------------------------------------------|
| `--ease-out-quart` | `cubic-bezier(0.23, 1, 0.32, 1)`       | Default UI ease. Hovers, focus, presses. |
| `--ease-out-expo`  | `cubic-bezier(0.16, 1, 0.3, 1)`        | Modals, popovers, anything that lands.    |
| `--ease-spring`    | `cubic-bezier(0.34, 1.56, 0.64, 1)`    | Available for press-up affordances. Not currently in use. |

The browser default `ease` is banned. So is `ease-in` on UI (`ease-in` is
reserved for things leaving the screen — and we don't currently have any).

### Durations

| Token         | ms    | When                                       |
|---------------|-------|--------------------------------------------|
| `--dur-press` | 90    | `:active` transform scale                  |
| `--dur-hover` | 120   | Hover, focus, color changes                |
| `--dur-menu`  | 180   | Dropdowns, popovers, chevron rotations     |
| `--dur-modal` | 220   | Modals, sheets, overlays                   |
| `--dur-meter` | 300   | Real meter fills (progress bar, ctx meter) |

300ms is the hard cap. The only place it lands is meters that genuinely
need to be seen growing.

### Rules

1. **Never `transition: all`.** Always enumerate the properties so the
   browser doesn't waste GPU time animating layout changes you didn't
   intend.
2. **Transform and opacity only.** No animation of `width`, `height`,
   `top`, `left`, `margin`, `padding`. The two exceptions are
   intentional meter fills (`width` on `.bar > i`, `.ctx-meter > i`,
   `.attach-chip-progress-fill`) and these are clearly commented in the
   source.
3. **Press feedback on every clickable.** Buttons, icon buttons,
   chips, pills, swatches all scale down 0.94–0.98 on `:active`
   (`--dur-press`).
4. **Popovers scale from their trigger.** `slash-menu` scales up from
   `bottom center`, `composer-attach-menu` from `bottom left`,
   `capture-modal` from `center top`, `capture-modal` (narrow) from
   `center bottom`.
5. **Scale-from-zero is banned.** Use `scale(0.96)` → `scale(1)` at most.
6. **No motion on keyboard-initiated actions.** Typing into the composer,
   pasting, submitting — none of these animate. State that changes as a
   side-effect of typing (the slash menu) does animate, because the
   appearance is a UI event, not a typing event.
7. **`prefers-reduced-motion` is honored.** All entry animations and
   transitions collapse to ~instant. The status pulses (live, waiting,
   running, current-task) survive because they're signal — without them
   the user can't tell at a glance whether a session is alive.

### What animates today

- **Hover state changes** on every clickable surface (`--dur-hover`).
- **Press feedback** on every clickable surface (`--dur-press`).
- **Chevrons rotate** when their parent expands (`--dur-menu`).
- **Popovers, menus, modals fade + scale in** on mount (`--dur-menu` /
  `--dur-modal`).
- **Overlays fade in.**
- **Meters fill** (`--dur-meter`).
- **Status dots pulse** continuously when active (semantic).

Anything else — a new bouncing element, a parallax scroll, an attention
shake — should be argued for in a PR.

## Light/dark/auto

Theme is picked at the document root via `[data-theme]`. The default is
dark; `paper` is the light variant. There is no mid-page theme flip and
no `prefers-color-scheme` auto-switch (the user chooses, and the choice
is persisted by `lib/theme.ts`).
