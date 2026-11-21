#!/usr/bin/env node
/*
 * Build the standalone app: one folder per platform that carries the app and everything it
 * runs, so it starts on a computer with nothing installed (no Node, no Rust, no Python).
 *
 *   node scripts/build-standalone.mjs                       Linux + Windows (host architecture)
 *   node scripts/build-standalone.mjs --platform host       only this computer's platform
 *   node scripts/build-standalone.mjs --platform linux      only Linux
 *   node scripts/build-standalone.mjs --no-plugins          leave the Python plugins out
 *   node scripts/build-standalone.mjs --no-ai               leave the AI runtime out
 *   node scripts/build-standalone.mjs --installers          also build the platform's installers
 *   node scripts/build-standalone.mjs --skip-build          assemble from the last release build
 *   node scripts/build-standalone.mjs --out DIR             where the folders are written
 *
 * Each folder holds:
 *
 *   bin/opentrader                  the app; the frontend is inside the binary (Linux)
 *   opentrader.exe                  the app (Windows)
 *   <resources>/ai-runtime/<target> the Node and Pi the AI analyst runs
 *   <resources>/plugins             the plugin packages, the Python they run under, its dependencies
 *
 * On Linux the resources sit in lib/OpenTrader next to bin/, as a deb installs them; on Windows
 * they sit next to opentrader.exe. The app finds them with Tauri's resource_dir(). The plugins
 * are copied into the app data folder the first time it runs (src/plugins/bundled.rs), so the
 * folder stays read-only and can be copied to another computer of the same platform.
 *
 * The build needs Node.js 22+, Rust stable, the Tauri system libraries of the host and uv
 * (https://docs.astral.sh/uv/) for the bundled Python. Building for a *different* platform is a
 * cross-compile: rustup installs the target and its cross-linker must be on PATH (or named by
 * CARGO_TARGET_<TRIPLE>_LINKER). Everything the app needs is staged here; the computer that
 * runs the folder needs none of it.
 *
 * The app is built by the Tauri CLI, not by `cargo build`: the CLI turns on `custom-protocol`,
 * which is what puts the frontend inside the binary. A plain cargo build looks for the dev
 * server and shows a white screen.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// The plugin configuration helpers live in the one setup-and-run script; using them here keeps
// the bundled plugin switches identical to the ones the app installs for itself.
import {
  ROOT,
  appVersion,
  ensureOpenSslDev,
  manifestFor,
  manifests,
  mergeBrokerConfig,
  pluginConfig,
} from "./tradepanel.mjs";

const APP = join(ROOT, "opentrader");
const SRC_TAURI = join(APP, "src-tauri");
const STAGING = join(SRC_TAURI, "standalone");
const DEFAULT_OUT = join(ROOT, "dist-standalone");
const PRODUCT = "TradePanel";
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";
const PYTHON_VERSION = "3.12";

// These mirror tradepanel.mjs: the bundled runtime must match what the app validates at startup.
const NODE_VERSION = process.env.OPENTRADER_NODE_VERSION || "22.23.4";
const PI_VERSION = "1.5.0";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_CLI = `node_modules/${PI_PACKAGE}/dist/bundle/cli.js`;
const NPM_CLI = "npm/bin/npm-cli.js";
const AI_SOURCE = join(ROOT, "extensions", "analyst", "runtime");
const AI_OUTPUT = join(SRC_TAURI, "ai-runtime");
const AI_CACHE = join(APP, "node_modules", ".cache", "ai-runtime");

const say = (message) => console.log(`standalone: ${message}`);
const warn = (message) => console.error(`standalone: warning: ${message}`);
function fail(message, hint) {
  console.error(`standalone: ${message}`);
  if (hint) console.error(`standalone: ${hint}`);
  process.exit(1);
}

// ── Targets ───────────────────────────────────────────────────────────────────────────────────
// `id` is the name the app uses for its AI runtime (src/pi/runtime.rs). The rust triple is what
// cargo builds; the uv strings fetch a self-contained Python for the same platform.
const TARGETS = {
  "linux-x64": {
    id: "linux-x64", os: "linux", arch: "x64", rust: "x86_64-unknown-linux-gnu",
    python: "cpython-3.12-linux-x86_64-gnu", pythonPlatform: "x86_64-unknown-linux-gnu",
    nodeDir: "linux-x64", archive: "tar.xz", nodeBinary: "bin/node", nodeExe: "node",
    linker: "x86_64-linux-gnu-gcc",
  },
  "linux-arm64": {
    id: "linux-arm64", os: "linux", arch: "arm64", rust: "aarch64-unknown-linux-gnu",
    python: "cpython-3.12-linux-aarch64-gnu", pythonPlatform: "aarch64-unknown-linux-gnu",
    nodeDir: "linux-arm64", archive: "tar.xz", nodeBinary: "bin/node", nodeExe: "node",
    linker: "aarch64-linux-gnu-gcc",
  },
  "win-x64": {
    id: "win-x64", os: "win32", arch: "x64", rust: "x86_64-pc-windows-gnu",
    python: "cpython-3.12-windows-x86_64-none", pythonPlatform: "x86_64-pc-windows-msvc",
    nodeDir: "win-x64", archive: "zip", nodeBinary: "node.exe", nodeExe: "node.exe",
    linker: "x86_64-w64-mingw32-gcc",
  },
  "win-arm64": {
    id: "win-arm64", os: "win32", arch: "arm64", rust: "aarch64-pc-windows-msvc",
    python: "cpython-3.12-windows-aarch64-none", pythonPlatform: "aarch64-pc-windows-msvc",
    nodeDir: "win-arm64", archive: "zip", nodeBinary: "node.exe", nodeExe: "node.exe",
    linker: null, // MSVC: only buildable on a Windows MSVC host.
  },
};

/** Where the app looks for its resources on each platform, relative to the folder root. */
export function layout(platform, productName = "OpenTrader") {
  if (platform === "win32") return { binary: "opentrader.exe", resources: "." };
  return { binary: "bin/opentrader", resources: `lib/${productName}` };
}

