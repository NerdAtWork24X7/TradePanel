# Changelog

## 2026-11-06 — Drawing tools: lightweight-charts-drawing integration (v5)
- **TradingView-parity drawing engine**: adopted
  [`lightweight-charts-drawing@0.6.3`](https://github.com/deepentropy/lightweight-charts-drawing)
  (MIT, one series primitive that renders every drawing, preview, anchor and axis label).
  This required upgrading the bundled Lightweight Charts **4.2.2 → 5.2.1** and migrating
  every series factory (`addCandlestickSeries`/`addLineSeries`/`addHistogramSeries`/… →
  `addSeries(<SeriesDefinition>, options)`) in `workspace.js`, the indicator overlays and
  the hidden AI snapshot renderer (`src/ai-snapshot/main.ts`).
- **86 tools**, including trend lines, channels, pitchforks, Fibonacci and Gann tools,
  chart patterns, Elliott waves, cycles, forecasts, volume profiles, measurers, brushes,
  arrows, shapes, text/notes, table, image and font icon. Long/short position, table cell,
  image and font-icon tools get host support: the trade-linked long/short position box and
  measure tool remain custom, text notes and table cells open the in-place editor, images
  use a size-capped file picker (cached in localStorage so they survive reloads) and the
  font icon prompts for a glyph.
- **Personal toolbar**: pin/unpin any catalog tool with its ☆ (or right-click a pinned
  tool), up to 8 pinned tools on the rail, persisted in workspace preferences. The rail
  keeps the cursor, magnet, hide-all, measure, long/short trade tools and clear button;
  **All tools** opens the searchable catalog with recents and per-family groups.
- **Editing UX**: a selected drawing gets a style bar (colour, line width, dash, lock,
  delete, deselect), magnet defaults to weak, the library keys (Esc / Delete / Ctrl-click
  multi-select / Shift constraints) work unchanged, and `setInterval` follows the chart
  timeframe so per-interval visibility is honoured.
- **Fixed — dragging a drawing panned the chart**: the workspace's vertical price-pan
  gesture ran on every vertical pane drag, so dragging *any* drawing (horizontal line,
  trend line, Fibonacci tool, text, table, image, Gann box, …) also shifted the price
  scale underneath it. The pan now yields to a drawing gesture (hover/`savedScroll`/
  cursor check) and reverts itself if a drag starts without a prior hover (touch / fast
  drags). Empty-pane drags still pan; verified by `tmp/draw_drag_audit.mjs` and
  `tmp/draw_all_drag_audit.mjs` (19 tool kinds, anchor resize, empty-pane control).
- **Persistence**: drawings stay in the chart's workspace config, always in raw price
  units; percentage/indexed modes are re-based through the manager (`display → raw` on
  change, `raw → display` on load, reprojected when the reference price moves). Legacy
  `{tool: "trend"}` records migrate on attach (trend/rect/fib/text/hline/vline) and the
  Python store validates both models (bounded points/style/kind payloads, 86-kind
  whitelist, 512-point cap for brushes).
- Verified: `frontend/tests/chart-drawings.test.mjs` (catalog, migration, projection,
  interval map, defensive parsing), `tests/test_workspace_store.py` (new + legacy models),
  `npm --prefix frontend test` (85 pass), `tsc --noEmit`, `vite build`, the AI snapshot
  renderer on v5, and Playwright audits for placement, style edits, persistence across
  reloads, price-mode rebasing, chart-type rebinding, legacy migration, timeframe interval,
  pinned tools (pin/unpin/cap/persist), text/table/image/font-icon tooling, layouts at
  900×620 and 1280×720 in both themes, plus the existing position/measure/guide audits.


## 2026-11-06 — Dotted price guide while dragging Long/Short levels
- Dragging the entry, take-profit or stop-loss handle (and the box body) now
  draws a dotted horizontal line across the full plot at the live price, so the
  level can be traced to the price axis while it moves. The line uses the level's
  colour (green target, red stop, direction colour for entry) and disappears as
  soon as the pointer is released or the gesture is cancelled.
- Implemented as `drawPositionGuide` in `frontend/web/workspace.js`; it reads
  `entry.positionDrag`, so it exists only during the gesture and adds no
  persistent state.
- Verified: `tmp/guide_audit.mjs` (entry/TP/SL/body drags draw a plot-wide dotted
  row at the pointer, no line before or after the drag, zero console errors) plus
  the position, measure and modal audits.

## 2026-11-06 — Measure tool is movable and no longer blocks other tools
- Root cause: the committed measurement reused the transient gesture object, so
  `pointermove`/`pointerup` kept treating it as a live drag. Every later shape
  was swallowed by the measure branch and the tool was dismissed without drawing.
- The measurement now has separate draft (`measureDraft`), committed (`measure`)
  and selected states. Dragging the line body moves it; dragging an endpoint moves
  just that point; both work with the Select tool and in cursor mode (no rail
  open). Hovering shows `move`, `Delete` removes it and `Esc` deselects. A bare
  click with the measure tool keeps the previous measurement instead of leaving a
  zero-length ghost. Starting another tool or symbol switch clears in-progress
  state but keeps the committed measurement.
- Verified: `tmp/measure_audit.mjs` (draw, trend line created afterwards, body
  drag, endpoint drag, cursor-mode drag, hover cursor, Esc/Delete, replacement
  drag, bare click) with zero console errors; full frontend suite and typecheck.

## 2026-11-06 — Long/Short position tool redesigned to TradingView parity
- New `frontend/web/position_tool.js` (UMD, DOM-free) owns the documented sizing math:
  `Qty = min(QtyRisk, QtyLvg)`, `QtyRisk = riskBudget / |entry − stop| / lotSize`,
  `QtyLvg = account × leverage / entry / lotSize`, risk/reward, profit/loss,
  balance at target/stop, PnL state (future edge vs right-edge close) and
  price/percent/tick offsets. Settings migrate the v1 single `risk` percentage.
- Canvas redesign: profit/risk zones, a solid entry line, dashed target/stop,
  TradingView-style right-edge level tags stacked on overlap (`ENTRY`, `TP +x%`,
  `SL −x%`, off-screen `▲`), an in-box quantity tag, balance chips at each exit,
  a compact one-line mode, and a selected-box stats panel with quantity, R/R,
  target/stop in price + percent + ticks, risk, reward, both balances and open /
  right-edge PnL. Entry handles are square, the right-edge grip is rounded, and
  the panel clamps to the plot on every side.
- Interaction: distinct `ns-resize` / `ew-resize` / `move` cursors per hit type,
  double-click opens the editor, the placement draft shows live R/R and quantity,
  and an abandoned draft no longer stays painted after Esc or a tool switch.
- Settings modal rebuilt around position sizing / display / selected-position
  sections: account, risk mode (% or USDT), leverage, lot size, quantity precision,
  default width, stats and compact switches, selected entry/target/stop inputs
  validated per direction, a 1:1 stop reset and a live preview that flags a
  leverage-capped quantity. All fields keep the 12 px type floor and were audited
  for clipping/overflow in both themes.
- Stored positions are normalized on load (invalid direction/prices/times dropped),
  so corrupt or hand-edited `localStorage` records cannot break rendering.
- Verified: `node --test frontend/tests/position-tool.test.mjs` (12 formula/guard
  tests), `npm --prefix frontend test` (76 pass), `tsc --noEmit`, plus Playwright
  audits for drag level/body/edge, single-click 2R placement, hover cursors,
  canvas pixels, compact mode, inline validation, delete, persistence across
  reloads and stored-record sanitization (`tmp/pos_audit.mjs`,
  `tmp/pos_short_audit.mjs`, `tmp/pos_persist_audit.mjs`, `tmp/pos_modal_audit.mjs`).
- Not implemented: TradingView's position alerts (the workspace has no price-alert
  service; alerts live in the Python shell), and per-object "always show stats"
  (stats visibility is a global default for new/selected boxes).

