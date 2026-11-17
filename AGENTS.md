# TradePanel: notes for coding agents

TradePanel is an OpenTrader-based desktop app. The upstream tree is generated; TradePanel
additions are independent packs and plugins.

## Layout

```
opentrader/                  generated upstream checkout (git-ignored, pinned by opentrader.lock.json)
opentrader.config.json       upstream repository + default ref
opentrader.lock.json         resolved commit + extension hashes (tracked)
extensions/<pack>/           TradePanel packs: extension.json, files/, core.patch
plugins/                     OpenTrader Plugin API 2 programs (crypto datafeed, NSE datafeed, ccxt brokers)
lightweight-charts-drawing/  drawing core (sibling checkout read by Vite)
scripts/                     update, launch, build, install and test tooling
```

**Never edit `opentrader/`.** It is reset by `scripts/update-opentrader.mjs`. Put new files in
`extensions/<pack>/files/` (mirroring the checkout tree) and changes to upstream files in that
pack's `core.patch`.

## Packs

- `branding` — required shell: splash, English-only interface, shell defaults. Other packs
  depend on it: its i18n test changes are what let feature strings ship in English only.
- `core` — Plugin API 2 seams (`secret` settings, Python runtime, bundled install), OS
  credential store, Pi supervisor, capture-window plumbing. Rust additions live here.
- `chart` — Bar Replay slicing, legend/live/navigation, pane geometry, stop-limit lines.
- `paper` — built-in simulated broker and account view.
- `venues` — venue logos, symbol-search prefixes, Exchanges tab, plugin settings surface.
- `nse` — NSE exchange mark in symbol search, refresh button and the narrow Tauri command that
  rebuilds the runtime plugin's symbol cache. Depends on `core` and `venues`.
- `plan` — entry/stop/target risk, reward and balance projections in the ticket.
- `analyst` — Analyze chart panel, hidden capture renderer, `runtime/` (Pi source) and
  `tests/analyst-rpc-smoke.mjs`.
- `trading` — broker picker, ticket composition and trading status wiring.

Order and dependencies are in each `extension.json`. A pack may be disabled by moving its
folder out of `extensions/`; rerun the updater. Runtime plugins do not need packs.

## Update upstream

```bash
npm run update:opentrader                     # latest release tag
npm run update:opentrader -- --ref main       # upstream HEAD
npm run update:opentrader:check               # assemble + tsc + vitest
npm run update:opentrader:full                # ... + cargo test --lib
npm run update:opentrader:dry                 # resolve/list only
./update --check                              # the standalone launcher (update.cmd on Windows)
node scripts/update-opentrader.mjs --locked   # reapply the pin in opentrader.lock.json
node scripts/update-opentrader.mjs --without analyst --check   # prove a pack is independent
```

The updater preserves `node_modules/`, `src-tauri/target/`, `src-tauri/ai-runtime/` and
`src-tauri/standalone/`. On a `core.patch` conflict it names the pack, resets the checkout,
and exits non-zero. Rebase that pack's patch (or its `files/` tree) and run again.

## Verify

```bash
npm run ot:typecheck
npm run ot:test
npm run test:plugins
npm run test:standalone
npm run test:ai
(cd opentrader/src-tauri && cargo test --lib)
python3 -m unittest discover -s plugins/crypto/tests
python3 -m unittest discover -s plugins/nse/tests
python3 -m unittest discover -s plugins/ccxt-broker/tests
```

`npm run setup` runs the updater with `--check`. A fresh clone needs the same toolchain as
upstream (Node.js 22+, Rust stable, Tauri system libraries); the first setup also stages the
AI runtime (Node + Pi) into `opentrader/src-tauri/ai-runtime` and generates
`opentrader/src/bindings.ts`.

## Conventions

- Match the code around you: comments say why, in plain words; no dead code.
- Persist UI state through `src/data/kv.ts`, not `localStorage`.
- Chart edits go through the stores (`window/shell/chart-edits.ts`,
  `window/drawings/drawing-store.ts`) so they are undo steps and are saved.
- A new Tauri command belongs in `core` (Rust) and must be listed in `specta_builder()`;
  regenerate bindings with `cargo test --lib export_bindings`.
- A plugin's manifest setting of type `secret` is stored in the OS credential store and only
  sent in `plugin.configure`. A `process` entry ending in `.py` runs under the plugin's
  `.venv` when present.
- Do not name market-data providers in code, docs or issues.
