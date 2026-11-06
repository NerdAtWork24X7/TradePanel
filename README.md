# TradePanel — Crypto Trading Terminal

A desktop trading panel for Hyperliquid with a synchronized, multi-exchange chart
workspace. The desktop shell is **Tauri 2** (Rust); the trading engine and exchange
integrations run in a supervised Python sidecar, the chart workspace is TypeScript/
JavaScript, and every technical study comes from
[`lightweight-charts-indicators`](https://github.com/deepentropy/lightweight-charts-indicators)
(1,869 indicators on Lightweight Charts 5.2).

Target platforms: **Windows 10/11** and **Linux** (Ubuntu / Linux Mint).

## Architecture

```
TradePanel/
├── src-tauri/                 # Tauri 2 shell (Rust)
│   ├── src/
│   │   ├── main.rs            # binary entry
│   │   ├── lib.rs             # plugins, state, lifecycle
│   │   ├── commands/          # allow-listed IPC, credentials, updates, order gate
│   │   ├── sidecar/           # spawn, handshake, health, restart, shutdown
│   │   ├── security/          # OS keyring store + validation
│   │   ├── ai/                # supervised read-only Pi runtime + AI commands
│   │   ├── protocol.rs        # JSON-RPC framing, allow-list, error codes
│   │   ├── events.rs          # backend status / event emission
│   │   └── config.rs          # app-data paths, legacy import, sidecar resolution
│   ├── capabilities/          # minimal WebView permissions
│   ├── icons/
│   ├── backend-dist/          # staged one-folder sidecar (generated)
│   ├── ai-runtime/            # staged Node + Pi runtime (generated)
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── frontend/                  # shell UI (TypeScript + Vite, no framework)
│   ├── src/
│   │   ├── app/               # controller, startup, reconnect handling
│   │   ├── components/        # toasts, modals, settings, AI Analysis panel
│   │   ├── services/          # backend, trading, market-data, account,
│   │   │                      # analysis, workspace, credentials, settings, ai
│   │   ├── ai-snapshot/       # offscreen LWC chart renderer (iframe page)
│   │   ├── lib/               # markdown, indicator engine kit, candles,
│   │   │                      # market levels, snapshot host
│   │   └── styles/            # Pi Scope tokens, fonts, shell + AI CSS
│   ├── web/                   # shared chart workspace (served by Vite/Tauri)
│   │   │                      # workspace.html/js, chart_sync.js, LWC 5.2.1,
│   │   │                      # indicators/ (generated engine + catalog),
│   │   │                      # tauri_bridge.js (compatibility adapter), fonts/
│   ├── tests/                 # bridge, drawing and AI markdown contract tests
│   ├── index.html
│   ├── snapshot.html          # hidden AI chart renderer page
│   └── package.json
│
├── ai/runtime/                # pinned Pi runtime source (package.json, extension, prompt)
├── backend/                   # Python sidecar + trading/analysis engine
│   ├── sidecar.py             # entry, stdout defence, signals
│   ├── ipc/                   # JSON-RPC server, methods, credentials, protocol
│   ├── build/                 # PyInstaller spec + build requirements
│   ├── requirements.txt       # pinned sidecar runtime
│   ├── Core/                  # Qt-free business logic (market data, persistence,
│   │   ├── trading_service.py #   calculations, shared trading operations)
│   │   ├── config.py          # data-dir / keyring env overrides
│   │   ├── market_data.py
│   │   └── workspace_store.py #   chart/indicator-list persistence
│   ├── Exchange/              # exchange integrations (Hyperliquid)
│   ├── strategies/            # strategy scripts/assets
│   └── scripts/               # dev/build-backend/build-release/test entry points
│
├── docs/                      # audit, architecture, IPC, security, build, testing
├── start.sh                   # launcher (deps + sidecar + tauri dev)
├── build.sh                   # reproducible release build for this platform
└── data/                      # legacy runtime data (migrated on first run)
```

The workspace HTML/JS lives in exactly one place (`frontend/web`) and is served to Tauri.
Only a 7 KB adapter file is new.

## Quick start

Prerequisites: Rust 1.77+, Node 20+, Python 3.12, uv, and the Tauri Linux
dependencies (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, …). Full details:
[`docs/BUILD.md`](docs/BUILD.md).

```bash
./start.sh                      # deps + PyInstaller sidecar (if missing) + tauri dev
./start.sh --rebuild-backend    # force a fresh sidecar, then launch
```

Release bundles:

```bash
./build.sh                      # current platform (AppImage+.deb / dmg / NSIS)
./build.sh --debug              # debug bundle
./build.sh --skip-backend       # reuse the staged sidecar
powershell -File backend/scripts/build-windows.ps1   # native Windows release
```

Manual steps behind the scripts:

```bash
npm install && npm --prefix frontend install
backend/scripts/build-backend.sh        # PyInstaller sidecar → src-tauri/backend-dist
npx tauri dev                   # or: npx tauri build
```

Tests:

```bash
backend/scripts/test.sh
```

## Desktop shell

* Pi Scope theme: warm near-black surfaces, one amber accent, Clash Grotesk /
  Satoshi / Meslo type, light + dark toggle (persisted in `localStorage`).
* Chart workspace: neutral OpenTrader/TradingView chrome (grey surfaces, blue
  accent, flat 1 px pane seams), OHLC readout plus one legend per indicator pane,
  floating zoom/reset/latest bar controls, 86 drawing-tool glyphs and the shell's
  filled SVG icon set (`frontend/web/icons`, MIT).
* Resizable, collapsible trade sidebar: Coin/TF + refresh icon, Center /
  Hyperliquid / Open ↗ on one line, QTY/RISK, direction + LIM, TP/SL, Read order,
  Update Order, Set Order. Drag the inner edge (or focus it and use the arrow
  keys) to resize; the width persists in `localStorage`. The Coin/TF row follows
  the focused chart. Collapsed it becomes a floating rail that parks off-screen
  (revealed at the right edge or by keyboard focus) so the charts own the full
  window.
* Backend status pill and banner. Any non-running backend disables trading controls;
  reconnection never submits an order.
* Settings (Ctrl+,): AI analysis indicators, credential management, signed app updates
  and in-app Pi (AI runtime) updates.
* Ctrl+Shift+T collapses the sidebar to the floating rail (the workspace's
  **Trade** button does the same).
* Preferences persist in the existing window-state JSON (merged, never reset).

## Multi-chart workspace

The workspace fills the chart area and is the only chart view: Lightweight Charts 5.2.1,
one WebView for all charts, timestamp-based synchronization, groups, layouts (`1`, `2h`,
`2v`, `4`, `6`, `8`, custom), drawings, position projections, measure tool, price-axis
modes (independent/absolute/percentage/indexed) and per-symbol drawing persistence.

It shares the shell's Pi Scope tokens (`frontend/web/workspace.html` mirrors
`frontend/src/styles/tokens.css`) and follows the light/dark toggle: the shell writes
`tp-theme` to the shared origin's localStorage, the workspace picks it up through the
`storage` event and repaints the charts from the `--chart-*` tokens.