## 2026-11-06 — application-wide typography, icon and readability standard
- One text family (bundled Satoshi; mono reserved for numeric readouts) and a
  centralized scale on `--text-xs` 12 → `--text-xl` 24 with 14 px as the interface
  floor. Removed the 7.5–11.5 px tier that carried ticket labels, table headers,
  AI transcript, chart-panel chrome and settings hints; the duplicated
  "settings readability" override layers in `shell.css` are gone (their layout
  rules were folded into the base declarations).
- Tokens added to `tokens.css` + `workspace.html`: `--text-*` sizes, weights,
  line heights, `--icon-*`, `--control-h*`, `--input-h`, `--hit-min`,
  `--control-border`, `--accent-text`, `--focus`. Buttons 36 px, inputs 38 px,
  icon buttons 36 px, navigation 14/500 with 20 px icons.
- Contrast: dark `--muted` and light `--text-3`/`--muted` raised past 4.5:1,
  light `--coral`/`--cyan` darkened, `--accent-text` introduced for amber text on
  white, focus rings moved from yellow to `--focus`, and control boundaries use
  `--control-border` (≥3:1). Disabled opacity 0.45 → 0.55.
- Icons: every inline SVG normalized to an 18 px/1.7-stroke metric (20 px in the
  collapsed rail), text glyphs (✕) replaced with vectors, chart-panel tools 30 px,
  group colour swatch given a 24 × 30 px hit box, tooltips on every icon-only
  action.
- Responsive: the sidebar is now a container (ticket actions stack and the
  instrument row wraps at the 248 px minimum), the Scale/Snap selectors moved to
  the workspace sub-bar (with labels) so the top bar no longer squeezes the
  workspace name, and chart-panel chrome degrades by hiding labels — never by
  shrinking type.
- Verified: `tmp/ui_audit.mjs` green at 1280/1366/1920/2560 in both themes for the
  trade ticket, AI panel (248/296/560 px), settings (four tabs), workspace, symbol
  picker and indicators modal (0 text <12 px, 0 icons <14 px, 0 AA failures,
  0 clipped labels, 0 overflow); `tmp/webkit_audit.py` repeats the probe in
  WebKitGTK including container queries; `tauri build` debug binary rebuilt and
  running under Xvfb with live data. Standards: `docs/UI_STANDARDS.md`.

## 2026-11-05 — maximized chart fills the grid
- Maximizing a chart left a dead band at the bottom whenever the workspace held
  more panels than the layout's explicit tracks. Sibling panels were hidden with
  `visibility: hidden`, so they stayed in grid flow, spilled into implicit rows,
  and the maximized panel (`grid-row: 1 / -1`, which stops at the explicit grid
  end) only filled the top tracks. Hidden panels now use `display: none`, so the
  maximized panel spans the whole grid area.
