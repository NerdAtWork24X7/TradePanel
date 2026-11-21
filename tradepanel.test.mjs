/* The one test suite for the single tradepanel script: the pure helpers that decide where the app's
 * folders live, what the installer writes to plugins.json, and how the extension packs are filtered.
 * Everything that shells out to git/cargo/tauri is exercised by running the script itself. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appDirs,
  canImportCcxt,
  ensurePartialCloneConfig,
  manifestFor,
  manifests,
  mergeBrokerConfig,
  pluginConfig,
  resolveRef,
  selectExtensions,
  venvPython,
} from "./tradepanel.mjs";

const ID = "com.opentrader.app";

// ── App folders ──────────────────────────────────────────────────────────────
test("app folders follow the app identifier on each platform", () => {
  const linux = appDirs({ platform: "linux", env: {}, home: "/home/me", identifier: ID });
  assert.equal(linux.data, `/home/me/.local/share/${ID}`);
  assert.equal(linux.config, `/home/me/.config/${ID}`);
  const mac = appDirs({ platform: "darwin", env: {}, home: "/Users/me", identifier: ID });
  assert.equal(mac.data, mac.config);
  assert.match(mac.data, /Application Support\/com\.opentrader\.app$/);
  assert.match(appDirs({ platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me", identifier: ID }).data, /Roaming\\com\.opentrader\.app$/);
  assert.equal(appDirs({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home: "/home/me", identifier: ID }).data, `/data/${ID}`);
});

// ── plugins.json ─────────────────────────────────────────────────────────────
test("enabling crypto keeps other plugins, settings and the token", () => {
  const before = {
    port: 47822,
    plugins: {
      ibkr: { enabled: true, token: "keep", settings: { mode: "paper" }, copied: [], verified: true, symbolMap: {} },
      crypto: { enabled: false, token: "old-token", settings: { network: "live" }, verified: true },
    },
    active_broker: "ibkr",
    trading_enabled: true,
  };
  const after = pluginConfig(before, "crypto", "new-token");
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
  const after = pluginConfig({}, "nse", "abc");
  assert.equal(after.port, 47822);
  assert.equal(after.active_broker, null);
  assert.equal(after.trading_enabled, false);
  assert.equal(after.plugins.nse.token, "abc");
  assert.deepEqual(after.plugins.nse.symbolMap, {});
});

// ── Broker catalog and config ────────────────────────────────────────────────
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
  assert.throws(() => manifestFor("hyperliquid"), /Unknown venue/);
});

test("merging broker venues keeps other plugins, settings and the active broker", () => {
  const before = {
    port: 47822,
    plugins: {
      crypto: { enabled: true, token: "crypto-token", settings: { network: "live" }, verified: true },
      bybit: { enabled: false, token: "keep-token", settings: { market: "spot", apiKey: "a" }, verified: true },
    },
    active_broker: "crypto",
    trading_enabled: true,
  };
  const after = mergeBrokerConfig(before, ["bybit", "okx"], { okx: "new-token" }, all);
  assert.equal(after.active_broker, "crypto");
  assert.deepEqual(after.plugins.crypto, before.plugins.crypto);
  assert.equal(after.plugins.bybit.enabled, true);
  assert.equal(after.plugins.bybit.token, "keep-token");
  assert.deepEqual(after.plugins.bybit.settings, { market: "spot", apiKey: "a" });
  assert.equal(after.plugins.okx.token, "new-token");
  assert.deepEqual(after.plugins.okx.settings, {});
  assert.equal(after.plugins.okx.verified, false);
});

test("installing venues off leaves an enabled venue as the user left it", () => {
  const before = { plugins: { bybit: { enabled: true, token: "keep", settings: { market: "spot" } } } };
  const after = mergeBrokerConfig(before, ["bybit", "kraken"], {}, all, null);
  assert.equal(after.plugins.bybit.enabled, true, "a broker the user turned on stays on");
  assert.equal(after.plugins.bybit.token, "keep");
  assert.equal(after.plugins.kraken.enabled, false, "a new venue arrives off");
  assert.equal(after.plugins.kraken.token.length > 0, true, "an off venue still gets its token");
  assert.equal(mergeBrokerConfig(before, ["bybit"], {}, all, false).plugins.bybit.enabled, false);
});

// ── venv probing ─────────────────────────────────────────────────────────────
test("a venv is only reused when it really can import ccxt", () => {
  const dir = mkdtempSync(join(tmpdir(), "tradepanel-venv-"));
  try {
    const venv = join(dir, "venv");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\n");
    assert.equal(canImportCcxt(venv, () => ({ status: 0, stdout: "4.5.92\n" })), true);
    assert.equal(canImportCcxt(venv, () => ({ status: 0, stdout: "" })), false);
    assert.equal(canImportCcxt(venv, () => ({ status: 1, stdout: "" })), false);
    assert.equal(canImportCcxt(join(dir, "absent"), () => ({ status: 0, stdout: "4.5.92\n" })), false);
    assert.match(venvPython(venv), /[\\/]bin[\\/]python$/);
    assert.match(venvPython(venv, "win32"), /Scripts[\\/]python\.exe$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Extension selection and refs ─────────────────────────────────────────────
test("all packs pass through when nothing is filtered", () => {
  const packs = [
    { id: "a", order: 1, dependsOn: [], remove: [] },
    { id: "b", order: 2, dependsOn: ["a"], remove: [] },
  ];
  assert.deepEqual(selectExtensions(packs).map((p) => p.id), ["a", "b"]);
});

test("a plain ref is used as-is and an empty ref falls back to origin/HEAD", () => {
  assert.equal(resolveRef("v0.4.25"), "v0.4.25");
  assert.equal(resolveRef(""), "origin/HEAD");
});

// ── Partial-clone repair ─────────────────────────────────────────────────────
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
function tempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "tradepanel-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(git(dir, ["init", "-q"]).status, 0);
  return dir;
}

test("restores partial-clone config when the promisor packs outlive it", (t) => {
  const dir = tempRepo(t);
  mkdirSync(join(dir, ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(dir, ".git", "objects", "pack", "pack-legacy.promisor"), "");
  ensurePartialCloneConfig(dir);
  assert.equal(git(dir, ["config", "--bool", "--get", "remote.origin.promisor"]).stdout.trim(), "true");
  assert.equal(git(dir, ["config", "--get", "remote.origin.partialCloneFilter"]).stdout.trim(), "blob:none");
});

test("leaves full checkouts and configured partial clones alone", (t) => {
  const full = tempRepo(t);
  ensurePartialCloneConfig(full);
  assert.equal(existsSync(join(full, ".git", "objects", "pack", "pack-legacy.promisor")), false);
  assert.notEqual(git(full, ["config", "--get", "remote.origin.promisor"]).status, 0);

  const custom = tempRepo(t);
  mkdirSync(join(custom, ".git", "objects", "pack"), { recursive: true });
  writeFileSync(join(custom, ".git", "objects", "pack", "pack-legacy.promisor"), "");
  assert.equal(git(custom, ["config", "remote.origin.partialCloneFilter", "tree:0"]).status, 0);
  ensurePartialCloneConfig(custom);
  assert.equal(git(custom, ["config", "--bool", "--get", "remote.origin.promisor"]).stdout.trim(), "true");
  assert.equal(git(custom, ["config", "--get", "remote.origin.partialCloneFilter"]).stdout.trim(), "tree:0");
});
