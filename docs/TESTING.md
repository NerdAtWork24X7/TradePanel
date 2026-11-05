# Testing

## 1. Automated suites

```bash
backend/scripts/test.sh            # everything below (except the packaged-sidecar check)
```

| Suite | Command | Count | Status |
|---|---|---|---|
| Python backend / IPC | `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'` | 78 | pass |
| Chart synchronisation | `node --test tests/chart_sync.test.mjs` | 21 | pass |
| Workspace bridge adapter | `node --test frontend/tests/tauri_bridge.test.mjs` | 13 | pass |
| Rust protocol/security/orders | `(cd src-tauri && cargo test)` | 12 | pass |
| Frontend types | `npm --prefix frontend run typecheck` | — | pass |
| Frontend production build | `npm --prefix frontend run build` | — | pass (59 KB JS, 17 KB gzip) |
| Dependency audit (prod) | `npm audit --omit=dev` (root + frontend) | — | 0 vulnerabilities |

Run date: 2026-11-05. Environment: Ubuntu 24.04, Python 3.12.13, Rust 1.98.1,
Node 24.20.0, headless Xvfb.

Headless note: the test session exports `WAYLAND_DISPLAY`, so X11 screenshots require
`GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1` (otherwise GTK creates the window on
the Wayland compositor and an Xvfb capture stays black). This affects test instrumentation
only, not the application.

### What the suites cover

**Python (78)** — existing market-data parsers/aggregation, workspace store and indicator
tests, credential file tests, plus the new sidecar suite:

* framing: request/notification shapes, malformed JSON, oversize frames, numeric ids;
* handshake success and protocol mismatch (`-32010`);
* unknown method (`-32601`), invalid params (`-32602`);
* duplicate request id (`-32012`), 12 concurrent correlated requests;
* shutdown drains in-flight work; serialized handlers never overlap;
* workspace store round-trip in the overridden data directory;
* window-state/alerts round-trip (unknown keys dropped, legacy keys merged);
* indicator config round-trip;
* secrets never echoed or logged; invalid key rejected;
* trading without credentials returns `-32001` and writes nothing;
* graceful shutdown exits 0 and every stdout line is valid JSON.

**JS adapter (13)** — inert outside an iframe; readiness announcement; QWebChannel-shaped
sync calls via JSON callback; `reqId` correlation through `dataReady`; `{ok:false,error}`
mapping; workspace signals become host events; host commands queue until boot; foreign
frame/origin messages ignored.

**Rust (12)** — response/error/notification parsing, malformed frames, allow-list excludes
handshake/shutdown/credentials, order timeout → `EXECUTION_UNKNOWN`, request framing,
credential validation, `.env` parsing, legacy data copy (no overwrite, WAL preserved),
restart backoff bounds, persisted uncertain state survives restart, identical in-flight
order rejection, order gate serialization.

## 2. End-to-end scenarios exercised manually

All runs used `Xvfb` (no physical display) and a temporary `XDG_DATA_HOME`.

| Scenario | Evidence |
|---|---|
| Dev build boots, backend handshake, workspace ready | logs: `backend handshake OK`, `bootstrap complete: 159 coins`, `workspace ready` |
| Release build with embedded assets boots | same log sequence without a Vite server |
| Packaged AppImage boots from a clean cwd | `TradePanel_0.1.0_amd64.AppImage` run with `APPIMAGE_EXTRACT_AND_RUN=1`; 4 charts rendered with live Binance/Bybit/OKX data |
| Multiple charts | default 4-chart workspace rendered; shell/frame layout intact |
| Crash detection + restart | `kill -9` on the sidecar → `restarting` status, `restart attempt 1`, new pid, handshake OK, charts resume polling |
| Single instance | second launch exits 0, no second sidecar process |
| Graceful shutdown | `WM_DELETE_WINDOW` → `Stopping Python sidecar`, backend `Shutdown started`, 0 backend processes left |
| Backend loss UI | reconnect banner + trading controls disabled while status ≠ running; no order path touched |
| Status event race | stale `starting` event ignored via `updatedAtMs`; UI stays `running` |
| Credential absence | `trading.place_order` and `account.position` return `-32001`; no file/order written |
| Persistence | `workspaces.json`, `window_state.json`, `alerts.json`, `indicator_config.json` written in the app-data dir; legacy values preserved |
| Settings UI | settings dialog opens (Ctrl+,), indicator save persists `fvg.gap_pct=0.75` to disk |
| Alert UI | Ctrl+Shift+A dialog saves `SOL` high/low into the existing `alerts.json` schema |
| Packaged sidecar studies | all eight advanced studies non-null over 800 candles |
| Legacy data import | 19 files copied from repo `data/` into app data; source untouched |

