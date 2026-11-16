#!/usr/bin/env node
//
// TradePanel launcher: check the toolchain, install the frontend dependencies when they are missing or stale,
// then start the desktop app (`tauri dev`) with hot reload.
//
//   npm start                     from the repository root
//   ./tradepanel                  Linux, macOS, Git Bash
//   tradepanel.cmd                Windows
//   ./tradepanel -- --no-watch    everything after `--` goes to `tauri dev`
//
// Runs on Node: the rest of the toolchain (Rust, the Tauri system libraries) is checked, never installed.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, "opentrader");
const SRC_TAURI = join(APP, "src-tauri");
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";
if (!existsSync(join(APP, "package.json")) || !existsSync(join(APP, ".git"))) {
  fail(
    "opentrader/ is not a prepared upstream checkout.",
    "Run `npm run setup` (clone, overlay the extension packs, install dependencies).",
  );
}
const MIN_NODE = [20, 19];
const RECOMMENDED_NODE = 22;

const say = (message) => console.log(`tradepanel: ${message}`);
const warn = (message) => console.error(`tradepanel: warning: ${message}`);

function fail(message, hint) {
  console.error(`tradepanel: ${message}`);
  if (hint) console.error(`tradepanel: ${hint}`);
  process.exit(1);
}

function usage() {
  console.log(`TradePanel launcher

  npm start                 start the desktop app (checks the toolchain, installs missing dependencies)
  ./tradepanel [flags]      the same from a terminal or a file manager (Linux, macOS, Git Bash)
  tradepanel.cmd [flags]    the same on Windows

Flags:
  -h, --help                this help
  --no-install              do not run "npm ci" when opentrader/node_modules is missing or stale
  -- <args>                 pass the rest to "tauri dev", e.g. -- --no-watch

Environment:
  TRADEPANEL_NO_INSTALL=1   same as --no-install
  TRADEPANEL_ENV=<file>     shell snippet sourced before the build (PKG_CONFIG_PATH and linker paths);
                            defaults to tmp/linux-env.sh when the WebKitGTK headers are missing

Requirements: Node.js ${RECOMMENDED_NODE}+, Rust stable, and the Tauri system dependencies
(https://v2.tauri.app/start/prerequisites/). The crypto plugin is optional: npm run ot:crypto.`);
}

const passthrough = [];
let noInstall = /^(1|true|yes|on)$/i.test(process.env.TRADEPANEL_NO_INSTALL ?? "");
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--") {
    passthrough.push(...process.argv.slice(i + 1));
    break;
  }
  if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  }
  if (arg === "--no-install") noInstall = true;
  else passthrough.push(arg);
}

// ── Toolchain ────────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(
    `Node.js ${process.versions.node} is too old (Vite needs ${MIN_NODE.join(".")}+, ${RECOMMENDED_NODE}+ recommended).`,
    "Install a current Node.js from https://nodejs.org and run this again.",
  );
}
if (major < RECOMMENDED_NODE) {
  warn(`Node.js ${process.versions.node} works, but TradePanel is tested on ${RECOMMENDED_NODE}+.`);
}

// A desktop session often starts with a sparse PATH: rustup installs into ~/.cargo/bin.
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const cargoBin = join(process.env.CARGO_HOME ?? join(home, ".cargo"), "bin");
if (existsSync(cargoBin) && !(process.env.PATH ?? "").split(WIN ? ";" : ":").includes(cargoBin)) {
  process.env.PATH = `${cargoBin}${WIN ? ";" : ":"}${process.env.PATH ?? ""}`;
}

function runs(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: WIN });
  return result.status === 0;
}

if (!runs("cargo")) {
  fail(
    "Rust is not installed (cargo was not found).",
    "Install Rust stable from https://rustup.rs, reopen the terminal and run this again.",
  );
}

const webkitHeaders = () =>
  process.platform === "linux" &&
  runs("pkg-config") &&
  !runs("pkg-config", ["--exists", "webkit2gtk-4.1"]) &&
  !runs("pkg-config", ["--exists", "webkit2gtk-4.0"]);

// WebKitGTK and libsoup headers: the Rust build cannot link the window without them. Distributions install them
// with the -dev packages; checkouts and containers that carry the runtime libraries only ship a shell snippet
// that points PKG_CONFIG_PATH (and the linkers) at them. `TRADEPANEL_ENV` names one explicitly.
let envFile = process.env.TRADEPANEL_ENV;
if (!envFile && webkitHeaders()) {
  const local = join(ROOT, "tmp", "linux-env.sh");
  if (existsSync(local)) envFile = local;
}
if (envFile) {
  // Relative to the caller's directory, then to the repository root (so `TRADEPANEL_ENV=tmp/linux-env.sh` works
  // from anywhere).
  let file = resolve(envFile);
  if (!existsSync(file)) file = resolve(ROOT, envFile);
  if (!existsSync(file)) fail(`TRADEPANEL_ENV points at ${envFile}, which does not exist.`);
  envFile = file;
  if (WIN) warn(`ignoring ${envFile}: it is a shell snippet, and Windows does not source it.`);
  else {
    const shown = envFile.startsWith(ROOT) ? envFile.slice(ROOT.length + 1) : envFile;
    say(`applying ${shown} as the build environment`);
    const sourced = spawnSync("bash", ["-c", 'set -a; . "$1" >&2; env -0', "tradepanel", envFile], {
      encoding: "buffer",
    });
    if (sourced.status !== 0) {
      warn(`could not apply ${shown}${sourced.error ? `: ${sourced.error.message}` : ""}; continuing without it.`);
    } else {
      for (const pair of sourced.stdout.toString().split("\0")) {
        const split = pair.indexOf("=");
        if (split > 0) process.env[pair.slice(0, split)] = pair.slice(split + 1);
      }
    }
  }
}

