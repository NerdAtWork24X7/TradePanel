# Crypto markets & Hyperliquid (OpenTrader plugin)

TradePanel's crypto side, as an OpenTrader data + broker plugin (Plugin API 2):

- **Market data** for Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, Bitget and
  Hyperliquid through [ccxt](https://github.com/ccxt/ccxt): search, symbol info, history,
  live quotes. Quotes stream over each venue's WebSocket (ccxt.pro) for the symbols the
  app asks for, with the REST poller as the fallback; closed history is memoized, and only
  the moving tail is read again. Spot tickers are `VENUE:BASE/QUOTE`; perpetuals take a `.P` suffix
  (`BINANCE:BTC/USDT.P`, ccxt's `BTC/USDT:USDT` internally) because an OpenTrader symbol
  keeps one colon.
- **Broker** for Hyperliquid perpetuals through the official `hyperliquid-python-sdk`:
  positions, working orders, executions, market / limit / stop / stop-limit orders,
  take profit / stop loss, partial close, modify, cancel.

## Install

`npm start` installs it with the rest of the workspace: it copies the plugin into the app's
plugin folder, builds its `.venv` and enables it. Close OpenTrader first: it rewrites
`plugins.json` on exit. Start the app; the plugin's exchanges and the Hyperliquid broker
appear in the **Exchanges** tab under the chart (its settings too), and its exchanges in the
symbol search. To install it by hand instead, package it (`python3 plugins/crypto/build.py`)
and use **Settings > Plugins > Install from file**; the plugin then needs Python 3.10+ with
the packages in `requirements.txt` (the app prefers a `.venv` inside the plugin's folder).

## Settings

The fields below are in the **Exchanges** tab under the chart: choose **Hyperliquid**, then
fill them in and press **Apply**. (Settings > Plugins leaves the plugin out: it is a venue
plugin, configured there.)

| Key | Meaning |
|---|---|
| `network` | `testnet` (default) or `live`. Testnet uses Hyperliquid's test network. |
| `privateKey` | Hyperliquid wallet key. **Stored in the OS credential store**, never in `plugins.json`, and sent to the plugin only in its configure message. |
| `accountAddress` | Main wallet address, only when the key is an API (agent) wallet. |
| `slippage` | Market-order slippage in percent: Hyperliquid has no native market order, so one is an IOC limit at the mid moved by this much. |
| `pollSeconds` | Fallback quote and account refresh interval (venues without a WebSocket, or while one reconnects). |

OpenTrader keeps trading off until **Trade > Connect broker** and the trading switch; every
live order is confirmed first. The plugin adds no way around that.

## Develop and test

```bash
python3 -m unittest discover -s plugins/crypto/tests   # 57 offline tests (macOS/Linux)
python -m unittest discover -s plugins/crypto/tests    # Windows
python3 plugins/crypto/build.py                        # plugins/dist/crypto-<version>.zip
```

The tests run a socketpair through the JSON-RPC layer, fake ccxt clients, the history
memo and a fake Hyperliquid SDK; no key and no network are used. `plugin.py` also runs by itself against a
connection file (`--connection-file`), which is what the `external` runtime in
`opentrader-plugin.dev.json` would use.

## Limits

- Hyperliquid **perpetuals** trade; spot trading is not wired (market data includes HL spot).
  The other eight venues trade through their own broker plugins, `opentrader/plugins/ccxt-broker`.
- The broker shows the account's perp balance in USDC, one account per wallet.
- `data.bars` paginates ccxt history at 1000 bars per request (80 pages at most).