- Verified in `tmp/workspace-preview.html` at 1600×900: maximized panel is
  1584×792 (grid 1600×808 minus 8 px padding), canvas fills the host minus the
  28 px time axis, restore returns all four panels to 788×392; checked layouts
  1 / 2h / 2v / 4 / 6 / 8 / custom and a resized grid, zero console warnings.

## 2026-11-05 — AI analysis always returns a trade with a probability
- `panel_submit_trade_plan` now requires `action` `long`/`short` plus an integer
  `probability` (1–99), the estimated chance that take-profit is reached before
  stop-loss. `no-trade` plans are rejected; the prompt tells the model to pick
  the better-evidenced side, calibrate the percentage from 1d/4h/5m alignment
  and the 5m trigger, and reflect weak evidence in a lower probability.
- Trade cards render the percentage as an accent chip in the header and include
  it in "Copy levels". Plans stored before this change (no-trade, qualitative
  confidence) still render from conversation history.
- Verified: frontend typecheck and 27 Node tests; AI smoke test rejects missing
  probability, no-trade and inverted levels and accepts a 62% long plan.

## 2026-11-05 — sidebar tabs for Trade and AI Analysis
- The right column is now two views instead of one stacked column: a **Trade**
  ticket and its own **AI Analysis** tab, switched by an ARIA tab strip
  (`frontend/src/components/sidebar-tabs.ts`, roving tabindex, Arrow/Home/End,
  choice persisted, `Ctrl+Shift+A` opens the AI tab). Each view owns the full
  column height, so the analysis gets a real transcript instead of a 62 % strip.
- AI type scale raised to a reading size: messages 13 px (was 11), markdown
  headings 13.5–14.5, plan values 13, compose/input 12–12.5, labels 9.5–10.5.
  The context bar is two rows now, so the instrument and timeframe never
  truncate at the 248 px minimum column width; the empty state owns the body
  when the transcript is empty. The AI tab carries the live status dot, so a
  run started on the Trade tab stays visible.
- The panel's own collapse chevron is gone (the tab strip replaces it); the
  widen button still temporarily expands the column and restores it on Escape
  or on switching back to Trade.
- Verified in the Chromium harness at 248/296/380/560 px (no overflow, glider
  alignment, focus/selection, reload persistence, scroll re-pin after a
  background run, light theme) plus typecheck, 27 Node tests and the Vite build.

## 2026-11-05 — clean startup paint and instant app close
- Startup no longer flashes the raw shell (the skip link and unstyled controls) before
  the stylesheet arrives. `frontend/index.html` carries critical first-paint CSS and a
  theme-aware boot screen that `main.ts` fades out once the module has run; the Tauri
  window paints `#1c1c1b` from its first frame (`backgroundColor`), so WebKit's white
  canvas is never visible. The chart area is now opaque and keeps a small "Loading
  charts" placeholder until the workspace bridge reports ready.
- Closing the window could hang forever: `HyperliquidClient` built `hyperliquid.info.Info`
  with the SDK's default websocket enabled, and `WebsocketManager` starts two **non-daemon**
  threads (run_forever + ping) that `threading._shutdown` joins at interpreter exit. The
  sidecar therefore never exited; the supervisor waited its 12 s grace and a force-closed
  shell left orphaned backend processes behind. The SDK client is now REST-only
  (`skip_ws=True`), `backend/sidecar.py` hard-exits after the graceful writer flush
  (`os._exit`, so no library thread can wedge the process), and the Rust supervisor bounds
  stdin writes with a 5 s timeout so a full pipe cannot block the exit path.
- Verified: `trading.price_precision` (which initialises the SDK) followed by
  `system.shutdown` now exits in 0.03 s with zero websocket threads; the real window closes
  in 254 ms with no orphaned sidecar; boot screenshots (dark and light, CSS deliberately
  blocked) show the branded splash only; 78 Python tests, 13 bridge + 21 sync Node tests,
  12 Rust tests, frontend typecheck/build pass.

## 2026-11-05 — price-axis pan no longer rescales with indicators on
- Dragging a chart vertically now translates the price range instead of refitting it. Overlay
  indicators (SMA/EMA/BB/VWAP/ribbon/HL EMA) are separate series on the same price scale; only the
  main series applied the pan offset, so the autoscale union grew and the axis stretched as soon as
  an indicator was visible. The right-scale autoscale provider is now shared by every series, and a
  vertical pan freezes the visible range (captured from the current mapping with the scale margins
  zeroed) so time pans, zooms and live tick updates keep the exact same span. The frozen window
  persists as a manual price scale; double-clicking the price axis, Center, symbol/timeframe/price-
  mode/reference changes, or a price-axis drag/wheel reset it back to autoscale.
- Verified in the browser harness (SMA+EMA+BB+VWAP on): pure and diagonal drags hold the span at
  9927.144772 through the gesture and after release, live ticks do not change it, percentage and
  absolute group modes keep span plus offset sync across two charts, and a following price-axis drag
  re-captures cleanly. 50 Python tests, 21 Node sync tests, compileall/import and the offscreen Qt
  smoke (verticalPan moved, offset -351.8) pass.

