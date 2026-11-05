# TradePanel — Crypto Trading Terminal

A desktop trading panel for Hyperliquid with a synchronized, multi-exchange chart
workspace. The desktop shell is **Tauri 2** (Rust); the trading engine, exchange
integrations, indicators and chart workspace are the existing Python/JavaScript
implementation, running unchanged behind a supervised Python sidecar.

Target platforms: **Windows 10/11** and **Linux** (Ubuntu / Linux Mint).
The legacy PySide6 app is still present and runnable during the migration.

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
│   │   ├── components/        # toasts, modals, settings, alerts
│   │   ├── services/          # backend, trading, market-data, account,
│   │   │                      # indicators, workspace, credentials, settings
│   │   ├── state/             # shell state helpers
│   │   └── styles/            # Amber Terminal Noir tokens + shell CSS
│   ├── tests/                 # bridge adapter contract tests
│   ├── index.html
│   └── package.json
│
├── backend/                   # Python sidecar
│   ├── sidecar.py             # entry, stdout defence, signals
│   ├── ipc/                   # JSON-RPC server, methods, credentials, protocol
│   ├── build/                 # PyInstaller spec + build requirements
│   └── requirements.txt       # pinned sidecar runtime
│
├── Core/                      # Qt-free business logic (market data, persistence,
│   ├── trading_service.py     #   calculations, shared trading operations)
│   ├── config.py              # data-dir / keyring env overrides
│   ├── market_data.py
│   ├── workspace_store.py
│   └── workspace_indicators.py
├── Indicator/                 # technical studies
├── Exchange/hyperliquid.py    # Hyperliquid SDK wrapper (testnet)
├── UI/                        # legacy PySide6 app + shared chart workspace
│   └── web/                   # workspace.html/js, chart_sync.js, LWC 4.2.2,
│                              # tauri_bridge.js (compatibility adapter)
├── docs/                      # audit, architecture, IPC, security, build, testing
├── scripts/                   # dev/build/test entry points
└── data/                      # legacy runtime data (migrated on first run)
```

The workspace HTML/JS lives in exactly one place (`UI/web`) and is served to both apps:
Vite copies it for Tauri, Qt loads it from disk. Only a 7 KB adapter file is new.

## Quick start

Prerequisites: Rust 1.77+, Node 20+, Python 3.12, uv, and the Tauri Linux
dependencies (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, …). Full details:
[`docs/BUILD.md`](docs/BUILD.md).

```bash
npm install
npm --prefix frontend install
scripts/build-backend.sh        # PyInstaller sidecar → src-tauri/backend-dist
scripts/dev.sh                  # Vite + Tauri with hot reload
```

Release bundles:

```bash
scripts/build-linux.sh          # AppImage + .deb
powershell -File scripts/build-windows.ps1   # NSIS installer
```

Tests:

```bash
scripts/test.sh
```

Legacy desktop app (still available until the new shell is signed off):

```bash
uv sync
source .venv/bin/activate
python main.py
```

## Desktop shell

* Amber Terminal Noir toolbar: coin/TF selectors, center-chart, Hyperliquid toggle,
  Open Browser, QTY/RISK/direction, LIM/TP/SL, Read order, Update Order, Set Order,
  favourites, FVG alert levels.
* Backend status pill and banner. Any non-running backend disables trading controls;
  reconnection never submits an order.
* Settings (Ctrl+,): advanced indicator parameters, credential management, signed updates.
* Alerts (Ctrl+Shift+A): per-coin FVG high/low, stored in the existing `alerts.json`.
* Ctrl+Shift+T hides the toolbar (the workspace's **Trade** button does the same).
* Preferences persist in the existing window-state JSON (merged, never reset).

## Multi-chart workspace

The workspace fills the chart area and is the only chart view. It is unchanged from the
audited application: Lightweight Charts 4.2.2, one WebView for all charts, timestamp-based
synchronization, groups, layouts (`1`, `2h`, `2v`, `4`, `6`, `8`, custom), drawings,
position projections, measure tool, price-axis modes (independent/absolute/percentage/
indexed) and per-symbol drawing persistence.

Live data comes from Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, Bitget and
Hyperliquid public endpoints. Python owns all exchange I/O; the WebView performs no network
requests (enforced by CSP).

### Synchronization (`UI/web/chart_sync.js`)

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
| [`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md) | phase log and definition-of-done status |

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
* **One chart implementation** — both apps share `UI/web`; no forked workspace.
* **The renderer is untrusted** — no secrets, no shell, no filesystem, no direct stdio.
* **Fail closed** — missing credentials, incompatible protocol, unavailable keyring and
  unsigned updates all stop the relevant operation instead of degrading silently.
* **Preserve trading behaviour** — order types, leveraging, sizing, TP/SL and duplicate
  semantics are the audited implementation.