if (webkitHeaders()) {
  fail(
    "the WebKitGTK 4.1 development headers were not found, and the Rust build cannot link the window without them.",
    [
      "Debian/Ubuntu: sudo apt install build-essential libwebkit2gtk-4.1-dev libgtk-3-dev " +
        "libayatana-appindicator3-dev librsvg2-dev patchelf",
      "Runtime libraries only: point TRADEPANEL_ENV at a shell snippet that sets PKG_CONFIG_PATH and the linker " +
        "paths (this workspace: TRADEPANEL_ENV=tmp/linux-env.sh).",
    ].join("\ntradepanel: "),
  );
} else if (process.platform === "darwin" && !runs("xcode-select", ["-p"])) {
  warn("the Xcode command line tools are missing; run: xcode-select --install");
}

// ── Frontend dependencies ────────────────────────────────────────────────────
const modules = join(APP, "node_modules");
const tauriCli = join(modules, "@tauri-apps", "cli", "tauri.js");
const lock = join(APP, "package-lock.json");
const stamp = join(modules, ".package-lock.json");

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
const stale = !existsSync(tauriCli) || !existsSync(join(modules, "vite")) || mtime(stamp) < mtime(lock);

if (stale) {
  if (noInstall) {
    fail(
      "opentrader/node_modules is missing or out of date and installing was disabled.",
      `Run "npm ci" in ${APP} first, or drop --no-install.`,
    );
  }
  say(`installing frontend dependencies in opentrader/ (npm ci)`);
  const install = spawnSync(NPM, ["ci", "--no-audit", "--no-fund"], {
    cwd: APP,
    stdio: "inherit",
    shell: WIN,
  });
  if (install.error) fail(`could not run npm: ${install.error.message}`, "Is npm on PATH?");
  if (install.status !== 0) fail("npm ci failed; fix the error above and run this again.");
  if (!existsSync(tauriCli)) fail("npm ci finished but the Tauri CLI is still missing.");
}

// The drawing core is a sibling checkout, read from source by Vite.
if (!existsSync(join(ROOT, "lightweight-charts-drawing", "src", "core"))) {
  fail(
    "the drawing core is missing: lightweight-charts-drawing/ must sit next to opentrader/.",
    "Clone https://github.com/deepentropy/lightweight-charts-drawing into the repository root.",
  );
}

// src/bindings.ts is generated from the Rust commands and git-ignored; a fresh clone needs it before Vite starts.
if (!existsSync(join(APP, "src", "bindings.ts"))) {
  say("generating src/bindings.ts (cargo test --lib export_bindings; the first Rust build takes a while)");
  const bindings = spawnSync("cargo", ["test", "--lib", "export_bindings"], {
    cwd: SRC_TAURI,
    stdio: "inherit",
    shell: WIN,
  });
  if (bindings.error) fail(`could not run cargo: ${bindings.error.message}`);
  if (bindings.status !== 0) fail("generating src/bindings.ts failed; fix the error above and run this again.");
}

// ── Crypto plugin (installed by default) ──────────────────────────────────────
if (!noInstall) {
  const installScript = join(ROOT, "scripts", "install-crypto-plugin.mjs");
  if (existsSync(installScript)) {
    say("ensuring the crypto plugin is installed (npm run ot:crypto)");
    const crypto = spawnSync(process.execPath, [installScript, "--if-needed"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: WIN,
    });
    if (crypto.status !== 0) warn("crypto plugin install failed; run `npm run ot:crypto` manually.");
  }
  // One broker plugin per venue, installed off: every broker is a card in Exchanges > Brokers and in
  // Trade > Connect broker, and enabling the one the user trades starts its process.
  const brokerScript = join(ROOT, "scripts", "install-broker-plugins.mjs");
  if (existsSync(brokerScript)) {
    say("ensuring the broker plugins are installed (npm run ot:brokers)");
    const brokers = spawnSync(process.execPath, [brokerScript, "--if-needed", "--disabled"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: WIN,
    });
    if (brokers.status !== 0) warn("broker plugin install failed; run `npm run ot:brokers` manually.");
  }
}

// ── Port ─────────────────────────────────────────────────────────────────────
const PORT = 1420; // vite.config.ts pins it with strictPort, so a busy port is a hard failure later on.
const inUse = await new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port: PORT });
  const done = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(400, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});
if (inUse) {
  say(`port ${PORT} is in use; attempting to stop the previous TradePanel/dev server`);
  if (WIN) {
    const netstat = spawnSync("cmd", ["/c", `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT}') do taskkill /PID %a /F`], { stdio: "ignore", shell: true });
    void netstat;
  } else {
    spawnSync("sh", ["-c", `lsof -ti:${PORT} | xargs -r kill -9`], { stdio: "ignore" });
    // Fallback when lsof is unavailable.
    spawnSync("sh", ["-c", `fuser -k ${PORT}/tcp`], { stdio: "ignore" });
  }
  // Re-check.
  const stillInUse = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
  if (stillInUse) {
    fail(
      `port ${PORT} is still in use, and the Vite dev server needs it.`,
      "Stop the other TradePanel (or dev server) manually and run this again.",
    );
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
say("starting TradePanel (tauri dev; the first Rust build takes several minutes)");
const child = spawn(process.execPath, [tauriCli, "dev", ...passthrough], {
  cwd: APP,
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => fail(`could not start the app: ${error.message}`));
child.on("exit", (code, signal) => {
  if (signal) {
    say(`the app was stopped by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
