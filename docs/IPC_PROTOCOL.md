# IPC Protocol

Two layers, both validated in Rust:

1. **WebView → Rust** — Tauri `invoke` commands. Only `backend_rpc` reaches the sidecar,
   and only for an explicit method allow-list.
2. **Rust ↔ Python** — JSON-RPC 2.0 over the sidecar's stdin/stdout.

## 1. Transport

* UTF-8, **one JSON object per line** (`\n`), no embedded newlines.
* Maximum frame: **8 MiB** (`MAX_MESSAGE_BYTES`). Oversized requests are rejected
  (`-32013`), oversized backend frames are drained and logged.
* stdout is protocol-only. All diagnostics go to stderr.
* Request ids are strings produced by the shell (`rpc-<n>`); responses echo the id.
* Backend → shell messages without an id are notifications (`event.*`).
* Concurrency: up to 64 in-flight sidecar requests; more are rejected (`-32005`).
  Trading methods and health pings are serialized; identical in-flight order payloads are
  rejected (`-32012`).
* Request ids are remembered for the last 512 frames; a replay is rejected (`-32012`).

## 2. Handshake and versioning

The shell sends `system.hello` immediately after spawn.

```json
{"jsonrpc":"2.0","id":"rpc-1","method":"system.hello",
 "params":{"protocol_version":1,"client":"TradePanel/0.1.0"}}
```

```json
{"jsonrpc":"2.0","id":"rpc-1","result":{
  "protocol_version":1,"backend_version":"0.1.0","python":"3.12.13",
  "platform":"Linux","pid":1234,"started_at_ms":1730000000000,
  "methods":["account.open_orders","account.position","..."]}}
```

A protocol mismatch returns `-32010` with `{expected, got, backend_version}`. The shell
sets status `incompatible`, kills the process and disables automatic restarts. Version
compatibility is therefore enforced in both directions: the UI refuses to trade against an
unexpected backend, and the backend refuses unknown clients.

## 3. Error codes

| Code | Meaning |
|---|---|
| `-32700` | malformed JSON |
| `-32600` | invalid request shape |
| `-32601` | unknown method |
| `-32602` | invalid parameters / invalid credential value |
| `-32603` | internal backend error (details only in stderr) |
| `-32000` | application error (market-data/exchange error message) |
| `-32001` | service unavailable (no credentials, sidecar not running) |
| `-32002` | request timeout (shell-side) |
| `-32004` | **execution status unknown** — an order may have reached the exchange |
| `-32005` | too many concurrent requests |
| `-32010` | protocol version mismatch |
| `-32011` | backend is shutting down |
| `-32012` | duplicate request id / identical order already in flight |
| `-32013` | frame too large |

`-32004` is never retried automatically. Its `data` contains
`{"retryable":false,"reconcile":"account.open_orders"}`.

## 4. Methods

### system

| Method | Params | Result |
|---|---|---|
| `system.hello` | `protocol_version:int`, `client:str` | versions, platform, pid, method list |
| `system.ping` | — | `{pong:true, uptime_ms}` |
| `system.shutdown` | — | `{ok:true}`; server drains in-flight work, then exits |
| `system.set_credentials` | `values:{KEY:str}`, `clear:[KEY]` | `{keys:[...], set:{KEY:bool}}` (Rust-only) |

`system.hello`, `system.shutdown` and `system.set_credentials` are **not** in the WebView
allow-list. The first two are orchestrated by Rust; credentials are pushed by the keyring
command after an explicit user action.

### market

| Method | Params | Result |
|---|---|---|
| `market.meta` | — | `{exchanges, timeframes, aggregations, layouts}` |
| `market.get_candles` | `exchange, market, symbol, timeframe, limit? (1–3000, default 600), end_time?` | `{ok, candles:[{time,open,high,low,close,volume}], has_more, aggregated_from, native, base, quote}` |
| `market.get_tick` | `exchange, market, symbol, timeframe` | same shape with ≤3 candles |
| `market.search_symbols` | `exchange, market, query?` | `{ok, symbols:[{symbol,native,base,quote}]}` |

Candles are UTC seconds, ascending. `aggregated_from` is set when the exchange has no
native interval and the backend aggregates a lower timeframe.

### indicators

| Method | Params | Result |
|---|---|---|
| `indicator.get_config` | — | `{ok, config}` (global study parameters) |
| `indicator.save_config` | `config:object` | `{ok, config}`; clears the study cache |
| `indicator.compute` | `exchange, market, symbol, timeframe, flags:{name:bool}` | `{ok, empty?, candles, aggregated_from?, sessions?, fvg?, ribbon?, vp?, daily_vp?, session_vp?, hl_ema?, adx?}` |