## 2026-11-04 — remove Daily EMA and HL Scalp indicators
- Deleted `Indicator/daily_ema.py` and `Indicator/hl_scalp.py` with their `Indicator` exports,
  `DEFAULT_CONFIG` sections, workspace indicator defaults, config-dialog groups, Python study
  handlers, JS overlay/signal rendering and indicator-popup rows. The indicator list is now 19
  entries (8 native + 11 Python studies).
- Cleaned the leftovers: `hl_scalp_visible` window-state key and the `daily_ema` / `hl_scalp`
  settings in `data/indicator_config.json` and `data/workspaces.json`; deleted the orphaned
  `data/chart_data.json` cache left behind by the old single-chart view.
- Verified: `compileall` + `import main`, 50 unit tests, `node --check`, browser harness (popup has
  no removed rows, zero console errors), and the offscreen Qt smoke (`studies` payload only contains
  `sessions/fvg/ribbon/vp/hl_ema/adx`, zero page errors).

## 2026-11-04 — remove Cloud Panel and Trade History
- Deleted `UI/message_sidebar.py` and `UI/trade_history.py` along with their `Trade_Panel.spec`
  entries, imports/wiring, horizontal/vertical splitters, collapse/expand handlers and the 30 s
  bottom-panel auto-refresh. The main window is now a single vertical layout: toolbar + workspace.
- Removed the panels' dead dependencies: `HyperliquidClient.get_recent_fills()` /
  `get_all_positions()`, the orphaned `GOLD`/`GREEN`/`RED` style aliases and `ICON_BUTTON_STYLE`, and
  the `sidebar_collapsed` / `bottom_panel_collapsed` window-state keys.
- Alert persistence (`data/alerts.json`) stays — it still powers the toolbar's Set Alert and Open
  Browser actions. Runtime files `data/alert_coin.json`, `data/coindata.json` and `data/alerts.json`
  were left untouched (no UI reads the first two anymore).
- Verified: `compileall` + `import main`, 51 unit tests, and the offscreen Qt smoke (window layout,
  workspace boot, page errors `[]`).

## 2026-11-04 — in-app API keys, SSH removed
- **API keys dialog**: the synchronization-groups drawer (right slide-over) gained a key icon in its
  header. It opens a modal that reads/writes `keys/.env` through new QWebChannel slots
  (`credentialStatus` / `saveCredentials`) backed by `Core/credentials.py` — atomic 0600 writes,
  validation (64-hex HL key, `0x` + 40-hex address), duplicate-key collapse, and live application
  (`Core.config.refresh_credentials`, `HyperliquidClient.reset()`), so saved keys work without a
  restart. Only set/not-set metadata crosses the bridge; stored secrets never return to the UI or
  reach the log. Blank fields keep the stored value; the per-field `×` clears it on save.
- **SSH access removed**: dropped the SSH credential fields, `ALERT_SSH_*` settings, the paramiko
  dependency, remote alert push/pull, and the Cloud Panel's "pull failed" status. The sidebar now
  reloads local `data/alert_coin.json` / `data/coindata.json` (button renamed **↻ Reload**) and
  **Set Alert** only touches local `data/alerts.json`. Stale `ALERT_SSH_*` lines were stripped from
  `keys/.env`; legacy `keys/pkey*` files are left on disk.
- Verified: 51 unit tests, offscreen Qt credential-bridge smoke (save/reject/clear + live client
  reset), local sidebar reload (146 coins / 20 alerts), browser harness (drawer button, save, clear,
  error and 460 px layouts), and the full workspace Qt boot smoke with zero page errors.

## 2026-11-03 — free chart panning
- Dragging the chart vertically now shifts the visible price range, while horizontal movement keeps
  native time panning; diagonal drags pan both axes. Implemented through the series autoscale
  provider because Lightweight Charts v4 has no price-range API; the latest point is re-updated to
  force recalculation, and overlays/positions redraw in step.
- **Select** now behaves like a cursor: it no longer disables chart scrolling, so the rail can stay
  open while panning; blank drags reach LWC, while hits on drawings/positions still drag the object.
- Vertical offsets sync across charts in the same **absolute** price group, reset on double-clicking
  the price axis, Center, symbol/timeframe/price-mode/reference changes. Percentage and indexed modes
  use display units, so the pan distance is correct.
- Qt smoke adds a vertical-pan assertion (`priceOffset` changes, price at a fixed pixel changes).

## 2026-11-03 — drawing movement fix
- Drawings and position boxes can now be dragged directly in cursor mode: the overlay listens on the
  chart host only when a drawing/position is hit, so dragging an object moves it without starting a
  chart pan, while blank areas still pan/zoom normally.
- Position overlays now use the actual plot height (v4 `timeScale.height()` is the time-axis strip),
  fixing hit-testing/edge pinning and making entry/TP/SL drag and the stats card line up with prices.
- Shared drawing-drag math keeps shapes anchored in time/price; hline and vline move on their own
  axis; hover shows a move cursor; blur/destroy commits pending drags cleanly.

## 2026-11-03 — multi-chart only + full feature parity
- **Single chart removed**: `UI/chart_view.py`, `UI/web/chart.html`, `UI/web/chart.js` and
  `UI/handlers/indicators.py` are deleted. The embedded multi-chart workspace is the only chart view;
  the Qt coin/timeframe selectors, Center and Open Browser act on the focused panel, and the toolbar
  trade inputs are driven by workspace position drawings.
