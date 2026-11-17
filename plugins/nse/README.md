# NSE India stocks — data plugin

A self-contained [OpenTrader Plugin API 2](../../opentrader/plugins/PROTOCOL.md) datafeed for
equities listed on the National Stock Exchange of India. It is a runtime plugin: no pack,
no upstream edit, no account, no API key and no third-party Python package.

- Search the Stocks tab for `RELIANCE`, `TCS`, `HDFCBANK`, … — rows are prefixed `NSE:`.
- Typing `NSE` lists the most popular Indian stocks; `NSE:SYMBOL` opens any listed symbol.
- The full symbol list is cached on disk after the first load (about 3,600 stocks), so later
  searches and restarts need no network. The cache refreshes once a day in the background;
  the refresh button in symbol search calls `data.refreshSymbols` to rebuild it immediately.
- History: 1, 5, 15, 30, 60 and 240 minutes, daily, weekly and monthly.
- Live quotes: the prices of subscribed symbols are refreshed on a timer (5–60 s, default 10 s).
- Data-only: this plugin exposes no broker account and cannot place orders.

## Install

Run `npm run ot:nse` with the app closed, then start TradePanel. The plugin is installed
and enabled by default by `npm start` and is included in standalone builds. It can also be
packaged with `python plugins/nse/build.py` and installed from **Settings > Plugins >
Install from file**.

For development, run `python plugins/nse/plugin.py --connection-file PATH` while the plugin
is enabled; the app writes that connection file while it is running.

## Data source

One public, keyless chart endpoint serves symbol metadata, OHLCV history and last-price
snapshots for `<symbol>.NS`; request rates are deliberately low and responses are cached.
The symbol list comes from the exchange's own public CSV, stored in the user cache folder
(`~/.cache/TradePanel/nse-symbols.json`, or the platform equivalent) and refreshed daily.
A bundled catalogue of widely held stocks keeps search useful if neither source is reachable.
The quote source is best-effort rather than a licensed real-time feed: it can throttle
requests, and quotes are snapshots, not a tick-by-tick stream. No website cookies or browser
impersonation is involved.
