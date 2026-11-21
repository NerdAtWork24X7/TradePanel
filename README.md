# TradePanel

TradePanel is an OpenTrader-based desktop trading workspace. Upstream OpenTrader is
[`opentrader/`](opentrader/), a **generated checkout** pinned by `opentrader.lock.json`;
TradePanel's additions are independent packs in [`extensions/`](extensions/) and plugins in
[`plugins/`](plugins/). Nothing is edited inside `opentrader/`: one command rebuilds it from
upstream and reapplies the packs.

It keeps OpenTrader's charting, drawing, indicators, layouts, replay and order ticket, and
adds:

- **Crypto market data from nine venues** — Binance, Bybit, OKX, Coinbase, Kraken, KuCoin,
  Gate.io, Bitget and Hyperliquid, spot and perpetuals, through a Python Plugin API 2
  datafeed (`plugins/crypto`). The venues' public endpoints are used directly, so the
  15-minute gateway delay does not apply to crypto feeds.
- **NSE India stocks** — a separate data-only plugin (`plugins/nse`) adds search, history and
  live snapshots for National Stock Exchange of India equities under `NSE:` symbols. The full
  symbol list is cached on disk and refreshed daily, so search stays fast and works offline.
  The refresh button in symbol search rebuilds every connected data plugin's cache; NSE rows
  show the exchange mark and India flag.
  No key, no broker account; the plugin is installed by default.
- **Trading on nine venues** — Hyperliquid through its official SDK, and Binance, Bybit,
  OKX, Gate.io, Bitget, KuCoin, Coinbase and Kraken as one ccxt broker plugin per exchange
  (`plugins/ccxt-broker`). Positions, orders, executions, brackets, partial closes and order
  modification, spot and perpetual futures, one broker connected at a time from
  **Exchanges → Brokers**. **Testnet by default** where the venue has one.
- **Paper trading** — a simulated account built into the app, listed with the brokers: it
  fills orders at the chart's live price with no plugin, account or API key. Market, limit,
  stop and stop-limit orders with take profit / stop loss, partial closes, reversals and order
  modification, a starting balance of your choosing, and an account manager with balance,
  equity, margin and P&L.