- **All chart studies moved into every panel**: sessions (Asian/London/NY AM/NY PM), FVG, MA ribbon,
  volume profile, daily VP, session VP, daily EMA, High/Low EMA, HL Scalp and ADX. Native indicators
  (SMA/EMA/BB/VWAP with D/W anchor/Volume/RSI/MACD/ATR) run in JS; advanced studies are computed by
  `Core/workspace_indicators.py` from the panel's own exchange candles (all 8 exchanges) and rendered
  as line overlays, canvas boxes/profiles and oscillator panes. The advanced config dialog opens from
  the Indicators popup and refreshes every panel.
- **Drawing/trade parity**: long/short position projections with mirrored stops, drag-editable
  entry/TP/SL with off-screen edge pinning, time-anchored right edge, stats card (R/R, qty, margin,
  risk, reward), position settings (account/risk/leverage/width), per-symbol local persistence, trade
  input bridge, plus the measure tool and existing line/rect/Fib/text annotations.
- **Workspace remains the only view**; startup and toolbar sync follow the focused panel.
- Tests: 21 Node synchronization tests and 40 Python tests (market data, workspace store, advanced
  studies); real offscreen/Wayland smoke covers live data, focused-panel sync, advanced studies,
  position→trade inputs and measure.

## 2026-11-03 — workspace integration + modern UI
- **Embedded workspace view**: the multi-chart workspace now lives inside the main window's chart
  area (`QStackedWidget`) instead of a separate window, and is the default startup view (the mode is
  persisted in `window_state.json`). The toolbar **Workspace** button is a checkable toggle (accent when
  active, `Ctrl+Shift+W`), the hidden single chart's Binance poller is paused, and
  `UI/workspace_window.py` was replaced by the reusable `UI/workspace_view.WorkspaceWidget`. HTML
  fullscreen now promotes the host window. Fixed restored-collapsed-sidebar splitter sizing so the
  workspace fills the chart pane without a black gap.
- **Modern workspace redesign**: new graphite/amber surface system, brand mark, grouped command bar
  (layout, sync LEDs with SYNC label, Scale/Snap fields), context sub-bar with group chips, empty-cell
  "Add chart" placeholders, hover-revealed panel tools, change pills, footer legend with colour dots,
  refreshed symbol picker, indicator switches, group drawer with backdrop, and container-query
  responsive panel headers (chart type / market / change hide before anything overlaps).

## 2026-11-03
- **Multi-chart analysis workspace**: new standalone window (toolbar **Workspace**) hosting 1/2/4/6/8-chart
  or custom resizable layouts in a single QWebEngine page, with add/remove, maximize, drag-reorder,
  fullscreen, and per-chart exchange/market/symbol/timeframe/chart-type/indicator/price-scale state.
  - `Core/market_data.py`: public adapters for Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io and
    Bitget (spot + perpetual where available), normalized UTC OHLCV, searchable symbol catalogs with disk
    fallback, timeframe capability map with real OHLCV aggregation, TTL/LRU candle cache and per-host
    throttling. No synthetic candles.
  - `UI/web/chart_sync.js`: framework-independent `ChartSyncManager` — timestamp-based crosshair sync using
    the destination chart's own price, visible **time-range** scroll/zoom sync with clamping and lazy history
    backfill, opt-in timeframe propagation, colour-coded synchronization groups with independent settings,
    absolute price-range coordination for quote-compatible instruments, rAF coalescing and echo guards.
  - Price-axis modes: independent, absolute (compatibility-guarded), percentage and indexed-100 with a
    display transform layer (raw OHLCV stays intact for tooltips/drawings) and first-visible / history-start /
    user-picked reference points.
  - `UI/web/workspace.js` + `workspace.html`: panels, layout engine with custom drag gutters, searchable
    exchange/pair picker (favourites, recents, market tabs), indicators (SMA/EMA/BB/VWAP/Volume/RSI/MACD/ATR),
    candlestick/hollow/OHLC/line/area/baseline types, and canvas drawing tools (hline, vline, trend, rectangle,
    Fibonacci, text).
  - `Core/workspace_store.py`: validated, atomic `data/workspaces.json` persistence with named workspaces and
    autosave.
  - Tests: 21 Node unit tests for the sync manager and 34 offline Python tests for market data + store;
    live provider checks for all eight exchanges; offscreen Qt smoke with real market data.

