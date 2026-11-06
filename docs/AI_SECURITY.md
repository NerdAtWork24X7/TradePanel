# AI Security Model

The analysis agent is **read-only by construction**, not by prompt request.
Enforcement happens in the Rust host, the process sandbox and the extension.

## Threat model

| Risk | Mitigation |
|---|---|
| Model places/updates/cancels an order | No trading tools or trading RPC are exposed to Pi. The only order-related tool reads the ticket. Order submission remains in the Rust order gate + Python sidecar. |
| Model reads exchange secrets | The child environment is cleared. Release builds inject no provider key at all: Pi reads its own `auth.json`. `HL_PRIVATE_KEY` / `HL_ADDRESS` are never present. |
| Model runs shell commands or edits files | Built-in tools, codemode, MCP, skills and prompt templates are disabled. The tool allow-list declares five `panel_*` tools only. |
| Model reads arbitrary files | Extension tools read one fixed path (`TRADEPANEL_AI_CONTEXT_FILE`), supplied by the host and never by the model. No path parameters exist. |
| Prompt injection through market data | Snapshots are numeric/validated; strings are length-capped and credential-like values rejected. The model has no action surface even if injected. |
| Credential leakage through logs/history | Keys are never placed in the snapshot or IPC payloads. Session history strips inline image/base64 payloads before crossing IPC. |
| Malicious/tampered runtime | Manifest paths must stay inside the runtime root; files must exist; the runtime is a build artifact installed with the application. |
| Runaway/crashed agent | Separate supervised process, bounded frames, request timeouts, health checks, bounded restarts, graceful shutdown. Trading never waits on it. |

## Process boundary

Rust starts the bundled Node executable directly. It does **not** use a shell.

```
node <runtime>/pi/.../cli.js
  --mode rpc
  --provider <provider> --model <model> --thinking <level>
  --session-dir <app-data>/ai/sessions --session-id <conversation>
  --no-context-files --no-skills --no-prompt-templates
  --no-extensions --no-mcp --no-builtin-tools --no-approve
  --extension <runtime>/pi/extensions/tradepanel-analysis.mjs
  --extension <app-data>/ai/extensions/<each user extension>
  --tools panel_market_context,panel_indicators,panel_portfolio,
          panel_order_ticket,panel_submit_trade_plan
  --system-prompt <runtime>/pi/prompts/analysis.md
```

Environment:

* allow-list only: `PATH`, `HOME`, locale/temp, Windows essentials, proxy and CA
  variables;
* `HOME` and `PI_CODING_AGENT_DIR` point into the app-data AI directory;
* `TRADEPANEL_AI_CONTEXT_FILE` points at the atomically written snapshot;
* `SCOPE_TOKEN_FILE` points at the local Pi Scope dashboard token when present;
  `OBS_SERVER_URL` is forwarded when set. Both are opt-in observability settings
  for the user extension folder, never exchange credentials;
* no provider API key in release builds. Pi reads `<agent dir>/auth.json`
  (mode 0600), so the credential never enters the process environment.
  Debug builds only: `TRADEPANEL_AI_DEV_PROVIDER` / `TRADEPANEL_AI_DEV_KEY`.

Working directory is an empty `<app-data>/ai/workspace`, so no project
`.pi` configuration, `AGENTS.md`, or user files are discovered.

## Extension boundary

`ai/runtime/extensions/tradepanel-analysis.mjs`:

* registers only the five tools;
* adds a `tool_call` interceptor that blocks any other tool name (defence in
  depth if the launch flags are ever changed);
* validates every read against a 4 MB cap, JSON shape and version;
* exposes no write, shell, network or filesystem traversal capability.

`panel_submit_trade_plan` validates the plan against the snapshot:

* `long`: `stopLoss < entry < takeProfit`
* `short`: `takeProfit < entry < stopLoss`
* risk/reward ≥ 0.5
* entry within 25% of the snapshot price; TP/SL within 60%
* `basisTimeframe = 5m`; quantity is derived from the user's RISK setting
* rationale required, length capped

### User extension folder

