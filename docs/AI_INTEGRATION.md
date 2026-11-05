# AI Analysis Integration

TradePanel embeds the Pi coding agent as a **read-only market-analysis engine**.
It runs inside the desktop application, in the existing right-hand sidebar,
immediately below the order ticket. No separate Pi installation, Node.js,
npm, browser, or terminal is required.

Pinned versions:

| Component | Version | Source |
|---|---|---|
| Pi coding agent | **1.5.0** | `ai/runtime/package.json` |
| Node.js runtime | **22.23.4** | SHA-256 verified download from nodejs.org |
| Tauri | 2.x | `src-tauri/Cargo.toml` |

## Architecture

```
Vanilla-TS sidebar (AiPanel)
   │ typed Tauri commands (ai_*)
   ▼
Rust AiManager ── supervised child process ──► bundled Node + Pi RPC
   │                                              │
   │ writes context.json atomically               ├─ panel_market_context
   │ (read-only snapshot)                         ├─ panel_indicators
   ▼                                              ├─ panel_portfolio
<app-data>/ai/                                    ├─ panel_order_ticket
  agent/auth.json   Pi provider credentials       └─ panel_submit_trade_plan
  agent/            Pi configuration
  sessions/         Pi session JSONL per conversation
  workspace/        empty cwd (isolated from projects)
  context.json      latest snapshot
  settings.json     provider/model/thinking
  conversations.json UI index (id, title, model)

Rust AuthService ── settings-service.mjs ──► Pi ModelRuntime
   │  providers / models / OAuth / API key
   └─ forwards auth prompts and status to the Settings → AI Analysis tab
```

* One Pi process per application. It starts **lazily** on the first Start
  Analysis, model listing, or conversation use.
* Conversation switching restarts the process with a different session id.
  Closing or remounting the sidebar never destroys a conversation.
* The trading engine, market data, exchange clients and order gate are
  untouched. If Pi crashes, trading continues; the manager restarts Pi with
  bounded backoff and reports the failure in the AI panel.

## Settings and provider sign-in

Settings is a full page opened from the gear button to the right of **Trade** in
the workspace top bar (or `Ctrl+,`). It has four tabs: **Indicators**,
**Credentials**, **AI Analysis** and **Updates**. The theme button sits next to
the gear. The old key button in the workspace toolbar was removed; Hyperliquid
keys are under **Credentials**.

**AI Analysis** is not a provider/key form invented by TradePanel. It mirrors Pi
Scope's approach:

* `ai/runtime/settings-service.mjs` imports the bundled Pi `ModelRuntime` and
  exposes its provider catalogue, OAuth/device flows, API-key prompts and
  available models over JSONL.
* Rust supervises it with the same cleared environment as the analysis process.
  It writes only Pi's `agent/auth.json` and `agent/device-id`.
* The UI lists all providers Pi knows (42 in Pi 1.5.0), highlights signed-in ones,
  and offers the methods the provider supports (account sign-in, API key, or
  ambient credentials).
* Saving a model writes `settings.json`; the next analysis starts Pi with that
  provider/model. Custom models declared in `agent/models.json` remain
  selectable as `(custom)` even though the runtime catalogue does not list them.

## Why screenshots instead of candles

Sending three timeframes of OHLCV as text costs tens of thousands of tokens and
still leaves the model guessing about structure. TradePanel instead renders the
same charts the user sees:

1. The shell fetches 1d, 4h and 5m candles through the existing market-data
   service (no new exchange connections).
2. A hidden, same-origin iframe (`frontend/snapshot.html`) draws each timeframe
   with the bundled Lightweight Charts build: candles, EMA ribbon (user's
   configured lengths), Bollinger Bands 20/2, volume, RSI 14, MACD 12/26/9 and
   the current entry/TP/SL price lines.
3. Each pane is captured with `chart.takeScreenshot()`, composited into one
   960×680 PNG, and returned as base64.
4. The three PNGs are attached to Pi's `prompt` command as images. The numeric
   snapshot contains only values (indicator readings, levels, ticket, portfolio),
   never candle arrays.

This is an offscreen WebView renderer, not an external browser. It adds no
Chromium download, works offline, and produces deterministic dark-theme charts.
Typical cost is ~2–3k image tokens for three charts instead of 30k+ for candle
dumps.

