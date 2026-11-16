#!/usr/bin/env node
/*
 * Build the standalone app: one folder that holds the app and everything it runs, so it starts
 * on a computer with nothing installed (no Node, no Rust, no Python).
 *
 *   node scripts/build-standalone.mjs               build it
 *   node scripts/build-standalone.mjs --no-ai       without the AI runtime
 *   node scripts/build-standalone.mjs --no-plugins  without the Python plugins
 *   node scripts/build-standalone.mjs --out DIR     where the folder is written
 *   node scripts/build-standalone.mjs --bundle      also build the installers of the platform
 *
 * The folder holds:
 *
 *   bin/opentrader              the app; the frontend is inside the binary
 *   lib/OpenTrader/ai-runtime   the Node and Pi the AI analyst runs
 *   lib/OpenTrader/plugins      the plugin packages, the Python they run under and the
 *                                dependencies that Python needs
 *
 * The plugins are installed in the app's data folder the first time it runs (the Rust side
 * reads <resources>/plugins, see src-tauri/src/plugins/bundled.rs), so the folder itself stays
 * read-only and can be copied to any computer of the same platform.
 *
 * The build needs Node.js 20+, Rust stable, the Tauri system libraries of the platform (see
 * the README) and uv (https://docs.astral.sh/uv/), which brings the Python the plugins run
 * under. Nothing else is needed on the computer that runs the app.
 *
 * The app is built by the Tauri CLI, not by `cargo build`: the CLI turns on the
 * `custom-protocol` feature, which is what puts the frontend inside the binary. A binary
 * built without it looks for the development server and shows a white screen.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "opentrader");
const SRC_TAURI = join(APP, "src-tauri");
const STAGING = join(SRC_TAURI, "standalone");
const PLUGINS = join(STAGING, "plugins");
const PRODUCT = "TradePanel";
const PYTHON_VERSION = "3.12";
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";
/** The platform name the AI runtime and the bundle use (`win` for Windows). */
const PLATFORM = { linux: "linux", darwin: "darwin", win32: "win" }[process.platform] ?? process.platform;
const TARGET = `${PLATFORM}-${process.arch}`;

const say = (message) => console.log(`standalone: ${message}`);
const warn = (message) => console.error(`standalone: warning: ${message}`);

function fail(message, hint) {
  console.error(`standalone: ${message}`);
  if (hint) console.error(`standalone: ${hint}`);
  process.exit(1);
}

function usage() {
  console.log(`Build the standalone app: a folder that holds the app and everything it runs.

  node scripts/build-standalone.mjs [flags]

Flags:
  --out DIR        where the folder is written (default: ${join(ROOT, "dist-standalone")})
  --no-ai          leave the AI runtime (Node + Pi) out
  --no-plugins     leave the Python plugins and their dependencies out
  --bundle         also build the installers of this platform (deb, AppImage, msi, dmg…)
  --skip-build     do not compile the app; assemble the folder from the last release build
  -h, --help       this help

Requirements: Node.js 20+, Rust stable, the Tauri system libraries of the platform and uv
(https://docs.astral.sh/uv/), which brings the Python the plugins run under.`);
}

// ── Options ─────────────────────────────────────────────────────────────────────
const options = {
  out: join(ROOT, "dist-standalone"),
  ai: true,
  plugins: true,
  bundle: false,
  skipBuild: false,
};

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) fail("--out needs a folder.");
      options.out = resolve(value);
    } else if (arg === "--no-ai") options.ai = false;
    else if (arg === "--no-plugins") options.plugins = false;
    else if (arg === "--bundle") options.bundle = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else fail(`Unknown argument: ${arg}`, "Run with --help to see the flags.");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────