Live data comes from Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, Bitget and
Hyperliquid public endpoints. Python owns all exchange I/O; the WebView makes no external
network requests (the CSP only allows same-origin assets, including the locally built
indicator engine/catalog).

### Synchronization (`frontend/web/chart_sync.js`)

Crosshair, visible time range, scroll, zoom and (optionally) timeframe are synchronized by
**timestamp**, never by array index. Nearest-candle policy is configurable with a drift cap;
missing data clears the destination crosshair instead of inventing a candle. Groups carry
independent settings and colours; re-entrancy guards and rAF coalescing prevent loops.

### Exchange coverage

| Exchange | Spot | Perpetual |
|---|---|---|
| Binance | ✓ | ✓ (USDT-M) |
| Bybit | ✓ | ✓ (linear) |
| OKX | ✓ | ✓ (USDT swap) |
| Coinbase | ✓ | — |
| Kraken | ✓ | — |
| KuCoin | ✓ | ✓ |
| Gate.io | ✓ | ✓ (USDT) |
| Bitget | ✓ | ✓ (USDT-M) |
| Hyperliquid | ✓ | ✓ (USDC) |

Unsupported intervals are aggregated from a lower interval and tagged in the timeframe menu.
Monthly/weekly aggregation uses UTC calendar boundaries.

