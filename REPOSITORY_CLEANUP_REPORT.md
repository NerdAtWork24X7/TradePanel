# Repository Cleanup Report — TradePanel

Date: 2026-11-05
Base commit: `a1b4ac1` (`main`, "refactor: reorganize project into backend and frontend layout")
Working tree at start: clean (no pre-existing user modifications)
Scope: repository audit and dead-code/artifact removal only. No trading logic, IPC contract,
capability set, CSP, UI design or build output semantics were changed.

---

## A. Executive summary

**Overall health: good.** The Tauri 2 migration had already removed the PySide6 shell; the
repository contains **no tracked Qt/C++ sources, build files or entry points** (`.cpp`, `.h`,
`.pro`, `.ui`, `.qrc`, `.qml`, `.qss`, CMake). The remaining Qt-era contamination was small and
concentrated in the Python `Core` layer plus one unresolvable `<script>` tag in the chart
workspace.

**Main problems found**

1. `backend/Core/candle_service.py` (352 lines) was a complete dead subsystem: a Binance
   REST + SQLite candle cache with **zero importers** anywhere in the repository. Live market
   data goes through `Core/market_data.py`.
2. Eight Qt-application constants remained in `Core/config.py` (`WINDOW_TITLE`,
   `WINDOW_WIDTH`, `WINDOW_HEIGHT`, `DEFAULT_RISK`, `DEFAULT_TIMEFRAME`, `WEB_DIR`,
   `BUNDLED_WEB_DIR`, `REALTIME_UPDATE_INTERVAL_MS`) with no readers.
3. `Core/utils.py` carried an unused `DaemonThreadPoolExecutor` that reached into CPython
   private APIs (`concurrent.futures.thread._worker`, `_threads_queues`).
4. `frontend/web/workspace.html` still loaded `qrc:///qtwebchannel/qwebchannel.js`, a scheme
   that cannot resolve in a Tauri WebView and is blocked by the production CSP
   (`script-src 'self'`).
5. Small dead frontend surface: `closeActiveModal()`, `TradeLevels`, a duplicated inline
   `AppInfo` return type, and `rangeEquals()` in `chart_sync.js`.
6. **Build reproducibility defect:** `backend/build/backend.spec` and
   `backend/build/requirements-build.txt` are required by `backend/scripts/build-backend.sh`
   but were excluded by the generic `build/` ignore rule, so a fresh clone could not build the
   sidecar. Their references in the build scripts were therefore dangling.
7. Two dependency sources were duplicated (root `requirements.txt` vs `pyproject.toml`), and
   `thiserror` was a declared but unused Rust dependency.
8. Documentation drift: `docs/MIGRATION_STATUS.md` still claimed the legacy PySide6 app "is
   untouched and still runs"; README listed a non-existent `frontend/src/state/`; test counts
   and bundle sizes in `docs/TESTING.md` were stale; `docs/BUILD.md` pointed at a moved
   Windows script.

**Cleanup performed:** 3 files deleted, 2 required-but-ignored build inputs restored to
version control, 13 dead symbols/constants plus one dead module removed, 1 Rust dependency
removed, 4 clippy warnings fixed, `cargo fmt` applied, 6 documentation inaccuracies corrected.

**Remaining concerns:** Windows/macOS runtime is still unverified (no host), testnet order
execution remains untested (prohibited), a few Qt-contract items are intentionally retained
(see §E), and the audit found one **pre-existing IPC allow-list defect** that was documented
rather than fixed, because fixing it would broaden IPC capabilities during a cleanup
(`trading.price_precision`, see §H.1).

---

## B. Removed files

| File/Directory | Reason for Removal | Verification |
|---|---|---|
| `backend/Core/candle_service.py` (352 lines) | Full dead subsystem (Binance REST + SQLite candle cache, table management, paginated fetchers). Not imported by any Python module, the IPC registry, the frontend, tests, or the sidecar. Live candles come from `Core/market_data.py`. | `grep -rn candle_service` over all tracked files → only the file itself and historical docs; PyInstaller `hiddenimports` entry removed; sidecar `--self-check` passes; 78 Python tests pass |
| `requirements.txt` (root) | Unpinned duplicate of the dependency set in `pyproject.toml` and the pinned `backend/requirements.txt`. No script, workflow or doc referenced the root file (`start.sh`/`uv sync` use `pyproject.toml`; sidecar builds use `backend/requirements.txt`). | `git grep "requirements.txt"` → only `backend/requirements.txt` references; `uv sync` path unchanged |
| `docs/MIGRATION_STATUS.md` (79 lines) | Obsolete migration phase log with stale claims ("legacy PySide6 application … still runs", old branch name, commit hashes). Superseded by `README.md` + `docs/ARCHITECTURE.md`. | No inbound links remain (README row removed, no other doc referenced it); markdown link audit reports zero broken links |
| `frontend/src/state/` (empty directory, untracked) | Leftover directory from an earlier refactor; contained no files and was listed in README as if it existed. | `rmdir` succeeded (directory was empty); typecheck/build unaffected |

