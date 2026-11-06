# Icon set

Vendored from [deepentropy/opentrader](https://github.com/deepentropy/opentrader)
(`src/assets/icons`, MIT — see `LICENSE`). TradingView-style filled glyphs on a
28×28 grid; every SVG uses `currentColor`, so one file serves both themes.

`frontend/web/icons.js` and `frontend/src/lib/icons-data.ts` are generated from
these files:

```bash
npm --prefix frontend run icons
```

Only edit SVGs here, never the generated registries.
