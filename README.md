# Trade_Panel — Crypto Trading Panel

A modular PySide6 desktop trading panel for Hyperliquid with a multi-chart TradingView-style analysis workspace
(Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, Bitget).

## Architecture

```
Trade_Panel/
├── main.py                  # Entry point (python main.py)
│
├── Core/                    # Business logic — zero Qt dependencies
│   ├── config.py            # Paths, .env loading, defaults
│   ├── models.py            # Dataclasses (OrderParams, CoinAlert, etc.)
│   ├── calculations.py      # Trade math (qty, TP/SL, price precision)
│   ├── coin_service.py      # Coin list fetch & persistence
│   ├── candle_service.py    # Binance candle fetching & SQLite caching
│   ├── market_data.py       # 8-exchange public market data (workspace)
│   ├── workspace_indicators.py # Legacy studies over workspace candles
│   ├── workspace_store.py   # Named workspace persistence
│   ├── credentials.py       # keys/.env read/write for the UI
│   ├── alert_service.py     # Alert persistence
│   ├── window_state.py      # UI state persistence
│   └── utils.py             # Shared helpers
│
├── Indicator/               # Technical indicator computations
│   ├── fvg.py               # Fair Value Gap detection + caching
│   ├── vwap.py              # Volume-Weighted Average Price
│   ├── sessions.py          # Session box ranges (Asian/London/NY)
│   ├── ema_ribbon.py        # Multi-length EMA/SMA ribbon (3 lines)
│   ├── hl_ema.py            # EMA of candle highs and lows
│   ├── adx.py               # ADX / +DI / -DI pane
│   ├── volume_profile.py    # Volume Profile (session + daily)
│   └── config.py            # Indicator config persistence
│
├── Exchange/                # Exchange integrations
│   └── hyperliquid.py       # Hyperliquid SDK wrapper
│
├── UI/                      # Qt UI layer
│   ├── main_window.py       # QMainWindow — workspace + trade orchestration
│   ├── workspace_view.py    # Embedded QWebEngine view + QWebChannel bridge
│   ├── toolbar.py           # Focused-panel coin/TF, trade inputs, favorites
│   ├── styles.py            # Amber Terminal Noir tokens + QSS
│   ├── config_dialog.py     # Advanced indicator config dialog
│   │
│   ├── handlers/            # Event handlers extracted from MainWindow
│   │   ├── trade.py         # Long/Short/Update/Set order logic
│   │   └── position.py      # Position loading from Hyperliquid
│   │
│   └── web/                 # Multi-chart frontend (vanilla JS)
│       ├── workspace.html
│       ├── workspace.js     # Panels, layouts, tools, persistence
│       ├── chart_sync.js    # ChartSyncManager (framework independent)
│       └── lightweight-charts.standalone.production.js
│
├── keys/                    # Credentials (gitignored)
│   └── .env                 # Hyperliquid keys
│
└── data/                    # Persistent data (gitignored)
    ├── coins.json
    ├── alerts.json
    └── candles_*.db         # Per-timeframe candle databases
```

## Workspace indicators

Open **Indicators** in any panel header. Toggles are per panel; advanced parameters come from the
global **⚙ Configure…** dialog (shared by every panel).

| Indicator | Description |
|-----------|-------------|
| SMA / EMA | Overlay moving averages (per-chart length). |
| Bollinger Bands | SMA ± N standard deviations (per-chart length/multiplier). |
| VWAP | Anchored VWAP (D/W anchor from the config dialog). |
| Volume | Base-volume histogram. |
| RSI / MACD / ATR | Oscillator panes below the price chart. |
| Session boxes | Asian / London / NY AM / NY PM UTC range boxes (start/end in config). |
| FVG | Unmitigated 3-candle fair value gaps above the configured gap %. |
| MA Ribbon | 3-line EMA/SMA ribbon (type + 3 lengths in config). |
| Volume Profile | Horizontal profile over the last N candles (count/rows in config). |
| Daily VP / Session VP | Per-day and active-session volume profiles. |
| High/Low EMA | EMA of candle highs and lows. |
| ADX | ADX / +DI / -DI pane with reference levels. |

Native overlays run in JavaScript on the panel's candles. Session/FVG/VP/ADX are
computed in Python (`Core/workspace_indicators.py`) from the **same exchange data**, so every exchange
gets the same studies instead of the old Binance-only SQLite path. Charts refresh studies on new bars.

## Drawing and trade tools

