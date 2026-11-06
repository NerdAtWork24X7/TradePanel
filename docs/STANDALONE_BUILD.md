# Standalone Build

TradePanel ships its own Node.js and Pi runtime. The target machine needs no
Node, npm, pnpm, Bun, Rust, Python or Pi installation.

## 1. Stage the AI runtime

```bash
node backend/scripts/build-ai-runtime.mjs                 # host target
node backend/scripts/build-ai-runtime.mjs --target win-x64
node backend/scripts/build-ai-runtime.mjs --target linux-x64 --target win-x64
```

The script:

1. Downloads the pinned Node.js **22.23.4** archive from nodejs.org and verifies
   its SHA-256 against `SHASUMS256.txt`.
2. Runs `npm ci --omit=dev --ignore-scripts` for the pinned
   `@earendil-works/pi-coding-agent@1.5.0` dependency tree. All Pi dependencies
   are pure JavaScript or WASM, so one install is valid for every target; only
   the Node executable differs.
3. Copies npm from the same Node distribution (`lib/node_modules/npm`, or
   `node_modules/npm` in the Windows zip) and prunes its offline docs. This copy
   powers Settings → Updates, so the target machine needs no Node/npm.
4. Copies the read-only analysis extension and system prompt.
5. Verifies the staged runtime before shipping: `node --version`, `pi --version`,
   `npm --version`, and an import of the extension (which resolves `typebox`).
6. Writes `manifest.json` (`schema: 2`) with the relative paths the Rust host
   validates, including `npm`.

Output (git-ignored):

```
src-tauri/ai-runtime/<target>/
  node/node
  npm/                      # npm CLI from the Node distribution
  pi/node_modules/@earendil-works/pi-coding-agent/...
  pi/extensions/tradepanel-analysis.mjs
  pi/prompts/analysis.md
  manifest.json
```

`manifest.json` paths must stay inside the runtime root; the Rust loader rejects
absolute paths and `..` traversal and repairs a missing executable bit on Unix.

## 2. Build the application

```bash
./build.sh                         # AppImage + deb (Linux) / NSIS (Windows)
./build.sh --skip-backend          # reuse the staged Python sidecar
./build.sh --skip-ai-runtime       # reuse the staged Node + Pi runtime
./build.sh --bundles=deb           # single bundle target
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\build-windows.ps1
# optional: -SkipBackend -SkipAiRuntime -Install
```

The Tauri resource map includes `ai-runtime` next to the Python `backend`
resource. User data never lives inside the installation directory: Pi
configuration, sessions, context, settings, conversations and logs live under
the OS application-data directory (`com.nerdatwork.tradepanel/ai` on Linux,
`%APPDATA%\com.nerdatwork.tradepanel\ai` on Windows).

## 3. Clean-machine verification

Test on a machine (or VM/container) with **no** Node, npm, Pi or developer
configuration:

1. Install the package (`.deb`, AppImage, or NSIS `.exe`).
2. Launch TradePanel. Charts and the order ticket work immediately.
3. Open **Settings** (gear button to the right of **Trade**, or `Ctrl+,`) →
   **AI Analysis**. Sign in with a provider account or API key, choose a model
   and press **Save model**. The sign-in service is the bundled Pi runtime.
4. Press **Start analysis**. Confirm the three chart thumbnails, streamed text
   and a plan card appear.
5. Press **Stop** during a long response; confirm the run settles as stopped.
6. Restart the application; confirm the conversation and plan card restore from
   the cached session.
7. Quit and uninstall. Confirm no files remain in the installation directory and
   that user data stays in the OS app-data location (removed by the user/uninstaller
   according to platform policy).
8. Disconnect the network or kill the Pi process; confirm trading, charts and
   order controls keep working and the AI panel reports the failure.

On Linux, Hyperliquid trading credentials use the Secret Service (GNOME
Keyring/KWallet via D-Bus). AI provider sign-in does **not** require it: Pi writes
its owner-only `auth.json` in the app-data directory. A locked keyring only
blocks trading-credential access.

## 4. Packaging checks

```bash
# Linux: inspect the resource tree and permissions
dpkg-deb -c dist/*.deb | grep -E "ai-runtime/(node/node|pi/(.*/cli.js|settings-service.mjs))"
# AppImage: inspect without launching
./TradePanel_*.AppImage --appimage-extract
find squashfs-root -path '*ai-runtime/node/node' -exec ls -l {} \;
```

The Node executable must be `-rwxr-xr-x`. The Rust loader repairs a missing
execute bit where the filesystem is writable, but packaging should preserve it.

## 5. Version pinning and updates

* Pi version: `ai/runtime/package.json` and `PI_VERSION` in
  `backend/scripts/build-ai-runtime.mjs` must match.
* Node version: `NODE_VERSION` in the build script (default `22.23.4`); Pi
  requires Node ≥ 22.19.
* `ai/runtime/package-lock.json` is committed. Never update Pi transitively
  without rebuilding the runtime and running `npm run test:ai`.
* Migrations: the runtime loader accepts `manifest.schema` 1 and 2 (schema 2
  adds `npm`). Bump the schema when the manifest layout changes and implement a
  migration in `src-tauri/src/ai/runtime.rs`.
* In-app updates (Settings → Updates → AI runtime): `npm view` checks the
  registry, then `npm install <pi>@<version> --omit=dev --ignore-scripts` writes
  a fresh Pi tree into `<app-data>/ai/runtime/<target>`; npm's registry
  integrity data verifies every tarball. The overlay is activated only after
  `pi --version`, the extension import and the settings-bridge check pass, and
  only when its Pi version is newer than the bundle's. Delete that folder to
  fall back to the bundled runtime.
* User data (sessions, settings, conversations, `agent/auth.json`, legacy
  keyring entries) lives outside the installation and survives application updates. Pi session JSONL is
  forward-compatible; the cached-history reader tolerates unknown entry types.
* The Tauri updater replaces the application and its bundled runtime together;
  the manifest ensures a partially replaced runtime is rejected at load.