const targetSpec = (id) => TARGETS[id];
const hostPlatform = () => (WIN ? "win32" : process.platform);
const hostArch = () => (process.arch === "ia32" ? "x64" : process.arch);

let hostRust = null;
/** The toolchain rustc was installed with. A native build uses it (MSVC on Windows), rather than
 *  forcing the GNU triple from TARGETS and asking for a mingw-w64 cross-linker. */
function hostTriple() {
  if (hostRust === null) {
    hostRust = has("rustc") ? output("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1] ?? "" : "";
  }
  return hostRust;
}
function rustFor(id) {
  const spec = targetSpec(id);
  if (spec.os === hostPlatform() && spec.arch === hostArch() && hostTriple()) return hostTriple();
  return spec.rust;
}

/** The build targets requested, ordered so the host is built first. */
export function selectTargets(platform, arch) {
  const requested = Object.values(TARGETS).filter(
    (spec) => (platform === "all" || spec.os === platform) && (arch === "all" || spec.arch === arch),
  );
  requested.sort((a, b) => Number(b.os === hostPlatform() && b.arch === hostArch()) - Number(a.os === hostPlatform() && a.arch === hostArch()));
  return requested.map((spec) => spec.id);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
const options = {
  platform: "all",
  arch: hostArch(),
  out: DEFAULT_OUT,
  ai: true,
  plugins: true,
  installers: false,
  skipBuild: false,
  skipSetup: false,
};

function usage() {
  console.log(`Build the standalone app: a folder per platform with the app and everything it runs.

  node scripts/build-standalone.mjs [flags]

Flags:
  --platform <all|host|linux|win32>  platforms to build (default: all)
  --arch <host|x64|arm64|all>        architectures to build (default: host)
  --out DIR                          where the folders are written (default: ${DEFAULT_OUT})
  --no-ai                            leave the AI runtime (Node + Pi) out
  --no-plugins                       leave the Python plugins and their runtime out
  --installers                       also build the platform's installers (deb, msi, nsis…)
  --skip-build                       assemble from the last release build, do not compile
  --skip-setup                       assume the checkout and its dependencies are ready
  -h, --help                         this help

Cross-compiling needs the rustup target and its linker (e.g. mingw-w64 for win-x64); the script
adds the target and names a missing linker. Set CARGO_TARGET_<TRIPLE>_LINKER to override it.
Requirements: Node.js 22+, Rust stable, the Tauri system libraries and uv (for --plugins).`);
}

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) fail(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--out") options.out = resolve(value());
    else if (arg === "--platform") {
      const platform = value();
      if (!["all", "host", "linux", "win32", "windows"].includes(platform)) fail(`unknown platform ${platform}`);
      options.platform = platform === "host" ? hostPlatform() : platform === "windows" ? "win32" : platform;
    } else if (arg === "--arch") {
      const arch = value();
      if (!["all", "host", "x64", "arm64"].includes(arch)) fail(`unknown architecture ${arch}`);
      options.arch = arch === "host" ? hostArch() : arch;
    } else if (arg === "--no-ai") options.ai = false;
    else if (arg === "--no-plugins") options.plugins = false;
    else if (arg === "--installers") options.installers = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--skip-setup") options.skipSetup = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else fail(`unknown argument ${arg}`, "Run with --help to see the flags.");
  }
}