## 3. Performance (headless, indicative only)

Method (`tmp/measure.py`, not part of the product): Xvfb 1600×1000, software rendering,
fresh app-data dirs, first 35 s ignored, then RSS of the whole process tree and 10 s CPU
sampling with charts live and polling. Window time = first mapped window ≥ 1000 px wide.
No hardware acceleration; CPU numbers are dominated by software compositing and are not a
desktop benchmark.

| Build | Window mapped | Idle RSS (tree) | Idle CPU |
|---|---|---|---|
| Qt/PySide6 (audited app) | 2.17–2.18 s | 1166–1175 MB | 48–90 % |
| Tauri dev (`target/debug`) | 0.31–0.34 s | 567–757 MB | 0.1–5.4 % |
| Tauri release | 0.27–0.31 s | 746 MB | 4.5 % |

Context: the Tauri tree includes the Python sidecar (~250 MB with pandas/numba) and
WebKitGTK web/network processes. Workspace readiness (all charts rendered with live data)
was ~4–5 s after launch in the release build. The Qt app's chart-readiness milestone was
not instrumented, so only window mapping and steady-state resources are comparable.
These measurements were taken on one Ubuntu 24.04 machine; do not treat them as
cross-platform claims.

## 4. Security checks performed

* `capabilities/default.json` contains no shell/fs/http/process permissions
  (`grep -R "shell:\\|fs:\\|http:" src-tauri/capabilities` → none).
* CSP includes `connect-src` limited to IPC + `frame-src`/`frame-ancestors 'self'`.
* The WebView allow-list test asserts `system.hello/shutdown/set_credentials` are not
  callable.
* Secret round-trip test asserts the private key/address never appear in responses or
  stderr.
* Packaged binary contains no Qt (`python -c` import graph is unreachable; PyInstaller
  excludes PySide6).
* `npm audit --omit=dev` reports 0 vulnerabilities (root and frontend).
* Manual inspection: logs contain credential **key names** only.

## 5. Not verified in this migration

| Item | Status |
|---|---|
| Windows 10/11 runtime (WebView2, Credential Manager, NSIS install) | **Not verified** — no Windows host; configuration and scripts are provided |
| Live or testnet order submission | **Not executed** (explicitly prohibited); safety paths verified via mocks/guards |
| Keyring unlock/denial UX with a real Secret Service | Unavailable under the headless test session; explicit failure path implemented |
| Signed update download/install | Not executed (requires a configured key + release endpoint); registration/refusal paths verified |
| Crosshair/scroll sync, drawings, fullscreen, high-DPI, 8-chart load on WebKitGTK | Rendered workspace verified; interaction-level parity needs a manual desktop pass |
| macOS | Out of scope for this brief |
| Long-running stability / memory leaks | Short sessions only |

## 6. Manual cross-platform checklist

**Windows 11**

1. Install the NSIS build on a clean VM (no Python).
2. Verify WebView2 bootstrap, tray-free launch, fonts and DPI at 125/150 %.
3. Confirm Credential Manager entries (`TradePanel`) and that Settings shows `set` flags.
4. Confirm the sidecar starts/stops and no console window appears.
5. Kill the sidecar from Task Manager → reconnect banner → charts recover.
6. Open 4/6/8 charts, change symbols/timeframes, draw positions, reload, verify persistence.
7. Testnet order placement and cancellation with disposable keys; verify duplicate guard
   by double-clicking Set Order.
8. Check the updater with a signed test artifact.

**Ubuntu 24.04 / Linux Mint 22**

1. Install the `.deb` (dependencies include `libwebkit2gtk-4.1-0`).
2. Repeat steps 2–7 above (Secret Service instead of Credential Manager).
3. Verify AppImage launch from a clean user account, Wayland and X11 sessions.

Record results in this file before declaring a release candidate.
