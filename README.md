# TradePanel

TradePanel is an OpenTrader-based desktop trading workspace. The app is in
[`opentrader/`](opentrader/); the original TradePanel shell, backend and web UI have been
removed.

It keeps OpenTrader's charting, drawing, indicators, layouts, replay and order ticket, and
adds:

- **Crypto market data from nine venues** — Binance, Bybit, OKX, Coinbase, Kraken, KuCoin,
  Gate.io, Bitget and Hyperliquid, spot and perpetuals, through a Python Plugin API 2
  datafeed. The venues' public endpoints are used directly, so the 15-minute gateway delay
  does not apply to crypto feeds.
- **Trading on nine venues** — Hyperliquid through its official SDK, and Binance, Bybit,
  OKX, Gate.io, Bitget, KuCoin, Coinbase and Kraken as one ccxt broker plugin per exchange
  (`opentrader/plugins/ccxt-broker`). Positions, orders, executions, brackets, partial closes
  and order modification, spot and perpetual futures, one broker connected at a time from
  **Exchanges → Brokers**. **Testnet by default** where the venue has one; a live account is
  used only after an explicit choice, and OpenTrader's trading switch and live-order
  confirmation remain the gate. An order ticket that cannot trade links straight to the
  broker's card or to the plugin catalog, so the settings it needs are one click away.
- **Paper trading** — a simulated account built into the app, listed with the brokers in
  **Exchanges → Brokers** and *Trade → Connect broker…*: it fills orders at the chart's
  live price with no plugin, account or API key. Market, limit, stop and stop-limit orders
  with take profit / stop loss, partial closes, reversals and order modification, a
  starting balance of your choosing, and an account manager with balance, equity, margin
  and P&L; positions and orders are kept on the computer and fill while the app is open.
