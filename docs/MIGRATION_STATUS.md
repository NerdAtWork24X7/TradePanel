# Migration Status

Branch: `feature/tauri2-migration`. The legacy PySide6 application (`main.py`, `UI/`) is
untouched and still runs.

## Phase log

| Phase | Status | Deliverable | Commit |
|---|---|---|---|
| 0 — Audit | Complete | `docs/MIGRATION_AUDIT.md`, baseline suites green | `95d5870` |
| 1 — Tauri foundation | Complete (Linux verified) | `src-tauri/` shell, strict CSP, capabilities, Vite/TypeScript frontend | `9436fe7` |
| 2 — Python sidecar | Complete | JSON-RPC server, supervisor, handshake, health, restart, shutdown drain, protocol tests | `fb8237c` |
| 3 — Chart workspace | Complete (Linux verified) | `tauri_bridge.js` adapter, iframe host, existing workspace untouched, live data in WebKitGTK | `f3f8a80` |
| 4 — Trading integration | Implemented, sandbox-gated | typed services, position read, order submit/update, duplicate + unknown-status guards | `9436fe7` |
| 5 — Desktop UI | Implemented | toolbar, trade ticket, favourites, settings, alerts, status/error UI, window state | `9436fe7` |
| 6 — Security | Implemented | keyring credentials, explicit legacy import, allow-list, CSP, order gate | `9436fe7` |
| 7 — Packaging | Linux complete, Windows scripted | one-folder sidecar, AppImage 167 MB, .deb 107 MB, NSIS script, updater wiring | docs commit |
| 8 — Regression | Linux complete, Windows pending | 110 automated tests, E2E crash/restart/shutdown/AppImage, performance notes | docs commit |

## Definition of Done

### Application
- [x] Tauri 2 desktop application launches (Linux dev + release + AppImage).
- [ ] Windows build works — scripted (`backend/scripts/build-windows.ps1`) and configured; **not executed** (no Windows host).
- [x] Linux build works (AppImage + deb).
- [x] Python backend starts automatically.
- [x] Backend crashes are detected and restart with bounded backoff.
- [x] Backend shuts down cleanly; no process left behind.

### Charts
- [x] Existing chart workspace loads inside the Tauri WebView.
- [x] Multiple charts work (4-chart default, 2-chart saved workspace, up to 12 schema limit).
- [ ] Chart synchronization interaction verified manually on a desktop (rendered workspace verified; sync manager unit-tested).
- [x] Indicators render (native + all eight Python studies non-null in packaged sidecar).
- [ ] Drawing tools verified end-to-end on WebKitGTK (workspace code unchanged; not exercised by automation).
- [x] Workspace persistence (`workspaces.json` written/loaded in the app-data dir).
- [x] Symbol and timeframe switching paths implemented (focused chart ↔ toolbar, search RPC).

### Trading
- [x] Exchange connectivity (market data for 8 exchanges + Hyperliquid client initialization path).
- [x] Market data streams (existing poll loop) work through the sidecar.
- [x] Account information path implemented (`account.position`, `account.open_orders`).
- [x] Positions path implements the audited TP/SL and default-level behaviour.
- [ ] Order submission verified on testnet — **not executed** (prohibited during migration testing); credential-gated rejection and guards tested.
- [ ] Order cancellation verified — same; implementation preserved from the audited `place_order`/`update_tp_sl` flow.
- [x] Duplicate order protection tested (identical in-flight payload, duplicate JSON-RPC id, existing identical-order no-op).
- [x] Disconnection handling tested (crash, restart, status transitions, no auto-trade).

### Security
- [x] Credentials stored in the OS credential store (Windows/macOS/Linux backends compiled in).
- [x] Private keys never reach frontend JavaScript (status returns flags only; tests assert no secret echo).
- [x] Tauri capabilities are restrictive (no shell/fs/http).
- [x] Sidecar IPC validated (allow-list, handshake, size limits, ids, params).
- [ ] Updates signed and verified end-to-end — signing is enforced by design (no pubkey ⇒ updater disabled); artifact install not executed.

### Deployment
- [x] Python backend bundled (one-folder PyInstaller resource).
- [ ] Clean Windows installation works — pending Windows validation.
- [x] Clean Linux installation works (AppImage run from `/tmp` with empty XDG dirs, no Python on PATH usage).
- [x] Existing user data preserved (copy-only import incl. WAL/SHM; window-state merge; no resets).
- [ ] Update process executed — not verified.

### Quality
- [x] Backend regression tests pass (69).
- [x] IPC tests pass (included above; 17 sidecar tests).
- [x] UI tests pass (21 sync + 8 adapter + typecheck/build); interaction checks are manual.
- [x] No known critical trading regressions.
- [x] Performance benchmarked (headless; see `docs/TESTING.md`).
- [x] Documentation complete (`MIGRATION_AUDIT`, `ARCHITECTURE`, `IPC_PROTOCOL`, `SECURITY`, `BUILD`, `TESTING`, this file).

## Required before release

1. Windows 11 validation on a clean VM (installer, WebView2, Credential Manager, sidecar).
2. Manual WebKitGTK interaction pass: crosshair/time sync, drawings, fullscreen, DPI, 8 charts.
3. Testnet order placement/cancellation with disposable credentials, including a forced
   timeout to exercise the persisted "execution unknown" gate.
4. Signed updater round-trip with a real endpoint and key.
5. Optional: trim the sidecar footprint (numba/llvmlite) if a no-numba `pandas_ta` path is
   proven equivalent.
