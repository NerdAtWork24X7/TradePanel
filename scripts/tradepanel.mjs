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
import { existsSync, mkdirSync, realpathSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOpenSslDev, hasOpenSslDev } from "./lib/openssl-dev.mjs";

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

Launching again from the desktop icon stops the running instance first. Without a terminal, output is
appended to tmp/tradepanel-launch.log.

Environment:
  TRADEPANEL_NO_INSTALL=1   same as --no-install
  TRADEPANEL_ENV=<file>     shell snippet sourced before the build (PKG_CONFIG_PATH and linker paths);
                            defaults to tmp/linux-env.sh when the WebKitGTK headers are missing
  OPENSSL_DIR=<dir>         OpenSSL headers and libs; Debian/Ubuntu stage libssl-dev into the user's data
                            directory automatically when the system headers are absent

Requirements: Node.js ${RECOMMENDED_NODE}+, Rust stable, and the Tauri system dependencies
(https://v2.tauri.app/start/prerequisites/). The crypto plugin is optional: npm run ot:crypto.`);
}

// ── Single instance ──────────────────────────────────────────────────────────
// The desktop icon is often clicked twice: the first launch takes a while to build, and Terminal=false hides
// the error. Killing by port used to take down the app's WebKit network process (it is a *client* of the Vite
// port too), which is what made the window appear to crash and restart. A pid file gives us the real owner.
const PID_FILE = join(ROOT, "tmp", "tradepanel.pid");

function readPidFile() {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function commandOf(pid) {
  if (WIN) {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout.trim() : "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function cwdOf(pid) {
  if (WIN) return "";
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return "";
    }
  }
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  return result.stdout.match(/^n(.+)$/m)?.[1] ?? "";
}

function isOurLauncher(pid) {
  const command = commandOf(pid);
  // `npm start` uses a relative script path, so check the working directory as well.
  const ours = command.includes("scripts/tradepanel.mjs") || command.includes("scripts\\tradepanel.mjs");
  return ours && (command.includes(ROOT) || cwdOf(pid) === ROOT);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitUntil(condition, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(200);
  }
  return false;
}

function portInUse() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function portOwners() {
  const lsof = spawnSync("lsof", ["-nP", "-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsof.status === 0) return [...new Set(lsof.stdout.split(/\s+/).filter(Boolean))];
  const ss = spawnSync("ss", ["-H", "-ltnp", `( sport = :${PORT} )`], { encoding: "utf8" });
  return [...new Set([...ss.stdout.matchAll(/pid=(\d+)/g)].map((match) => match[1]))];
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

// Native TLS needs the OpenSSL headers at build time. Without this check cargo fails much later, inside
// openssl-sys, with a pkg-config error that gives no hint about the launcher.
const opensslEnv = ensureOpenSslDev({ say, fail });
if (opensslEnv) Object.assign(process.env, opensslEnv);
else if (!hasOpenSslDev()) {
  fail(
    "the OpenSSL development headers were not found, and the Rust build cannot link native TLS without them.",
    [
      "Debian/Ubuntu: sudo apt install libssl-dev",
      "macOS: brew install openssl@3",
      "Other systems: install the OpenSSL development package, or set OPENSSL_DIR to an OpenSSL installation.",
    ].join("\ntradepanel: "),
  );
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
  const nseScript = join(ROOT, "scripts", "install-nse-plugin.mjs");
  if (existsSync(nseScript)) {
    say("ensuring the NSE plugin is installed (npm run ot:nse)");
    const nse = spawnSync(process.execPath, [nseScript, "--if-needed"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: WIN,
    });
    if (nse.status !== 0) warn("NSE plugin install failed; run `npm run ot:nse` manually.");
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
const previous = readPidFile();
let stoppedPrevious = false;
if (previous && previous !== process.pid && processAlive(previous)) {
  if (isOurLauncher(previous)) {
    say(`stopping the previous TradePanel (pid ${previous})`);
    if (WIN) {
      spawnSync("taskkill", ["/PID", String(previous), "/T", "/F"], { stdio: "ignore", shell: true });
    } else {
      try {
        process.kill(previous, "SIGTERM");
      } catch (error) {
        warn(`could not signal pid ${previous}: ${error.message}`);
      }
    }
    if (!(await waitUntil(() => !processAlive(previous), 8000))) {
      try {
        process.kill(previous, "SIGKILL");
      } catch {
        // It exited between the checks; nothing left to do.
      }
      await waitUntil(() => !processAlive(previous), 2000);
    }
    if (processAlive(previous)) {
      fail(
        `the previous TradePanel (pid ${previous}) did not stop.`,
        `Check that process manually, then run this again.`,
      );
    }
    stoppedPrevious = true;
  } else {
    warn(`ignoring ${PID_FILE}: pid ${previous} is not this TradePanel launcher.`);
  }
}

// The launcher exits only after its child process group is gone, but give the socket a moment to close.
if (stoppedPrevious && (await portInUse())) await waitUntil(async () => !(await portInUse()), 5000);

if (await portInUse()) {
  const owners = portOwners();
  const owner = owners.length ? ` (pid ${owners.join(", ")})` : "";
  fail(
    `port ${PORT} is still in use${owner}, and the Vite dev server needs it.`,
    "Stop that process manually and run this again. The launcher never kills unknown processes on this port.",
  );
}

// ── Start ────────────────────────────────────────────────────────────────────
say("starting TradePanel (tauri dev; the first Rust build takes several minutes)");
// A separate process group lets SIGTERM take down tauri dev, Vite and the WebView together. `tauri dev` owns
// grandchildren that would otherwise survive us and keep port 1420 busy on the next launch.
const child = spawn(process.execPath, [tauriCli, "dev", ...passthrough], {
  cwd: APP,
  stdio: "inherit",
  env: process.env,
  detached: !WIN,
});

function removePidFile() {
  try {
    // A newer launcher may already own the file when we exit; never delete its pid.
    if (readPidFile() === process.pid) unlinkSync(PID_FILE);
  } catch {
    // The file is best-effort; a stale entry is recognized and ignored on the next launch.
  }
}
try {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
} catch (error) {
  warn(`could not write ${PID_FILE}: ${error.message}; a second launch cannot stop this one cleanly.`);
}
process.on("exit", removePidFile);

let stopping = false;
function stopChild(signal) {
  if (stopping || !child.pid) return;
  stopping = true;
  if (WIN) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // It exited between the checks.
      }
    }
  }
  const force = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 5000);
  force.unref();
}
process.on("SIGTERM", () => stopChild("SIGTERM"));
process.on("SIGINT", () => stopChild("SIGINT"));

child.on("error", (error) => fail(`could not start the app: ${error.message}`));
child.on("exit", (code, signal) => {
  removePidFile();
  if (signal) {
    say(`the app was stopped by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