## 2026-10-19
- **Overlay sync during price-scale zoom/pan**: Lightweight Charts has no price-scale subscription, so canvas overlays (Long/Short boxes, sessions, FVG, volume profiles, Daily EMA, measure) only refreshed on time-scale or wheel events and lagged while the price axis was dragged. The chart now runs a requestAnimationFrame redraw loop for the duration of any pointer gesture on the chart, adds a capture-phase wheel listener (LWC may stop wheel propagation from the price axis), and performs one final redraw on pointerup/cancel/blur. Verified in the browser harness: 6 redraws while holding, 3 more during a move, loop stopped on release, wheel on the price axis triggered a redraw, zero console errors.
- **Unrestricted box resize + TradingView-style width**: Long/Short drawings now resize with no limits. Entry/TP/SL handles map directly to the pointer price (off-screen levels stay reachable through the existing edge proxies), removing the 50%-of-pane height cap and the visible-range clamps. The right edge is now **time-anchored** (`endTime`) instead of a fixed pixel width, so it scales with zoom and can be dragged arbitrarily into future whitespace with no 500px maximum; legacy pixel-width drawings are migrated on load. The `Box width (px)` setting is now only the default for new boxes and accepts any positive value. Verified in the browser harness: width extended to 720px (previously capped at 500), zoom changed the pixel span while the time span stayed fixed, TP/entry drags moved beyond the old pane cap / off-screen, and legacy width-only drawings migrated cleanly.
- **Drawn boxes replace chart trade lines**: removed the entry/TP/SL trade-line overlay (lines, drag-to-edit, PnL titles), its **Trade Lines** row in the Indicators popup, the **Price Lines** config group, the top-bar **LONG/SHORT** quick buttons, and the quick-price/HL line-sync path. Selecting a box, creating one, or finishing a level/body/resize drag now pushes its entry / TP / SL / direction straight into the trade inputs (validated, qty recalculated) through a new `positionDrawingChanged` bridge signal, so the drawing is the single trade source of truth. Removed the now-dead bridge APIs (`setEntryPrice`, `setTP`, `setSL`, `setTradeVisible`, `setRiskAmount`, `setOpenTradeQty`, `setPositionDir`, `clearAllLines`, line dragging, trade toggle), chart-line visibility state, and line-related window/config keys. `Update Order` / `Set Order` remain in the top toolbar.
- **Repo restructure**: flattened the `Trade_Panel/` package into top-level layers at the repo root — `UI/`, `Core/`, `Indicator/`, `Exchange/`, `keys/`. Entry point is now `main.py`; imports are `Core.*`, `Indicator.*`, `Exchange.*`, `UI.*`. Chart assets moved to `UI/web/` and `WEB_DIR`/`BUNDLED_WEB_DIR`/PyInstaller datas follow. Credentials (`.env`, `pkey`, `pkey.ppk`) moved to `keys/` (gitignored); `Core/config.py` loads `keys/.env`, falls back to a legacy root `.env`, and falls back to `keys/pkey` when the configured SSH key path is missing. Updated `README.md`, `start.sh`, `build.py`, `Trade_Panel.spec`, and `tmp/preview.html`.
- **Long/Short sizing + resize guide**: new boxes and vertical edits are capped to a total height of 50% of the plot, further limited by the visible top/bottom margins, so both edges stay visible. Level/body drags are clamped into the visible price range; the symmetric create path uses half the cap per edge. While dragging a level/body (or the width grip), a dotted horizontal guide is drawn at the active price and removed on release/cancel. The edge proxies from the previous pass remain only as a fallback for older drawings that become off-screen after zooming.
- **Chart viewport fix**: the chart no longer jumps to `fitContent()` when data refreshes. VWAP overlay updates (pushed on every candle close) were calling `fitContent()` whenever VWAP was visible, resetting the user's zoom/pan; the chart now preserves the visible logical range on same-symbol reloads and only fits on first load or symbol/timeframe switch. Explicit **Center chart** still fits.
- **Amber Terminal Noir UI**: applied the superdesign-alpha system to both layers.
  - Qt: new tokens, font fallback stack and global QSS in `UI/styles.py`; `configure_app()` in `main.py`; hairline card surfaces, mono numeric inputs, amber focus/primary actions, green/red trade semantics across toolbar, sidebar, trade history and config dialog.
  - Web chart: `:root` tokens, hairline graph-paper panel texture, amber indicator/CTA/focus states, dark surfaces, success/danger candles, and mono readouts in `UI/web/chart.html` + `UI/web/chart.js`. IDs, JS behavior and persistence contracts unchanged.
  - Verified: `compileall`, `node --check UI/web/chart.js`, offscreen Qt smoke, xvfb launch, live SSH sync, and a browser-driven chart pass with zero console errors.

## 2026-10-18
- **Drawing tool UX fixes**: three issues reported after the first cut.
  - **Settings no longer cover the chart**: the always-on long/short settings panel was replaced by a gear-anchored popover in the drawing rail, hidden by default (`display:none`), closed on outside click, when the Indicators popup opens, or with `Esc`. It sits beside the rail and only contains the sizing inputs.
  - **Future placement fixed**: a drawing dropped to the right of the last candle was snapping back to the last bar. Anchors in whitespace now extrapolate through an affine time↔pixel map built from the last two bars (`_futureMap`), which is exact where LWC's `coordinateToLogical` is bar-quantized; `_anchorX`/`_timeToX` render them and body drags move them deeper into the future. In-range anchors still snap to the nearest bar per timeframe.
  - **One drawing per activation**: after a box is placed the tool drops back to cursor/select mode and keeps the new drawing selected, so a stray click no longer adds another projection.
  - Also: `Esc` now works from a focused field and closes the settings popover; `Delete` is still suppressed while typing; closing the Indicators popup releases focus from its search box so chart shortcuts keep working.
  - Files changed:
    - `web/chart.js` — `_futureMap`/`_timeAtX`/`_timeToX` whitespace anchoring, `_anchorX` future-first, body-drag time via `_timeAtXClamped`, auto-select on `_onPointerUp`, `setSettingsOpen`/`toggleSettings`/`closeSettings` + outside-click, `reanchor` leaves future anchors untouched, keyboard guard split (Escape always, Delete only when not typing), `position_tool` registry row renamed "Drawings", indicators `panelOpen` closes the popover, `window.togglePositionSettingsUI`.
    - `web/chart.html` — rail gear button, `#position-tool-ui` turned into a popover (rail-adjacent, mobile placement), panel slimmed to sizing inputs only.

