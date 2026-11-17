/* The bundled-plugin installer keeps every other plugin and preference, and writes the
 * camelCase fields the plugin host's `PluginConfig` reads. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appDirs, enablePlugin, mergeConfig } from "../install-crypto-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("app folders follow the app identifier on each platform", () => {
  const linux = appDirs("linux", {}, "/home/me");
  assert.match(linux.data, /\/home\/me\/\.local\/share\/com\.opentrader\.app$/);
  assert.match(linux.config, /\/home\/me\/\.config\/com\.opentrader\.app$/);
  const mac = appDirs("darwin", {}, "/Users/me");
  assert.equal(mac.data, mac.config);
  assert.match(mac.data, /Application Support\/com\.opentrader\.app$/);
  assert.match(appDirs("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me").data, /Roaming\\com\.opentrader\.app$/);
});

test("merging enables crypto and keeps other plugins, settings and the token", () => {
  const before = {
    port: 47822,
    plugins: {
      ibkr: { enabled: true, token: "keep", settings: { mode: "paper" }, copied: [], verified: true, symbolMap: {} },
      crypto: { enabled: false, token: "old-token", settings: { network: "live" }, verified: true },
    },
    active_broker: "ibkr",
    trading_enabled: true,
  };
  const after = mergeConfig(before, "new-token");
  assert.equal(after.active_broker, "ibkr");
  assert.equal(after.trading_enabled, true);
  assert.deepEqual(after.plugins.ibkr, before.plugins.ibkr);
  assert.equal(after.plugins.crypto.enabled, true);
  assert.equal(after.plugins.crypto.token, "old-token");
  assert.deepEqual(after.plugins.crypto.settings, { network: "live" });
  assert.deepEqual(after.plugins.crypto.secretKeys, []);
  assert.equal(after.plugins.crypto.verified, false);
});

test("a fresh config gets a token and the defaults the Rust side expects", () => {
  const after = mergeConfig({}, "abc");
  assert.equal(after.port, 47822);
  assert.equal(after.active_broker, null);
  assert.equal(after.trading_enabled, false);
  assert.equal(after.plugins.crypto.token, "abc");
  assert.deepEqual(after.plugins.crypto.symbolMap, {});
});

test("enabling the NSE plugin keeps existing plugins and settings", () => {
  const before = {
    plugins: { crypto: { enabled: true, token: "keep", settings: { pollSeconds: "15" } } },
    active_broker: "hyperliquid",
    trading_enabled: true,
  };
  const after = enablePlugin(before, "nse", "new-token");
  assert.deepEqual(after.plugins.crypto, before.plugins.crypto);
  assert.equal(after.plugins.nse.enabled, true);
  assert.equal(after.plugins.nse.token, "new-token");
  assert.deepEqual(after.plugins.nse.settings, {});
  assert.equal(after.active_broker, "hyperliquid");
  assert.equal(after.trading_enabled, true);
});

test("the NSE installer replaces an older --if-needed install but keeps the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "tradepanel-nse-"));
  try {
    const installer = join(ROOT, "scripts", "install-nse-plugin.mjs");
    const args = ["--if-needed", "--data", join(dir, "data"), "--config", join(dir, "config")];
    const installed = join(dir, "data", "plugins", "nse", "opentrader-plugin.json");
    const config = join(dir, "config", "plugins.json");
    const run = () => spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const token = JSON.parse(readFileSync(config, "utf8")).plugins.nse.token;
    const manifest = JSON.parse(readFileSync(installed, "utf8"));
    writeFileSync(installed, JSON.stringify({ ...manifest, version: "0.0.1" }));
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(readFileSync(installed, "utf8")).version, manifest.version);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).plugins.nse.token, token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the crypto installer replaces an older --if-needed install but keeps the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "tradepanel-crypto-"));
  try {
    const installer = join(ROOT, "scripts", "install-crypto-plugin.mjs");
    const args = ["--if-needed", "--no-deps", "--data", join(dir, "data"), "--config", join(dir, "config")];
    const installed = join(dir, "data", "plugins", "crypto", "opentrader-plugin.json");
    const config = join(dir, "config", "plugins.json");
    const run = () => spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const token = JSON.parse(readFileSync(config, "utf8")).plugins.crypto.token;
    const manifest = JSON.parse(readFileSync(installed, "utf8"));
    writeFileSync(installed, JSON.stringify({ ...manifest, version: "0.0.1" }));
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(readFileSync(installed, "utf8")).version, manifest.version);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).plugins.crypto.token, token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