### Indicators

Every study on every chart comes from
[`lightweight-charts-indicators`](https://github.com/deepentropy/lightweight-charts-indicators)
(`0.19.3`, `oakscriptjs` 0.15) — 117 standard studies, 1,707 community scripts and
45 candlestick patterns, all computed in the WebView from the panel's own candles.

* **Add / remove**: the funnel button in a panel header opens a searchable picker
  (Technical / Community / Patterns tabs, grouped by category, `Enter` adds a
  unique match, up to 20 studies per chart).
* **Settings**: each study has an `Inputs` / `Style` / `Visibility` dialog with live
  preview — `Cancel` restores the previous inputs, `Apply` persists them. Inputs are
  generated from the indicator's own `inputConfig` (lengths, sources, MA types,
  colours, widths, per-plot visibility) and inactive inputs follow the library's
  `active` conditions.
* **Legend**: one row per study, anchored to the top-left of its pane — eye toggle
  (hidden studies keep their settings), title (opens settings), last/crosshair value
  and a settings button. Overlay studies stack under the OHLC readout.
* **Panes**: overlays draw on the price pane, oscillators get their own panes in
  add order (3:1 price-to-oscillator stretch, drag a separator to resize; the
  legend follows the pane).
* **Live updates** reuse series (`reuseSeries`) so a tick only pushes the newest
  points; price mode changes (percentage/indexed) recompute on the transformed bars
  so overlays stay aligned with the candles.

The engine (~10 MB IIFE) and its browse catalog are built by
`npm --prefix frontend run indicators` (also runs automatically before
`dev`/`build`) from `frontend/node_modules`; nothing indicator-specific is
hand-written in this repository.

### Drawing and trade tools

