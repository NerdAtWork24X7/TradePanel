#!/usr/bin/env node
/*
 * Install the CCXT broker plugins: one plugin per venue (Binance, Bybit, OKX, Gate.io,
 * Bitget, KuCoin, Coinbase, Kraken), each with its own manifest, settings and token.
 *
 *   node scripts/install-broker-plugins.mjs [--only=binance,bybit] [--no-deps]
 *                                           [--if-needed] [--disabled] [--data DIR] [--config DIR]
 *
 * `--disabled` installs the venues without enabling them (a venue already installed keeps its
 * switch): the Exchanges tab and the broker picker list every venue's card, and enabling the one
 * the user trades starts its process. The launcher (`npm start`) installs them that way, so the
 * app never runs eight Python brokers at once.
 *
 * The app connects to one broker at a time (Trade > Connect broker…), but every installed
 * venue appears in the Exchanges tab under Brokers, so the ones a user does not trade can
 * be disabled there. Close OpenTrader first: it rewrites `plugins.json` when it exits.
 *
 * One venv holds ccxt for all of them: each plugin folder's `.venv` links to it (a
 * junction on Windows), because the plugin host runs a `.py` entry with the venv inside
 * its own folder. Removing a plugin removes the link, not the shared environment.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appDirs } from "./install-crypto-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "plugins", "ccxt-broker");
const SKIP = new Set([".venv", "__pycache__", "tests", "dist", ".pytest_cache", "build.py", "manifests.py"]);
const SHARED_VENV = ".ccxt-broker-venv";

/** The generated manifests (one per venue), keyed by plugin id. */
export function manifests(dir = SOURCE) {
  return JSON.parse(readFileSync(join(dir, "manifests.json"), "utf8"));
}

/** The manifest of one venue, or a clear refusal for a name the catalog does not carry. */
export function manifestFor(id, all = manifests()) {
  const manifest = all[id];
  if (!manifest) throw new Error(`Unknown venue ${JSON.stringify(id)}; expected one of ${Object.keys(all).join(", ")}`);
  return manifest;
}

/** `plugins.json` with every named venue in it: `enabled` true or false for all of them, or `null` to leave a
 *  venue's switch as it is and install a new one off. Other plugins, settings and the active broker are kept. */
export function mergeConfig(config, ids, tokens, all = manifests(), enabled = true) {
  const next = { ...config };
  next.port ??= 47822;
  next.plugins ??= {};
  next.active_broker ??= null;
  next.trading_enabled ??= false;
  for (const id of ids) {
    manifestFor(id, all);
    const previous = next.plugins[id] ?? {};
    next.plugins[id] = {
      ...previous,
      enabled: enabled === null ? (previous.enabled ?? false) : enabled,
      token: previous.token || tokens[id] || randomBytes(24).toString("hex"),
      settings: previous.settings ?? {},
      secretKeys: previous.secretKeys ?? [],
      copied: previous.copied ?? [],
      // The installer writes unsigned files, whatever the previous package's signature was.
      verified: false,
      symbolMap: previous.symbolMap ?? {},
    };
  }
  return next;
}

function copyPlugin(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(SOURCE, target, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).some((part) => SKIP.has(part)),
  });
}

/** The Python interpreter that will build the venv. */
function pythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