Pi's automatic discovery stays off. TradePanel enumerates `*.ts`, `*.js`,
`*.mjs` and `*.cjs` files in `<app-data>/ai/extensions` and
`<agent-dir>/extensions`, then passes each to Pi with an explicit
`--extension`. This is how the user-installed Pi Scope observability extension
is loaded; no individual filename is hardcoded.

Those user extensions are outside TradePanel's build and review. They can read
the snapshot and post session events to their own endpoints, but they cannot
widen the `--tools` allow-list: the five `panel_*` tools remain the model's
entire action surface.

## Snapshot boundary

`src-tauri/src/ai/context.rs` rejects:

* top-level fields outside the expected schema,
* credential-like key names (`private_key`, `api_key`, `secret`, `token`,
  `password`, `authorization`, `credential`),
* values that look like a 64-hex private key, `sk-` or `ghp_` tokens,
* deeply nested or oversized payloads (1.5 MB cap),
* invalid timestamps and missing instruments.

Images must be raw base64 PNGs (`iVBORw0KGgo` signature), max 4, max 3 MB each
and 5 MB total. Data URLs and non-PNG payloads are rejected.

## Credentials

Provider sign-in uses Pi's own authentication runtime, the same flows as the
`/login` command:

* `settings-service.mjs` imports `ModelRuntime` from the bundled Pi package and
  runs in a separate, equally locked-down Node process (no shell tools, cleared
  environment, empty working directory).
* Browser/device OAuth and API-key prompts are relayed as JSONL. The WebView sees
  only the prompt, URL/device code and a boolean/masked status — never a stored
  secret.
* Credentials are written by Pi to `<app-data>/ai/agent/auth.json` with mode
  `0600` (owner-only). Rust re-applies the mode after every login. There is no
  plaintext copy elsewhere in the application.
* The analysis process reads `auth.json`; no provider key is placed in its
  environment. Disconnect calls Pi's logout, which deletes the entry.
* API-key logins reject an empty value in both the UI and the service. The
  WebView never logs a prompt answer.
* Legacy keys stored by older builds under `AI_PROVIDER_<PROVIDER>_API_KEY` in
  the OS keyring are still read as a fallback and are deleted on disconnect.
* Exchange credentials remain in the separate keyring namespace used by the
  Python sidecar. They are never part of the AI environment.
* Debug builds only: `TRADEPANEL_AI_DEV_PROVIDER` and
  `TRADEPANEL_AI_DEV_KEY` allow a mock provider for local tests. Release builds
  compile the override out.

## Network

The model provider is the only network endpoint the bundled analysis extension
can reach: it has no network code and the runtime is started with no tools that
can make requests.

The one other outbound connection is user-initiated: Settings → Updates → AI
runtime asks the npm registry for the latest `@earendil-works/pi-coding-agent`
release and, after confirmation, downloads it together with its npm
dependencies. That install runs the staged npm CLI with `--ignore-scripts`, so
no package lifecycle code executes; tarballs are checked against the registry's
SHA-512 integrity values, and the new tree replaces the active runtime only
after the Pi CLI and the read-only extension both boot. Nothing is checked or
downloaded in the background. TradePanel's own market-data connections are unaffected and
are not shared with Pi. User extensions in the optional extension folder are
not part of the bundled runtime; a user-installed extension such as Pi Scope may
post session events to its local dashboard.

## Residual risks

* The provider receives the screenshots and snapshot fields you enabled. Treat
  them as data leaving the machine; portfolio context is opt-in.
* A prompt can still produce wrong analysis. The UI labels the output read-only,
  shows data freshness, validates level relationships, and requires a manual
  ticket fill and order submission.
* OS-level sandboxing is limited to the process/environment boundary. A
  compromised Node/Pi binary runs with the user's OS permissions, like any
  bundled application component. Keep the pinned runtime updated and rebuild it
  from the lockfile.
* User extensions in `<app-data>/ai/extensions` and `<agent-dir>/extensions`
  run with the app's OS permissions. They cannot widen the model's tool
  allow-list, but they can read the snapshot and make network requests (for
  example, Pi Scope posts session events to its local dashboard). Install only
  extensions you trust.
