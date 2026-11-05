# TradePanel — Crypto Trading Terminal

A desktop trading panel for Hyperliquid with a synchronized, multi-exchange chart
workspace. The desktop shell is **Tauri 2** (Rust); the trading engine, exchange
integrations, indicators and chart workspace are the existing Python/JavaScript
implementation, running unchanged behind a supervised Python sidecar.

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
│   │   ├── protocol.rs        # JSON-RPC framing, allow-list, error codes
│   │   ├── events.rs          # backend status / event emission
│   │   └── config.rs          # app-data paths, legacy import, sidecar resolution
│   ├── capabilities/          # minimal WebView permissions
│   ├── icons/
│   ├── backend-dist/          # staged one-folder sidecar (generated)
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── frontend/                  # shell UI (TypeScript + Vite, no framework)
│   ├── src/
│   │   ├── app/               # controller, startup, reconnect handling
│   │   ├── components/        # toasts, modals, settings
│   │   ├── services/          # backend, trading, market-data, account,
│   │   │                      # indicators, workspace, credentials, settings
│   │   └── styles/            # Pi Scope tokens, fonts, shell CSS
│   ├── web/                   # shared chart workspace (served by Vite/Tauri)
│   │   │                      # workspace.html/js, chart_sync.js, LWC 4.2.2,
│   │   │                      # tauri_bridge.js (compatibility adapter), fonts/
│   ├── tests/                 # bridge adapter contract tests
│   ├── index.html
│   └── package.json
│
├── backend/                   # Python sidecar + trading/analysis engine
│   ├── sidecar.py             # entry, stdout defence, signals
│   ├── ipc/                   # JSON-RPC server, methods, credentials, protocol
│   ├── build/                 # PyInstaller spec + build requirements
│   ├── requirements.txt       # pinned sidecar runtime
│   ├── Core/                  # Qt-free business logic (market data, persistence,
│   │   ├── trading_service.py #   calculations, shared trading operations)
│   │   ├── config.py          # data-dir / keyring env overrides
│   │   ├── market_data.py
│   │   ├── workspace_store.py
│   │   └── workspace_indicators.py
│   ├── Indicator/             # technical studies
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
* Resizable, collapsible trade sidebar: Coin/TF + refresh icon, Center /
  Hyperliquid / Open ↗ on one line, QTY/RISK, direction + LIM, TP/SL, Read order,
  Update Order, Set Order. Drag the inner edge (or focus it and use the arrow
  keys) to resize; the width persists in `localStorage`. The Coin/TF row follows
  the focused chart. Collapsed it becomes a floating rail that parks off-screen
  (revealed at the right edge or by keyboard focus) so the charts own the full
  window.
* Backend status pill and banner. Any non-running backend disables trading controls;
  reconnection never submits an order.
* Settings (Ctrl+,): advanced indicator parameters, credential management, signed updates.
* Ctrl+Shift+T collapses the sidebar to the floating rail (the workspace's
  **Trade** button does the same).
* Preferences persist in the existing window-state JSON (merged, never reset).

## Multi-chart workspace

The workspace fills the chart area and is the only chart view: Lightweight Charts 4.2.2,
one WebView for all charts, timestamp-based synchronization, groups, layouts (`1`, `2h`,
`2v`, `4`, `6`, `8`, custom), drawings, position projections, measure tool, price-axis
modes (independent/absolute/percentage/indexed) and per-symbol drawing persistence.

It shares the shell's Pi Scope tokens (`frontend/web/workspace.html` mirrors
`frontend/src/styles/tokens.css`) and follows the light/dark toggle: the shell writes
`tp-theme` to the shared origin's localStorage, the workspace picks it up through the
`storage` event and repaints the charts from the `--chart-*` tokens.

Live data comes from Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, Bitget and
Hyperliquid public endpoints. Python owns all exchange I/O; the WebView performs no network
requests (enforced by CSP).

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

Per-panel toggles plus global parameters (Settings dialog):

| Indicator | Notes |
|---|---|
| SMA / EMA | per-chart length |
| Bollinger Bands | length/multiplier |
| VWAP | anchored (D/W) |
| Volume | base histogram |
| RSI / MACD / ATR | oscillator panes |
| Session boxes | Asian / London / NY AM / NY PM (UTC) |
| FVG | unmitigated 3-candle gaps above configured % |
| MA Ribbon | 3 lines, EMA/SMA, configurable lengths |
| Volume Profile / Daily VP / Session VP | horizontal profiles |
| High/Low EMA | EMA of candle highs/lows |
| ADX | ADX/±DI pane with reference levels |

Native overlays run in JavaScript on the panel's candles; session/FVG/VP/ADX are computed
in Python from the same exchange data and cached briefly.

### Drawing and trade tools

Long/Short position boxes (drag entry→target, stop mirrors 1:1; click for a 0.5 % stop with
2R target), Select (drag levels/edge, Delete removes, Esc exits), cursor move, pan (with
vertical price offset), measure, horizontal/vertical lines, trend lines, rectangles,
Fibonacci retracement and text. Position drawings persist per symbol in local storage and
the selected box feeds the trade ticket.

## Data, credentials and safety

* User data lives in the OS app-data directory. On first run a legacy `data/` directory is
  **copied** (missing files only, including SQLite WAL/SHM); the original is untouched.
* Credentials are stored in the OS credential store (Windows Credential Manager, Secret
  Service, Keychain). Nothing is written to `keys/.env` by the new app and secrets never
  reach JavaScript. A legacy `keys/.env` is detected and can be imported explicitly from
  Settings → Credentials.
* If the credential store is unavailable, the app fails explicitly — there is no plaintext
  fallback.
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

## Known limitations

* Windows runtime validation is pending (scripts and configuration are provided).
* Live/testnet order execution was not run during migration testing; the execution paths
  are preserved and guarded, but require a disposable-key testnet pass before release.
* The bundled Python sidecar is large (~267 MB on disk) because `pandas_ta` requires numba.
* Lightweight Charts 4.x has no native panes/toolkit; oscillator panes, session/FVG/VP
  boxes, measure and position projections are custom canvas layers.
* Absolute price sync deliberately skips charts with incompatible quote currency/scale.
* Symbol entry is search-driven: only instruments listed by the exchange/market can be used.
* Update installation requires a configured signing key and endpoint; unconfigured builds
  refuse updates by design.

## Design principles

* **Core stays Qt-free** — all business logic is testable headlessly and reused by the
  sidecar; the UI layer is replaceable.
* **One chart implementation** — `frontend/web` is the only workspace copy; no fork.
* **The renderer is untrusted** — no secrets, no shell, no filesystem, no direct stdio.
* **Fail closed** — missing credentials, incompatible protocol, unavailable keyring and
  unsigned updates all stop the relevant operation instead of degrading silently.
* **Preserve trading behaviour** — order types, leveraging, sizing, TP/SL and duplicate
  semantics are the audited implementation.
