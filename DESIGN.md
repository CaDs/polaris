# Polaris visual identity

Polaris is the north star: the fixed point you navigate by. The app is a quiet, near-neutral tracker with one accent, so
status colors (running, review, done, failed) stay the loudest thing on a board.

## Palettes (Settings → Appearance)

Each user picks a palette and a mode (system, light, dark); both are saved on the server (`user_preferences`, `GET/PUT
/api/me/preferences`), so they follow the user to every browser and workspace. `web/index.html` applies a local copy
before first paint. Chosen from a canvas of options (true black and neutral greys read best around status colors):

| id | Name | Character | Accent light / dark |
|---|---|---|---|
| `black` (default) | Black + Blue | true black, neutral greys, one steel blue | `#1f6d9a` / `#2f7cad` |
| `graphite` | Graphite | neutral monochrome: the accent is the ink | `#18181b` / `#ededef` |
| `stone` | Stone & Ink | warm monochrome (paper and ink) | `#1c1a17` / `#ece8e1` |
| `polar` | Polar Night | the original navy ink, north blue | `#3d68ee` |
| `ember` | Ember | warm charcoal, orange; running turns violet so it never reads as the accent | `#c2410c` / `#ff7a45` |
| `teal` | Deep Teal | the schemecolor.com "Polaris" scheme: Black Pearl, Daintree, Boston/Teal Blue, Mabel | `#07435e` / `#4390ba` |

Review is never the accent's hue (periwinkle or violet next to a blue accent), so a review card never looks like a button.

## Tokens (web/style.css)

One block per palette (`:root` = the default, `[data-palette="…"]` the others; the attribute also scopes a palette to an
Appearance preview card), each `light-dark(light, dark)`:
bg, sidebar, surface, hover (raised), border, text, muted, accent, on-accent, accent-text, warn (running), review, ok
(done), error (failed), and for the always-dark landing night, glow, glow-on. Derived for every palette:
`--accent-hover` (accent mixed 15% toward text), `--flow-a/b` (accent → accent-text).

Contrast (WCAG AA, checked for every palette and mode): text, muted, accent-text and the four status colors ≥ 4.5:1 on bg,
surface, raised and sidebar (status colors are also text: error messages, "failed"); on-accent on accent ≥ 4.5:1; accent
on bg ≥ 3:1 (focus rings).

## Type and spacing

- System UI stack (Inter if installed), 13px base, unchanged; wordmark 34px / 650 / -0.015em; form titles 18px; tagline 15px.
- 4px spacing grid (4/8/12/16/24); auth card gap 14px, padding 28/24px, radius 12px.

## Icons

Outline glyphs only: 1.5px stroke, `currentColor`, round caps, on a 24-unit grid (`Icon` in web/ui.tsx; status and
priority glyphs in ui.tsx/tracker.tsx follow the same rule at 14px). No emoji and no typed symbols (⚠ ✓ ✗ ↑ ↓ +) as
icons: they render as filled color pictures on some platforms. An icon-only control carries its own `aria-label`;
counts sit beside a glyph, never over it. Nav links, the palette button, Ask Polaris and New ticket carry a muted glyph
before the label (`IconName` in ui.tsx lists them: user, review, box, layers, views, chart, bulb, board, cycle, clock, book,
home, search, chat, edit, bolt, list, code); the label always stays. No looping motion anywhere: "running" is a static half-filled circle,
and a running card's static gradient hairline says a model is working. Selects use the same outline chevron instead of the OS control.

## Mark

"Circumpolar": a fixed point with two star trails turning around it; Polaris holds still while the agents work. Inline SVG
(`Mark` in web/App.tsx) on a 32-unit grid: two arcs at a 2.6 stroke with round caps and a filled center dot, all in
`currentColor`. Monochrome, no tile, no glow: it takes the text color (the landing's starlight on the night sky). The
favicon is the same mark in white on a black rounded tile, so it reads on light and dark tabs.

## Gradient rule

Inside the app a gradient means "a model is working": the 2px top hairline on a running board card and the 2px left rule on
the model's own transcript in a run (`--flow-a → --flow-b`). Chat replies carry no rule: they sit in a gutter behind the
mark (16px, muted), which takes the accent while the reply is still coming. Buttons and the mark are flat. The landing is one
night sky across the whole page (the palette's night, a soft accent glow behind the brand, stars), always dark: the
mark, wordmark and tagline centered over the form card. Never on page, card, table or sidebar backgrounds, or on text.