### Files restored to version control (not removals)

| File | Why | Verification |
|---|---|---|
| `backend/build/backend.spec` | Required input of `backend/scripts/build-backend.sh`; was ignored by the generic `build/` rule. `hiddenimports` entry for the deleted `candle_service` removed. | Rebuilt the sidecar with the edited spec: PyInstaller build OK, packaged `--self-check` → `OK protocol=1 methods=25 exchanges=9 layouts=7` |
| `backend/build/requirements-build.txt` | Same; referenced by `build-backend.sh` / `build-backend.ps1`. | Same build run |

`.gitignore` now ignores `backend/build/work/` and `dist/` instead of the whole `build/`
directory, so the build inputs are trackable while PyInstaller output stays ignored.

---

## C. Removed code

### C.1 Python

| Location | Removed | Lines | Evidence it was dead |
|---|---|---|---|
| `backend/Core/candle_service.py` | Entire module | 352 | No importers; see §B |
| `backend/Core/config.py` | `WEB_DIR`, `BUNDLED_WEB_DIR`, `WINDOW_TITLE`, `WINDOW_WIDTH`, `WINDOW_HEIGHT`, `DEFAULT_RISK`, `DEFAULT_TIMEFRAME`, `REALTIME_UPDATE_INTERVAL_MS`, and the now-unused private `_INTERNAL` | 14 | Repo-wide token search: each symbol appears exactly once (its definition). Python/Jinja/RPC/frontend/config consumers absent. |
| `backend/Core/utils.py` | `DaemonThreadPoolExecutor` class + `threading`, `weakref`, `ThreadPoolExecutor`, `_threads_queues`, `_worker` imports | 47 | Zero references to the class name in the repository |
| `backend/Core/workspace_indicators.py` | `SESSION_KEYS` mapping | 6 | Zero references (`SESSION_FLAGS` is the live constant) |

Retained on purpose in the same files: `candles_db_path()` and `load_candles_df()` are still
used by the seven `Indicator/*` modules as their documented `df=None` fallback, and
`TIMEFRAMES` / `LONG_TP_PCT` / `SHORT_*` are consumed by `trading_service` and the IPC layer.

### C.2 TypeScript

| Location | Removed | Lines |
|---|---|---|
| `frontend/src/components/modal.ts` | `closeActiveModal()` export (no caller; modal lifecycle is owned by `openModal`) | 4 |
| `frontend/src/types.ts` | `TradeLevels` interface (no references) | 7 |
| `frontend/src/services/backend.ts` | Duplicated inline `AppInfo` return type; now reuses the existing `types.ts` `AppInfo` | 4 net |

### C.3 JavaScript / HTML

| Location | Removed | Lines |
|---|---|---|
| `frontend/web/chart_sync.js` | `rangeEquals()` helper (never called; sync comparisons use the registration ranges) | 6 |
| `frontend/web/workspace.html` | `<script src="qrc:///qtwebchannel/qwebchannel.js">` — unresolvable Qt scheme, blocked by CSP | 1 |
| `frontend/web/tauri_bridge.js`, `frontend/web/workspace.js` | Corrected two stale comments that described QWebChannel as the active transport | 5 changed (comments only) |

### C.4 Rust

No dead functions, structs, enums, traits or modules were found: `cargo check --all-targets`
reports no `dead_code`/`unused_imports` warnings, clippy is clean, and every `pub` item was
manually traced to a caller (`FRONTEND_METHODS` / `generate_handler!` / `events` / tests).

Changes made were limited to quality:

- `Cargo.toml`: removed unused `thiserror = "2"` dependency (no `thiserror::` usage, no
  `#[derive(Error)]`).
- `security/mod.rs`: two redundant closures → `map_err(store_error)`; nested `match` on
  `SecretStore::entry` → `?` (identical control flow).
- `lib.rs`: `std::io::Error::new(ErrorKind::Other, e)` → `std::io::Error::other(e)`.
- `cargo fmt`: 35 formatting hunks across 7 files (line wrapping only; **no semantic change**).

