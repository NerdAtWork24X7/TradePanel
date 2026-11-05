/**
 * Contract tests for the QWebChannel-compatibility adapter used by the chart
 * workspace inside the Tauri shell. The adapter is plain JS loaded before
 * workspace.js, so it can be exercised with a minimal fake DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const adapterSource = fs.readFileSync(path.join(repoRoot, "frontend", "web", "tauri_bridge.js"), "utf8");

function createHarness() {
  const posted = [];
  const listeners = {};
  const wsCalls = [];
  const parentFrame = {
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    }
  };
  const windowObject = {
    parent: parentFrame,
    location: { origin: "tauri://localhost" },
    postMessage() {
      throw new Error("the workspace adapter must post to the parent frame");
    },
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    WS: undefined
  };
  const ws = {
    store: { workspaces: [{ id: "ws-test" }] },
    setFocusedCoin(...args) { wsCalls.push(["setFocusedCoin", args]); },
    setFocusedTimeframe(...args) { wsCalls.push(["setFocusedTimeframe", args]); },
    centerFocused(...args) { wsCalls.push(["centerFocused", args]); },
    setIndicatorConfig(...args) { wsCalls.push(["setIndicatorConfig", args]); },
    setActive(...args) { wsCalls.push(["setActive", args]); },
    setFullscreenState(...args) { wsCalls.push(["setFullscreenState", args]); },
    shutdown(...args) { wsCalls.push(["shutdown", args]); }
  };
  const documentObject = {
    readyState: "loading",
    addEventListener(type, handler) {
      (listeners[`doc:${type}`] ??= []).push(handler);
    }
  };
  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    setTimeout,
    clearTimeout,
    console,
    JSON
  });
  vm.runInContext(adapterSource, context, { filename: "tauri_bridge.js" });

  const fire = (type, event) => (listeners[type] ?? []).forEach((handler) => handler(event));
  const postToPage = (data) =>
    fire("message", { source: parentFrame, data, origin: "tauri://localhost" });
  const lastRpc = () => {
    const message = posted.filter((entry) => entry.message.type === "rpc").at(-1)?.message;
    assert.ok(message, "expected an rpc message");
    return message;
  };
  const respond = (id, payload) =>
    postToPage({ __ws: 1, type: "rpc-result", id, ok: payload.ok, result: payload.result, error: payload.error });
  const installWorkspace = () => {
    windowObject.WS = ws;
  };
  const boot = (install = true) => {
    if (install) installWorkspace();
    fire("doc:DOMContentLoaded", {});
    return new Promise((resolve) => setTimeout(resolve, 10));
  };
  return {
    windowObject, documentObject, ws, posted, fire, postToPage, lastRpc, respond,
    boot, installWorkspace, wsCalls
  };
}

test("adapter is inert outside an iframe (legacy Qt path)", () => {
  const windowObject = { parent: null, location: { origin: "file://" }, addEventListener() {} };
  windowObject.parent = windowObject;
  const context = vm.createContext({ window: windowObject, document: { readyState: "complete", addEventListener() {} }, setTimeout, clearTimeout, console });
  vm.runInContext(adapterSource, context);
  assert.equal(windowObject.__WS_STUB__, undefined);
});

test("boot announces readiness and exposes the QWebChannel-shaped stub", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;
  assert.ok(stub, "stub must be installed");
  for (const method of ["meta", "loadStore", "saveStore", "indicatorConfig", "requestCandles", "requestTick", "requestIndicators", "searchSymbols", "credentialStatus", "saveCredentials", "onTradeOverlayResult"]) {
    assert.equal(typeof stub[method], "function", `${method} missing`);
  }
  assert.equal(harness.posted[0].message.type, "event");
  assert.equal(harness.posted[0].message.event, "ready");
});

test("synchronous bridge calls resolve through a JSON string callback", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;

  const response = new Promise((resolve) => {
    stub.meta((payload) => resolve(JSON.parse(payload)));
  });
  const request = harness.lastRpc();
  assert.equal(request.method, "meta");
  harness.respond(request.id, { ok: true, result: { exchanges: [], timeframes: [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(await response)), { exchanges: [], timeframes: [] });
});

test("asynchronous requests are correlated by reqId through dataReady", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;
  const received = [];
  stub.on("dataReady", (reqId, payload) => received.push([reqId, JSON.parse(payload)]));

  stub.requestCandles("ws-42", "binance", "spot", "BTC/USDT", "5m", 600, 0);
  const request = harness.lastRpc();
  assert.equal(request.method, "requestCandles");
  assert.deepEqual(JSON.parse(JSON.stringify(request.args.slice(0, 5))), ["binance", "spot", "BTC/USDT", "5m", 600]);
  harness.respond(request.id, { ok: true, result: { ok: true, candles: [] } });

  assert.equal(received.length, 1);
  assert.equal(received[0][0], "ws-42");
  assert.deepEqual(JSON.parse(JSON.stringify(received[0][1])), { ok: true, candles: [] });
});

test("failures surface as {ok:false,error} so workspace.js rejects", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;
  const response = new Promise((resolve) => {
    stub.loadStore((payload) => resolve(JSON.parse(payload)));
  });
  const request = harness.lastRpc();
  harness.respond(request.id, { ok: false, error: "backend offline" });
  assert.deepEqual(JSON.parse(JSON.stringify(await response)), { ok: false, error: "backend offline" });
});

test("workspace signals become typed host events", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;

  stub.onFocusedChartChanged("BTC/USDT", "binance", "spot", "5m");
  stub.onPositionDrawingChanged("short", 100, 90, 105);
  stub.onTradeOverlayResult(true, "Short BTC/USDT drawn on the chart.");
  stub.onConfigRequested();
  stub.toggleTopBar();
  stub.debug("hello");

  const events = harness.posted.filter((entry) => entry.message.type === "event");
  const plain = (message) => JSON.parse(JSON.stringify(message));
  assert.deepEqual(plain(events.at(-6).message), {
    __ws: 1, type: "event", event: "focusedChart",
    payload: ["BTC/USDT", "binance", "spot", "5m"]
  });
  assert.deepEqual(plain(events.at(-5).message.payload), ["short", 100, 90, 105]);
  assert.deepEqual(plain(events.at(-4).message), {
    __ws: 1, type: "event", event: "tradeOverlay",
    payload: [true, "Short BTC/USDT drawn on the chart."]
  });
  assert.equal(events.at(-3).message.event, "configRequested");
  assert.equal(events.at(-2).message.event, "toggleTopBar");
  assert.deepEqual(plain(events.at(-1).message.payload), ["hello"]);
});

test("fullscreen toggles use the bridge and sync state back", async () => {
  const harness = createHarness();
  await harness.boot();
  const stub = harness.windowObject.__WS_STUB__;
  stub.toggleFullscreen();
  const event = harness.posted.filter((entry) => entry.message.type === "event").at(-1).message;
  assert.equal(event.event, "toggleFullscreen");

  harness.postToPage({ __ws: 1, type: "host", cmd: "setFullscreenState", payload: [true] });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.wsCalls.at(-1))), ["setFullscreenState", [true]]);
});

test("host commands reach the workspace API and are queued until boot", async () => {
  const harness = createHarness();
  // Queue commands before the workspace reports readiness: the host can send
  // commands before workspace.js has created window.WS.
  harness.postToPage({ __ws: 1, type: "host", cmd: "setFocusedCoin", payload: ["ETH"] });
  await harness.boot();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(JSON.parse(JSON.stringify(harness.wsCalls.at(-1))), ["setFocusedCoin", ["ETH"]]);

  harness.postToPage({ __ws: 1, type: "host", cmd: "centerFocused", payload: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.wsCalls.at(-1))), ["centerFocused", []]);
});

test("messages from other frames or origins are ignored", async () => {
  const harness = createHarness();
  await harness.boot();
  const before = harness.wsCalls.length;
  harness.fire("message", {
    source: {},
    origin: "https://evil.example",
    data: { __ws: 1, type: "host", cmd: "shutdown", payload: [] }
  });
  assert.equal(harness.wsCalls.length, before);
});
