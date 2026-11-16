/* The broker installer writes one plugin per venue, keeps every other plugin and preference,
 * and gives each venue its own manifest and token. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canImportCcxt, manifests, manifestFor, mergeConfig, venvPython } from "../install-broker-plugins.mjs";

const all = manifests();

test("the catalog carries the eight ccxt venues", () => {
  assert.deepEqual(Object.keys(all), ["binance", "bybit", "okx", "gate", "bitget", "kucoin", "coinbase", "kraken"]);
  for (const [id, manifest] of Object.entries(all)) {
    assert.equal(manifest.id, id);
    assert.deepEqual(manifest.provides, ["broker"]);
    assert.deepEqual(manifest.runtime.args, ["--venue", id]);
    assert.equal(manifest.setup.length > 0, true);
  }
});

test("each venue names its exchange, market and network fields", () => {
  assert.equal(manifestFor("binance").exchange, "BINANCE");
  assert.equal(manifestFor("gate").exchange, "GATEIO");
  const okx = Object.fromEntries(manifestFor("okx").settings.map((field) => [field.key, field]));
  assert.deepEqual(okx.market.options.map((option) => option.value), ["futures", "spot"]);
  assert.equal(okx.network.default, "testnet");
  assert.equal(okx.passphrase.type, "secret");
  const coinbase = Object.fromEntries(manifestFor("coinbase").settings.map((field) => [field.key, field]));
  assert.deepEqual(coinbase.market.options.map((option) => option.value), ["spot"]);
  assert.deepEqual(coinbase.network.options.map((option) => option.value), ["live"]);
  assert.throws(() => manifestFor("hyperliquid"), /Unknown venue/);
});

test("merging enables the venues and keeps other plugins, settings and the active broker", () => {
  const before = {
    port: 47822,
    plugins: {
      crypto: { enabled: true, token: "crypto-token", settings: { network: "live" }, verified: true },
      bybit: { enabled: false, token: "keep-token", settings: { market: "spot", apiKey: "a" }, verified: true },
    },
    active_broker: "crypto",
    trading_enabled: true,
  };
  const after = mergeConfig(before, ["bybit", "okx"], { okx: "new-token" }, all);
  assert.equal(after.active_broker, "crypto");
  assert.equal(after.trading_enabled, true);
  assert.deepEqual(after.plugins.crypto, before.plugins.crypto);
  assert.equal(after.plugins.bybit.enabled, true);
  assert.equal(after.plugins.bybit.token, "keep-token");
  assert.deepEqual(after.plugins.bybit.settings, { market: "spot", apiKey: "a" });
  assert.equal(after.plugins.okx.enabled, true);
  assert.equal(after.plugins.okx.token, "new-token");
  assert.deepEqual(after.plugins.okx.settings, {});
  assert.deepEqual(after.plugins.okx.secretKeys, []);
  assert.deepEqual(after.plugins.okx.symbolMap, {});
  assert.equal(after.plugins.okx.verified, false);
  assert.throws(() => mergeConfig(before, ["nope"], {}, all), /Unknown venue/);
});

test("a venv is only reused when it really can import ccxt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-broker-venv-"));
  try {
    const venv = join(dir, "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    const python = join(venv, "bin", "python");
    writeFileSync(python, "#!/bin/sh\n");
    const ok = () => ({ status: 0, stdout: "4.5.92\n" });
    const empty = () => ({ status: 0, stdout: "" });
    const broken = () => ({ status: 1, stdout: "" });
    assert.equal(canImportCcxt(venv, ok), true, "a venv that prints ccxt's version is reused");
    assert.equal(canImportCcxt(venv, empty), false, "a stub that prints nothing is not");
    assert.equal(canImportCcxt(venv, broken), false, "a failing import is not");
    assert.equal(canImportCcxt(join(dir, "absent"), ok), false, "a venv without an interpreter is not");
    assert.match(venvPython(venv), /[\\/]bin[\\/]python(\.exe)?$/);
    assert.match(venvPython(venv, "win32"), /Scripts[\\/]python\.exe$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--disabled installs the venues off: listed as brokers, no process until one is enabled", () => {
  const before = { plugins: { crypto: { enabled: true, token: "t" } }, active_broker: "crypto" };
  const after = mergeConfig(before, ["binance", "kraken"], {}, all, null);
  assert.equal(after.plugins.binance.enabled, false);
  assert.equal(after.plugins.kraken.enabled, false);
  assert.equal(after.plugins.binance.token.length > 0, true, "an off venue still gets its token");
  assert.deepEqual(after.plugins.crypto, before.plugins.crypto);
  assert.equal(after.active_broker, "crypto");
  // The default stays "enabled", what `npm run ot:brokers` does.
  assert.equal(mergeConfig(before, ["binance"], {}, all).plugins.binance.enabled, true);
});

test("--disabled leaves a venue that was on as the user left it, keeping its token and settings", () => {
  const before = { plugins: { bybit: { enabled: true, token: "keep", settings: { market: "spot" } } } };
  const after = mergeConfig(before, ["bybit", "kraken"], {}, all, null);
  assert.equal(after.plugins.bybit.enabled, true, "a broker the user turned on stays on");
  assert.equal(after.plugins.bybit.token, "keep");
  assert.deepEqual(after.plugins.bybit.settings, { market: "spot" });
  assert.equal(after.plugins.kraken.enabled, false, "a new venue arrives off");
  // The flag alone still turns them all off when that is what the user asked for.
  assert.equal(mergeConfig(before, ["bybit"], {}, all, false).plugins.bybit.enabled, false);
});