### C.5 Duplicate implementations

- Root `requirements.txt` duplicated `pyproject.toml` (removed).
- Inline `AppInfo` shape duplicated the exported interface (deduplicated, see C.2).
- No duplicated workspace: `frontend/web` remains the single chart implementation.

---

## D. Dependency cleanup

| Dependency | Package Manager | Reason for Removal |
|---|---|---|
| `thiserror` | Cargo | Declared in `src-tauri/Cargo.toml`, never used (`grep thiserror src/` → no matches). Transitive copies remain in `Cargo.lock` via Tauri, so no lockfile churn beyond the removed edge. |
| `requirements.txt` (root, 5 specs) | pip / uv | Redundant second source of the same five dependencies already in `pyproject.toml`; unreferenced. |

Audited and **kept** (all proven used):

- npm: `@tauri-apps/api` (6 service modules), `typescript` (typecheck/build), `vite`
  (`vite.config.ts`, build), `@tauri-apps/cli` (root scripts).
- Cargo: `tauri`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, `tauri-plugin-log`,
  `serde` (derives in `commands`, `protocol`, `security`), `serde_json`, `tokio`
  (io/process/sync/time + `#[tokio::test]`), `log`, `open` (`open_trade_page`), `keyring`
  (credential store), `zeroize` (`Zeroizing<String>`).
- Python: `python-dotenv` (config), `requests` (market data, Hyperliquid), `pandas`
  (indicators), `pandas_ta` (studies), `hyperliquid-python-sdk` (exchange), `numpy`
  (indicators, pinned in `backend/requirements.txt`, required by PyInstaller `hiddenimports`).

No package upgrades or version changes were performed.

---

## E. Retained legacy files

| Item | Why retained |
|---|---|
| `frontend/web/workspace.js` → `Bridge.connect` QWebChannel branch, `Bridge._attach` `dataReady.connect` branch | Unreachable inside the Tauri shell (the adapter always installs `window.__WS_STUB__` first), but it is the documented no-stub path for loading `workspace.html` directly and the contract the adapter mirrors. Removing it is a behavioural edit to a file the architecture declares "unchanged"; the payoff is ~10 lines. Documented as the one remaining Qt-shaped code path. |
| `frontend/web/tauri_bridge.js` (QWebChannel-shaped stub API) | Not Qt code: it is the compatibility surface that lets `workspace.js` run unmodified, exercised by 13 adapter tests. Its docstring now states the actual transport (postMessage). |
| `docs/MIGRATION_AUDIT.md` | Historical audit trail for trading behaviour and the dependency map (referenced in `ARCHITECTURE.md` "deliberate deviations"). Marked with an explicit "Historical document" banner and links to the current design. |
| `Changelog.md` | Project history; contains Qt-era entries by design. |
| `backend/ipc/protocol.py` → `TIMEOUT`, `EXECUTION_UNKNOWN` | Wire-protocol codes mirrored by Rust (`-32002` / `-32004`). Currently unused inside Python, but they document the contract; deleting them invites drift. |
| `backend/strategies/strategy_v6.pine` | Strategy reference asset shipped with the original application; not referenced by code, but it is user-facing domain material, not a build artifact. |
| `install-desktop.sh` + `logo.png` | A dev-checkout desktop launcher (menu entry pointing at `start.sh`) that still works. `logo.png` is its icon; no Tauri bundle reference, so both stay together. |
| `src-tauri/icons/64x64.png`, `icons/icon.png` | Standard Tauri icon set. `icon.png` is embedded by `tauri-build` as the default window icon even though `bundle.icon` does not list it; `64x64.png` is part of the conventional set. |
| `data/`, `keys/`, `tmp/`, `.pi*`, `.venv*`, `src-tauri/{target,gen,backend-dist}`, `frontend/dist` | Gitignored local artifacts (legacy user data, secrets, build output). Not part of the repository. |

---

## F. Validation results

All commands were executed on this host (Ubuntu 24.04.5, Python 3.12.13, Node 24.20.0,
Rust 1.98.1). The host lacks the WebKitGTK **development** headers, so the repository's own
pkg-config sysroot discovery (`start.sh` looks for `webkit2gtk-4.1.pc`) was used explicitly:

```bash
export PKG_CONFIG_PATH=/tmp/tpsysroot/lib/pkgconfig
```

