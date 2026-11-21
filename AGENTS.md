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
tradepanel.mjs               the single entrypoint: setup + run, and --update / --ref / --latest
tradepanel.test.mjs          its tests
update, update.cmd           the update entrypoint (tradepanel.mjs --update --setup)
```

**Never edit `opentrader/`.** It is reset by `tradepanel.mjs`. Put new files in
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
npm start                       # set up if needed, then run the app
npm start -- --setup            # set up only
./update                        # re-assemble at the ref in opentrader.config.json
./update --ref main             # another tag, branch or commit
./update --latest               # newest vX.Y.Z release tag
```

`tradepanel.mjs` owns `opentrader/`: it resets it to the ref, overlays the packs in dependency
order, regenerates `src/bindings.ts` and the i18n catalog, stages the AI runtime and installs the
plugins. It preserves `node_modules/`, `src-tauri/target/`, `src-tauri/ai-runtime/` and
`src-tauri/standalone/`. On a `core.patch` conflict it names the pack, restores the previously
locked checkout and exits non-zero. Rebase that pack's patch (or its `files/` tree) and run again.

## Verify

```bash
npm test                                        # the tradepanel script's own tests

npm --prefix opentrader exec -- tsc --noEmit -p opentrader/tsconfig.json
npm --prefix opentrader test
node extensions/analyst/tests/analyst-rpc-smoke.mjs   # the analyst RPC smoke test
(cd opentrader/src-tauri && cargo test --lib)
python3 -m unittest discover -s plugins/crypto/tests
python3 -m unittest discover -s plugins/nse/tests
python3 -m unittest discover -s plugins/ccxt-broker/tests
```

`npm start` sets up and runs; `./update` re-assembles the checkout. A fresh clone needs the same
toolchain as upstream (Node.js 22+, Rust stable, Tauri system libraries); the first setup also
stages the AI runtime (Node + Pi) into `opentrader/src-tauri/ai-runtime` and generates
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
