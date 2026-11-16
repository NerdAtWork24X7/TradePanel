#!/usr/bin/env node
/*
 * Install the bundled crypto plugin into a running OpenTrader installation.
 *
 * The app's own Settings > Plugins > Install from file works too, but it cannot create the
 * plugin's Python virtualenv. This script copies the package into the app's plugin folder,
 * builds `.venv` (which the plugin host prefers for a `.py` entry) and enables the plugin in
 * `plugins.json`. It never writes a secret: the private key goes in through Settings, which
 * stores it in the OS credential store.
 *
 *   node scripts/install-crypto-plugin.mjs [--no-deps] [--data DIR] [--config DIR]
 *
 * Close OpenTrader first: it rewrites `plugins.json` when it exits.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "opentrader");
const PLUGIN_ID = "crypto";
const SKIP = new Set([".venv", "__pycache__", "tests", "dist", ".pytest_cache"]);

/** The app's data and config folders, as Tauri resolves them (`identifier` in tauri.conf.json). */
export function appDirs(platform = process.platform, env = process.env, home = homedir()) {
  const identifier = JSON.parse(readFileSync(join(APP, "src-tauri", "tauri.conf.json"), "utf8")).identifier;
  if (platform === "win32") {
    const roaming = env.APPDATA || win32.join(home, "AppData", "Roaming");
    return { data: win32.join(roaming, identifier), config: win32.join(roaming, identifier) };
  }
  if (platform === "darwin") {
    const support = posix.join(home, "Library", "Application Support");
    return { data: posix.join(support, identifier), config: posix.join(support, identifier) };
  }
  return {
    data: posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), identifier),
    config: posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), identifier),
  };
}

/** `plugins.json` with the crypto plugin enabled; every other plugin and preference kept. */
export function mergeConfig(config, token) {
  const next = { ...config };
  next.port ??= 47822;
  next.plugins ??= {};
  next.active_broker ??= null;
  next.trading_enabled ??= false;
  const previous = next.plugins[PLUGIN_ID] ?? {};
  next.plugins[PLUGIN_ID] = {
    ...previous,
    enabled: true,
    token: previous.token || token,
    settings: previous.settings ?? {},
    secretKeys: previous.secretKeys ?? [],
    copied: previous.copied ?? [],
    // The installer writes unsigned files, whatever the previous package's signature was.
    verified: false,
    symbolMap: previous.symbolMap ?? {},
  };
  return next;
}

function copyPlugin(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(ROOT, "plugins", PLUGIN_ID), target, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).some((part) => SKIP.has(part)),
  });
}

function makeVenv(target) {
  const python = process.platform === "win32" ? "python" : "python3";
  const venv = join(target, ".venv");
  console.log(`Creating ${venv} (${python})…`);
  const created = spawnSync(python, ["-m", "venv", venv], { stdio: "inherit" });
  if (created.status !== 0) {
    throw new Error(`${python} -m venv failed. Install Python 3.10+ and run again, or pass --no-deps and provide the packages yourself.`);
  }
  const pip = process.platform === "win32" ? join(venv, "Scripts", "pip.exe") : join(venv, "bin", "pip");
  console.log("Installing ccxt and the Hyperliquid SDK…");
  const installed = spawnSync(pip, ["install", "--disable-pip-version-check", "-r", join(target, "requirements.txt")], { stdio: "inherit" });
  if (installed.status !== 0) throw new Error("pip install failed");
}

function alreadyInstalled(target, configDir, argv = []) {
  const file = join(configDir, "plugins.json");
  if (!existsSync(join(target, "plugin.py"))) return false;
  if (!existsSync(file)) return false;
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    if (!cfg?.plugins?.crypto?.enabled) return false;
  } catch { return false; }
  // A venv is expected when deps were installed; allow --no-deps installs without one.
  return existsSync(join(target, ".venv")) || argv.includes("--no-deps");
}

function main(argv) {
  const deps = !argv.includes("--no-deps");
  const ifNeeded = argv.includes("--if-needed");
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const dirs = appDirs();
  const data = resolve(value("--data") || dirs.data);
  const configDir = resolve(value("--config") || dirs.config);
  const target = join(data, "plugins", PLUGIN_ID);
  if (ifNeeded && alreadyInstalled(target, configDir, argv)) {
    console.log(`Crypto plugin already installed in ${target}; skipping.`);
    return;
  }
  copyPlugin(target);
  if (deps) makeVenv(target);
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "plugins.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify(mergeConfig(current, randomBytes(24).toString("hex")), null, 2) + "\n");
  console.log(`\nInstalled ${PLUGIN_ID} into ${target}`);
  console.log(`Enabled it in ${file}`);
  console.log("\nStart OpenTrader. Crypto symbols appear in the symbol search (BINANCE:, BYBIT:, …).");
  console.log("To trade: Settings > Plugins > Crypto markets & Hyperliquid > Settings, then Trade > Connect broker.");
  if (!deps) console.log("--no-deps: install ccxt, hyperliquid-python-sdk and eth-account for the plugin's Python yourself.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`install-crypto-plugin: ${e.message}`);
    process.exit(1);
  }
}
