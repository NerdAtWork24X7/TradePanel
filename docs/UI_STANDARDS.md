# UI standards — typography, icons, controls

Single source of truth for the TradePanel shell (`frontend/src/styles/*`) and the
chart workspace (`frontend/web/workspace.html`). Both layers carry the same token
names so a component can move between them without a type change.

## Font families

| Token | Stack | Use |
|---|---|---|
| `--font-body` | Satoshi (bundled variable, 300–900) → `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | **All interface text.** One family; headings differ by size/weight, not by face. |
| `--font-mono` | MesloLGS NFM → `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` | Prices, quantities, timestamps, key chords, terminal readouts only. |

No webfont is fetched at runtime; `@font-face` declarations point at
`frontend/web/fonts/` (Vite `publicDir`), which is also what the workspace iframe
loads.

## Type scale

| Token | Size | Weight | Applied to |
|---|---:|---:|---|
| `--text-xl` | 24 | 600 | Page titles (`Settings`, workspace error) |
| `--text-lg` | 19 | 600 | Modal / drawer titles, section headings |
| `--text-md` | 16 | 600 | Card headings, brand, panel symbols, AI markdown `h3` |
| `--text-base` | 14 | 400/500 | Body, inputs, buttons, navigation, tabs, table cells, form labels (500) |
| `--text-sm` | 13 | 400 | Secondary copy, tooltips, dense table cells, tertiary buttons |
| `--text-xs` | 12 | 400/500/600 | Status labels, table headers (600), kickers, metadata |

* `--text-base` is the floor for **interface content**; 12 px is reserved for
  genuinely secondary metadata. Nothing renders below 12 px.
* Line heights: `--leading-heading` 1.3, `--leading-body` 1.5,
  `--leading-dense` 1.4 (tables, kickers).
* Weights: 400 body, 500 labels/nav/tabs, 600 headings/titles, 700 emphasis.
* Numeric columns use `--font-mono` + `font-variant-numeric: tabular-nums`.

## Icons

| Token | Size | Use |
|---|---:|---|
| `--icon-lg` | 20 | Main navigation (collapsed rail) |
| `--icon-md` | 18 | Toolbar, button, input, table-action icons |
| `--icon-sm` | 16 | Chart-panel tools, status glyphs |

* Every inline SVG uses `viewBox="0 0 24 24"` with `stroke="currentColor"` and a
  single `stroke-width="1.7"`; no filled/outlined mixing.
* Icon-only buttons carry `aria-label` + `title`. Sizes are set by component CSS
  (`.icon-btn svg`), never by ad-hoc `width`/`height` attributes.
* Hit targets: `--hit-min` 36 px for shell controls; chart-panel heads use 30 px
  tool buttons (dense, hover/focus-revealed) and the group colour swatch is a
  10 px dot inside a 24 × 30 px button.

## Controls

| Token | Value | Use |
|---|---:|---|
| `--input-h` | 38 | Text inputs, selects, textareas (single line) |
| `--control-h` | 36 | Buttons, toggles, direction switch |
| `--control-h-lg` | 38 | Primary settings actions, AI start/send |
| `--control-h-sm` | 32 | Tertiary inline actions (`.mini`) |
| `--hit-min` | 36 | Icon-button width/height |

## Colour & contrast

Targets: WCAG 2.2 AA — 4.5:1 for text, 3:1 for large text and control
boundaries.

* `--text` / `--text-2` / `--text-3` / `--muted` are ordered by contrast; the
  dimmest (`--muted`) still clears 4.5:1 on every surface in both themes.
* `--control-border` (inputs, selects, switches, segmented controls) is
  calibrated to ≥3:1 against the surrounding surface. `--border` is decorative
  only (cards, separators, hairlines).
* `--accent-text` is accent colour used **as text**: `#ffd43b` on dark,
  `#7a5c00` on light (yellow fails on white). `--accent` stays for fills,
  borders and glows behind dark ink.
* `--focus` is the focus ring and focus border colour (amber on dark, dark
  amber on light).
* Trading semantics keep green/red (`--success` / `--danger`); status text never
  relies on colour alone (label or glyph accompanies it).
* Disabled controls use `opacity: .55` — distinguishable but not invisible.

## Responsiveness

* The sidebar is a **container** (`.sidebar-body { container-type: inline-size }`);
  layout changes react to the column width via `@container sidebar (…)`, not the
  window width. At ≤280 px the ticket actions stack and the instrument action row
  wraps instead of clipping labels.
* Chart panels use `@container (max-width: …)` queries on the panel: the chart-type
  button drops below 700 px, the change badge below 470 px, the market badge below
  430 px. Type sizes are never reduced to make room.
* Workspace chrome tiers: chip labels drop below 1440 px (LED + tooltip stays),
  the workspace-name brand text below 1280 px, sync label / stacked field labels
  below 1100 px. Scale/Snap live in the sub-bar so the top bar keeps its full-size
  controls at 1280 px.

## Verification

`tmp/ui_audit.mjs` (Playwright, Chromium) audits every screen at 1280×720,
1366×768, 1920×1080 and 2560×1440 in both themes and fails on: text < 12 px,
icons < 14 px, text contrast below AA, control borders below 3:1, clipped text,
horizontal overflow, console errors. `tmp/webkit_audit.py` runs the same probe in
WebKitGTK — the engine Tauri uses on Linux — to confirm container queries and
`color-mix()` behave there too.
