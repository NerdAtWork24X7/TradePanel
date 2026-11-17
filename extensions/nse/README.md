# NSE symbol search pack

Keeps the NSE additions independent of the generated `opentrader/` checkout:

- `files/src/assets/exchanges/nse.svg` — the NSE rosette, redrawn from NSE's official media
  asset. The venues pack's filename glob resolves it for `exchangeLogoSrc("NSE")`, so rows
  show the exchange mark.
- `core.patch` — adds the refresh button to the symbol search input, maps Indian exchanges
  to the India flag, and wires a Tauri command that fans `data.refreshSymbols` out to every
  connected data plugin. Plugins without a refresh handler are ignored; one slow plugin
  cannot hold up the rest. It also registers the command and covers the row/test assertions.

The button rebuilds each plugin's symbol cache, then re-runs the current search, so newly
listed stocks across all exchanges appear immediately. The pack depends on `core` and
`venues` and is included in `opentrader.lock.json`; `npm run update:opentrader` reapplies
it unchanged.