// ── Process helpers ───────────────────────────────────────────────────────────────────────────
function run(command, args, options_ = {}) {
  say(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: WIN && /\.cmd$/i.test(command), ...options_ });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed (${result.status}).`);
  return result;
}
function output(command, args, options_ = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options_ });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
  return result.stdout.trim();
}
const has = (command, args = ["--version"]) => spawnSync(command, args, { stdio: "ignore", shell: WIN }).status === 0;

/** A folder's size, with symlinks counted as the link and not as their target. */
function sizeOf(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(child) : lstatSync(child).size;
  }
  return total;
}
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// ── Toolchain ─────────────────────────────────────────────────────────────────────────────────
/** A sparse desktop PATH often misses ~/.cargo/bin, where rustup installs cargo and rustc. */
function ensureCargoPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cargoBin = join(process.env.CARGO_HOME ?? join(home, ".cargo"), "bin");
  if (existsSync(cargoBin) && !(process.env.PATH ?? "").split(WIN ? ";" : ":").includes(cargoBin)) {
    process.env.PATH = `${cargoBin}${WIN ? ";" : ":"}${process.env.PATH ?? ""}`;
  }
}

/**
 * WebKitGTK and libsoup headers are build-time dependencies on Linux. A machine that only has
 * the runtime libraries can point TRADEPANEL_ENV at a shell snippet with the header paths; the
 * workspace uses tmp/linux-env.sh when it is there.
 */
function applyBuildEnvironment(ids) {
  if (!ids.some((id) => targetSpec(id).os === "linux")) return;
  const headers = () => !has("pkg-config") || (!has("pkg-config", ["--exists", "webkit2gtk-4.1"]) && !has("pkg-config", ["--exists", "webkit2gtk-4.0"]));
  let envFile = process.env.TRADEPANEL_ENV;
  if (!envFile && headers()) {
    const local = join(ROOT, "tmp", "linux-env.sh");
    if (existsSync(local)) envFile = local;
  }
  if (!envFile) {
    if (headers() && ids.some((id) => targetSpec(id).os === hostPlatform())) {
      fail(
        "the WebKitGTK development headers were not found, and the Rust build cannot link the window without them.",
        "Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf\n" +
          "Runtime libraries only: point TRADEPANEL_ENV at a shell snippet that sets PKG_CONFIG_PATH and the linker paths.",
      );
    }
    return;
  }
  let file = resolve(envFile);
  if (!existsSync(file)) file = resolve(ROOT, envFile);
  if (!existsSync(file)) fail(`TRADEPANEL_ENV points at ${envFile}, which does not exist.`);
  if (WIN) {
    warn(`ignoring ${file}: it is a shell snippet, and Windows does not source it.`);
    return;
  }
  say(`applying ${file} as the build environment`);
  const sourced = spawnSync("bash", ["-c", 'set -a; . "$1" >&2; env -0', "standalone", file], { encoding: "buffer" });
  if (sourced.status !== 0) {
    warn(`could not apply ${file}; continuing without it.`);
    return;
  }
  for (const pair of sourced.stdout.toString().split("\0")) {
    const split = pair.indexOf("=");
    if (split > 0) process.env[pair.slice(0, split)] = pair.slice(split + 1);
  }
}

function checkToolchain(ids) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) fail(`Node.js ${process.versions.node} is too old.`, "Install Node.js 22 or newer: https://nodejs.org");
  ensureCargoPath();
  if (!has("cargo")) fail("Rust is not installed (cargo was not found).", "Install Rust stable: https://rustup.rs");
  if (options.plugins && !has("uv")) {
    fail("uv was not found; the build needs it for the bundled Python.", "Install uv: https://docs.astral.sh/uv/getting-started/installation/");
  }
  if (options.ai) {
    for (const id of ids) {
      if (!has("unzip") && targetSpec(id).archive === "zip" && !has("python3") && !WIN) {
        fail(`unzip is needed to stage the Windows AI runtime for ${id}.`, "Install unzip, or build with --no-ai.");
      }
    }
  }
  if (!existsSync(join(ROOT, "lightweight-charts-drawing", "src", "core"))) {
    fail("the drawing core is missing: lightweight-charts-drawing/ must sit next to opentrader/.", "Clone https://github.com/deepentropy/lightweight-charts-drawing into the repository root.");
  }
  applyBuildEnvironment(ids);
}

/** The targets cargo can actually build here. A cross target without its linker is skipped with a
 *  clear hint rather than aborting a build that could still produce the other platform. */
function checkTargets(ids) {
  const buildable = [];
  for (const id of ids) {
    const spec = targetSpec(id);
    const rust = rustFor(id);
    if (rust === hostTriple()) {
      buildable.push(id);
      continue;
    }
    if (!spec.linker) {
      warn(`skipping ${id}: it can only be built on a Windows MSVC host.`);
      continue;
    }
    if (!has("rustup")) {
      warn(`skipping ${id}: cross-compiling needs rustup (https://rustup.rs).`);
      continue;
    }
    if (!output("rustup", ["target", "list", "--installed"]).split(/\s+/).includes(rust)) {
      run("rustup", ["target", "add", rust]);
    }
    const linkerVar = `CARGO_TARGET_${rust.toUpperCase().replace(/-/g, "_")}_LINKER`;
    if (!process.env[linkerVar] && !has(spec.linker)) {
      warn(
        `skipping ${id}: cross-compiling needs ${spec.linker} (or ${linkerVar}).`,
      );
      warn(
        WIN ? "Install a cross linker such as mingw-w64 via MSYS2 and set the variable." :
          `Debian/Ubuntu: sudo apt install ${spec.linker.includes("mingw") ? "mingw-w64" : "gcc-" + spec.linker.replace("-gcc", "")}`,
      );
      continue;
    }
    if (!process.env[linkerVar]) process.env[linkerVar] = spec.linker;
    buildable.push(id);
  }
  return buildable;
}

