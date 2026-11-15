# OpenTrader: notes for coding agents

A desktop charting app: a Rust backend (Tauri 2) and a SolidJS frontend. This file is for working **on this
repository**. To work **with the running app** (charts, scripts, strategies), connect to its MCP server instead:
see "Use with a coding agent" in the README.

## Layout

```
src/                     frontend (SolidJS, TypeScript)
  App.tsx                the window: tabs, panes, the stores below wired together
  window/                UI by area: chart/, drawings/, oakscript/ (script editor), strategy-tester/, header/, shell/ …
  data/                  stores and data access (datafeed, kv persistence, alerts, scripts, strategy results)
  agent/                 the MCP server's tools, guide and protocol (answered in the window)
  backtester/            strategy engine (worker)
  bindings.ts            generated from the Rust commands: never edit, it is gitignored
src-tauri/               Rust: commands (src/commands/), windows, alerts, updates, agent.rs (MCP endpoint)
  crates/core            data side shared with the web server
  crates/server          the web build's backend
../lightweight-charts-drawing   drawing core, read from a sibling checkout (see README)
```

Indicators come from `lightweight-charts-indicators`, the script runtime from `oakscriptjs`, drawings from
`lightweight-charts-drawing`. A change to an indicator, the script API or a drawing tool belongs in that library;
each ships its own agent guide in `skills/`.

## TradePanel additions

- `plugins/crypto/` — the bundled crypto data + Hyperliquid broker plugin (Python, Plugin API 2).
- `plugins/ccxt-broker/` — one broker-only plugin per exchange (Binance, Bybit, OKX, Gate.io,
  Bitget, KuCoin, Coinbase, Kraken) over ccxt. `specs.json` is the venue catalog;
  `manifests.py --write` generates `manifests.json` (the installer and `build.py` read it);
  `scripts/install-broker-plugins.mjs` installs all of them with one shared venv. Tickers are
  whole OpenTrader symbols, the same the crypto datafeed serves.
  `python3 -m unittest discover -s plugins/crypto/tests` (Windows: `python`) runs its offline
  protocol and mapping tests. A manifest setting of type `secret` is stored in the OS
  credential store (`plugins::read_secret` / `store_secret`) and only sent to the plugin in
  `plugin.configure`. A `process` runtime entry ending in `.py` runs under the plugin's
  `.venv` when one is present (`plugins::plugin_command`).
- `src-tauri/src/pi/` + `src/window/assistant/ChartAnalyst.tsx` — the chart analyst runs the
  bundled Pi coding agent (`ai-runtime/`, staged by `npm run ai:runtime`) as a read-only RPC
  child: five `panel_*` tools, a version-1 snapshot, no built-in tools. The window renders the
  selected symbol at 1d/4h/5m in a short-lived hidden Tauri window (`AnalysisCaptureWindow`,
  with the visible studies) and sends those three pictures plus the snapshot; Rust validates them,
  owns the provider key and streams the events. Completed runs live in the analysis log
  (`src/data/analyst-log.ts`, pictures under `<app data>/analysis-images`). Base URLs are
  normalized to the API base (`/chat/completions` is appended by Pi) and only HTTPS or loopback
  HTTP is accepted. `npm run test:ai` runs the staged runtime against a mock provider.
- `src/window/trading/plan.ts` + `TradePlanCard.tsx` — the ticket's projections; keep the
  math in `plan.ts` (tested) and the view free of it.
- `src/data/trading/paper-account.ts` + `paper-broker.ts` — the built-in paper account: the
  engine is pure and tested (`__tests__/paper-account.test.ts`), the store feeds it the
  datafeed's live prices and keeps it in kv; `window/trading/PaperAccount.tsx` is its account
  view. It is picked by `brokerOf()` in `data/trading/broker.ts` after replay and before a
  broker plugin; connecting a plugin disconnects it and the other way round.

## Commands

```bash
npm ci
npm test                         # vitest (tests in __tests__/ next to the code)
npx tsc --noEmit -p tsconfig.json
cd src-tauri && cargo test --lib # Rust tests; also regenerates src/bindings.ts
npm run ai:runtime               # stage Node + Pi into src-tauri/ai-runtime (before a release)
npm run test:ai                  # the staged Pi runtime against a mock provider
npm run tauri dev                # the app with hot reload (first Rust build: minutes)
node ../scripts/build-standalone.mjs   # the standalone folder (the app with everything it runs)
```

A new Tauri command: add it in `src-tauri/src/`, list it in `specta_builder()` (`src-tauri/src/lib.rs`), then run
`cargo test --lib export_bindings` and call it through `commands` from `src/bindings.ts`. If the web build serves it
too, put its body in `opentrader_core::commands`, add its name to `SERVED` there and route it in
`crates/server/src/invoke.rs` (tests check that the lists match).

## Conventions

- Match the code around you: comments say why, in plain words; no dead code.
- Persist through `src/data/kv.ts`, not `localStorage`.
- Chart edits go through the stores (`window/shell/chart-edits.ts`, `window/drawings/drawing-store.ts`) so they are
  undo steps and are saved.
- Do not name market-data providers in code, docs or issues.
- Dates shown to the user: dd/mm/yyyy.
- Commit only the files you changed (no `git add -A`): other work may be in the tree.

## Languages

The interface ships in **English only**. The catalog and the page translator stay in place, because they are what
keeps the text whole and greppable, and adding a language later is one entry plus one dictionary:

- `src/i18n/catalog.json` lists every text to translate, generated from the code, the built-in studies and
  `src/i18n/tools/run-time-texts.ts` (`npm run i18n:extract`; a test fails when it is out of date).
- A text: write it whole. Values go through `translateWith("{0} bars of {1}", n, sym)`, counts through
  `translatePlural(n, { one: "{0} bar", other: "{0} bars" })`, dates and numbers through `src/i18n/format.ts`; never
  join words to values (`"Undo " + name`, a test fails). A word with two meanings takes a sense (`data-i18n-sense`,
  `translateAs`).
- Not interface text: data (tickers, company and script names, exchanges, hotkeys, what the user wrote, legal notices
  kept verbatim) is shown in an element with `data-no-translate`; a text the code already wrote in English (words
  translated one by one and joined with values, dates of `format.ts`) goes through `formatted()`.
- A language would be one entry in `src/i18n/languages.ts` (name, plural locale, formats, direction, `partial` while
  it is being translated) and its `<lang>.json`; the language menu row appears only when more than one exists
  (`profileMenu` hides it otherwise). `npm run i18n:report` gives coverage, `npm run i18n:missing -- <lang>` writes
  the missing texts with their context, `npm run i18n:merge -- <lang> <file>` merges the filled file back (checked).
  The pseudo-language utilities (`src/i18n/pseudo.ts`, `pseudo-rtl.ts`) stay for testing the translator, unregistered.
- `src/i18n/__tests__/translator.test.ts`, `format.test.ts` and `drawing-labels.test.ts` carry their own small
  dictionaries as fixtures: they test the translator and the drawing labels, not a shipped language.
- Right to left stays wired (`src/styles/rtl.css`, `ot-flip-rtl`, `reading-direction.ts`) so a right-to-left language
  can be added without touching the layout: the page's `dir` is the language's, and a menu or popover places itself
  through `fitToWindow`/`createPopover`. English is left to right, so nothing exercises it today.
