# TradePanel — PySide6 → Tauri 2 Migration Audit

> **Historical document.** Phase 0 deliverable, written before the migration. It
> describes the PySide6 application that has since been deleted: files and modules it
> names (`main.py`, `UI/`, `Core.candle_service.py`) no longer exist. Kept as the audit
> trail for the trading-behaviour and dependency review. Current design:
> [`ARCHITECTURE.md`](ARCHITECTURE.md).

Status: Phase 0 deliverable. No application source was modified to produce this document.
Audit date: 2026-11-05. Audited commit: `7ded81b` (`main`), branch `feature/tauri2-migration`.

## 1. Executive summary

TradePanel is a PySide6 6.x desktop application whose entire trading stack is already
UI-independent:

- `backend/Core/` (market data, persistence, calculations, credentials file I/O) and `backend/Indicator/`
  import **no Qt at all** (verified by grep and by reading every module's import block).
- `backend/Exchange/hyperliquid.py` is a thin wrapper over `hyperliquid-python-sdk` (testnet endpoints,
  hard-coded in the current implementation).
- The whole UI surface is `UI/` (~1.9k lines of Python) plus a vanilla-JS multi-chart
  workspace (`frontend/web/workspace.js`, 5.2k lines) that talks to Python through **one**
  QWebChannel object (`bridge`) and renders with Lightweight Charts 4.2.2.

Consequences:

1. The migration boundary is clean: a Python sidecar can expose the same calls the
   QWebChannel bridge exposes today, and no business logic needs rewriting.
2. The only Qt-specific code in the chart workspace is the `QWebChannel` bootstrap in
   `workspace.js` (36 lines) and a `qrc://` script tag in `workspace.html`. Both can be
   replaced by a compatibility adapter loaded before `workspace.js`; the rest of the
   workspace can stay byte-identical.
3. The Qt shell (toolbar, trade inputs, indicator dialog, window lifecycle) must be rebuilt
   in HTML/CSS/TypeScript. It is small: 12 toolbar signals, 6 workspace signals, 7 dialog groups.

Risk is therefore concentrated in process supervision, credential handling, and
Windows/Linux WebView differences — not in trading logic.

## 2. Current architecture

```
main.py
  └─ QApplication → configure_app() → MainWindow (QMainWindow)
       ├─ Toolbar (QWidget)                coin / TF / trade inputs / favourites
       ├─ WorkspaceWidget (QWidget)        QWebEngineView + QWebChannel bridge
       │    └─ frontend/web/workspace.html
       │         ├─ workspace.js           panels, layouts, drawings, indicators, sync
       │         ├─ chart_sync.js          ChartSyncManager (timestamp based)
       │         └─ lightweight-charts.standalone.production.js (v4.2.2)
       ├─ TradeHandler                     level validation, qty math, order placement
       ├─ PositionHandler                  background position read → toolbar
       └─ IndicatorConfigDialog            advanced study parameters

backend/Core/        config, models, calculations, coin/candle/market data, workspace store,
                     workspace indicators, credentials file, alerts, window state, utils
backend/Indicator/   fvg, vwap, sessions, ema_ribbon, hl_ema, adx, volume_profile, config
backend/Exchange/    hyperliquid.py (Info/Exchange SDK wrapper, singleton)
keys/.env    HL_PRIVATE_KEY, HL_ADDRESS (plaintext, gitignored)
data/        JSON state + per-timeframe SQLite candle caches (gitignored)
```

### Startup sequence (current)

1. `main.py` sets QtWebEngine GPU env vars, configures `logging` to stderr, creates
   `QApplication`, applies the QSS theme.
2. `MainWindow.__init__`: loads alerts + coins (`backend/Core/alert_service`, `backend/Core/coin_service`),
   builds toolbar and workspace, creates two daemon thread pools (orders max 4, positions max 2).
3. `WorkspaceWidget.__init__`: copies missing web assets from the bundled dir into the
   writable web dir, creates `QWebEngineView`, registers `WorkspaceBridge` on a `QWebChannel`,
   loads `workspace.html` from `file://`.
4. Page `DOMContentLoaded` → `WS.boot()` → `Bridge.connect` (QWebChannel) → `meta` →
   `loadStore` → `indicatorConfig` → render workspace and start per-chart polling.
5. `MainWindow._restore_window_state` fills the toolbar from `data/window_state.json`;
   `_on_coin_changed` pushes the coin into the workspace and fetches the Hyperliquid position.
6. `closeEvent` saves toolbar state and shuts down thread pools, the page and Chromium.

## 3. Module dependency map

```
main.py ──► UI.main_window ──► UI.toolbar, UI.workspace_view, UI.handlers.{trade,position},
                              UI.config_dialog, Core.{coin_service,alert_service,window_state}
UI.workspace_view ──► Core.{market_data, workspace_store, workspace_indicators, credentials}
                      Indicator.config
UI.handlers.trade ──► Core.calculations, Core.models, Exchange.hyperliquid
UI.handlers.position ──► Core.calculations, Core.utils, Exchange.hyperliquid
Core.workspace_indicators ──► Core.market_data, Indicator.*, Indicator.config
Core.candle_service ──► Core.config, Core.utils (SQLite)
Exchange.hyperliquid ──► Core.config, Core.models, hyperliquid SDK, eth_account
Core.* ──► stdlib, requests, pandas, dotenv (no Qt)
Indicator.* ──► pandas, pandas_ta, Core.config, Core.utils (no Qt)
```

### Qt-dependent modules (must be replaced)

| Module | Qt usage |
|---|---|
| `main.py` | `QApplication`, WebEngine env flags, logging setup |
| `UI/main_window.py` | `QMainWindow`, `QMessageBox`, `QTimer`, `QShortcut`, signals/slots |
| `UI/workspace_view.py` | `QWebEngineView`, `QWebEnginePage`, `QWebChannel`, `QWebEngineSettings`, fullscreen requests |
| `UI/toolbar.py` | `QComboBox`, `QPlainTextEdit`, `QCheckBox`, `QPushButton`, `QTimer`, 12 signals |
| `UI/config_dialog.py` | `QDialog`, `QGroupBox`, `QScrollArea`, inputs |
| `UI/styles.py` | QSS/QFont helpers |
| `frontend/web/workspace.html` | `qrc:///qtwebchannel/qwebchannel.js` script tag |
| `frontend/web/workspace.js` | `QWebChannel`/`qt.webChannelTransport` bootstrap inside `Bridge` |
| `Trade_Panel.spec`, `build.py` | PyInstaller packaging of the Qt app |

### Qt-independent modules (reused by the sidecar as-is)

`backend/Core/*` (all 14 modules), `backend/Indicator/*` (all 9 modules), `backend/Exchange/hyperliquid.py`,
`UI/handlers/trade.py` and `UI/handlers/position.py` logic (pure Python; the two files
import no Qt and can be called directly once the toolbar dependency is replaced by a
plain settings object — see §9).

## 4. Existing communication protocols

| Channel | Direction | Shape |
|---|---|---|
| QWebChannel `bridge.dataReady(reqId, payload_string)` | Python → JS | JSON string; correlates async requests |
| `bridge.requestCandles/requestTick/requestIndicators/searchSymbols` | JS → Python | `reqId` first; Python replies via `dataReady` |
| `bridge.meta/loadStore/saveStore/indicatorConfig` | JS → Python | synchronous callback-returned JSON string |
| `bridge.credentialStatus/saveCredentials` | JS → Python | JSON string; secrets never returned |
| `bridge.onPositionDrawingChanged/onFocusedChartChanged/onConfigRequested/toggleTopBar` | JS → Python | Qt signals |
| `page.runJavaScript(...)` (`setFocusedCoin`, `setFocusedTimeframe`, `centerFocused`, `setIndicatorConfig`, `setActive`, `shutdown`) | Python → JS | direct JS evaluation |
| `dataReady` | Python → JS | async market data / indicator payloads |
| Hyperliquid SDK | Python → exchange | HTTPS, testnet base URL |
| Public market data | Python → 8 exchanges | HTTPS REST, no keys |
| Binance candles | Python → Binance REST + SQLite | legacy `candle_service` path |
| `keys/.env` | file | plaintext credentials |

The workspace performs **no** `fetch`, `WebSocket` or `XMLHttpRequest` calls; all exchange
I/O is delegated to Python. This is a security-positive property that the Tauri design
must preserve (CSP can forbid network access from the WebView entirely).

## 5. Frontend/backend interface inventory

Bridge methods → business function:

| Bridge method | Backend function | Response |
|---|---|---|
| `meta` | `market_data.exchanges_meta`, `TIMEFRAMES`, `capabilities`, fixed layouts | `{exchanges, timeframes, aggregations, layouts}` |
| `loadStore` | `workspace_store.load_store` | `{ok, version, active, workspaces}` |
| `saveStore(json)` | `workspace_store.save_store` | `{ok, store}` / `{ok:false, error}` |
| `indicatorConfig` | `Indicator.config.load_indicator_config` | `{ok, config}` |
| `requestIndicators(...)` | `workspace_indicators.compute_workspace_indicators` | indicator map or `{ok:false,error}` |
| `requestCandles(..., limit, endTime)` | `market_data.fetch_candles` | `{ok, candles[], has_more, aggregated_from, ...}` |
| `requestTick(...)` | `market_data.fetch_tick` | `{ok, candles[<=3]}` |
| `searchSymbols(...)` | `market_data.search_symbols` | `{ok, symbols[]}` |
| `credentialStatus` | `Core.credentials.status` | `{ok, fields[{key,label,secret,group,set}]}` |
| `saveCredentials(json)` | `Core.credentials.save` | `{ok, keys, fields}` (values never echoed) |
| `onPositionDrawingChanged` | toolbar level sync + qty recalc | — |
| `onFocusedChartChanged` | toolbar coin/TF sync + position fetch | — |
| `onConfigRequested` | `IndicatorConfigDialog` | — |
| `toggleTopBar` | show/hide Qt toolbar | — |

Shell commands (Qt) → business function:

| Action | Business function |
|---|---|
| Set Order | `TradeHandler.place_order` → `HyperliquidClient.place_order` (cancel+replace, duplicate no-op) |
| Update Order | `TradeHandler.update_order` → `HyperliquidClient.update_tp_sl` |
| Read order | `PositionHandler.fetch_position` → `HyperliquidClient.get_position` |
| Coin list / refresh | `coin_service.load_coins` / `refresh_coins` |
| Open Browser | `webbrowser.open("https://app.hyperliquid.xyz/trade/<coin>")` |
| Set Alert | `alert_service.update_fvg` + `save_alerts` (inputs currently absent from layout → no-op) |
| Favourites | in-memory toolbar + `window_state.json` |
| Center chart | `WS.centerFocused()` |

## 6. Trading functionality inventory (must be preserved)

1. **Order placement** — limit entry with GTC, then SL trigger, then TP trigger, all
   reduce/close-side orders; existing open orders for the coin are cancelled first; if an
   identical limit + both triggers already exist, placement is a no-op.
2. **TP/SL update** — cancels existing trigger orders for the coin and re-places SL then TP
   on the close side; skips when both triggers already match.
3. **Position read** — `user_state` + `frontend_open_orders`; assigns TP/SL from trigger
   prices using direction heuristics; missing levels fall back to `quick_long_params` /
   `quick_short_params`.
4. **Quantity math** — `risk / |entry − SL|` rounded to `szDecimals`; `szDecimals` fetched
   once from `info.meta()` and cached.
5. **Price precision** — rounded from the live mid price before submission.
6. **Direction** — long/short, set from toolbar or from the selected position drawing.
7. **Order/timeout safety today** — duplicate suppression exists inside the SDK wrapper,
   there is no retry logic, and orders run on a daemon thread pool with no cancellation
   after submission (result may be unknown if the app exits).
8. **No live trading in tests** — suite uses mocks; the client points at Hyperliquid testnet.

## 7. Potential compatibility issues

| Area | Finding | Impact |
|---|---|---|
| `workspace.js` boot | Replaces `document.body.innerHTML` when the bridge fails | Bridge adapter must connect before `WS.boot()`; a late handshake would destroy host-reachable DOM |
| QWebChannel-only code | `Bridge.connect` at `workspace.js:186` | Adapter via `window.__WS_STUB__` avoids editing 5.2k lines |
| `qrc://` script | `workspace.html:982` | Must be loaded conditionally (no `qrc:` in Tauri) |
| `ResizeObserver` | Used unguarded (`workspace.js:862`) | Present in WebKitGTK ≥ 2.34; verify at runtime |
| Fullscreen | `document.documentElement.requestFullscreen()` | WebView fullscreen behaviour differs; host must provide a fallback |
| Canvas 2D | 3 contexts, no `filter`/`OffscreenCanvas` | Likely portable; verify DPI scaling on WebKitGTK |
| `localStorage` | 3 keys, all try/catch | Available in both WebViews; origin must be stable (`tauri://localhost`) |
| `file://` assets | Qt loads `workspace.html` from disk | Tauri serves assets from its custom protocol; relative URLs must be preserved |
| `document.execCommand` | Not used | — |
| CSP | Qt app had none | Tauri CSP must allow inline styles used by `workspace.html` while blocking network |
| `window_state.json` | Written to install dir when frozen | New app must use an OS data dir and import legacy data |
| Candles DB | `data/candles_*.db` WAL files | Must be copied with `-wal`/`-shm` or checkpointed before migration |
| `config.py` paths | Resolve from executable/install dir | Sidecar needs an explicit data-dir override |
| `coin_service.fetch_common_coins` | No HTTP timeout | Can hang sidecar startup; must add timeout or keep off the critical path |
| Hyperliquid endpoints | Testnet hard-coded | Preserve exactly; making it configurable is an unreviewed trading change |
| Logging | Python logs to stderr in Qt app; no `print()` anywhere | Safe for stdio JSON-RPC once stdout is defended |
| PyInstaller | Windowed mode would detach stdio | Sidecar must build with `console=True` and no console window on Windows |

## 8. Proposed migration architecture

```
Tauri 2 (Rust)                    Python sidecar                    Exchanges
┌────────────────────────┐        ┌─────────────────────────┐
│ window + WebView       │        │ tradepanel-backend      │
│  shell UI (TS)         │        │  ipc/server.py          │──► Hyperliquid SDK (testnet)
│  iframe: workspace     │        │  ipc/methods.py         │──► 8 public market APIs
│                        │        │  Core / Indicator       │──► SQLite candle cache
│ SidecarManager         │ stdio  │  (unchanged logic)      │
│  spawn / health /      │◄──────►│ JSON-RPC 2.0, 1 msg/line│
│  restart / shutdown    │        └─────────────────────────┘
│ Pending correlation    │
│ Event forwarding        │        OS keyring
│ Keyring credentials    │◄────── HL_PRIVATE_KEY / HL_ADDRESS (never to JS)
└────────────────────────┘
```

- **Transport**: JSON-RPC 2.0 over stdin/stdout, newline delimited, UTF-8, max 8 MiB,
  request ids as strings, structured errors with codes, `system.hello` handshake carrying
  `protocol_version = 1` and payload schema versions.
- **Frontend**: shell page invokes Rust commands; the workspace iframe talks to the shell
  over `postMessage` (typed envelope), the shell performs Tauri IPC. This keeps the
  workspace free of Tauri imports and preserves the existing bridge contract exactly.
- **Credentials**: Rust owns the OS keyring (Windows Credential Manager / Secret Service),
  imports legacy `keys/.env` once, and injects secrets into the sidecar environment at
  spawn and through `system.set_credentials`. The sidecar never writes secrets to disk.
  If the keyring is unavailable the app fails explicitly; there is no plaintext fallback.
- **Trading safety**: no automatic retries; trading RPCs get a bounded timeout and return
  an `EXECUTION_UNKNOWN` error instead of being retried; Rust rejects duplicate in-flight
  identical order submissions; shutdown waits for in-flight trading calls before killing
  the sidecar; reconnect never re-submits anything.
- **Data**: sidecar receives `TRADEPANEL_DATA_DIR` (OS app-data dir); first run imports a
  legacy `data/` directory (copy, including WAL files) without deleting the original.
- **Packaging**: PyInstaller one-file sidecar named per target triple as a Tauri
  `externalBin`; AppImage + NSIS/MSI bundles; updater gated on a configured signing pubkey.

## 9. Migration plan

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 Audit | this document + baseline tests/measurements | audit committed; 50 Python + 21 JS tests green |
| 1 Foundation | `src-tauri/`, `frontend/` shell, capabilities, CSP, Vite build | window launches, TypeScript typecheck + Vite build pass |
| 2 Sidecar | protocol server, Rust manager, health/restart/shutdown, framed RPC tests | sidecar handshake through Rust, kill/restart verified, protocol tests green |
| 3 Chart workspace | `tauri_bridge.js` adapter, iframe host, asset serving, fullscreen fallback | existing workspace boots with real candles, layouts/sync/drawings persist |
| 4 Trading | services (`trading/account/market-data/indicators`), position read, order submit, duplicate/in-flight guards | mocked/sandbox RPC tests; no live order executed in migration testing |
| 5 Desktop UI | toolbar, trade inputs, favourites, alerts, indicator settings, status/errors, window state | parity checklist with Qt toolbar |
| 6 Security | keyring, legacy import, capability audit, CSP, dependency audit | no secret reaches JS; CSP blocks external network; keyring failure is explicit |
| 7 Packaging | sidecar build scripts, AppImage, Windows installer config, updater | clean Linux build launches; Windows build documented and scripted |
| 8 Regression | full suite, WebView matrix, performance comparison, docs | release checklist complete |

## 10. Risks and effort

| Risk | Severity | Mitigation |
|---|---|---|
| WebKitGTK rendering/DPI differences | High | run the workspace in the actual Tauri WebView on Linux; keep Chromium harness for regression; feature-guard `ResizeObserver` |
| Order status unknown on crash/timeout | Critical | no auto-retry; explicit `EXECUTION_UNKNOWN`; reconcile via `account.open_orders`; shutdown grace for in-flight orders |
| Credential store unavailable (headless/CI) | High | explicit failure + dev-only env opt-in; never plaintext fallback |
| Sidecar restart storms / duplicates | High | single spawn guarded by mutex, generation counter, exponential backoff, single-instance plugin |
| PyInstaller missing hidden imports (`pandas_ta`) | Medium | collect-all in spec + smoke test of every indicator RPC |
| Legacy data loss during data-dir move | High | copy-only import with WAL/SHM, never delete, document |
| Node/Rust toolchain drift | Medium | pin versions in `package.json` and `Cargo.lock`; document prerequisites |
| WebView2/WebKit IPC differences | Medium | IPC only in the top-level shell frame; iframe uses `postMessage` |
| Migration effort | — | ~6–8 engineering days for phases 1–8 at audit scope, excluding Windows hardware validation |

### Baseline measurements (pre-migration)

- Python unit suite: **50 tests, 0.4 s, OK**. JS sync suite: **21 tests, OK**.
- Qt app imports cleanly; headless smoke (offscreen Qt) and the browser harness exist in `tmp/`.
- Startup/RSS numbers for the Qt app and the Tauri app are captured in
  `docs/TESTING.md` (§Performance) with the measurement method used; claims are limited to
  what was actually measured on the audit machine.

## 11. Recommended changes to the migration brief

1. **Keep one chart workspace source tree.** Instead of copying `frontend/web` into
   `frontend/web`, point the Vite `publicDir` at the existing `frontend/web` and add a single
   adapter file there. This removes a 5.2k-line duplicate that would immediately drift.
2. **Tray icon:** the current app has no `QSystemTrayIcon`; do not add one.
3. **Native menus/dialogs:** the Qt app uses `QMessageBox` only for order results and load
   failures; HTML modals/toasts preserve the behaviour without new native surface.
4. **One-file sidecar:** despite the brief's one-folder preference, one-file is the better
   fit for Tauri `externalBin` (single signed artifact, no executable-bit or read-only
   resource issues inside AppImage). Build scripts keep a one-folder target for debugging.
5. **Hyperliquid environment:** keep the existing testnet base URL. Making it configurable
   is a trading-behaviour change that requires explicit approval and tests.
6. **Set Alert:** the Qt inputs for FVG high/low are never added to the layout, so the
   button is currently a no-op. The new shell exposes the two inputs and preserves the
   existing persistence semantics rather than silently dropping the feature.