Studies: `session_asian`, `session_london`, `session_ny_am`, `session_ny_pm`, `fvg`,
`ribbon`, `vp`, `daily_vp`, `session_vp`, `hl_ema`, `adx`. Individual study failures are
reported as `null` for that key with a stderr warning; they never fail the whole request.

### workspace

| Method | Params | Result |
|---|---|---|
| `workspace.load` | — | `{ok:true, version, active, workspaces}` |
| `workspace.save` | `store:object` | `{ok:true, store}` (validated/clamped, atomic write) |

`store` is the existing schema v1 (layout, columns/rows, charts, sync groups, settings,
drawings). Unknown/invalid values are sanitised by `Core.workspace_store`.

### account (read-only)

| Method | Params | Result |
|---|---|---|
| `account.position` | `coin` | `{coin, has_position, entry, tp, sl, size, pnl}`; missing TP/SL are filled with the existing quick-parameter defaults |
| `account.open_orders` | `coin` | `{coin, orders:[{oid, side, size, limitPrice, triggerPrice, isTrigger, reduceOnly, timestamp}]}` |

Both require credentials. Without a key they return `-32001`; no file or order is touched.

### trading

| Method | Params | Result |
|---|---|---|
| `trading.place_order` | `coin, is_buy, qty, limit_price, tp_price, sl_price` | `{success:bool, message}` |
| `trading.update_tp_sl` | `coin, is_short, tp, sl` | `{success:bool, message}` |
| `trading.calc_qty` | `risk, entry, sl, is_short, coin` | `{qty, sz_decimals}` |
| `trading.sz_decimals` | `coin` | `{coin, sz_decimals}` |
| `trading.coins` | `refresh?:bool` | `{coins:[...]}` |

Semantics are unchanged from the audited application:

* `place_order` rounds prices from the live mid, cancels existing open orders for the coin,
  then submits limit + SL + TP; if an identical limit/TP/SL combination is already open it
  is a no-op (`success:true`).
* `update_tp_sl` requires an open position, skips when both triggers already match, and
  otherwise cancels and replaces the triggers.
* Trading methods are serialized; queued trading calls are rejected once shutdown starts.
* No partial retry exists anywhere. A timeout or process exit while a call is in flight is
  reported as `-32004` and persisted in `trading_state.json`.

### alerts / settings

| Method | Params | Result |
|---|---|---|
| `alerts.get` | `coin` | `{coin, high, low}` (nulls when unset) |
| `alerts.set` | `coin, high, low` | `{ok, coin, high, low}` (existing `alerts.json` schema) |
| `settings.window_state.get` | — | `{state}` |
| `settings.window_state.save` | `state` | `{ok}`; merges into the existing file |

## 5. Notifications

The sidecar may emit notifications; Rust forwards them as the Tauri event
`backend:event` with `{method, params}`. The protocol supports them for long-running
work without blocking the request channel; the current backend emits none during normal
operation (market updates are pulled by the workspace's existing polling loop, preserving
the Qt behaviour).

## 6. Rust command surface (WebView → Rust)

| Command | Purpose |
|---|---|
| `backend_status` | current `BackendStatus` |
| `backend_rpc` | allow-listed proxy to a sidecar method (`timeout_ms` 1–120 s) |
| `backend_restart` | manual supervisor restart |
| `orders_acknowledge` / `orders_state` | clear/read the persisted "execution unknown" gate |
| `credentials_status` | keyring state (`{key,label,secret,group,set}` only) |
| `credentials_save` | validate + store values, apply to the sidecar; returns no values |
| `credentials_legacy_status` / `credentials_import_legacy` | detect/import `keys/.env` after explicit confirmation |
| `app_info` | app version, protocol version, data directory |
| `open_trade_page` | open `https://app.hyperliquid.xyz/trade/<coin>` (coin validated) |
| `set_fullscreen` | window fullscreen (HTML fullscreen is forwarded by the shell) |
| `update_check` / `update_install` | signed updater (fail closed when unconfigured) |
| `log_frontend` | frontend diagnostics into the Rust log |

All commands are callable from the main window only (capability scoped to `main`), and the
WebView has **no** shell, filesystem, HTTP or updater capability.

## 7. Timeouts

| Operation | Default |
|---|---|
| `market.get_candles` | 40 s |
| `market.get_tick` / `search_symbols` | 25 s / 30 s |
| `indicator.compute` | 45 s |
| `workspace.save` | 20 s |
| `account.*` | 40 s |
| `trading.*` | 45 s |
| other | 30 s |

The sidecar emits one response per request; the shell removes timed-out entries from the
pending map. A late response is ignored (`rpc-*` log at debug level).