- **AI chart analyst** — *AI assistant → Analyze chart* runs the bundled
  [Pi coding agent](https://github.com/earendil-works/pi) as a supervised, read-only process
  (`opentrader/ai-runtime`). A short-lived hidden Tauri window renders the selected symbol at 1d, 4h
  and 5m with the studies the user shows; those three pictures travel with a numeric snapshot
  (1d/4h/5m studies, structural levels, position, ticket). The answer streams with a validated
  long/short trade card (BP, SL, qty, TP, probability) whose levels can be shown on the chart or
  filled into the ticket, and every run is kept in an analysis log that can be loaded again. The
  agent has five `panel_*` tools and cannot trade; only HTTPS or loopback HTTP providers are
  accepted, and the API key stays in the OS credential store.
- **Trade plan projections** — the order ticket shows entry, stop and target, risk and
  reward in account currency and % of balance, R:R, and the balance after either level.
- **Secrets in the OS keyring** — plugin settings marked `secret` are read and written
  through `keyring`, never through the webview or `plugins.json`.

## Requirements

- Node.js 22 or newer
- Rust stable (`rustup`)
- Tauri system dependencies for your OS:
  <https://v2.tauri.app/start/prerequisites/>
- [uv](https://docs.astral.sh/uv/) — only for the standalone build, which brings the Python
  the trading plugins run under

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y \
  build-essential libssl-dev pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf
```

On Ubuntu 20.04 use `libwebkit2gtk-4.0-dev`.

The drawing core is a sibling checkout, already present in this workspace as
`lightweight-charts-drawing/`.

## Run

```bash
npm start              # desktop app: checks the toolchain, installs missing deps and plugins, starts `tauri dev`
npm run ot:crypto      # the Python crypto plugin alone (app closed)
npm run ot:brokers     # the Binance…Kraken broker plugins alone, enabled (app closed)
npm run dev            # the same as npm start, without the checks
```

`npm start` starts the **OpenTrader** window with hot reload. It needs Node.js 22+, Rust
stable and the Tauri system dependencies above; it installs `opentrader/node_modules` itself
(skip that with `--no-install`, or `TRADEPANEL_NO_INSTALL=1`). It installs both plugin sets
too: the crypto plugin on, and the eight ccxt brokers **off** (no Python process until you
enable one), so every venue is a card in **Exchanges → Brokers** and in **Trade → Connect
broker**. Outside npm, run `./tradepanel` (Linux, macOS, Git Bash) or `tradepanel.cmd`
(Windows); arguments go to the launcher, and everything after `--` goes to `tauri dev`. On
a Linux machine that has only the WebKitGTK runtime libraries, `TRADEPANEL_ENV=<snippet>`
sources a shell script that sets `PKG_CONFIG_PATH` and the linker paths before building
(this workspace uses `tmp/linux-env.sh` automatically; without it the launcher stops before
compiling):

```bash
./tradepanel -- --no-watch      # start without the file watcher
./tradepanel --help
```

The frontend alone can be previewed with:

```bash
npm --prefix opentrader run dev     # http://localhost:1420
```

A source build of OpenTrader's gateway-backed data needs `OPENTRADER_GATEWAY_TOKEN` in
`opentrader/.env`; see [`opentrader/README.md`](opentrader/README.md#market-data-token-source-builds-only).
Crypto symbols work without that token because the plugin talks to the venues directly.

## Build

```bash
npm run build
```

Installers are written under `opentrader/src-tauri/target/release/bundle/`; the release
binary is `opentrader/src-tauri/target/release/opentrader`. `npm run ot:frontend:build`
builds only the Vite bundle.

### Standalone build

```bash
npm run standalone
```

One folder that holds the app **and everything it runs**, so it starts on a computer with
nothing installed — no Node, no Rust, no Python:

```
dist-standalone/TradePanel-<version>-<os>-<arch>/
  TradePanel                          the launcher (TradePanel.cmd on Windows)
  bin/opentrader                      the app; the frontend is inside the binary
  lib/OpenTrader/ai-runtime           the Node and Pi the AI analyst runs
  lib/OpenTrader/plugins              the plugin packages, the Python they run under
                                      and their dependencies (ccxt, the Hyperliquid SDK…)
```

The first start copies the plugins and the Python runtime into the app's data folder, where
the plugin host expects them (`opentrader/src-tauri/src/plugins/bundled.rs`); the folder
itself stays read-only and can be copied to any computer of the same platform. The crypto
plugin starts; the eight broker plugins are listed in **Exchanges → Brokers** and start when
they are switched on.

Flags:

```bash
npm run standalone -- --no-ai        # without the AI runtime (Node + Pi)
npm run standalone -- --no-plugins   # without the Python plugins
npm run standalone -- --out DIR      # where the folder is written
npm run standalone -- --bundle       # also build the installers of the platform
npm run standalone -- --skip-build   # assemble the folder from the last release build
```

The build needs `uv` (it brings the Python the plugins run under) and takes a while: it
stages the AI runtime, installs the Python dependencies, builds the frontend and compiles
the Rust binary.

## Test

```bash
npm run ot:test

cd opentrader/src-tauri
cargo test --lib

cd ../..
python -m unittest discover -s opentrader/plugins/crypto/tests
python -m unittest discover -s opentrader/plugins/ccxt-broker/tests
```

The Python plugin tests need their requirements:

```bash
python -m pip install -r opentrader/plugins/crypto/requirements.txt
python -m pip install -r opentrader/plugins/ccxt-broker/requirements.txt
```

## Layout

```
opentrader/                  OpenTrader (SolidJS + Tauri 2)
opentrader/plugins/crypto/   Python Plugin API 2 datafeed + Hyperliquid broker
opentrader/plugins/ccxt-broker/  one ccxt broker plugin per exchange (Binance…Kraken)
lightweight-charts-drawing/  chart drawing core (sibling dependency)
```

`opentrader/src/bindings.ts` is generated by the Rust build and git-ignored. After a fresh
clone, run `cargo test --lib export_bindings` in `opentrader/src-tauri/` once before
type-checking the frontend.

## Security notes

- Hyperliquid starts on **testnet**. Do not enable live trading until you have tested order
  placement with a funded testnet key.
- The AI analyst key and the Hyperliquid private key live in the OS credential store.
- Treat a plugin as code running with your rights: install only plugins you trust.

## License

MIT. See [`LICENSE`](LICENSE) and [`opentrader/LICENSE`](opentrader/LICENSE).
