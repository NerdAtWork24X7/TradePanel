# TradePanel Architecture (Tauri 2 + Python sidecar)

## 1. Process model

```
┌────────────────────────────── Tauri 2 shell (Rust) ──────────────────────────────┐
│ main window (WebView2 / WebKitGTK)                                               │
│  ┌────────────────────────────┐   postMessage    ┌────────────────────────────┐  │
│  │ shell UI (TypeScript)     │◄────────────────►│ workspace iframe           │  │
│  │ toolbar / trade ticket    │   typed RPC       │ workspace.html + workspace │  │
│  │ settings / alerts / toasts│                   │ .js (unchanged)            │  │
│  └─────────────┬──────────────┘                   └────────────────────────────┘  │
│                │ Tauri IPC (invoke / events)                                     │
│  ┌─────────────▼──────────────┐    JSON-RPC 2.0 over stdio    ┌────────────────┐ │
│  │ commands + SidecarManager  │◄─────────────────────────────►│ Python sidecar │ │
│  │ allow-list, order gate,    │   one UTF-8 JSON object/line  │ backend/       │ │
│  │ health, restart, keyring   │                               │ Core/          │ │
│  └────────────────────────────┘                               │ Indicator/     │ │
│                                                               │ Exchange/      │ │
└───────────────────────────────────────────────────────────────┴────────────────┘
```

* **One shell process** per user session (`tauri-plugin-single-instance`).
* **One sidecar process** per shell (`SidecarManager` holds `AsyncMutex<Option<Child>>`
  and a generation counter). The one-folder PyInstaller build is deliberate: a one-file
  build adds a bootloader parent/child pair and makes "the process we spawned" ambiguous.
* The sidecar never writes to stdout except JSON-RPC frames. `backend/sidecar.py`
  duplicates fd 1 for the protocol writer and redirects the original descriptor to
  stderr before importing backend modules.
* No Qt import is reachable from the sidecar; the legacy `UI/` package is not packaged.

## 2. Layers

| Layer | Location | Responsibility |
|---|---|---|
| Desktop shell | `src-tauri/src` | window lifecycle, process supervision, IPC validation, credential store, updates, OS integration |
| Shell UI | `frontend/src` | typed services, toolbar/trade ticket, settings/credentials/alerts dialogs, connection state |
| Workspace adapter | `UI/web/tauri_bridge.js` | exposes the existing QWebChannel contract over `postMessage` |
| Chart workspace | `UI/web/*` | charts, layouts, sync, drawings, indicators, workspace persistence (unchanged logic) |
| Sidecar | `backend/` | JSON-RPC server, method registry, credential mirror, shutdown drain |
| Trading core | `Core/`, `Indicator/`, `Exchange/` | market data, indicators, persistence, Hyperliquid execution |

## 3. Startup sequence

1. Rust `setup`: resolve app-data paths, copy legacy `data/` if present (copy-only),
   resolve `<resource>/backend/tradepanel-backend`, create `AppState`, start supervisor.
2. Supervisor spawns the sidecar with `TRADEPANEL_DATA_DIR`, `TRADEPANEL_KEYS_DIR`,
   keyring secrets (if any), `TRADEPANEL_IGNORE_ENV_FILE=1`, `NUMBA_THREADING_LAYER=workqueue`.
3. `system.hello` handshake (protocol 1). Mismatch ⇒ status `incompatible`, process killed,
   automatic restart disabled.
4. Status events (`backend:status`) drive the shell UI:
   running ⇒ load coins, market metadata, window state, indicator config, then load the
   workspace iframe. Non-running ⇒ trading controls disabled, banner shown, no order can
   be sent (`backend_rpc` rejects when the sidecar is not ready).
5. The workspace boots exactly as it did under Qt: `Bridge.connect` → `meta` →
   `loadStore` → `indicatorConfig` → render. `tauri_bridge.js` supplies the bridge.
6. The workspace reports `ready`; the shell pushes the global indicator config.

## 4. Request flow examples

**Chart data**

```
workspace.js  Bridge.request('requestCandles', [...])
  → postMessage {type:'rpc', method:'requestCandles'}
  → workspace-host dispatch → invoke('backend_rpc', {method:'market.get_candles'})
  → Rust allow-list + JSON-RPC frame → sidecar market.get_candles
  → market_data.fetch_candles (throttled, cached) → exchange REST
  → response → Rust pending correlation → invoke result
  → rpc-result → Bridge dataReady(reqId, payload) → chart
```