/** The pinned checkout and its dependencies: one command does setup and never starts the app. */
function ensureSetup() {
  if (options.skipSetup) return;
  say("checking the checkout and dependencies (tradepanel.mjs --setup)");
  run(process.execPath, [join(ROOT, "scripts", "tradepanel.mjs"), "--setup"], { cwd: ROOT });
}

/**
 * The Rust build needs OpenSSL headers too. Setup stages them for its own process; apply them
 * here as well, otherwise openssl-sys fails in this process even though setup succeeded.
 */
function applyOpenSsl(ids) {
  if (!ids.some((id) => targetSpec(id).os === "linux")) return;
  const env = ensureOpenSslDev();
  if (env) Object.assign(process.env, env);
}

// ── AI runtime ────────────────────────────────────────────────────────────────────────────────
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function download(url, destination) {
  say(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}
function extractArchive(archivePath, destination) {
  mkdirSync(destination, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (WIN || has("unzip")) run(WIN ? "powershell" : "unzip", WIN
      ? ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destination}'`]
      : ["-q", "-o", archivePath, "-d", destination]);
    else run("python3", ["-m", "zipfile", "-e", archivePath, destination]);
  } else run("tar", ["-xf", archivePath, "-C", destination]);
}
function removeMaps(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removeMaps(path);
    else if (entry.name.endsWith(".map")) rmSync(path, { force: true });
  }
}
function installPi(staging) {
  const prefix = join(staging, "pi");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  cpSync(join(AI_SOURCE, "package.json"), join(prefix, "package.json"));
  const lock = join(AI_SOURCE, "package-lock.json");
  const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
  if (existsSync(lock)) {
    cpSync(lock, join(prefix, "package-lock.json"));
    run(NPM, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  } else {
    run(NPM, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix], { env });
  }
  const installed = JSON.parse(readFileSync(join(prefix, "node_modules", PI_PACKAGE, "package.json"), "utf8"));
  if (installed.version !== PI_VERSION) throw new Error(`Installed Pi ${installed.version}, expected ${PI_VERSION}`);
  mkdirSync(join(prefix, "extensions"), { recursive: true });
  cpSync(join(AI_SOURCE, "extensions"), join(prefix, "extensions"), { recursive: true });
  cpSync(join(AI_SOURCE, "prompts"), join(prefix, "prompts"), { recursive: true });
  for (const entry of readdirSync(join(prefix, "node_modules"), { withFileTypes: true })) {
    if (entry.isDirectory()) removeMaps(join(prefix, "node_modules", entry.name));
  }
  return prefix;
}
function stageNpm(source, out) {
  const destination = join(out, "npm");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  for (const name of ["docs", "man"]) rmSync(join(destination, name), { recursive: true, force: true });
  removeMaps(destination);
  if (!existsSync(join(destination, "bin", "npm-cli.js"))) throw new Error(`npm CLI missing after staging: ${destination}`);
}
function npmSource(staging, base) {
  for (const source of [join(staging, base, "lib", "node_modules", "npm"), join(staging, base, "node_modules", "npm")]) {
    if (existsSync(join(source, "bin", "npm-cli.js"))) return source;
  }
  throw new Error(`The Node archive has no npm CLI: ${base}`);
}

