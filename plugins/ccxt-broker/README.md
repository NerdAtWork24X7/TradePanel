# CCXT broker plugins (OpenTrader Plugin API 2)

One plugin per exchange, so every venue a user trades appears as its own broker in the
**Exchanges** tab's broker list — the same catalog the TradePanel repo trades through ccxt,
published as OpenTrader plugins instead of one shared backend:

| Plugin id | Exchange | Markets | Networks |
|---|---|---|---|
| `binance` | Binance | perpetual futures, spot | testnet, live |
| `bybit` | Bybit | perpetual futures, spot | testnet, live |
| `okx` | OKX | perpetual futures, spot | testnet, live |
| `gate` | Gate.io | perpetual futures, spot | testnet, live |
| `bitget` | Bitget | perpetual futures, spot | testnet, live |
| `kucoin` | KuCoin | perpetual futures, spot | live |
| `coinbase` | Coinbase | spot | live |
| `kraken` | Kraken | spot | live |

Hyperliquid keeps its native broker in the `crypto` data plugin; these eight are broker-only
plugins, and the crypto plugin still serves their market data. OpenTrader connects to one
broker plugin at a time (**Trade > Connect broker…**), which is why the venue is chosen by
installing and connecting that venue's plugin.

## Install

`npm start` (with the app closed) installs all eight venues **off**: every venue is then a
card in the Exchanges tab and in **Trade > Connect broker**, while no broker process runs
until the user enables one — a click on its card does that and connects it. Close OpenTrader
first; it rewrites `plugins.json` when it exits.

Setup copies each venue's package into the app's plugin folder, writes its generated
manifest, records it off in `plugins.json`, and points every plugin's `.venv` at **one
shared venv** with ccxt — a junction on Windows — because the host runs a `.py` entry with
the venv inside the plugin's own folder. An existing venv that already imports ccxt is
reused (the crypto plugin's `.venv`, or `<data>/plugins/.ccxt-broker-venv` from an earlier
run), so a second 40 MB install is not made; otherwise it creates the shared venv and
installs `requirements.txt` into it. Removing one plugin removes its link, not the shared
environment.

To install or ship a single venue, build its zip (`python3 plugins/ccxt-broker/build.py
--venue bybit`) and use **Settings > Plugins > Install from file**; it then needs Python
3.10+ with `requirements.txt` (the app prefers a `.venv` inside the plugin's folder).

## Use

1. **Exchanges** tab under the chart → **Brokers**: pick the venue.
2. Fill its **API key** and **secret** (and passphrase where the venue needs one). Settings
   of type `secret` go to the OS credential store, never to `plugins.json` or the webview.
3. Choose the network and the market (where the venue offers both), then **Connect**.
4. Turn trading on in the same pane (or **Trade** menu). OpenTrader confirms every order to
   a live account; this plugin adds no way around that.

A chart on another venue still trades: `broker.resolveSymbol` maps the chart's base and
quote to this venue's market, and positions and orders use whole OpenTrader symbols
(`BINANCE:BTC/USDT.P` for perpetuals, `BINANCE:BTC/USDT` for spot), so they open on the
chart as they are.

### Where the ticket sends you

Brokers are plugins, so an order ticket that cannot trade names the one place that fixes it,
with a button: **Open Exchanges** (the broker's card: keys, Connect, trading switch, symbol
map), **Connect a broker** (the broker picker), or **Install a broker plugin** (Settings >
Plugins). A venue plugin is configured in the Exchanges tab, never in Settings > Plugins — the
ticket no longer points there.

## Orders

| | Perpetual futures | Spot |
|---|---|---|
| Types | market, limit, stop, stop-limit | market, limit |
| Take profit / stop loss on a new order | reduce-only trigger orders | — |
| Position brackets (Protect) | yes | — |
| Partial close | yes | — |
| Modify / cancel | yes (venue edit, else replace) | yes |

Quantities are base-asset units, as the protocol requires; the broker converts them to the
venue's contracts with the market's `contractSize` and rounds through ccxt's
`amount_to_precision` / `price_to_precision`. A quantity below the venue's step or minimum
is refused before the order leaves the plugin.

## Package

`specs.json` is the catalog: ccxt ids per market, networks, passphrase, setup text. The
manifests are generated from it:

```bash
python3 plugins/ccxt-broker/manifests.py --write     # regenerate manifests.json
python3 plugins/ccxt-broker/build.py                 # one zip per venue in plugins/dist/
python3 plugins/ccxt-broker/build.py --venue bybit
```

`tests/test_manifests.py` fails when `manifests.json` no longer matches the generator. Each
zip holds the manifest at its root, so **Settings > Plugins > Install from file** installs
that one venue; the plugin then needs Python 3.10+ with `requirements.txt` (the app prefers
a `.venv` inside the plugin's folder).

## Develop and test

```bash
python3 -m unittest discover -s plugins/ccxt-broker/tests   # offline: fake ccxt client
python3 plugins/ccxt-broker/plugin.py --venue bybit --connection-file <file>
```

The tests fake ccxt at `ccxt_broker._ccxt`: no key, no network, no exchange. `--connection-file`
runs the plugin by itself against a file the app writes for an `external` runtime.

## Limits

- One venue and one market per plugin. Switch `market` to move between a venue's spot and
  perpetual account; the account, positions and orders follow.
- Spot is long-only: sell orders are exits from the base balance and there are no position
  brackets. Shorting needs the perpetual market.
- Execution history is the venue's last 24 hours of trades (`fetch_my_trades`); venues that
  only answer per symbol fall back to the symbols the account holds.
- Testnet availability follows ccxt's sandbox mode; KuCoin, Coinbase and Kraken are live
  only in this catalog.