**Order**

```
Set Order → trading.placeOrder → invoke('backend_rpc', 'trading.place_order')
  → OrderGate (uncertain check, serialize, identical-in-flight guard)
  → sidecar trading.place_order (serialized under one lock)
  → Core.trading_service.place_order → Hyperliquid SDK (testnet)
  → {success, message} → modal; failures are never retried automatically
```

## 5. Chart workspace compatibility

`workspace.js` is not modified for Tauri except three user-facing strings. The adapter
implements `window.__WS_STUB__`, the hook that already existed for tests:

| QWebChannel method | Host mapping |
|---|---|
| `meta`, `loadStore`, `saveStore`, `indicatorConfig` | `market.meta`, `workspace.load/save`, `indicator.get_config` |
| `requestCandles`, `requestTick`, `requestIndicators`, `searchSymbols` | `market.get_candles/get_tick`, `indicator.compute`, `market.search_symbols` |
| `credentialStatus`, `saveCredentials` | Rust keyring commands (never Python, never a file) |
| `onPositionDrawingChanged`, `onFocusedChartChanged`, `onConfigRequested`, `toggleTopBar` | shell events |
| `WS.setFocusedCoin/Timeframe`, `centerFocused`, `setIndicatorConfig`, `setActive`, `shutdown` | host → iframe commands |

Both frame and parent validate origin and `event.source`; the iframe performs no Tauri
imports and no network requests.

## 6. State and persistence

| Data | Location | Format |
|---|---|---|
| Coins, alerts, window state, indicator config | `<app-data>/data/` | existing JSON schemas |
| Workspaces (layouts, charts, drawings) | `<app-data>/data/workspaces.json` | schema v1, validated and atomic |
| Candle cache | `<app-data>/data/candles_<tf>.db` | existing SQLite + WAL |
| Order-uncertain marker | `<app-data>/data/trading_state.json` | `{"uncertain": bool}` |
| Secrets | OS credential store | service `TradePanel`, account = env key |
| Logs | OS log dir (plus stderr) | `tradepanel.log` |

Legacy `data/` is imported once by **copying missing files** (including `-wal`/`-shm`);
the source is never changed. `window_state.json` saves merge into the existing file so
legacy visibility flags and future keys survive.

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| Sidecar exits/crashes | status `restarting`, pending requests fail; trading requests get `EXECUTION_UNKNOWN`; restart with 1/2/5/10/30 s backoff, max 6 attempts |
| Sidecar hangs | `system.ping` every 10 s; 3 failures ⇒ forced restart |
| Protocol mismatch | status `incompatible`, no restart, trading disabled |
| Backend down | shell disables Set/Update/Read order, shows banner; charts keep last data and resume polling after reconnect |
| Order timeout | never retried; gate records "uncertain" on disk; further submissions blocked until the user verifies and acknowledges |
| Sidecar killed during an order | pending order resolves with `EXECUTION_UNKNOWN` (code −32004) |
| App quit with in-flight order | sidecar `system.shutdown`; backend rejects new trading calls, drains in-flight work for up to 10 s; shell waits 12 s before killing |
| Keyring unavailable | settings/credentials return an explicit error; no plaintext fallback; app still runs read-only |
| Corrupt workspace JSON | existing `workspace_store` behaviour: rename to `.corrupt`, return defaults |

## 8. Deliberate deviations from the brief

1. **`frontend/web` is not a copy of `UI/web`.** Vite's `publicDir` points at `UI/web`, so
   the chart workspace has one source of truth and the legacy Qt app keeps working.
2. **No tray icon, no native menus.** The Qt app used neither.
3. **One-folder sidecar** instead of one-file: deterministic single-process supervision.
4. **Hyperliquid stays on testnet** exactly as the audited code; making it configurable is
   a trading-behaviour change that needs explicit approval.
5. **The update plugin is only registered when `TRADEPANEL_UPDATER_PUBKEY` is present at
   build time.** Otherwise update commands fail closed with a clear message instead of
   accepting unsigned artifacts.
