# OpenTrader AI runtime (Pi coding agent)

The Analyze chart panel runs the [Pi coding agent](https://github.com/earendil-works/pi)
as a supervised, read-only process. This folder is its source:

| File | What it is |
|---|---|
| `package.json` / `package-lock.json` | Pinned `@earendil-works/pi-coding-agent` 1.5.0 and `typebox` (the tools' schemas). |
| npm from the pinned Node distribution | Staged as `npm/` by `tradepanel.mjs` so the app can install updates without a system npm. |
| `extensions/tradepanel-analysis.mjs` | The entire tool surface: `panel_market_context`, `panel_indicators`, `panel_portfolio`, `panel_order_ticket`, `panel_submit_trade_plan`. It reads one context snapshot file the host writes; it cannot write, run commands or open the network. |
| `prompts/analysis.md` | The analysis system prompt: the 5-minute long/short trade card and the read-only rules. |

## Stage it

`npm start` (or `./update`) stages it for the host target while setting the workspace up. It
writes `src-tauri/ai-runtime/<target>/` (git-ignored): the Node executable, the installed Pi
tree, the extension, the prompt and a `manifest.json` the Rust host validates. Release builds
bundle that folder as a Tauri resource.

Pi's own provider credentials are **not** used: OpenTrader collects an API key
for the selected provider and stores it in the OS credential store. The child
process receives only that provider's environment variable, a cleared
environment, an isolated home and session folder, no built-in tools, no MCP, no
skills, and the five `panel_*` tools above.

## Who runs it

`src-tauri/src/pi/` is the host:

| File | What it does |
|---|---|
| `runtime.rs` | Resolves `<app-data>/ai/runtime/<target>` (a user overlay), then the bundled resource, then (debug) this checkout; validates `manifest.json` and every file it names. |
| `spawn.rs` | The launch contract: cleared environment + allow-list, `HOME`/`PI_CODING_AGENT_DIR` under `<app-data>/ai`, the five-tool allowlist, every capability flag off. |
| `settings.rs` | The provider form → Pi `models.json` (`apiKey: $TRADEPANEL_API_KEY`), HTTPS or loopback HTTP only. |
| `context.rs` | Validates the version-1 snapshot (allowed fields, no credential-shaped keys, 1.5 MB) and writes it atomically (0600); validates the images. |
| `manager.rs` | One lazily started child: RPC framing, bounded frames, `get_state` readiness, event forwarding, abort, crash reporting. |
| `commands.rs` | `pi_status`, `pi_set_settings`, `pi_clear_key`, `pi_analyze`, `pi_abort`, `pi_new_session`, `pi_update`. |

## Update it in the app

**Update Pi** in the Analyze chart header installs a newer release into
`<app-data>/ai/runtime/<target>`. `pi/update.rs` asks Pi's release service for
the newest version, downloads that release's pinned `package.json` and
`package-lock.json`, and runs the npm CLI staged next to Node with scripts and
user configuration disabled. Stage, verify and swap are separate: a failed
install leaves the current runtime in place, and the old overlay is restored if
the final rename fails. Node, the analysis extension and the prompt are copied
from the current runtime so the read-only bundle is never modified.

The window side is `src/data/analyst.ts` (RPC records → text, tool steps, the
plan) and `src/window/assistant/ChartAnalyst.tsx` (the panel and its card). The
panel's first action is **Start analysis** (the agent asks its own questions);
later messages are follow-ups that rebuild the snapshot. The provider form
takes an API **base** URL: Pi appends `/chat/completions`, and a legacy saved
endpoint is trimmed to its base on the next run.

## Check it

```bash
node extensions/analyst/tests/analyst-rpc-smoke.mjs   # mock OpenAI-compatible provider + the staged runtime
```

The smoke test replays the host's exact launch and asserts the tools, the
image attachment, the rejected-then-accepted plan, the quantity derived from
the ticket's RISK, and that an undeclared tool (`bash`) is blocked. It skips
when no runtime is staged.