/** The interpreter of a venv, when it has one. */
export function venvPython(venv, platform = process.platform) {
  return join(venv, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

/** `venv` can import ccxt (the probe prints its version, so a stub that runs nothing does not pass). */
export function canImportCcxt(venv, run = spawnSync) {
  const python = venvPython(venv);
  if (!existsSync(python)) return false;
  const probe = run(python, ["-c", "import ccxt; print(ccxt.__version__)"], { encoding: "utf8" });
  return probe.status === 0 && /\d+\.\d+/.test(probe.stdout ?? "");
}

/** A venv that can `import ccxt` already: the shared one, or the crypto plugin's (it ships ccxt too). */
function reusableVenv(pluginsDir) {
  for (const venv of [join(pluginsDir, SHARED_VENV), join(pluginsDir, "crypto", ".venv")]) {
    if (!canImportCcxt(venv)) continue;
    console.log(`Reusing ${venv} for the broker plugins.`);
    return venv;
  }
  return null;
}

/** One ccxt install for every broker plugin; each folder links to it. */
function sharedVenv(pluginsDir) {
  const existing = reusableVenv(pluginsDir);
  if (existing) return existing;
  const venv = join(pluginsDir, SHARED_VENV);
  console.log(`Creating the shared venv ${venv} (${pythonCommand()})…`);
  const created = spawnSync(pythonCommand(), ["-m", "venv", venv], { stdio: "inherit" });
  if (created.status !== 0) throw new Error(`${pythonCommand()} -m venv failed. Install Python 3.10+ and run again, or pass --no-deps.`);
  const pip = process.platform === "win32" ? join(venv, "Scripts", "pip.exe") : join(venv, "bin", "pip");
  console.log("Installing ccxt for the broker plugins…");
  const installed = spawnSync(pip, ["install", "--disable-pip-version-check", "-r", join(SOURCE, "requirements.txt")], { stdio: "inherit" });
  if (installed.status !== 0) throw new Error("pip install failed");
  return venv;
}

/** The plugin's own `.venv`: a link to the shared one, unless the user already put one there. */
function linkVenv(target, venv) {
  const link = join(target, ".venv");
  if (existsSync(venvPython(link))) return true; // already linked, or a venv the user made
  try {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(venv, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    console.warn(`Could not link ${link}: ${error.message}. The plugin will use the system Python; install ccxt there.`);
    return false;
  }
}

function main(argv) {
  const deps = !argv.includes("--no-deps");
  const ifNeeded = argv.includes("--if-needed");
  // Installed but off: listed in the Exchanges tab and the broker picker, no process until the user enables one.
  // A venue already enabled keeps its switch: the launcher must not turn off a broker the user chose.
  const enabled = argv.includes("--disabled") ? null : true;
  const value = (name) => {
    const inline = argv.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const only = value("--only");
  const all = manifests();
  const ids = only ? only.split(",").map((id) => id.trim()).filter(Boolean) : Object.keys(all);
  for (const id of ids) manifestFor(id, all);

  const dirs = appDirs();
  const data = resolve(value("--data") || dirs.data);
  const configDir = resolve(value("--config") || dirs.config);
  const pluginsDir = join(data, "plugins");
  const targets = ids.map((id) => join(pluginsDir, id));

  if (ifNeeded && targets.every((target) => existsSync(join(target, "plugin.py")) && existsSync(join(target, "opentrader-plugin.json")))) {
    console.log(`Broker plugins already installed in ${pluginsDir}; skipping.`);
    return;
  }

  const venv = deps ? sharedVenv(pluginsDir) : null;
  for (const id of ids) {
    const target = join(pluginsDir, id);
    copyPlugin(target);
    writeFileSync(join(target, "opentrader-plugin.json"), JSON.stringify(manifestFor(id, all), null, 2) + "\n");
    if (venv) linkVenv(target, venv);
    console.log(`Installed ${id} into ${target}`);
  }

  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "plugins.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify(mergeConfig(current, ids, {}, all, enabled), null, 2) + "\n");
  console.log(
    enabled === false || enabled === null
      ? `Installed ${ids.length} broker plugin${ids.length === 1 ? "" : "s"} (new venues off) in ${file}`
      : `Enabled ${ids.length} broker plugin${ids.length === 1 ? "" : "s"} in ${file}`,
  );
  console.log("\nStart OpenTrader. The venues are in the Exchanges tab under Brokers and in Trade >");
  console.log("Connect broker: fill one's API key and secret (and passphrase, where it has one), then");
  console.log("Connect. Each venue runs its own small process only while it is enabled, so keep off the");
  console.log("ones you do not trade.");
  if (!deps) console.log("--no-deps: install ccxt for the plugin's Python yourself.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`install-broker-plugins: ${error.message}`);
    process.exit(1);
  }
}
