# OpenTrader AI runtime (Pi coding agent)

The Analyze chart panel runs the [Pi coding agent](https://github.com/earendil-works/pi)
as a supervised, read-only process. This folder is its source:

| File | What it is |
|---|---|
| `package.json` / `package-lock.json` | Pinned `@earendil-works/pi-coding-agent` 1.5.0 and `typebox` (the tools' schemas). |
| `extensions/tradepanel-analysis.mjs` | The entire tool surface: `panel_market_context`, `panel_indicators`, `panel_portfolio`, `panel_order_ticket`, `panel_submit_trade_plan`. It reads one context snapshot file the host writes; it cannot write, run commands or open the network. |
| `prompts/analysis.md` | The analysis system prompt: the 5-minute long/short trade card and the read-only rules. |

## Stage it

```bash
npm run ai:runtime       # pinned Node 22 + Pi, for the host target
npm run ai:runtime:dev   # the Node running the script (development)
```

The script writes `src-tauri/ai-runtime/<target>/` (git-ignored): the Node
executable, the installed Pi tree, the extension, the prompt and a
`manifest.json` the Rust host validates. Release builds bundle that folder as a
Tauri resource.

Pi's own provider credentials are **not** used: OpenTrader collects an API key
for the selected provider and stores it in the OS credential store. The child
process receives only that provider's environment variable, a cleared
environment, an isolated home and session folder, no built-in tools, no MCP, no
skills, and the five `panel_*` tools above.