- **Long / Short drawing tool (TradingView-style)**: The chart now has a left drawing rail with Select, Long Position, Short Position and Clear.
  - **Draw**: pick Long or Short, then drag on the chart from entry to target. A live projection renders while dragging; the stop mirrors the target 1:1 on release and every level stays draggable. A plain click places a quick box with `Risk%` stop and 2R target.
  - **Edit**: drag the body to move a drawing in time and price, drag entry/target/stop lines to tune individual levels, or use the mid-edge grip (placed in the widest zone gap) to resize. `Esc` exits drawing mode, `Delete` removes the selected drawing, the trash button clears all.
  - **Read**: each drawing shows price tags (`@entry`, target/stop price + %) and a stats card with R/R, qty, margin, risk and reward from `Acct` / `Risk%` / `Lev`.
  - **Persist**: drawings are stored per symbol in local storage, survive coin/timeframe switches and app restarts, and re-anchor to the nearest bar when the timeframe changes. A symbol that owns drawings reopens them in select mode.
  - **Integrate**: drawing mode locks chart panning while armed, and yields cleanly to the Measure tool; the legacy click-to-place Position Tool behavior is preserved as the quick-click path.
  - Files changed:
    - `web/chart.js` — `ChartApp.positionTool` rewritten (drag-to-draw, preview, selection, level/body/resize drags, price tags, stats card, per-symbol persistence); new Tools registry rows `long_position` / `short_position`, `position_tool` renamed to "Drawing Panel"; `applyCandleData` records price precision and re-anchors drawings; `setCoinWithData` swaps drawings per symbol instead of clearing; trade-line/measure gesture guards; `window.toggleLongPositionUI` / `toggleShortPositionUI` / `selectDrawingsUI` / `clearPositionDrawings` helpers.
    - `web/chart.html` — new `#drawing-toolbar` rail (SVG icons, ARIA, mobile layout), `#draw-mode-hint` status pill, restyled Position Drawings panel, updated help text.

## 2026-07-29
- **Session Volume Profile**: New volume profile indicator aligned to trading session boundaries (Asian/London/NY AM/NY PM). Only computes for the currently active session — no historical session VP.
  - Starts at the 1st candle of the active session, ends at the start of the next session.
  - Updates dynamically on each candle close: high/low range expands as new candles arrive.
  - Histogram bars drawn from the session start x-coordinate, growing rightward. Includes POC line and 70% Value Area.
  - Uses the existing session definitions (configurable via ⚙ Config → Sessions) for start/end boundaries.
  - Toggled via the "Session VP" button in the chart's indicator toggle bar.
  - Added files:
    - `Trade_Panel/core/indicators/volume_profile.py` — `compute_session_volume_profile()`, `_get_current_session_info()` with 1-second TTL cache
    - `Trade_Panel/core/indicators/__init__.py` — re-exports
    - `Trade_Panel/core/indicators/config.py` — default config (`enabled: false`)
    - `Trade_Panel/ui/chart_view.py` — `set_session_vp_data()` / `toggle_session_vp()` bridge methods, `_sessionVpReady` signal, data pipeline in `_compute_indicator_data()` and `refresh_indicators()`
    - `web/chart.html` — "Session VP" toggle button
    - `web/chart.js` — `ChartApp.sessionVolumeProfile` module with `drawSessionVP()`, state (`sessionVpVisible`, `sessionVpDataCache`), `setSessionVPData()`/`toggleSessionVP()` API

## 2026-06-06
- **Daily 9 EMA indicator**: New configurable EMA overlay computed on daily close prices and mapped to the current timeframe.
  - Computes EMA(length, default 9) on daily candle closes.
  - Line is **green** when the previous daily close > previous daily EMA (bullish), **red** otherwise.
  - Rendered on a 2D canvas overlay as a stair-step polyline: flat horizontal segment per day with vertical connectors at day boundaries. Each segment is coloured independently (green/red) based on the previous day's close vs. EMA.
  - Length is configurable (2–200) via the config dialog (⚙ Config → "Daily 9 EMA" group).
  - Toggled via the "Daily EMA" button in the chart's indicator toggle bar.
  - Visibility persisted globally via window state (`daily_ema_visible`).
  - Added files:
    - `Trade_Panel/core/indicators/daily_ema.py` — core computation logic
    - `Trade_Panel/core/indicators/__init__.py` — re-exports
    - `Trade_Panel/core/indicators/config.py` — default config (`length: 9`, `enabled: false`)
    - `Trade_Panel/ui/config_dialog.py` — "Daily 9 EMA" config group with EMA length field
    - `Trade_Panel/ui/handlers/indicators.py` — `toggle_daily_ema()`, `apply_config()` wiring
    - `Trade_Panel/ui/chart_view.py` — `set_daily_ema_data()` / `toggle_daily_ema()` bridge methods
    - `Trade_Panel/ui/main_window.py` — visibility persistence (`daily_ema_visible`)
    - `web/chart.html` — "Daily EMA" toggle button
    - `web/chart.js` — `ChartApp.dailyEma` module, two-series rendering, `setDailyEmaData()`/`toggleDailyEma()` API
  - Pine Script equivalent:
    ```pinescript
    day_1 = request.security(syminfo.tickerid, "1D", close)
    ema9 = ta.ema(close, 9)
    ema9_1d = request.security(syminfo.tickerid, "1D", ema9)
    color_line = color.white
    if day_1[1] > ema9_1d[1]
        color_line := color.green
    else
        color_line := color.red
    plot(ema9_1d, color = color_line, title = 'daily_9ema')
    ```