| Check | Result | Notes |
|---|---|---|
| Frontend production build | **PASS** | `npm --prefix frontend run build` → `dist/index.html 13.64 kB`, CSS 17.53 kB, JS 59.00 kB (gzip 17.14 kB); `workspace.html`, fonts and LWC copied from `publicDir` |
| Type checking | **PASS** | `tsc --noEmit`, `noUnusedLocals`/`noUnusedParameters` enabled |
| Lint | **N/A** | No linter configured in the repository (not added, per no-new-dependencies rule). TypeScript strict mode + `tsc` is the configured gate. |
| Rust check | **PASS** | `cargo check --all-targets` (before and after cleanup) |
| Rust tests | **PASS** | `cargo test` → 12 passed, 0 failed |
| Clippy | **PASS** | `cargo clippy --all-targets` → 0 warnings (baseline: 4) |
| `cargo fmt --check` | **PASS** | Baseline failed with 35 hunks; formatting applied (whitespace only) |
| Python tests | **PASS** | `python -m unittest discover -s tests -p 'test_*.py'` → 78 tests OK |
| Chart sync tests | **PASS** | `node --test tests/chart_sync.test.mjs` → 21 pass |
| Bridge adapter tests | **PASS** | `node --test frontend/tests/*.test.mjs` → 13 pass |
| Aggregate suite | **PASS** | `PKG_CONFIG_PATH=… backend/scripts/test.sh` → "All checks passed." |
| Sidecar self-check (source) | **PASS** | `python -m backend.sidecar --self-check` → `OK protocol=1 methods=25 exchanges=9 layouts=7` |
| Sidecar build (PyInstaller) | **PASS** | `backend/scripts/build-backend.sh` rebuilt one-folder sidecar with the edited spec; packaged `--self-check` OK |
| Tauri build (release, no bundle) | **PASS** | `npx tauri build --no-bundle` → `Finished release profile in 2m 02s`, binary at `src-tauri/target/release/tradepanel` (run twice: before and after the sidecar rebuild) |
| Functional startup | **PASS** | Headless Xvfb run: `Backend handshake OK (protocol 1)`, `bootstrap complete: 159 coins, tf=5m`, `workspace ready: chart bridge connected`; no errors or panics |
| Trading screens / charts render | **PASS** | Screenshot of the running release build: 2-chart workspace with live Binance `SOL/USDT` and Bybit `BTC/USDT` candles, MA ribbon, volume, indicator bar, trade ticket (QTY/RISK/LIM/TP/SL, Set Order), "Ready" status, "BACKEND 0.1.0" |
| Live/testnet order execution | **NOT RUN** | Prohibited during cleanup; no order path was modified |
| Windows/macOS runtime | **NOT RUN** | No host available; configuration/scripts unchanged by this cleanup |

The release binary was executed with throwaway `XDG_*` directories, so no user data or
credential store entry was touched. Only public market-data endpoints were contacted (read-only).

---

## G. Repository statistics

Counting method: line counts via `splitlines()` on Git-tracked text files; "code" =
`.py .ts .js .mjs .html .css .rs .sh .ps1 .spec .pine .toml` (lockfiles, `CHANGELOG`-style
prose and binary assets excluded). "Before" = `HEAD` (`a1b4ac1`), "after" = resulting index.

| Metric | Before | After | Δ |
|---|---|---|---|
| Total tracked files | 131 | 130 | −1 |
| Tracked code lines | 23,315 | 23,043 | −272 |
| Python | 7,802 | 7,385 | −417 |
| TypeScript | 2,745 | 2,730 | −15 |
| JavaScript | 6,255 | 6,248 | −7 |
| Rust | 2,321 | 2,353 | +32 (rustfmt line wrapping) |
| HTML | 1,359 | 1,358 | −1 |
| CSS | 1,177 | 1,177 | 0 |
| Tests (`.mjs`) | 720 | 720 | 0 |
| Docs (`.md`, incl. this report) | 1,753 | 1,678 + report | −75 |
| Qt/C++ tracked files (`cpp/h/pro/pri/ui/qrc/qml/qss/cmake`) | 0 | 0 | 0 |
| Frontend npm dependencies (direct) | 1 prod + 2 dev + 1 root dev | unchanged | 0 |
| Rust Cargo dependencies (direct) | 12 | 11 | −1 |
| Python dependency specs (direct) | 2 lists (5 + 5) + 1 pinned (6) | 1 list (5) + 1 pinned (6) | −1 list |
| Files deleted | — | 3 | — |
| Files restored to the repository | — | 2 | — |
| Dead symbols/constants removed | — | 13 (+1 module) | — |
| Lines removed (gross deletions) | — | 627 | — |
| Lines added (gross insertions) | — | 277 | — |

