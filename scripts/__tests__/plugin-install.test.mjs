/* The bundled-plugin installer keeps every other plugin and preference, and writes the
 * camelCase fields the plugin host's `PluginConfig` reads. */
import assert from "node:assert/strict";
import test from "node:test";
import { appDirs, mergeConfig } from "../install-crypto-plugin.mjs";

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
