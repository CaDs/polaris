# Polaris visual identity

Polaris is the north star: the fixed point you navigate by. The identity is a calm night sky
(navy ink, star-white) with one clear accent, so the tracker stays quiet and status colors stay meaningful.

## Palettes considered

| | A. Polar Night (chosen) | B. Brass & Navy | C. Aurora |
|---|---|---|---|
| Night / brand panel | `#0b1224` | `#0b1224` | `#0b1224` |
| Star-white | `#f4f6fb` | `#f4f6fb` | `#f4f6fb` |
| Accent (fill) | `#3d68ee` north blue | light `#996a0a` / dark `#e8b64c` brass | light `#0d7a70` / dark `#5eead4` teal |
| Text on accent | `#ffffff` (4.76:1) | `#ffffff` / `#0b1224` (4.75 / 9.97) | `#ffffff` / `#0b1224` (5.20 / 12.9) |
| Accent text | light `#2449c7` / dark `#8fb0ff` | light `#996a0a` / dark `#e8b64c` | light `#0d7a70` / dark `#5eead4` |

Why A: B and C are more distinctive, but brass collides with the amber "running"/warn color and
teal collides with the green "done"/ok color; on a status board that ambiguity costs more than the
flair gains. North blue reads as "night sky, starlight", keeps white text on buttons in both themes,
and needs no per-theme on-accent color. Brass is the runner-up if a warmer brand is wanted
(it would require moving --warn to orange).

## Tokens (web/style.css, `light-dark(light, dark)`)

- bg `#ffffff` / `#0a0f1d`, sidebar `#f5f7fb` / `#0e1527`, surface `#ffffff` / `#121a2e`
- hover `#eaeef6` / `#1a2440`, border `#dde3ee` / `#243049`
- text `#0f1729` / `#e6ebf5`, muted `#5a6478` / `#8f9ab3`
- accent `#3d68ee`, accent-hover `#2f5bea`, on-accent `#ffffff`, accent-text `#2449c7` / `#8fb0ff`
- ok `#146c36` / `#4cc38a`, warn `#8f5a0a` / `#f0b429`, error `#c4331f` / `#ff8a7a`
- night `#0b1224`, star `#f4f6fb` (brand panel and mark, same in both themes)

Contrast (WCAG AA, 4.5:1 for text): text/bg >= 14.5; muted on bg/hover >= 5.1; accent-text on
bg/hover >= 6.3; ok/warn/error on bg and hover >= 4.7 (light ok and warn were 4.1 and 3.6 before, now
fixed); white on accent 4.76; tagline `#c9d3ea` on night 12.4. Accent vs dark bg is 4.0 (focus rings, >= 3:1).

## Type and spacing

- System UI stack (Inter if installed), 13px base, unchanged; wordmark 34px / 650 / -0.015em; form titles 18px; tagline 15px.
- 4px spacing grid (4/8/12/16/24); auth card gap 14px, padding 28/24px, radius 12px.

## Icons

Outline glyphs only: 1.5px stroke, `currentColor`, round caps, on a 24-unit grid (`Icon` in web/ui.tsx; status and
priority glyphs in ui.tsx/tracker.tsx follow the same rule at 14px). No emoji and no typed symbols (⚠ ✓ ✗ ↑ ↓ +) as
icons: they render as filled color pictures on some platforms. An icon-only control carries its own `aria-label`;
counts sit beside a glyph, never over it. No looping motion anywhere: "running" is a static half-filled circle,
and a running card's static gradient hairline says a model is working. Selects use the same outline chevron instead of the OS control.

## Mark

Inline SVG (`Mark` in web/App.tsx): a four-ray star (long cardinal rays, faded diagonals, like a
compass rose) on a `#5b86ff -> #2f5bea` tile. Landing, sidebar and the data-URI favicon.

## Gradient rule

The night sky is the brand; inside the app a gradient means "a model is working". Only here:
landing brand panel (160deg `#0b1224 -> #0f1a3d -> #16245c`, aurora glow, stars, tagline rule),
the mark tile, `.btn.primary` (`#4f7cff -> #3d68ee`), the 2px top hairline on a running board card,
and the 2px left rule on the model's own transcript text (`--flow-a -> --flow-b`: `#3d68ee -> #8fb0ff`,
dark `#5b86ff -> #9dbbff`). Never on page, card, table or sidebar backgrounds, or on text.
Tool calls keep a flat grey rule.

## What changed

- web/style.css: new tokens (plus --accent-hover, --on-accent, --night, --star); hardcoded `#fff`
  and `#6e79da` replaced by tokens; person avatars and diff hunk tint moved from indigo to blue.
- Landing: auth forms beside a night-sky brand panel (mark, "Polaris", tagline); stacks under 720px. Text unchanged.
- Sidebar header shows the mark instead of the workspace initial; the workspace name is unchanged.
- e2e: the dark-theme body color in m2 and m11 specs updated to `rgb(10, 15, 29)`.
