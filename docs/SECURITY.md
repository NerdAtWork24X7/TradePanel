# Security Model

TradePanel executes real exchange orders. The security posture therefore favours
fail-closed behaviour and explicit errors over convenience.

## 1. Trust boundaries

| Boundary | Trusted? | Controls |
|---|---|---|
| Chart workspace iframe | No (untrusted renderer) | no Tauri imports, no network, strict CSP, origin-checked postMessage, host validates every RPC |
| Shell WebView | No (untrusted renderer) | minimal capabilities, allow-listed commands, no shell/fs/http permissions, CSP |
| Rust shell | Yes | process supervision, keyring, validation, order gate |
| Python sidecar | Yes (local binary) | Rust-only spawn, framed JSON-RPC, size limits, id/handshake checks, serialized trading |
| Exchanges | No (network) | TLS via the SDK/`requests`; responses validated by the existing Core code |

A compromised WebView can call only the commands in
`src-tauri/capabilities/default.json` plus the allow-listed `backend_rpc` methods. It
cannot spawn processes, read arbitrary files, open sockets (CSP forbids it) or read
secrets.

## 2. Credentials

* Stored in the OS credential store through the `keyring` crate:
  * Windows — Credential Manager (`windows-native`)
  * Linux — Secret Service over D-Bus (`sync-secret-service`, no libsecret headers)
  * macOS — Keychain (`apple-native`)
* Service `TradePanel`, account = `HL_PRIVATE_KEY` / `HL_ADDRESS`.
* Values are validated before storage (`0x`+40 hex address, 64 hex private key).
* Secrets are **never** returned to JavaScript. `credentials_status` returns only
  `{key, label, secret, group, set}`. The workspace credential modal shows
  "configured/missing".
* Secrets reach the sidecar through its environment at spawn and through
  `system.set_credentials` (internal Rust-only RPC). They are never written to
  `keys/.env`, logs, error messages or telemetry.
* If the credential store is unavailable/locked, commands fail with an explicit message.
  **There is no plaintext fallback.**
* Legacy migration is explicit: the settings dialog detects `keys/.env` and offers
  "Import legacy keys". The source file is left untouched so the user can verify and
  delete it. Nothing is imported silently.
* The sidecar ignores `keys/.env` (`TRADEPANEL_IGNORE_ENV_FILE=1`) when started by the
  shell, so a stale plaintext file cannot silently override keyring values.

**Residual risk:** environment variables are visible to same-user processes
(`/proc/<pid>/environ` on Linux) and crash dumps may contain them. Mitigations are OS
user isolation and the short-lived nature of the values; a future hardening step is a
pipe-based secret handshake.

## 3. Tauri lockdown

`src-tauri/capabilities/default.json` grants only:

* `core:default`
* `core:window:allow-set-fullscreen`, `core:window:allow-is-fullscreen`

No `shell:*`, `fs:*`, `http:*`, `process:*` or updater permission is granted. The Python
sidecar is spawned by Rust, so the shell plugin is not even a dependency.

Content Security Policy (production):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost;
frame-src 'self';
frame-ancestors 'self';
object-src 'none';
base-uri 'none';
form-action 'none'
```

* `connect-src` allows only the Tauri IPC endpoints; the workspace has no network code
  (all exchange I/O is in Python).
* `style-src 'unsafe-inline'` is required by the existing workspace HTML, which carries an
  inline `<style>` block and inline layout attributes. Scripts are not inline.
* Dev CSP additionally allows the Vite origin and its HMR WebSocket.

Command validation:

* `backend_rpc` accepts only the allow-list in `src-tauri/src/protocol.rs`.
* `params` must be a JSON object; `timeout_ms` is clamped to 1–120 s.
* `open_trade_page` accepts `[A-Za-z0-9]{1,20}` only and builds a fixed HTTPS URL.
* `set_fullscreen` ignores any URL/navigation input.
* `credentials_save` accepts only the two known keys and re-validates values.

## 4. Sidecar hardening

* Spawned only by `SidecarManager`; a mutex + generation counter prevents duplicates.
* Unbundled release runs check `TRADEPANEL_BACKEND_BIN`, the resource directory, the
  executable directory and the development staging directory (in that order).
* The handshake is mandatory; protocol mismatch kills the process and disables restarts.
* Frames: 8 MiB cap on both directions (the Rust reader uses a bounded line reader),
  UTF-8 strictness, object/id/method validation, 512-id replay window, 64 in-flight cap.
* Requests to unknown methods are rejected; internal methods are not exposed to the
  WebView.
* stdout is defended before any backend import, so a stray `print()` cannot forge frames.
* Order methods run under a single lock; trading calls are refused while shutting down.
* The shell writes order-uncertain state to disk and blocks further submissions until the
  user acknowledges after checking open orders.

## 5. Order-execution safety

| Requirement | Implementation |
|---|---|
| Never trade on startup/reconnect | no order call exists in startup/reconnect paths; the only call sites are the explicit Set/Update buttons |
| Never silently retry non-idempotent requests | no retry logic; timeouts map to `EXECUTION_UNKNOWN`; the persisted gate blocks resubmission |
| Duplicate prevention | backend wrapper skips identical open orders; shell rejects identical in-flight payloads; backend rejects duplicate ids; trading serialized |
| Unknown execution status | `-32004` + "Execution status unknown" modal + "Check open orders" + explicit re-enable |
| Backend/exchange disconnection | trading controls disabled on any non-running status; reconnect never submits |
| Shutdown during submission | backend drains in-flight calls up to 10 s, rejects new trading calls; shell waits 12 s before kill |
| Order semantics unchanged | `Core/trading_service.py` is the extracted, behaviour-preserving implementation used by both UIs |
| No live test orders | regression suite never reaches the order path; the client remains on Hyperliquid **testnet** |

## 6. Updates

* Signed artifacts are mandatory: the updater plugin is registered only when
  `TRADEPANEL_UPDATER_PUBKEY` was provided at build time. Without it, update commands fail
  with an explicit "not configured" error; no unsigned artifact can be installed.
* Signature verification is performed by `tauri-plugin-updater` (minisign) before install.
* Installation is user-initiated from Settings → Updates (with a confirmation prompt).
* Sidecar and shell are shipped in the same bundle; the protocol handshake rejects
  mismatched combinations after a partial/manual update.
* Failure recovery: a failed download/signature/install surfaces the error and leaves the
  running version untouched.

## 7. Dependency auditing

```bash
npm audit --omit=dev --prefix frontend
npm audit --omit=dev
(cd src-tauri && cargo audit)        # cargo install cargo-audit
(cd src-tauri && cargo deny check)   # optional policy check
```

Pinned toolchain: Tauri 2.12.x, `@tauri-apps/api` 2.12.3, keyring 3.6.3, tokio 1.54.
Frontend production dependencies are limited to `@tauri-apps/api`; everything else is a
build-time dev dependency. The Python sidecar pins its runtime versions in
`backend/requirements.txt`.

## 8. Known limitations / follow-ups

* Windows 10/11 runtime validation is pending (build scripts and configuration are
  provided; no Windows host was available during this migration).
* Live/testnet order submission was not executed during migration testing; execution
  safety is verified through protocol tests, credential-gated rejection and manual
  reconciliation flows.
* Tauri capabilities should be re-audited after any new plugin is added.
* AppImage relies on the system WebKitGTK runtime; keep it updated with the OS.