- **Fix: Daily 9 EMA rendering**: Resolved two visual bugs in the daily EMA overlay.
  - **Disconnected segments**: The line is now drawn as a continuous stair-step polyline — each day contributes a flat horizontal segment with a vertical connector to the next day's segment at the day boundary. Weekend gaps correctly show no connector.
  - **Last segment overshoot**: The last segment no longer extends past the rightmost intraday candle; it is clipped to the last bar's time.
  - **Edge artifacts**: Connectors are only drawn when the day boundary is on-screen, eliminating spurious vertical lines at the chart edges.
  - **Coordinate handling**: Fixed pre-existing bug where segments starting off-screen left had their start clamped to the right edge, drawing the horizontal line in the wrong direction.
  - **Cleanup**: Removed unused `_TF_SECONDS` dict and `tf_step` variable from `daily_ema.py`.
  - Files changed:
    - `Trade_Panel/core/indicators/daily_ema.py` — clip last segment to last bar; remove dead code
    - `web/chart.js` (`ChartApp.dailyEma.draw()`) — vertical connectors; fix off-screen coordinate handling

## 2026-05-09
- **Fix: Update Order popup notification**: When "Update Order" is pressed, a QMessageBox popup now appears saying "Order was successfully updated" on success, or shows the error on failure. Previously the return value of `update_order()` was silently discarded.
  - `main_window.py`: Captured `(success, msg)` return from `TradeHandler.update_order()`, added `_show_order_result()` method that shows a `QMessageBox`. Used `_orderResult = Signal(bool, str)` to safely marshal from the Python background thread to the Qt main thread (replacing broken `QTimer.singleShot` approach — `QTimer` doesn't safely cross non-Qt thread boundaries).

## 2026-05-08
- **Candle close indicator refresh**: When a candle closes (new candle time detected in JS realtime poll), all indicators (VWAP, FVG, Sessions, EMA Ribbon, Volume Profile) are automatically recomputed and pushed to the chart via Python background thread.
  - `chart.js`: Added `lastCandleTime` state tracking. Realtime handler detects time change → calls `bridge.onCandleClosed(coin, tf)`.
  - `chart_view.py`: Added `ChartBridge.onCandleClosed` slot, `ChartView.candleClosed` signal, `refresh_indicators()` method (background thread recomputes all indicators without full chart reload).
  - `main_window.py`: Wires `candleClosed` signal → refreshes indicators for current coin.

- **EMA Ribbon: Separate config per line**: Replaced single `base_length` (x2/x3) with independent `length1`, `length2`, `length3` config parameters.
  - `ema_ribbon.py`: Replaced `_ribbon_base_length` with `_ribbon_lengths` list. New `set_ribbon_lengths()`/`get_ribbon_lengths()` API.
  - `config.py`: Default config uses `length1: 20, length2: 40, length3: 60`.
  - `config_dialog.py`: 3 separate input fields for each line length.
  - `indicators.py` handler: Reads `length1/2/3` from config, passes to `set_ribbon_lengths()`.
  - `indicator_config.json`: Updated to new format.

## 2026-05-04
- **Packaging**: Added PyInstaller support (`Trade_Panel.spec` + `build.py`) to produce standalone executables for Windows & Linux.
- Patched `Trade_Panel/config.py` to resolve paths relative to the executable when running as a frozen bundle (`sys.frozen`). Added `BUNDLED_WEB_DIR` pointing to `sys._MEIPASS/web/` for bundled assets.
- Patched `Trade_Panel/ui/chart_view.py` to copy bundled web assets to writable `WEB_DIR` on first run, so XHR for `chart_data.json` resolves correctly in frozen bundles.

## 2026-05-04
- **Coin_List dropdown**: Added `combobox-popup: 0;` to COMBOBOX_STYLE — forces Qt to use list-based popup that respects `setMaxVisibleItems(20)`. Fixes all coins showing at once. Dropdown now shows 20 items, scrollable for rest, auto-closes on outside click.

## 2026-05-05
- **PnL from open trade**: When a position is loaded from Hyperliquid, PnL on the entry line is now calculated using actual `qty` and `entry_price` from the exchange (`qty * (currentPrice - entryPrice)`) instead of deriving qty from risk/sl-distance.
  - `chart.js`: Added `openTradeQty` state field, `_getQty()` helper, `setOpenTradeQty()` API. `calcPnL`/`calcCurrentPnL` use actual qty when set.
  - `chart_view.py`: Added `set_open_trade_qty()` bridge method.
  - `position.py`: Passes `abs(size)` to chart when applying HL position.
  - `trade.py`: Resets `openTradeQty` on new long/short trades (falls back to risk-based qty).
- **Fix short PnL sign bug**: Direction was inferred from SL position relative to entry. Moving SL below entry for a short would flip PnL sign. Now stores actual `positionDir` (1=long, -1=short) from exchange data and uses it for PnL calc regardless of where SL is dragged.
