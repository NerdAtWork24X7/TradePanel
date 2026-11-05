# Build and Packaging

Tested toolchain (migration baseline):

| Tool | Version |
|---|---|
| Rust / Cargo | 1.98.1 |
| Tauri crate / CLI | 2.12.5 / 2.12.2 |
| Node / npm | 24.20.0 / 11.19.0 |
| TypeScript / Vite | 5.9.3 / 7.3.7 |
| Python | 3.12.13 |
| PyInstaller | 6.22.3 |

## 1. Prerequisites

### Linux (Ubuntu 24.04 / Linux Mint 22)

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev \
  libayatana-appindicator3-dev
```

* Tauri 2 requires **webkit2gtk-4.1** (not 4.0). Verify with
  `pkg-config --modversion webkit2gtk-4.1`.
* The AppImage/deb bundles do **not** ship WebKitGTK; the target machine needs
  `libwebkit2gtk-4.1-0` and `libgtk-3-0` (the deb declares these dependencies).
* Python 3.12 + [uv](https://docs.astral.sh/uv/) (or plain venv/pip).
* Node 20+ and Rust 1.77+.

### Windows 10/11

* Visual Studio Build Tools with "Desktop development with C++".
* Rust MSVC toolchain (`rustup default stable-msvc`).
* Node 20+, Python 3.12, uv (optional).
* WebView2: the NSIS installer uses the evergreen bootstrapper
  (`bundle.windows.webviewInstallMode = downloadBootstrapper`).
* NSIS is downloaded by the Tauri bundler on first release build.

## 2. First-time setup

```bash
# repository root
npm install                 # Tauri CLI (dev dependency)
npm --prefix frontend install   # Vite/TypeScript/@tauri-apps/api

# or let the launcher do it:
./start.sh
```

The Python app environment (legacy Qt app and tests) is managed by uv:

```bash
uv sync
```

## 3. Python sidecar

```bash
backend/scripts/build-backend.sh          # Linux/macOS
powershell -File backend/scripts/build-backend.ps1   # Windows
```

What it does:

1. Creates `.venv-build` and installs `backend/requirements.txt` + PyInstaller.
2. Runs `backend/build/backend.spec` as a **one-folder** bundle.
3. Copies the folder to `src-tauri/backend-dist/tradepanel-backend/`.
4. Runs `tradepanel-backend --self-check` (imports the full backend surface).

Why one folder: a one-file PyInstaller binary is a bootloader parent plus a Python child.
Killing the process the shell spawned would leave an orphan, making supervision and
shutdown unreliable. One folder = one process. Set `TRADEPANEL_BACKEND_ONEFILE=1` only for
a manual experiment and place the binary yourself.

The sidecar is staged as a Tauri **resource** (`backend-dist/tradepanel-backend` →
`backend/` in the bundle), not an `externalBin`. Tauri resolves it at runtime from the
resource directory; `TRADEPANEL_BACKEND_BIN` can override it for diagnostics.

Notes:

* PyInstaller must use `console=True` on Windows (stdio pipes); the shell spawns it with
  `CREATE_NO_WINDOW`, so no console appears.
* `numba`/`llvmlite` are bundled because `pandas_ta` imports numba unconditionally. The
  optional TBB threading backend is stripped (`libtbb.so.12` is not a dependency) and the
  sidecar runs with `NUMBA_THREADING_LAYER=workqueue`.
* Sidecar size: ~267 MB on disk, ~107 MB inside the .deb, ~167 MB AppImage (includes the
  webview-independent Python scientific stack).

## 4. Development

```bash
./start.sh                  # deps + sidecar (if missing) + tauri dev
./start.sh --rebuild-backend   # force a fresh PyInstaller sidecar first
backend/scripts/dev.sh              # same launcher without the toolchain checks
```

`./start.sh` is safe from any working directory: it installs `node_modules` when missing,
builds `src-tauri/backend-dist/tradepanel-backend` when missing (or when
`--rebuild-backend` is passed), then runs `tauri dev`. Arguments after `--` go to
`tauri dev`, e.g. `./start.sh -- --no-watch`.

Manual equivalent:

```bash
backend/scripts/build-backend.sh
npx tauri dev
```

* `tauri dev` starts Vite on `http://localhost:5173`, then the Rust shell.
* `custom-protocol` is a **default feature** (`src-tauri/Cargo.toml`) that is only
  compiled into release builds; `tauri dev` runs `cargo run --no-default-features` so the
  webview loads `devUrl` instead of the assets embedded in the binary. Keep it that way —
  if it is added to `[dependencies]` unconditionally, `tauri dev` silently serves the last
  compiled `frontend/dist` and frontend edits need a full rebuild.
* `cargo run` **without** the Tauri CLI uses `devUrl`; start Vite yourself
  (`npm --prefix frontend run dev`).
