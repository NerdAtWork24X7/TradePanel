# AI Troubleshooting

## The AI panel says the runtime is unavailable

The bundled runtime was not staged or was removed.

```bash
node backend/scripts/build-ai-runtime.mjs
```

Check Settings → AI Analysis → Runtime diagnostics for the exact path and error. In
development, the loader also looks under `src-tauri/ai-runtime/<target>`. On
Linux the Node file must be executable (`-rwxr-xr-x`); the loader repairs a
missing bit when the filesystem is writable.

## Provider sign-in fails

Settings → AI Analysis → Sign in uses Pi's own authentication runtime. Common causes:

| Message | Fix |
|---|---|
| `Provider did not answer in time` | Check VPN/proxy/firewall. `HTTPS_PROXY` / `HTTP_PROXY` are passed through to Pi. Retry the sign-in. |
| `No models are available for …` | The account/key lacks access, the provider is wrong, or the provider requires a model allow-list. Sign in again or use **Refresh**. |
| `Provider asks for more than an API key` | That provider needs its browser/device flow. Use **Sign in**, not the API-key button. |
| `Enter a value before submitting` | The sign-in prompt was submitted empty. Paste the API key or answer. |
| 401/403 from the provider | The key is invalid, expired, or has no permission for the selected model. Sign out, then sign in again. |
| `provider auth: unavailable` in Diagnostics | The staged runtime has no `pi/settings-service.mjs`. Rebuild with `node backend/scripts/build-ai-runtime.mjs`. |

The sign-in service writes Pi's `agent/auth.json` (mode 0600). The Linux Secret
Service is **not** needed for AI sign-in; it is only used for Hyperliquid trading
credentials.

The runtime may log provider details. Set the Tauri log level to debug or inspect
the application log file; stderr from Pi is forwarded to the app log with the
`ai` target.

## Start analysis does nothing / no chart

* Select a chart in the workspace. The context bar must show a symbol, exchange,
  market and timeframe.
* The market-data backend must answer `market.get_candles` for 1d/4h/5m. If one
  timeframe fails, the panel reports it and continues with the rest; if all fail,
  no analysis starts.
* If chart rendering fails, the panel shows a render error. The hidden
  `snapshot.html` page must be present in the built frontend (`dist/snapshot.html`)
  and Lightweight Charts must be served (`/lightweight-charts.standalone.production.js`).

## Screenshots are blank or truncated

The renderer waits two animation frames plus 80 ms per chart before
`takeScreenshot()`. A heavily throttled or hidden (zero-size) WebView can return
an empty canvas. Keep the window visible and retry. Each render has a 25 s
timeout; three charts are rendered serially.

## Streaming stops without an answer

* Open the panel's error row; provider errors arrive as an assistant message
  with `stopReason: "error"`.
* Use **Stop** to abort a hung run. The Rust manager also health-checks an idle
  process every 30 s and restarts after two failures.
* If the process crashes, the panel reports it and the manager restarts with
  backoff (1s, 2s, 5s, 10s, 30s; five attempts). Trading is unaffected.

## History is missing after a restart

History is read from `<app-data>/ai/sessions/**/*_<conversation-id>.jsonl`.
Check Runtime diagnostics for the sessions directory and file count. Deleting a
conversation removes only files with the exact id suffix. If the app-data
directory was deleted or the OS profile changed, history cannot be recovered.

## The plan card is missing

The model must call `panel_submit_trade_plan`. If it only writes prose, no card
appears. The prompt requires the tool call; repeated omission usually means a
weak model. Switch to a stronger model in Settings → AI Analysis. Invalid plans are rejected
with a tool error, and the model is expected to correct them; if it gives up,
ask "submit the plan again with consistent levels".

## The model sees stale data

The context bar shows freshness. Follow-ups rebuild the snapshot from fresh
candles; the Start Analysis screenshots are a point-in-time capture. If the
snapshot is older than the timeframe's stale threshold, the tools explicitly tell
the model to ask for a new analysis.

## Reset AI state

```text
<app-data>/com.nerdatwork.tradepanel/ai/      # Linux
%APPDATA%\com.nerdatwork.tradepanel\ai\       # Windows
```

* `settings.json` — provider/model/thinking/portfolio.
* `conversations.json` — UI index.
* `sessions/` — Pi conversation files.
* `agent/` — Pi configuration (`models.json`, caches) and `auth.json` (provider
  credentials). Delete to reset model discovery and sign-ins; the next sign-in
  recreates it.
* `context.json` — last snapshot.

Deleting this directory removes conversations, local AI settings and provider
credentials. Legacy `AI_PROVIDER_*` keyring entries from older builds must be
removed separately if present; the current **Sign out** button deletes the
`auth.json` entry.

## Diagnostics to include in a bug report

Copy the Runtime diagnostics block (runtime root, Node/Pi versions, target,
paths, session count, last error) plus the AI panel error text. Never include
API keys, account addresses or private keys.