The panel's left rail contains:

- **Long / Short** — drag from entry to target; the stop mirrors 1:1 (R/R 1.00), a plain click creates a
  quick 0.5% stop with a 2R target. Selection pushes entry/TP/SL and direction into the Qt trade inputs
  through the workspace bridge.
- **Select** — move the box, drag entry/TP/SL levels (off-screen levels pin to the plot edge), or resize
  the time edge; `Delete` removes the selected position, `Esc` exits the tool.
- **Cursor mode** — with no drawing tool armed, click any line/shape/position and drag to move it; the
  pointer shows a move cursor over selectable objects, and chart panning still works everywhere else.
- **Pan** — drag empty chart space: horizontal movement pans time (native LWC), vertical movement
  shifts the price range. This also works while **Select** is active. Double-click the price axis or
  press **Center** to reset the vertical offset. Shape tools temporarily pause chart panning.
- **Measure** — drag to read Δprice, Δ%, and bar count.
- Horizontal/vertical lines, trend lines, rectangles, Fibonacci retracement, text annotations.
- **Gear** — account size, risk %, leverage and default box width; the stats card shows R/R, qty,
  margin, risk and reward.
- Position drawings persist **per symbol** in local storage; the trash button clears the chart's
  drawings, positions and measure.
- **Indicators** popup → **⚙ Configure…** edits all advanced study parameters.

## Quick Start