* `cargo build --release` embeds `frontend/dist` because the `custom-protocol` feature is
  enabled in `Cargo.toml`. Run `npm --prefix frontend run build` first.

## 5. Linux release

```bash
./build.sh                    # AppImage + deb (targets from tauri.linux.conf.json)
backend/scripts/build-linux.sh        # thin wrapper over ./build.sh
```

`./build.sh` options:

| Flag | Effect |
|---|---|
| `--debug` | debug bundle instead of an optimised release build |
| `--bundles=deb,appimage` | override the platform bundle targets |
| `--skip-backend` | reuse the already staged sidecar (fails if it is missing) |
| `--install` | force `npm ci` for the shell and the frontend |
| `-- <args>` | forwarded to `tauri build` (e.g. `--no-bundle`, `--verbose`) |

It builds the sidecar, prunes stale staging (`target/release/backend`,
`target/release/bundle`, the pre-resource-mapping `tradepanel-backend` file), runs
`tauri build`, then lists the produced artifacts.

Outputs:

```
src-tauri/target/release/bundle/appimage/TradePanel_0.1.0_amd64.AppImage
src-tauri/target/release/bundle/deb/TradePanel_0.1.0_amd64.deb
```

If AppImage bundling fails on a machine without FUSE, run:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./build.sh --bundles=appimage --skip-backend
```

Clean-install check (no Python installed required):

```bash
chmod +x TradePanel_0.1.0_amd64.AppImage
./TradePanel_0.1.0_amd64.AppImage
```

## 6. Windows release

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
# options: -SkipBackend  (reuse the staged sidecar)
#          -Install      (force npm ci for shell and frontend)
```

`build.sh` detects Git Bash/MSYS on Windows and delegates to this script.

Outputs (NSIS):

```
src-tauri\target\release\bundle\nsis\TradePanel_0.1.0_x64-setup.exe
```

The installer bundles the one-folder sidecar and installs WebView2 if missing. Verify on a
clean Windows 11 VM (no Python, no Rust, no Node).

## 7. Signed updates (opt-in)

The repository ships `bundle.createUpdaterArtifacts: false` and an empty updater pubkey.
The updater plugin is registered **only** when a public key is supplied at build time;
otherwise Settings → Updates reports that updates are not configured (fail closed).

One-time setup:

```bash
npx tauri signer generate -w ~/.tauri/tradepanel.key
# copy the printed public key
export TRADEPANEL_UPDATER_PUBKEY="<public key>"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tradepanel.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password>"
```

Then:

1. Set real endpoints in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
   (TLS required; `{{target}}`, `{{arch}}`, `{{current_version}}` are supported).
2. Set `bundle.createUpdaterArtifacts: true`.
3. Build with the three environment variables present.
4. Publish the signed artifacts (`*.sig` / `latest.json`) at the configured endpoint.
5. The app verifies the signature before installation; the update is user-confirmed and
   restarts the app. Shell and sidecar are updated together, and the protocol handshake
   rejects mismatched pairs.

Never publish a build without `TRADEPANEL_UPDATER_PUBKEY` and expect updates to work —
they will be refused by design.

## 8. Clean data and legacy migration

* Writable state: `$XDG_DATA_HOME/com.nerdatwork.tradepanel/data` (Linux),
  `%APPDATA%\com.nerdatwork.tradepanel\data` (Windows).
* Logs: platform log directory (`tradepanel.log`), plus stderr in dev.
* On first run, a legacy `data/` directory next to the executable or repository is copied
  (missing files only, including SQLite `-wal`/`-shm`). The legacy directory is untouched.
* Legacy `keys/.env` is never imported automatically. Settings → Credentials detects it
  and offers an explicit import into the OS keyring.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank window in a direct release run | build with `--features custom-protocol` (already default in Cargo.toml) or `npx tauri build` |
| `Could not connect to localhost: Connection refused` | debug binary built without Vite: run `npx tauri dev` or start Vite |
| `Python backend executable not found` | run `backend/scripts/build-backend.sh`; path is printed in the error |
| Backend restarts repeatedly | check `tradepanel.log`; a protocol mismatch never auto-restarts. Remove stale `target/release/backend` and rebuild |
| `libtbb.so.12` during AppImage bundling | stale resource staging; delete `target/release/backend` and rebuild the sidecar |
| Credential save fails | keyring/Secret Service is locked or unavailable; unlock it. Plaintext fallback is intentionally not provided |
| WebKit warnings under Xvfb | use `WEBKIT_DISABLE_COMPOSITING_MODE=1`; these do not affect normal desktops |
| Window missing when capturing Xvfb while a Wayland session is active | add `GDK_BACKEND=x11` so GTK creates the window on the X server |
| GStreamer `appsink` warning | media framework not bundled (not used by the app) |