Long/Short position boxes follow TradingView's long and short position tools:
drag entry→target and the stop mirrors 1:1, or click once for a 2R template. Every box
carries right-edge entry/target/stop tags with price and signed percentage, an in-box
quantity tag and account-balance tags at target and stop. The selected box opens a stats
panel with quantity, risk/reward, target and stop in price, percentage and ticks, risk,
reward, balances at each exit, and open PnL (or the PnL at the box's right-edge close).
Hovering a level shows a `ns-resize` cursor, the right edge `ew-resize`, the body `move`;
dragging entry/target/stop draws a dotted guide across the chart until release, and
double-click opens the editor. Position settings cover account size, risk as a percentage
or a fixed USDT amount, leverage, lot size, quantity precision, default width, stats
visibility and compact mode, plus entry/target/stop editing and a 1:1 stop reset with a
live preview. Position drawings persist per symbol in local storage and the selected box
feeds the trade ticket.

All other chart drawings come from
[`lightweight-charts-drawing`](https://github.com/deepentropy/lightweight-charts-drawing)
(MIT, 86 TradingView-parity tools) rendered as a Lightweight Charts v5 series primitive:
trend lines, rays, channels, pitchforks, Fibonacci and Gann tools, chart patterns,
Elliott waves, cycles, forecasts, volume profiles, measurers, brushes, arrows, shapes,
text/notes, table, image and font icon. The left rail is your personal toolbar: pin a tool
with the ☆ in the **All tools** catalog (or right-click a pinned tool to unpin) and up to
eight pinned tools show next to the cursor. The catalog adds instant search, recently used
tools, a magnet toggle and hide-all. Selecting a drawing opens a style bar (colour, line
width, dash, lock, delete); text notes and table cells edit in place, and drawings are
saved per chart in the workspace store, including after timeframe, chart-type and
percentage/indexed price-mode changes. The measure tool and the trade-linked long/short
position boxes remain custom.

## AI Analysis (Pi)

The right sidebar has two tabs — **Trade** (instrument + order ticket) and
**AI Analysis** — so the analysis owns the full column height instead of a
stacked strip. `Ctrl+Shift+A` jumps to the AI tab; `Ctrl+Shift+T` shows/hides the
sidebar.
It runs the bundled Pi 1.5.0 agent on a bundled Node 22 runtime, so the installed
application needs no Node, npm, Pi CLI or terminal. Provider sign-in, model
selection and the rest of the app's settings live on a separate, tabbed Settings
page opened from the gear button to the right of **Trade** (or `Ctrl+,`).

* **Start analysis is explicit.** The panel renders the current instrument's
  **1d, 4h and 5m** charts offscreen with the same indicators that are visible on
  the focused chart (overlays on the price pane, up to three oscillator panes),
  volume and ticket levels, then attaches the three PNGs to the prompt. This
  replaces sending hundreds of candles as text and cuts token use by an order of
  magnitude.
* The AI indicator set follows the focused chart: add, remove, hide or retune a
  study there and the next analysis uses it — there is no second UI to keep in
  sync.
* Pi receives a compact snapshot (instrument, freshness, per-timeframe indicator
  values, structural levels, optional portfolio, read-only ticket) through five
  `panel_*` tools. It has no shell, file, network or trading tools.
* The answer ends with a validated plan card: **LONG/SHORT/NO TRADE, entry,
  take-profit, stop-loss, R:R**. The card can fill the ticket as a user action;
  it never submits an order.
* Conversations persist as Pi session files under the OS app-data directory and
  restore without starting Pi.
* Provider sign-in uses Pi's own authentication runtime: OAuth/device flows and
  API keys are handled by the bundled agent and stored in its owner-only
  `agent/auth.json`. Settings → AI Analysis lists every provider Pi supports,
  highlights signed-in accounts and shows the models they unlock.
* Settings → Updates keeps Pi current: it asks npm for the latest
  `@earendil-works/pi-coding-agent` release, installs it with its npm
  dependencies into `<app-data>/ai/runtime/<target>` (never into the read-only
  installation), verifies the CLI and the analysis extension, then restarts Pi
  on the new tree. No Node or npm is needed on the machine — the build ships
  both — and no lifecycle scripts run during the install.

Stage and test the runtime:

```bash
npm run ai:runtime        # download Node + install pinned Pi (build-time only)
npm run test:ai           # mock-provider end-to-end: images, tools, plan, abort
npm --prefix frontend test
```

Details: [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md),
[`docs/AI_SECURITY.md`](docs/AI_SECURITY.md),
[`docs/STANDALONE_BUILD.md`](docs/STANDALONE_BUILD.md),
[`docs/AI_TROUBLESHOOTING.md`](docs/AI_TROUBLESHOOTING.md).

## Data, credentials and safety

* User data lives in the OS app-data directory. On first run a legacy `data/` directory is
  **copied** (missing files only, including SQLite WAL/SHM); the original is untouched.
* **Trading credentials** are stored in the OS credential store (Windows Credential
  Manager, Secret Service, Keychain). Nothing is written to `keys/.env` by the new app
  and secrets never reach JavaScript. A legacy `keys/.env` is detected and can be
  imported from Settings → Credentials. If the credential store is unavailable, the
  app fails explicitly — there is no plaintext fallback.
* **AI provider credentials** are stored by Pi in `<app-data>/ai/agent/auth.json`
  (mode 0600) after an OAuth or API-key sign-in. They are separate from trading keys
  and are never passed to the chart workspace or model prompt.
* Order submission is never retried automatically. Timeouts and sidecar exits during an
  order produce `EXECUTION_UNKNOWN`, persist a lock, and require the user to check open
  orders before re-enabling trading. Identical in-flight submissions are rejected in both
  the shell and the backend.
* Hyperliquid remains on the **testnet** endpoints, exactly as in the audited application.

Details: [`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/IPC_PROTOCOL.md`](docs/IPC_PROTOCOL.md).

## Documentation

| Document | Contents |
|---|---|
| [`docs/MIGRATION_AUDIT.md`](docs/MIGRATION_AUDIT.md) | original architecture, dependency map, risks, migration plan |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | process model, flows, failure handling, deviations |
| [`docs/IPC_PROTOCOL.md`](docs/IPC_PROTOCOL.md) | JSON-RPC envelope, error codes, every method and timeout |
| [`docs/SECURITY.md`](docs/SECURITY.md) | threat model, credentials, CSP/capabilities, order safety, updates |
| [`docs/BUILD.md`](docs/BUILD.md) | prerequisites, dev/build commands, packaging, updater, troubleshooting |
| [`docs/TESTING.md`](docs/TESTING.md) | suites, E2E evidence, performance, manual cross-platform checklist |
| [`docs/AI_INTEGRATION.md`](docs/AI_INTEGRATION.md) | Pi runtime, screenshots, tools, plan validation, conversations |
| [`docs/AI_SECURITY.md`](docs/AI_SECURITY.md) | read-only boundary, environment isolation, snapshot validation, provider auth |
| [`docs/STANDALONE_BUILD.md`](docs/STANDALONE_BUILD.md) | runtime staging, Windows/Linux packaging, clean-machine checklist |
| [`docs/AI_TROUBLESHOOTING.md`](docs/AI_TROUBLESHOOTING.md) | provider, runtime, rendering and history failures |

## Known limitations

* Windows runtime validation is pending (scripts and configuration are provided).
* Live/testnet order execution was not run during migration testing; the execution paths
  are preserved and guarded, but require a disposable-key testnet pass before release.
* The bundled Python sidecar is large (~267 MB on disk) because `pandas_ta` requires numba.
* The bundled AI runtime adds ~200 MB (Node + Pi dependencies). Chart snapshots are
  rendered by an offscreen WebView page, not a bundled Chromium.
* AI provider sign-in uses Pi's bundled authentication runtime (OAuth/device code
  or API key) and stores credentials in `agent/auth.json`; the Linux Secret Service
  is only required for Hyperliquid trading credentials. Provider keys are still
  never sent to the model or written into the analysis snapshot.
* Lightweight Charts 4.x has no native panes/toolkit; oscillator panes, session/FVG/VP
  boxes, measure and position projections are custom canvas layers.
* Absolute price sync deliberately skips charts with incompatible quote currency/scale.
* Symbol entry is search-driven: only instruments listed by the exchange/market can be used.
* Update installation requires a configured signing key and endpoint; unconfigured builds
  refuse updates by design. Pi updates are independent of that channel, need
  registry access, and are installed only after verification.
* An in-app Pi update is user data, not a signed artifact: tarballs are checked
  against npm's registry integrity values by the staged npm CLI, and updates
  only run with `--ignore-scripts`. Delete `<app-data>/ai/runtime/<target>` to
  return to the bundled Pi.

## Design principles

* **Core stays Qt-free** — all business logic is testable headlessly and reused by the
  sidecar; the UI layer is replaceable.
* **One chart implementation** — `frontend/web` is the only workspace copy; no fork.
* **The renderer is untrusted** — no secrets, no shell, no filesystem, no direct stdio.
* **Fail closed** — missing credentials, incompatible protocol, unavailable keyring and
  unsigned updates all stop the relevant operation instead of degrading silently.
* **Preserve trading behaviour** — order types, leveraging, sizing, TP/SL and duplicate
  semantics are the audited implementation.