Project uses [uv](https://docs.astral.sh/uv/). Sync the locked environment, then run:

```bash
uv sync
source .venv/bin/activate
python main.py
```

Or launch with the bundled script (works from any directory):

```bash
./start.sh
```

Install an application-menu entry and a desktop icon:

```bash
./install-desktop.sh
```


## Multi-Chart Workspace

The multi-chart workspace is the **only chart view** in the app. It fills the main window's chart
area; the Qt toolbar, trade inputs and cloud panel stay in place. The toolbar coin/timeframe selectors
and **Center** button act on the focused panel; **Read order** loads the Hyperliquid position for the
focused chart's coin. Live data comes from **Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io and Bitget**
(public endpoints, no keys).

### Layouts
`1`, `2 horizontal`, `2 vertical`, `4 (2×2)`, `6 (3×2)`, `8 (4×2)` and a **custom** grid with drag
gutters. Add/remove charts, maximize/restore a panel, drag panel headers to rearrange, and use HTML
fullscreen. Layout changes preserve every chart configuration (hidden charts keep exchange, symbol,
timeframe, indicators, price mode and drawings).

### Per-chart state
Each panel owns its exchange, market (spot/perpetual), symbol, timeframe, chart type
(candles, hollow, OHLC bars, line, area, baseline), native and advanced indicators, price-scale
mode, historical data and drawing objects. Symbol and timeframe
changes reload data in place — the chart instance is never recreated.

### Synchronization (`UI/web/chart_sync.js`)
A framework-free `ChartSyncManager` synchronizes by **timestamp**, never by array index:
- **Crosshair** — the source timestamp is broadcast; each destination resolves its own candle and
  calls `setCrosshairPosition(ownPrice, ownBarTime, ownSeries)`. Nearest-candle policy is selectable
  (previous / closest / next / exact) with a per-chart drift cap; missing data clears the destination
  crosshair instead of inventing a candle.
- **Time / scroll / zoom** — visible **timestamp ranges** are copied (gated independently by the
  Time, Scroll and Zoom chips), clamped safely for shorter histories, and older history is lazy-loaded
  when a synced viewport reaches the start of a chart's data.
- **Timeframe** (opt-in) — changing one chart's timeframe updates linked charts in the same group.
- **Groups** — charts join named, colour-coded groups with independent settings; ungrouped charts are
  fully independent.
- Re-entrancy guards and requestAnimationFrame coalescing prevent feedback loops and throttling noise.

### Price-axis modes
- **Independent** — per-chart autoscale (default).
- **Absolute** — shared price range only inside a group and only for quote-compatible instruments
  (same quote currency and a sane price ratio); other charts fall back to independent automatically.
- **Percentage** — plotted relative to a reference price (first visible candle, start of history or a
  user-picked timestamp); axis labels show `%`.
- **Indexed 100** — normalized to 100 at the same reference point.

OHLC/volume data is never mutated: percentage/indexed modes use a display transform while tooltips,
headers and drawings keep the raw values.

### Persistence
Workspaces (layout, columns/rows, chart configs, groups, settings, drawings) are saved as JSON in
`data/workspaces.json` (atomic writes + schema validation). Multiple named workspaces are supported
with autosave, explicit **Save**, rename and delete. Favourite/recent pairs live in the page's local
storage.

### Exchange coverage
| Exchange | Spot | Perpetual | Notes |
|---|---|---|---|
| Binance | ✓ | ✓ (USDT-M) | |
| Bybit | ✓ | ✓ (linear) | |
| OKX | ✓ | ✓ (USDT swap) | |
| Coinbase | ✓ | — | displayed intervals without a native endpoint are aggregated from real OHLCV |
| Kraken | ✓ | — | XBT/Z-prefixed assets normalized |
| KuCoin | ✓ | ✓ | |
| Gate.io | ✓ | ✓ (USDT) | |
| Bitget | ✓ | ✓ (USDT-M) | |
| Hyperliquid | ✓ | ✓ (USDC) | |

Only intervals an exchange can serve (natively or by aggregating a lower interval) are enabled; the
timeframe menu tags aggregated ones (e.g. `30m ← 15m`). Monthly/weekly aggregation uses UTC calendar
boundaries from daily data.

### Workspace files & verification
```
Core/market_data.py        # 8 exchange adapters, symbol catalogs, caching, aggregation
Core/workspace_store.py    # validated JSON persistence
UI/workspace_view.py       # embedded QWebEngine view + QWebChannel bridge
UI/web/workspace.html      # workspace chrome (Amber Terminal Noir)
UI/web/workspace.js        # panels, layouts, indicators, drawings, persistence
UI/web/chart_sync.js       # ChartSyncManager (framework independent)
Core/workspace_indicators.py # Advanced studies over any exchange candles
```
```bash
node --test tests/chart_sync.test.mjs
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python tmp/build_workspace_preview.py   # browser harness with synthetic data
```

### Known limitations
- Lightweight Charts 4.x has no panes or drawing toolkit; oscillator panes, session/FVG/VP boxes,
  measure and position projections are custom canvas layers.
- v4 has no price-range API and no native vertical pane pan; vertical movement is implemented by
  shifting the autoscale range. Panned offsets are view state and are not written to workspaces.
- Advanced studies are recomputed on the server for the panel's exchange; changing an advanced
  parameter refreshes every panel.
- Drawing tools cover horizontal/vertical lines, trend lines, rectangles, Fibonacci retracements and
  text — not the full TradingView toolkit (no brush, pitchfork, alerts on drawings, etc.).
- Absolute price sync deliberately skips charts whose quote currency or unit scale is incompatible.
- Symbol entry is search-driven: only instruments listed by the selected exchange/market can be chosen.
- Binance **futures** (`fapi.binance.com`) is blocked in some regions; the panel surfaces the exchange
  error with a Retry and a Change-pair action.

## Configuration

Credentials live in `keys/.env`:

| Env Var | Description |
|---|---|
| `HL_PRIVATE_KEY` | Hyperliquid private key |
| `HL_ADDRESS` | Hyperliquid wallet address |

In the workspace, open the synchronization-groups drawer (top-bar groups icon) and click the key
icon to view or update these keys without editing files. Saved keys apply immediately; secrets are
never sent back to the UI.

## UI Theme

The desktop shell and chart use the **Amber Terminal Noir** system: near-black surfaces (`#0A0A0A` / `#121212`), hairline borders, a rationed amber accent (`#F5C400`), green/red trade semantics, and a mono face for numeric readouts. Qt tokens and the global stylesheet live in `UI/styles.py`; workspace tokens live in the `:root` block of `UI/web/workspace.html`.

## Design Principles

- **Core has zero Qt dependency** — all business logic is testable standalone.
- **Clear layer boundaries** — `Core/` (logic), `Indicator/` (calculations), `Exchange/` (brokers), `UI/` (Qt + chart), `keys/` (secrets).
- **Indicators are isolated** — each indicator (FVG, VWAP, Sessions) is its own module under `Indicator/`.
- **Handlers extract business logic from MainWindow** — MainWindow is a slim ~200-line orchestrator; trade, position, and indicator logic live in separate handler classes.
- **Signals flow one way** — UI emits signals → handlers compute → chart/toolbar update.
- **No hardcoded paths or credentials** — everything via `config.py` + env vars.
- **Each UI widget is self-contained** — toolbar doesn't know about the chart, chart doesn't know about the toolbar.