## Explicit analysis workflow

Analysis **only** starts when the user presses **Start analysis**. On mount the
panel loads cached history from Pi's session files without starting Pi.

Start analysis:

1. Fetch 1d/4h/5m candles in parallel; drop timeframes that fail and report them.
2. Compute RSI, MACD, EMA, Bollinger, ATR, volume stats, trends and structural
   levels in `frontend/src/lib/technical.ts`.
3. Render the screenshots.
4. Build the read-only snapshot and write it atomically to
   `<app-data>/ai/context.json`.
5. Send one prompt with the images. Free-text input is enabled only after this
   first analysis; follow-ups rebuild the snapshot (without images) so tools
   never read stale data casually.

The prompt instructs Pi to read the images, call `panel_market_context` and
`panel_indicators`, reconcile the three timeframes, then call
`panel_submit_trade_plan` exactly once. The written answer is compact.

## Trade plan output

The final result is a validated plan card:

* `action`: `long` or `short` (analysis always returns a trade)
* `entry` (buy price for a long)
* `takeProfit`
* `stopLoss`
* `probability`: integer percentage (1–99) estimating the chance that TP is
  reached before SL
* `basisTimeframe`, `riskReward`, `rationale`

`panel_submit_trade_plan` validates the levels in the extension (not just the
prompt): `action` must be `long` or `short` and `probability` is required; long
requires `SL < entry < TP`, short requires `TP < entry < SL`, risk/reward must
be ≥ 0.5, and levels must stay within 25%/60% of the snapshot price. An invalid plan is returned to the model as a tool error so it can
correct itself. The accepted plan is stored in the Pi session and re-rendered
from cached history.

The card offers explicit user actions:

* **Fill ticket** copies the levels into the order form.
* **Show on chart** draws the plan as a long/short position box (entry,
  take-profit, stop-loss, reward/risk zones) on the workspace chart for the
  plan's instrument. It reuses a chart with that instrument when one is open and
  otherwise adds a panel (up to the 12-chart limit), then focuses it. The box is
  persisted with the other drawings.
* **Copy levels** copies a compact `SHORT BTC/USDT entry=… tp=… sl=…` string.

Neither Fill ticket nor Show on chart submits an order; the overlay never fills
the ticket.

## Tool surface

| Tool | Purpose |
|---|---|
| `panel_market_context` | Instrument, price, freshness, indicator summary, levels, portfolio status, ticket summary |
| `panel_indicators` | Exact per-timeframe RSI/MACD/EMA/Bollinger/ATR/volume values and structural levels |
| `panel_portfolio` | Position, open orders, P&L and exposure when the user enabled portfolio context |
| `panel_order_ticket` | Current ticket fields, read-only |
| `panel_submit_trade_plan` | Validate and return the final plan card |

No other tools are declared. Built-in `read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`, `codemode`, MCP, skills and prompt templates are disabled.

## Conversations

Each conversation maps to a Pi session file named `*_<conversation-id>.jsonl`
under `<app-data>/ai/sessions`. The UI index stores title, timestamps and model.
History is read directly from the JSONL (user/assistant text plus accepted plan
cards) without spawning Pi. Deleting a conversation removes its index entry and
only session files with the exact `_<id>.jsonl` suffix.

## Diagnostics

Settings → AI Analysis → Runtime diagnostics shows the runtime root, Node and Pi versions,
target, node/pi paths, agent/session directories, context file, session count and
the last runtime error. `TRADEPANEL_AI_DEV_PROVIDER` / `TRADEPANEL_AI_DEV_KEY`
exist **only in debug builds** for local mock-provider testing; release builds
have no such escape hatch.

## Tests

| Check | Command |
|---|---|
| Rust unit tests (framing, snapshot validation, args isolation, store, history) | `cd src-tauri && cargo test` |
| Frontend unit tests (markdown safety, indicator math, context) | `npm --prefix frontend test` |
| TypeScript | `npm --prefix frontend run typecheck` |
| Pi end-to-end with a mock OpenAI-compatible provider (images, tools, plan validation, streaming, abort, session file) | `npm run test:ai` |
| Provider settings bridge (catalogue, API-key prompt, auth.json mode, models, logout) | `npm run test:ai` |

The end-to-end test requires the staged runtime (`npm run ai:runtime`).