function run(command, args, options_ = {}) {
  say(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options_ });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed (${result.status}).`);
  return result;
}

function has(command, args = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore", shell: WIN }).status === 0;
}

/** The size of a folder, in bytes. A symbolic link counts as the link, not as its target. */
function sizeOf(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(child) : lstatSync(child).size;
  }
  return total;
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// ── Toolchain ───────────────────────────────────────────────────────────────────
function checkToolchain() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 19)) {
    fail(`Node.js ${process.versions.node} is too old.`, "Install Node.js 22 or newer: https://nodejs.org");
  }
  // A desktop session often starts with a sparse PATH: rustup installs into ~/.cargo/bin.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cargoBin = join(process.env.CARGO_HOME ?? join(home, ".cargo"), "bin");
  if (existsSync(cargoBin) && !(process.env.PATH ?? "").split(WIN ? ";" : ":").includes(cargoBin)) {
    process.env.PATH = `${cargoBin}${WIN ? ";" : ":"}${process.env.PATH ?? ""}`;
  }
  if (!has("cargo")) {
    fail("Rust is not installed (cargo was not found).", "Install Rust stable: https://rustup.rs");
  }
  if (options.plugins && !has("uv")) {
    fail(
      "uv was not found; the build needs it to bring the Python the plugins run under.",
      "Install uv: https://docs.astral.sh/uv/getting-started/installation/",
    );
  }
  // The drawing core is a sibling checkout, read from source by Vite.
  if (!existsSync(join(ROOT, "lightweight-charts-drawing", "src", "core"))) {
    fail(
      "the drawing core is missing: lightweight-charts-drawing/ must sit next to opentrader/.",
      "Clone https://github.com/deepentropy/lightweight-charts-drawing into the repository root.",
    );
  }
  applyBuildEnvironment();
  installFrontendDependencies();
  generateBindings();
}

/**
 * The Tauri system libraries. A Linux machine that carries the WebKitGTK runtime libraries
 * only (no -dev packages) needs the paths to the headers; `TRADEPANEL_ENV` names a shell
 * snippet with them, and this workspace keeps one in tmp/linux-env.sh.
 */
function applyBuildEnvironment() {
  if (process.platform !== "linux" || !has("pkg-config")) return;
  const headers = () =>
    !has("pkg-config", ["--exists", "webkit2gtk-4.1"]) && !has("pkg-config", ["--exists", "webkit2gtk-4.0"]);
  let envFile = process.env.TRADEPANEL_ENV;
  if (!envFile && headers()) {
    const local = join(ROOT, "tmp", "linux-env.sh");
    if (existsSync(local)) envFile = local;
  }
  if (!envFile) {
    if (headers()) {
      fail(
        "the WebKitGTK development headers were not found, and the Rust build cannot link the window without them.",
        "Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev\n" +
          "standalone: runtime libraries only: point TRADEPANEL_ENV at a shell snippet that sets PKG_CONFIG_PATH and the linker paths.",
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
  const sourced = spawnSync("bash", ["-c", 'set -a; . "$1" >&2; env -0', "standalone", file], {
    encoding: "buffer",
  });
  if (sourced.status !== 0) {
    warn(`could not apply ${file}; continuing without it.`);
    return;
  }
  for (const pair of sourced.stdout.toString().split("\0")) {
    const split = pair.indexOf("=");
    if (split > 0) process.env[pair.slice(0, split)] = pair.slice(split + 1);
  }
}

/** The frontend dependencies, installed when they are missing or out of date. */
function installFrontendDependencies() {
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
  if (existsSync(tauriCli) && existsSync(join(modules, "vite")) && mtime(stamp) >= mtime(lock)) return;
  say("installing the frontend dependencies (npm ci)");
  run(NPM, ["ci", "--no-audit", "--no-fund"], { cwd: APP });
}

/** `src/bindings.ts` is generated from the Rust commands and git-ignored. */
function generateBindings() {
  if (existsSync(join(APP, "src", "bindings.ts"))) return;
  say("generating src/bindings.ts (cargo test --lib export_bindings; the first Rust build takes a while)");
  run("cargo", ["test", "--lib", "export_bindings"], { cwd: SRC_TAURI });
}

// ── The AI runtime ──────────────────────────────────────────────────────────────
function stageAiRuntime() {
  say("staging the AI runtime (Node + Pi)");
  run(process.execPath, [join(ROOT, "scripts", "build-ai-runtime.mjs")], { cwd: ROOT });
  const staged = join(SRC_TAURI, "ai-runtime", TARGET);
  if (!existsSync(join(staged, "manifest.json"))) {
    fail(`the AI runtime for ${TARGET} is missing: ${staged}`);
  }
  say(`the AI runtime for ${TARGET} is staged (${megabytes(sizeOf(staged))})`);
}

// ── The Python runtime and the plugins ──────────────────────────────────────────
function stagePlugins() {
  rmSync(PLUGINS, { recursive: true, force: true });
  mkdirSync(PLUGINS, { recursive: true });

  stagePythonRuntime();
  stagePluginPackages();
}

/**
 * A Python of its own, with the plugins' dependencies. The bundle has to run on a computer
 * with no Python installed, so the interpreter comes with it (uv's managed build, which is
 * self-contained).
 */
function stagePythonRuntime() {
  const cache = join(APP, "node_modules/.cache/standalone/python");
  say(`fetching Python ${PYTHON_VERSION} (uv)`);
  run("uv", ["python", "install", PYTHON_VERSION, "--install-dir", cache, "--no-bin"]);

  const installed = readdirSync(cache).find((name) => {
    if (!/^cpython-\d+\.\d+\.\d+/.test(name)) return false;
    return statSync(join(cache, name)).isDirectory();
  });
  if (!installed) fail(`uv did not install Python ${PYTHON_VERSION} in ${cache}.`);

  const python = join(PLUGINS, "runtime", "python");
  say("copying the Python into the bundle");
  cpSync(join(cache, installed), python, { recursive: true, dereference: true });
  prunePython(python);

  const interpreter = WIN ? join(python, "python.exe") : join(python, "bin", "python3");
  if (!existsSync(interpreter)) fail(`the bundled Python has no interpreter: ${interpreter}`);

  say("installing the plugins' dependencies (ccxt, the Hyperliquid SDK…)");
  const dependencies = join(PLUGINS, "runtime", "site-packages");
  run("uv", [
    "pip",
    "install",
    "--target",
    dependencies,
    "--python",
    interpreter,
    "-r",
    join(ROOT, "plugins", "crypto", "requirements.txt"),
    "-r",
    join(ROOT, "plugins", "ccxt-broker", "requirements.txt"),
  ]);
  say(`the Python runtime is staged (${megabytes(sizeOf(join(PLUGINS, "runtime")))})`);
}

/** The parts of the Python no plugin uses: the headers, the manuals, the IDLE, Tcl/Tk. */
export function prunePython(python) {
  const remove = [
    "include",
    "share",
    join("lib", "pkgconfig"),
    join("lib", "tcl9.0"),
    join("lib", "tk9.0"),
    join("lib", "libtcl9.0.so"),
    join("lib", "libtk9.0.so"),
    join("lib", "thread3.0.4"),
    join("lib", "itcl4.3.5"),
  ];
  for (const name of remove) rmSync(join(python, name), { recursive: true, force: true });
  const lib = join(python, "lib");
  if (!existsSync(lib)) return;
  for (const entry of readdirSync(lib)) {
    if (!/^python3\.\d+$/.test(entry)) continue;
    for (const part of ["test", "idlelib", "tkinter", "tclib", "lib2to3", "ensurepip", "pydoc_data"]) {
      rmSync(join(lib, entry, part), { recursive: true, force: true });
    }
    // pip is not used: the environment the plugins run under is made without it.
    const site = join(lib, entry, "site-packages");
    if (!existsSync(site)) continue;
    for (const item of readdirSync(site)) {
      if (/^pip/.test(item)) rmSync(join(site, item), { recursive: true, force: true });
    }
  }
}

/**
 * The plugin packages. The installers of the app write them (they know the manifests of the
 * venues and what each plugin needs), with `--no-deps`: the dependencies are the shared
 * Python runtime above, not an environment per plugin.
 */
function stagePluginPackages() {
  const data = join(STAGING, "data");
  const config = join(STAGING, "config");
  rmSync(data, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });

  say("staging the plugin packages");
  run(process.execPath, [join(ROOT, "scripts", "install-crypto-plugin.mjs"), "--no-deps", "--data", data, "--config", config]);
  run(process.execPath, [
    join(ROOT, "scripts", "install-broker-plugins.mjs"),
    "--no-deps",
    "--disabled",
    "--data",
    data,
    "--config",
    config,
  ]);

  // The layout the app reads: the packages, and the settings that say which of them start.
  const packages = join(PLUGINS, "packages");
  mkdirSync(packages, { recursive: true });
  for (const id of readdirSync(join(data, "plugins"))) {
    cpSync(join(data, "plugins", id), join(packages, id), { recursive: true });
  }
  const settings = JSON.parse(readFileSync(join(config, "plugins.json"), "utf8"));
  for (const plugin of Object.values(settings.plugins ?? {})) {
    // The tokens are the app's business: it writes its own when it installs a plugin.
    plugin.token = "";
  }
  writeFileSync(join(PLUGINS, "plugins.json"), `${JSON.stringify(settings, null, 2)}\n`);

  writeFileSync(
    join(PLUGINS, "manifest.json"),
    `${JSON.stringify(
      {
        schema: 1,
        product: PRODUCT,
        version: appVersion(),
        target: TARGET,
        builtAt: new Date().toISOString(),
        plugins: Object.keys(settings.plugins ?? {}),
      },
      null,
      2,
    )}\n`,
  );
  say(`${Object.keys(settings.plugins ?? {}).length} plugins are staged`);
}

// ── The app ─────────────────────────────────────────────────────────────────────
/** The Tauri configuration: the version, the product name, the resources it reads. */
function tauriConfig() {
  return JSON.parse(readFileSync(join(SRC_TAURI, "tauri.conf.json"), "utf8"));
}

function appVersion() {
  return tauriConfig().version;
}

/** The resources the app reads at runtime, in the Tauri configuration. */
function resourcesMap() {
  const resources = {};
  if (options.ai) resources["ai-runtime"] = "ai-runtime";
  if (options.plugins) resources["standalone/plugins"] = "plugins";
  return resources;
}

function buildApp() {
  const config = join(STAGING, "tauri.standalone.json");
  writeFileSync(config, `${JSON.stringify({ bundle: { resources: resourcesMap() } }, null, 2)}\n`);
  say("building the app (the frontend, then the Rust binary)");
  const args = ["--prefix", APP, "run", "tauri", "--", "build"];
  if (!options.bundle) args.push("--no-bundle");
  args.push("-c", config);
  run(NPM, args, { cwd: ROOT });
}

// ── The folder ──────────────────────────────────────────────────────────────────
/**
 * Where the app expects its resources, per platform (the Tauri resource directory).
 * `productName` is the name the Tauri configuration gives the app: on Linux the resources
 * sit in `../lib/<productName>` next to the executable, as the deb package installs them.
 */
export function layout(platform = process.platform, productName = "OpenTrader") {
  if (platform === "win32") return { binary: "opentrader.exe", resources: "." };
  if (platform === "darwin") return { binary: "bin/opentrader", resources: "Resources" };
  return { binary: "bin/opentrader", resources: `lib/${productName}` };
}

/**
 * The app must carry its frontend inside the binary. A binary built with a plain
 * `cargo build --release` has no `custom-protocol` feature: it looks for the development
 * server instead, and the window stays white.
 */
function assertFrontendInside(binary) {
  const index = join(APP, "dist", "index.html");
  if (!existsSync(index)) return;
  const asset = readFileSync(index, "utf8").match(/\/assets\/[^"']+\.js/)?.[0];
  if (!asset) return;
  if (!readFileSync(binary).includes(asset, 0, "utf8")) {
    fail(
      `${binary} does not carry the frontend (${asset} is not in it).`,
      "Build it with the Tauri CLI (npm run build): a plain `cargo build --release` leaves the app in development mode, where it looks for the dev server and shows a white screen.",
    );
  }
}

function assemble() {
  const version = appVersion();
  const name = `${PRODUCT}-${version}-${process.platform}-${process.arch}`;
  const folder = join(options.out, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });

  const binary = join(SRC_TAURI, "target", "release", WIN ? "opentrader.exe" : "opentrader");
  if (!existsSync(binary)) {
    fail(`the release binary is missing: ${binary}`, "Run the build without --skip-build.");
  }
  assertFrontendInside(binary);
  const place = layout(process.platform, tauriConfig().productName);
  const target = join(folder, place.binary);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(binary, target);
  if (!WIN) chmodSync(target, 0o755);

  // The resources: where the app looks for them.
  const resources = join(folder, place.resources);
  mkdirSync(resources, { recursive: true });
  if (options.ai && existsSync(join(SRC_TAURI, "ai-runtime"))) {
    say("copying the AI runtime");
    cpSync(join(SRC_TAURI, "ai-runtime"), join(resources, "ai-runtime"), { recursive: true });
  }
  if (options.plugins && existsSync(PLUGINS)) {
    say("copying the plugins and their Python runtime");
    cpSync(PLUGINS, join(resources, "plugins"), { recursive: true });
  }

  writeLauncher(folder);
  writeReadme(folder, version);

  // A stable path to the newest build: a desktop entry or a script can point at it, and a new
  // version does not break it.
  const link = join(options.out, "current");
  rmSync(link, { recursive: true, force: true });
  symlinkSync(name, link);

  say(`the standalone app is in ${folder} (${megabytes(sizeOf(folder))})`);
  archive(folder);
  return folder;
}

/** The script that starts the app: the binary is not where a double click expects it. */
function writeLauncher(folder) {
  const place = layout(process.platform, tauriConfig().productName);
  if (WIN) {
    writeFileSync(join(folder, `${PRODUCT}.cmd`), `@echo off\r\n"%~dp0${place.binary}" %*\r\n`);
    return;
  }
  const launcher = join(folder, PRODUCT);
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      "# Start TradePanel from this folder.",
      'here="$(cd -- "$(dirname -- "$0")" >/dev/null 2>&1 && pwd)"',
      `exec "$here/${place.binary}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
}

