#!/usr/bin/env node
/*
 * Install the bundled NSE data plugin into a running OpenTrader installation.
 *
 * The plugin is pure Python standard library, so no virtualenv is needed. The app's
 * Settings > Plugins > Install from file works too, but this script also enables the
 * plugin in `plugins.json`. Close OpenTrader first: it rewrites that file when it exits.
 *
 *   node scripts/install-nse-plugin.mjs [--if-needed] [--data DIR] [--config DIR]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appDirs, enablePlugin } from "./install-crypto-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "nse";
const SKIP = new Set([".venv", "__pycache__", "tests", "dist", ".pytest_cache"]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function copyPlugin(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(ROOT, "plugins", PLUGIN_ID), target, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).some((part) => SKIP.has(part)),
  });
}

function alreadyInstalled(target, configDir, ifNeeded) {
  if (!ifNeeded) return false;
  const config = readJson(join(configDir, "plugins.json"));
  if (!existsSync(join(target, "plugin.py")) || config?.plugins?.[PLUGIN_ID]?.enabled !== true) return false;
  // Reinstall on a version change so `--if-needed` cannot pin an old plugin forever.
  const version = readJson(join(ROOT, "plugins", PLUGIN_ID, "opentrader-plugin.json"))?.version;
  return !!version && readJson(join(target, "opentrader-plugin.json"))?.version === version;
}

function main(argv) {
  const ifNeeded = argv.includes("--if-needed");
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const dirs = appDirs();
  const data = resolve(value("--data") || dirs.data);
  const configDir = resolve(value("--config") || dirs.config);
  const target = join(data, "plugins", PLUGIN_ID);
  if (alreadyInstalled(target, configDir, ifNeeded)) {
    console.log(`NSE plugin already installed in ${target}; skipping.`);
    return;
  }
  copyPlugin(target);
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "plugins.json");
  const current = readJson(file) ?? {};
  writeFileSync(file, JSON.stringify(enablePlugin(current, PLUGIN_ID, randomBytes(24).toString("hex")), null, 2) + "\n");
  console.log(`\nInstalled ${PLUGIN_ID} into ${target}`);
  console.log(`Enabled it in ${file}`);
  console.log("\nStart OpenTrader and search for NSE: symbols in the Stocks tab.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`install-nse-plugin: ${e.message}`);
    process.exit(1);
  }
}