/** Stage Node + Pi for one target into src-tauri/ai-runtime/<id>, the layout the app validates. */
async function stageAiRuntime(id) {
  const spec = targetSpec(id);
  const out = join(AI_OUTPUT, id);
  if (existsSync(join(out, "manifest.json"))) {
    say(`the AI runtime for ${id} is already staged`);
    return;
  }
  say(`staging the AI runtime for ${id} (Node ${NODE_VERSION} + Pi ${PI_VERSION})`);

  const base = `node-v${NODE_VERSION}-${spec.nodeDir}`;
  const fileName = `${base}.${spec.archive}`;
  mkdirSync(AI_CACHE, { recursive: true });
  const archivePath = join(AI_CACHE, fileName);
  const sumsPath = join(AI_CACHE, `SHASUMS256-v${NODE_VERSION}.txt`);
  if (!existsSync(sumsPath)) await download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sumsPath);
  const expected = readFileSync(sumsPath, "utf8").split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === fileName)?.[0];
  if (!expected) throw new Error(`No SHA-256 entry for ${fileName} in SHASUMS256.txt`);
  if (!existsSync(archivePath)) await download(`https://nodejs.org/dist/v${NODE_VERSION}/${fileName}`, archivePath);
  if (sha256(archivePath) !== expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`SHA-256 mismatch for ${fileName}`);
  }

  const staging = join(AI_CACHE, "standalone", id);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const piDir = installPi(staging);

  const extractDir = join(staging, "node");
  extractArchive(archivePath, extractDir);
  const nodeBinary = join(extractDir, base, spec.nodeBinary);
  if (!existsSync(nodeBinary)) throw new Error(`Node binary missing after extraction: ${nodeBinary}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "node"), { recursive: true });
  const nodeOut = join(out, "node", spec.nodeExe);
  cpSync(nodeBinary, nodeOut);
  if (spec.nodeExe !== "node.exe") chmodSync(nodeOut, 0o755);
  cpSync(piDir, join(out, "pi"), { recursive: true });
  // npm's bin links point into the build cache; the runtime calls the CLI by path, and Tauri
  // must not ship symlinks that break when that cache is gone.
  rmSync(join(out, "pi", "node_modules", ".bin"), { recursive: true, force: true });
  stageNpm(npmSource(extractDir, base), out);

  const runtimePi = join(out, "pi");
  for (const file of [nodeOut, join(runtimePi, PI_CLI), join(out, NPM_CLI),
    join(runtimePi, "prompts", "analysis.md"), join(runtimePi, "extensions", "tradepanel-analysis.mjs")]) {
    if (!existsSync(file)) throw new Error(`Staged runtime file missing: ${file}`);
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify({
    schema: 1,
    target: id,
    nodeVersion: `v${NODE_VERSION}`,
    piVersion: PI_VERSION,
    node: `node/${spec.nodeExe}`,
    piCli: `pi/${PI_CLI}`,
    npmCli: NPM_CLI,
    extension: "pi/extensions/tradepanel-analysis.mjs",
    systemPrompt: "pi/prompts/analysis.md",
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
  say(`staged ${id}: ${megabytes(sizeOf(out))}`);
}

// ── Python and plugins ────────────────────────────────────────────────────────────────────────
const PLUGIN_SKIP = new Set([".venv", "__pycache__", "tests", "dist", ".pytest_cache", "build.py", "manifests.py"]);

/** The parts of Python no plugin uses: headers, manuals, IDLE, Tcl/Tk and pip. */
export function prunePython(python) {
  const remove = [
    "include", "share", join("lib", "pkgconfig"), join("lib", "tcl9.0"), join("lib", "tk9.0"),
    join("lib", "libtcl9.0.so"), join("lib", "libtk9.0.so"), join("lib", "thread3.0.4"), join("lib", "itcl4.3.5"),
  ];
  for (const name of remove) rmSync(join(python, name), { recursive: true, force: true });
  const lib = join(python, "lib");
  if (!existsSync(lib)) return;
  for (const entry of readdirSync(lib)) {
    if (!/^python3\.\d+$/.test(entry)) continue;
    for (const part of ["test", "idlelib", "tkinter", "tclib", "lib2to3", "ensurepip", "pydoc_data"]) {
      rmSync(join(lib, entry, part), { recursive: true, force: true });
    }
    const site = join(lib, entry, "site-packages");
    if (!existsSync(site)) continue;
    for (const item of readdirSync(site)) {
      if (/^pip/.test(item)) rmSync(join(site, item), { recursive: true, force: true });
    }
  }
}

/** uv downloads a self-contained Python, so the bundle runs on a machine with no Python. */
function stagePythonRuntime(id, runtime) {
  const spec = targetSpec(id);
  const cache = join(APP, "node_modules", ".cache", "standalone", "python", id);
  say(`fetching Python ${PYTHON_VERSION} for ${id} (uv)`);
  run("uv", ["python", "install", spec.python, "--install-dir", cache, "--no-bin"]);
  const installed = readdirSync(cache).find((name) => /^cpython-3\.12\./.test(name) && statSync(join(cache, name)).isDirectory());
  if (!installed) fail(`uv did not install Python ${PYTHON_VERSION} for ${id} in ${cache}.`);

  say("copying the Python into the bundle");
  cpSync(join(cache, installed), join(runtime, "python"), { recursive: true, dereference: true });
  prunePython(join(runtime, "python"));

  say("installing the plugins' dependencies (ccxt, the Hyperliquid SDK…)");
  run("uv", [
    "pip", "install", "--target", join(runtime, "site-packages"),
    "--python-version", PYTHON_VERSION, "--python-platform", spec.pythonPlatform,
    "-r", join(ROOT, "plugins", "crypto", "requirements.txt"),
    "-r", join(ROOT, "plugins", "ccxt-broker", "requirements.txt"),
  ]);
  say(`the Python runtime for ${id} is ${megabytes(sizeOf(runtime))}`);
}

function copyPlugin(source, target, extraSkip = []) {
  const skip = new Set([...PLUGIN_SKIP, ...extraSkip]);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => skip.has(part)),
  });
}

/** The plugin packages and the settings that say which of them start. */
function stagePluginPackages(id, plugins) {
  const all = manifests();
  const ids = Object.keys(all);
  const packages = join(plugins, "packages");
  mkdirSync(packages, { recursive: true });

  say("staging the plugin packages");
  copyPlugin(join(ROOT, "plugins", "crypto"), join(packages, "crypto"));
  copyPlugin(join(ROOT, "plugins", "nse"), join(packages, "nse"));
  for (const venue of ids) {
    const target = join(packages, venue);
    copyPlugin(join(ROOT, "plugins", "ccxt-broker"), target);
    writeFileSync(join(target, "opentrader-plugin.json"), `${JSON.stringify(manifestFor(venue, all), null, 2)}\n`);
  }

  let config = pluginConfig({}, "crypto", "");
  config = pluginConfig(config, "nse", "");
  config = mergeBrokerConfig(config, ids, {}, all, null); // new venues off; the user enables one in Exchanges
  for (const plugin of Object.values(config.plugins ?? {})) plugin.token = ""; // the app writes its own
  writeFileSync(join(plugins, "plugins.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(plugins, "manifest.json"), `${JSON.stringify({
    schema: 1, product: PRODUCT, version: appVersion(), target: id,
    builtAt: new Date().toISOString(), plugins: Object.keys(config.plugins ?? {}),
  }, null, 2)}\n`);
  say(`${Object.keys(config.plugins ?? {}).length} plugins are staged`);
}

function stagePlugins(id) {
  const plugins = join(STAGING, id, "plugins");
  rmSync(plugins, { recursive: true, force: true });
  mkdirSync(plugins, { recursive: true });
  stagePythonRuntime(id, join(plugins, "runtime"));
  stagePluginPackages(id, plugins);
}

// ── Build and assemble ────────────────────────────────────────────────────────────────────────
function tauriOverride(id) {
  const resources = {};
  if (options.ai) resources["ai-runtime"] = "ai-runtime";
  if (options.plugins) resources[`standalone/${id}/plugins`] = "plugins";
  const file = join(STAGING, id, "tauri.standalone.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ bundle: { resources } }, null, 2)}\n`);
  return file;
}