Gross diff: **+277 / −627** (`git diff --stat` over 30 files). Of the 277 insertions, 137 are
`backend/build/backend.spec` being tracked for the first time (it already existed on disk and
is not new code), and ~180 are `rustfmt` re-wrapping of Rust lines. **Net semantic source
reduction: ≈ 304 lines** (352-line module + 67 lines of dead Python/TS/JS + 5-line duplicate
dependency list + docs, minus small comment/type dedup changes).

Build/test status: all previously passing suites still pass; the previously failing
`cargo fmt --check` now passes; clippy warnings went from 4 to 0.

---

## H. Outstanding issues

1. **Pre-existing IPC allow-list defect (documented, not fixed).**
   `backend/ipc/methods.py:385` registers `trading.price_precision` and
   `frontend/src/services/trading.ts:78` invokes it, but the method is missing from
   `FRONTEND_METHODS` (`src-tauri/src/protocol.rs:243–264`), so `backend_rpc` rejects the
   call. Impact is graceful: `controller.ts:661` catches the error and the ticket falls back
   to default price formatting instead of the exchange tick size. Fixing it is a one-line
   allow-list addition, but Phase 5 forbids broadening IPC capabilities during cleanup, so it
   is reported for an explicit decision rather than changed here. All other 19 methods the
   frontend calls are allow-listed.
2. **Windows and macOS were not validated.** No host available. NSIS script, WebView2
   bootstrap, Credential Manager and macOS keychain remain unverified (pre-existing gap).
3. **Testnet order placement/cancellation was not executed** (prohibited for this task and by
   the repository's own testing policy). The order gate, duplicate guard and
   `EXECUTION_UNKNOWN` paths were not modified; their unit tests pass.
4. **Rust builds used a stub pkg-config sysroot** because the WebKitGTK dev packages are not
   installed on this host. Compilation, linking, and runtime were all verified with it, but a
   build against distro `-dev` packages was not repeated.
5. **The restored build inputs are staged, not committed.** `backend/build/backend.spec` and
   `backend/build/requirements-build.txt` were added to the index; the change only reaches a
   clone after a commit. No commit was created (out of scope).
6. **Legacy SQLite candle cache is now read-only.** With `candle_service` gone nothing writes
   `data/candles_<tf>.db`; `load_candles_df()` still reads it as a fallback but the workspace
   indicator path always passes a DataFrame. Removing that fallback would be a behavioural
   refactor of the indicator modules and was deliberately left alone.
7. **`workspace.js` keeps its QWebChannel branch** and `ipc/protocol.py` keeps two
   contract-only error constants (see §E).
8. **Local untracked footprint** is large (`src-tauri/target` 15 GB, `.venv-build` 301 MB,
   `backend/build/dist` ~267 MB, `data/` 9 MB). All are ignored and outside the repository,
   but they dominate disk usage on a working checkout.
9. `frontend/src/lib/exchange-price.ts` is only reachable through the shell controller and a
   Node test; it is correctly scoped but there is no unit-test harness that type-checks it
   beyond `tsc` (unchanged).

---

## I. Final assessment

**Status: Mostly clean.**

Every category in the brief was audited and, where removal was provable, executed:

- No tracked Qt/C++ implementation, build system or resource pipeline remains.
- No unused Tauri plugin, unused capability or orphaned command exists: 25 IPC methods are
  registered, 20 are allow-listed for the WebView, 4 are Rust-internal handshake/shutdown/
  credential methods, and 1 (`trading.price_precision`) is reachable from the frontend but
  missing from the allow-list — a pre-existing defect documented in §H.1, deliberately not
  fixed because it would widen IPC capabilities during cleanup. Capabilities and CSP are
  untouched.
- No unused npm/Cargo/Python dependency remains that could be proven unnecessary.
- No unused frontend component, hook, service, style, font or image remains; all 145 inline
  workspace CSS classes, all 35 workspace element ids, all 47 shell ids and all 72 shell CSS
  classes are referenced.
- The four validation gates that previously failed or warned (fmt, clippy) are now clean.
- A required build input that was accidentally excluded from the repository is restored, so a
  fresh clone can build the sidecar again.

The classification is **not "Clean"** because of the deliberate retentions listed in §E
(QWebChannel fallback, contract-only protocol constants), the uncommitted restoration of the
build inputs, and the unchanged platform/testnet verification gaps that a cleanup task cannot
close. None of these is dead weight that could be removed without either changing behaviour
or losing contract documentation.