function writeReadme(folder, version) {
  const place = layout(process.platform, tauriConfig().productName);
  const lines = [
    `${PRODUCT} ${version} (${process.platform}-${process.arch})`,
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
    `  ${place.binary}          the app (the frontend is inside the binary)`,
    `  ${place.resources}/ai-runtime   the AI runtime (Node + Pi)`,
    `  ${place.resources}/plugins      the plugin packages and their Python runtime`,
    "",
  ];
  writeFileSync(join(folder, "README.txt"), lines.join("\n"));
}

/** The folder as one archive, to copy it to another computer. */
function archive(folder) {
  const name = folder.split(/[\\/]/).pop();
  if (WIN) {
    say("writing the archive (zip)");
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${folder}' -DestinationPath '${join(options.out, name)}.zip' -Force`],
      { stdio: "inherit" },
    );
    if (ps.status !== 0) warn("the archive was not written.");
    else say(`the archive is ${join(options.out, `${name}.zip`)}`);
    return;
  }
  say("writing the archive (tar.gz)");
  const tar = spawnSync("tar", ["-czf", `${folder}.tar.gz`, "-C", options.out, name], { stdio: "inherit" });
  if (tar.status !== 0) warn("the archive was not written.");
  else say(`the archive is ${folder}.tar.gz (${megabytes(statSync(`${folder}.tar.gz`).size)})`);
}

// ── Run ─────────────────────────────────────────────────────────────────────────
function main(argv) {
  parseArgs(argv);
  say(`building ${PRODUCT} for ${process.platform}-${process.arch}`);
  checkToolchain();
  if (options.ai) stageAiRuntime();
  if (options.plugins) stagePlugins();
  if (!options.skipBuild) buildApp();
  assemble();
  say("done");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