function buildApp(id, config) {
  const args = ["--prefix", APP, "run", "tauri", "--", "build", "--target", rustFor(id), "-c", config];
  if (!options.installers) args.push("--no-bundle");
  say(`building the app for ${id}`);
  run(NPM, args, { cwd: ROOT });
}

/** A binary built without custom-protocol looks for the dev server and shows a white screen. */
function assertFrontendInside(binary) {
  const index = join(APP, "dist", "index.html");
  if (!existsSync(index)) return;
  const asset = readFileSync(index, "utf8").match(/\/assets\/[^"']+\.js/)?.[0];
  if (!asset) return;
  if (!readFileSync(binary).includes(asset, 0, "utf8")) {
    fail(
      `${binary} does not carry the frontend (${asset} is not in it).`,
      "Build with the Tauri CLI: a plain `cargo build --release` leaves the app in development mode.",
    );
  }
}

function releaseBinary(id) {
  const spec = targetSpec(id);
  for (const dir of [join(SRC_TAURI, "target", rustFor(id), "release"), join(SRC_TAURI, "target", "release")]) {
    const binary = join(dir, spec.os === "win32" ? "opentrader.exe" : "opentrader");
    if (existsSync(binary)) return binary;
  }
  fail(`the release binary for ${id} is missing.`, "Run the build without --skip-build.");
}

function archiveFolder(folder, id) {
  const name = basename(folder);
  if (targetSpec(id).os === "win32") {
    const zip = `${folder}.zip`;
    if (has("zip")) run("zip", ["-q", "-r", zip, name], { cwd: options.out });
    else if (has("python3")) run("python3", ["-m", "zipfile", "-c", zip, name], { cwd: options.out });
    else return warn(`${zip} was not written (zip or python3 is missing).`);
    say(`the archive is ${zip}`);
  } else {
    const tarball = `${folder}.tar.gz`;
    run("tar", ["-czf", tarball, "-C", options.out, name]);
    say(`the archive is ${tarball} (${megabytes(statSync(tarball).size)})`);
  }
}

function writeLauncher(folder, id) {
  const place = layout(targetSpec(id).os);
  if (targetSpec(id).os === "win32") {
    writeFileSync(join(folder, `${PRODUCT}.cmd`), `@echo off\r\n"%~dp0${place.binary}" %*\r\n`);
    return;
  }
  const launcher = join(folder, PRODUCT);
  writeFileSync(launcher, [
    "#!/bin/sh",
    "# Start TradePanel from this folder.",
    'here="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)"',
    `exec "$here/${place.binary}" "$@"`,
    "",
  ].join("\n"));
  chmodSync(launcher, 0o755);
}

function writeReadme(folder, id) {
  const place = layout(targetSpec(id).os);
  const lines = [
    `${PRODUCT} ${appVersion()} (${id})`,
    "",
    "Everything the app needs is in this folder: the app itself, the Node and Pi the AI",
    "analyst runs, and the Python the trading plugins run under with their dependencies.",
    "Nothing has to be installed on this computer.",
    "",
    `Start it with ./${PRODUCT} (Windows: ${PRODUCT}.cmd).`,
    "",
    "The first start copies the plugins and the Python runtime into the app's data folder,",
    "so the plugins can run there. That happens once; the folder itself stays untouched.",
    "",
    "Folders:",
    `  ${place.binary}                   the app (the frontend is inside the binary)`,
    `  ${posix.join(place.resources, "ai-runtime")}   the AI runtime (Node + Pi)`,
    `  ${posix.join(place.resources, "plugins")}      the plugin packages and their Python runtime`,
    "",
  ];
  writeFileSync(join(folder, "README.txt"), lines.join("\n"));
}

function collectInstallers(id) {
  if (!options.installers) return;
  const bundle = join(SRC_TAURI, "target", rustFor(id), "release", "bundle");
  if (!existsSync(bundle)) return warn(`no installer bundle found for ${id} in ${bundle}`);
  const target = join(options.out, "installers", id);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(bundle, { withFileTypes: true })) {
    const from = join(bundle, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) cpSync(from, to, { recursive: true });
    else cpSync(from, to);
  }
  say(`the installers for ${id} are in ${target}`);
}

function assemble(id) {
  const spec = targetSpec(id);
  const version = appVersion();
  const name = `${PRODUCT}-${version}-${id}`;
  const folder = join(options.out, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });

  const binary = releaseBinary(id);
  assertFrontendInside(binary);
  const place = layout(spec.os);
  const target = join(folder, place.binary);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(binary, target);
  if (spec.os !== "win32") chmodSync(target, 0o755);

  const resources = join(folder, place.resources);
  mkdirSync(resources, { recursive: true });
  if (options.ai && existsSync(join(AI_OUTPUT, id))) {
    say("copying the AI runtime");
    cpSync(join(AI_OUTPUT, id), join(resources, "ai-runtime", id), { recursive: true });
  }
  if (options.plugins && existsSync(join(STAGING, id, "plugins"))) {
    say("copying the plugins and their Python runtime");
    cpSync(join(STAGING, id, "plugins"), join(resources, "plugins"), { recursive: true });
  }

  writeLauncher(folder, id);
  writeReadme(folder, id);
  collectInstallers(id);

  // A stable path to the newest build. Windows needs privileges for symlinks, so it is optional.
  const link = join(options.out, `current-${id}`);
  rmSync(link, { recursive: true, force: true });
  try {
    symlinkSync(name, link);
  } catch (error) {
    warn(`could not create ${link}: ${error.message}`);
  }

  say(`${folder} (${megabytes(sizeOf(folder))})`);
  archiveFolder(folder, id);
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────
async function main(argv) {
  parseArgs(argv);
  const ids = selectTargets(options.platform, options.arch);
  if (!ids.length) fail("no platforms match --platform and --arch.");

  checkToolchain(ids);
  const buildable = checkTargets(ids);
  if (!buildable.length) fail("none of the requested targets can be built on this host.");
  say(`building the standalone app for ${buildable.join(", ")}`);
  ensureSetup();
  applyOpenSsl(buildable);

  for (const id of buildable) {
    if (options.ai) await stageAiRuntime(id);
    if (options.plugins) stagePlugins(id);
    if (!options.skipBuild) buildApp(id, tauriOverride(id));
    assemble(id);
  }
  say("done");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