- **AI chart analyst** — *AI assistant → Analyze chart* runs the bundled
  [Pi coding agent](https://github.com/earendil-works/pi) as a supervised, read-only process
  (`extensions/analyst/runtime`). A short-lived hidden Tauri window renders the selected
  symbol at 1d, 4h and 5m with the studies the user shows; those three pictures travel with a
  numeric snapshot. The answer streams with a validated long/short trade card whose levels can
  be shown on the chart or filled into the ticket, and every run is kept in an analysis log.
- **Trade plan projections** — the order ticket shows entry, stop and target, risk and reward
  in account currency and % of balance, R:R, and the balance after either level.
- **Secrets in the OS keyring** — plugin settings marked `secret` are read and written through
  `keyring`, never through the webview or `plugins.json`.
- **Exchanges tab** — venue logos, symbol-search prefixes, broker cards, settings and account
  management in one place under the chart.

## Requirements

- Node.js 22 or newer
- Rust stable (`rustup`)
- Tauri system dependencies for your OS:
  <https://v2.tauri.app/start/prerequisites/>

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

## Setup

`opentrader/` is generated. Do not edit it; edit a pack in `extensions/` or a plugin in
`plugins/`. One command does everything — setup and run:

```bash
npm start                  # set up if needed, then start the desktop app
npm start -- --setup       # set up only: clone, apply the packs, install, do not start

./update                   # move the pin and install: same as `tradepanel.mjs --update --setup`
./update --ref main        # another tag, branch or commit
./update --latest          # the newest vX.Y.Z release tag
```

`tradepanel.mjs` (the one implementation, run by `npm start`) clones the pinned commit in
`opentrader.config.json`, overlays the packs in dependency order, installs the frontend
dependencies, regenerates `src/bindings.ts` and the i18n catalog, stages the AI runtime and
installs the plugins. Setup is reproducible from `opentrader.lock.json`, and it runs
automatically only when needed — a missing checkout, or a change to a pack or the lock;
`update` (or `tradepanel.mjs --update`) re-assembles on demand. A pack whose `core.patch` no
longer applies is named in the error; the checkout is restored to the previously locked,
working state instead of being left as bare upstream. Rebase that pack's patch before moving the
pin. Build caches (`node_modules/`, `src-tauri/target/`, the staged AI runtime) are preserved.

To pick a different pinned release permanently, edit `opentrader.config.json` and run `./update`.

## Run

```bash
npm start                          # set up if needed, then start the desktop app (`tauri dev`)
node tradepanel.mjs --setup        # set up only, do not start
node tradepanel.mjs --update       # re-assemble the checkout, then start
node tradepanel.mjs -- --no-watch  # start without the file watcher
node tradepanel.mjs --help
```

`npm start` starts the **OpenTrader** window with hot reload. It needs Node.js 22+, Rust
stable and the Tauri system dependencies above; it installs `opentrader/node_modules` itself
(skip that with `--no-install`, or `TRADEPANEL_NO_INSTALL=1`). It installs both plugin sets
too: the crypto and NSE plugins on, and the eight ccxt brokers **off** (no Python process until you
enable one), so every venue is a card in **Exchanges → Brokers** and in **Trade → Connect
broker**. Everything after `--` goes to `tauri dev`.

On a Linux machine that has only the WebKitGTK runtime libraries,
`TRADEPANEL_ENV=<snippet>` sources a shell script that sets `PKG_CONFIG_PATH` and the linker
paths before building (this workspace uses `tmp/linux-env.sh` automatically).

The frontend alone can be previewed with:

```bash
npm --prefix opentrader run dev     # http://localhost:1420
```

A source build of OpenTrader's gateway-backed data needs `OPENTRADER_GATEWAY_TOKEN` in
`opentrader/.env`; see [`opentrader/README.md`](opentrader/README.md#market-data-token-source-builds-only).
Crypto symbols work without that token because the plugin talks to the venues directly;
NSE symbols come from their own plugin as well.

## Build

```bash
npm --prefix opentrader run tauri build
```

Installers are written under `opentrader/src-tauri/target/release/bundle/`; the release
binary is `opentrader/src-tauri/target/release/opentrader`.

## Test

```bash
npm test                                        # the tradepanel script's own tests

npm --prefix opentrader exec -- tsc --noEmit -p opentrader/tsconfig.json
npm --prefix opentrader test
(cd opentrader/src-tauri && cargo test --lib)

python -m unittest discover -s plugins/crypto/tests
python -m unittest discover -s plugins/nse/tests
python -m unittest discover -s plugins/ccxt-broker/tests
```

The Python plugin tests need their requirements:

```bash
python -m pip install -r plugins/crypto/requirements.txt
python -m pip install -r plugins/ccxt-broker/requirements.txt
```

The NSE plugin uses only the Python standard library.

`opentrader/src/bindings.ts` is generated during setup and git-ignored.

## Layout

```
opentrader/                  generated OpenTrader checkout (git-ignored, pinned by opentrader.lock.json)
opentrader.config.json       upstream repository and default ref
extensions/                  TradePanel packs, applied over the checkout in dependency order
  core/                      plugin API seams, credentials, Pi supervisor, capture windows
  chart/                     Bar Replay and chart geometry fixes
  paper/                     built-in paper account
  venues/                    venue logos, symbol search, Exchanges tab
  nse/                       NSE icon, India flag and provider-wide symbol refresh
  plan/                      ticket trade-plan projections
  analyst/                   Analyze chart panel + Pi runtime source
  trading/                   broker picker, ticket composition, trading status
  branding/                  splash, English-only interface, shell defaults
plugins/                     OpenTrader runtime plugins (Plugin API 2)
  crypto/                    crypto datafeed + Hyperliquid broker
  ccxt-broker/               one ccxt broker plugin per exchange
lightweight-charts-drawing/  chart drawing core (sibling dependency)
tradepanel.mjs               the single entrypoint: sets the workspace up and runs the app
update, update.cmd           updates the checkout and reapplies the packs (tradepanel.mjs --update --setup)
tradepanel.test.mjs          its tests
```

Each pack has an `extension.json`, an optional `files/` overlay and an optional `core.patch`.
See [`extensions/README.md`](extensions/README.md).

## Security notes

- Hyperliquid starts on **testnet**. Do not enable live trading until you have tested order
  placement with a funded testnet key.
- The AI analyst key and exchange API keys live in the OS credential store.
- Treat a plugin as code running with your rights: install only plugins you trust.

## License

MIT. See [`LICENSE`](LICENSE) and [`opentrader/LICENSE`](opentrader/LICENSE).
