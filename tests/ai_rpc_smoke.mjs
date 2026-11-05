/**
 * End-to-end smoke test for the bundled Pi runtime.
 *
 * Proves, without any external API key:
 *  - the staged Node + Pi + extension start over JSONL RPC,
 *  - an image attachment reaches the provider,
 *  - read-only context tools execute,
 *  - plans without a probability, no-trade plans and inverted levels are
 *    rejected by the extension, and a valid plan is accepted with a structured
 *    plan,
 *  - streaming text settles,
 *  - abort produces `agent_settled { aborted: true }`,
 *  - the persistent session file is written with the requested id.
 *
 * Requires `node backend/scripts/build-ai-runtime.mjs`. Skipped otherwise
 * unless TRADEPANEL_REQUIRE_AI_RUNTIME=1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOST = `${process.platform === "win32" ? "win" : process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
const RUNTIME = join(ROOT, "src-tauri/ai-runtime", HOST);
const NODE = join(RUNTIME, "node", process.platform === "win32" ? "node.exe" : "node");
const CLI = join(RUNTIME, "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const EXTENSION = join(RUNTIME, "pi/extensions/tradepanel-analysis.mjs");
const SYSTEM_PROMPT = join(RUNTIME, "pi/prompts/analysis.md");
const READY = existsSync(NODE) && existsSync(CLI) && existsSync(EXTENSION);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

if (!READY && process.env.TRADEPANEL_REQUIRE_AI_RUNTIME === "1") {
  throw new Error(`AI runtime missing at ${RUNTIME}; run backend/scripts/build-ai-runtime.mjs`);
}

const skip = READY ? false : "AI runtime not staged (run backend/scripts/build-ai-runtime.mjs)";

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamToolCall(res, id, name, args) {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Date.now(), model: "mock-model" };
  sse(res, {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
  });
  sse(res, {
    ...base,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamText(res, pieces) {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Date.now(), model: "mock-model" };
  for (const piece of pieces) {
    sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function startMockProvider() {
  const state = { requests: [], sawImage: false, imageParts: 0, releaseSlow: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      state.requests.push(payload);
      const messages = payload.messages || [];
      if (JSON.stringify(messages).includes("image_url") || JSON.stringify(messages).includes("base64")) {
        state.sawImage = true;
        const user = messages.find((message) => Array.isArray(message.content));
        state.imageParts = (user?.content || []).filter((part) => part.type === "image_url").length;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (payload.model === "slow-model") {
        const base = { id: "chatcmpl-slow", object: "chat.completion.chunk", created: Date.now(), model: "slow-model" };
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Starting " }, finish_reason: null }] });
        state.releaseSlow = () => {
          try { res.write("data: [DONE]\n\n"); res.end(); } catch { /* already closed */ }
        };
        res.on("close", () => { state.releaseSlow = null; });
        return;
      }
      const toolResults = messages.filter((message) => message.role === "tool");
      if (toolResults.length === 0) {
        streamToolCall(res, "call_market", "panel_market_context", {});
        return;
      }
      if (toolResults.length === 1) {
        streamToolCall(res, "call_plan_no_probability", "panel_submit_trade_plan", {
          action: "long",
          entry: 64250,
          takeProfit: 66000,
          stopLoss: 63000,
          basisTimeframe: "5m",
          rationale: "Deliberately invalid: every plan must carry a probability percentage.",
        });
        return;
      }
      if (toolResults.length === 2) {
        streamToolCall(res, "call_plan_no_trade", "panel_submit_trade_plan", {
          action: "no-trade",
          probability: 55,
          basisTimeframe: "5m",
          rationale: "Deliberately invalid: analysis always returns a trade.",
        });
        return;
      }
      if (toolResults.length === 3) {
        streamToolCall(res, "call_plan_bad", "panel_submit_trade_plan", {
          action: "long",
          entry: 64250,
          takeProfit: 66000,
          stopLoss: 65000,
          probability: 60,
          basisTimeframe: "5m",
          rationale: "Deliberately invalid: stop above entry for a long.",
        });
        return;
      }
      if (toolResults.length === 4) {
        streamToolCall(res, "call_plan_good", "panel_submit_trade_plan", {
          action: "long",
          entry: 64250,
          takeProfit: 66000,
          stopLoss: 63000,
          probability: 62,
          basisTimeframe: "5m",
          rationale: "5m reclaimed the EMA ribbon and holds above the range low.",
        });
        return;
      }
      streamText(res, ["Plan submitted."]);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer({ server, state, port: server.address().port }));
  });
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.records = [];
    this.waiters = [];
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        this.records.push(record);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(record)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  waitFor(predicate, timeoutMs = 30_000) {
    const existing = this.records.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        resolveWait(null);
      }, timeoutMs);
      const waiter = { predicate, resolve: resolveWait, timer };
      this.waiters.push(waiter);
    });
  }

  async stop() {
    this.child.stdin.end();
    await new Promise((resolveExit) => {
      this.child.once("exit", resolveExit);
      setTimeout(() => this.child.kill(), 3000);
    });
  }
}

function startPi({ agent, workspace, sessions, sessionId, model, provider = "mock" }) {
  const args = [
    "--mode", "rpc",
    "--provider", provider,
    "--model", model,
    "--thinking", "medium",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-mcp",
    "--no-builtin-tools",
    "--no-approve",
    "--extension", EXTENSION,
    "--tools", "panel_market_context,panel_indicators,panel_portfolio,panel_order_ticket,panel_submit_trade_plan",
    "--system-prompt", SYSTEM_PROMPT,
  ];
  if (sessionId) args.push("--session-dir", sessions, "--session-id", sessionId);
  else args.push("--no-session");
  const env = {
    PATH: process.env.PATH,
    HOME: agent,
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TRADEPANEL_AI_CONTEXT_FILE: join(agent, "context.json"),
  };
  const child = spawn(NODE, [CLI, ...args], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RpcClient(child);
  client.send({ id: "init", type: "get_state" });
  return client;
}

function snapshot() {
  return {
    version: 1,
    capturedAtMs: Date.now(),
    generatedBy: "ai_rpc_smoke",
    instrument: {
      symbol: "BTC/USDT",
      base: "BTC",
      quote: "USDT",
      exchange: "binance",
      market: "spot",
      szDecimals: 5,
      timeframe: "5m",
      chartTimeframe: "5m",
      price: 64250.5,
      change24h: -1.2,
      source: "test",
    },
    analysis: {
      timeframes: ["1d", "4h", "5m"],
      primaryTimeframe: "5m",
      imageOrder: ["1d", "4h", "5m"],
      screenshots: [],
      missing: [],
    },
    indicators: {
      available: ["rsi14", "macd", "ema", "bollinger", "atr14", "volume", "levels"],
      unavailable: [],
      summary: { primaryBias: "up", dailyBias: "up", fourHourBias: "up", alignment: "aligned", rsi14: 58 },
      perTimeframe: {
        "5m": { values: { close: 64250.5, rsi14: 58, ema1: 64100, ema2: 63900, ema3: 63000 }, levels: { high20: 64500, low20: 63500 }, trend: { bias: "up", reasons: [] } },
      },
      levels: { high20: 64500, low20: 63500, high50: 65000, low50: 63000, pivotHighs: [64500], pivotLows: [63500] },
    },
    portfolio: { enabled: false },
    ticket: { readOnly: true, direction: "long", qty: "0.01", risk: "10", limit: "64250", tp: "66000", sl: "63000" },
  };
}

test("bundled Pi runtime: images, read-only tools, plan validation, streaming", { skip, timeout: 120_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "tp-ai-smoke-"));
  const agent = join(base, "agent");
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  for (const dir of [agent, workspace, sessions]) mkdirSync(dir, { recursive: true });
  const { server, state, port } = await startMockProvider();
  try {
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock",
            models: [
              { id: "mock-model", name: "Mock", contextWindow: 32000, maxTokens: 4096, input: ["text", "image"] },
              { id: "slow-model", name: "Slow", contextWindow: 32000, maxTokens: 4096, input: ["text"] },
            ],
          },
        },
      }),
    );
    writeFileSync(join(agent, "context.json"), JSON.stringify(snapshot()));

    const client = startPi({ agent, workspace, sessions, sessionId: "ai-smoke", model: "mock-model" });
    try {
      const stateResponse = await client.waitFor((record) => record.type === "response" && record.command === "get_state");
      assert.equal(stateResponse?.success, true, client.stderr);
      client.send({ id: "p1", type: "prompt", message: "Start analysis.", images: Array.from({ length: 3 }, () => ({ type: "image", data: PNG, mimeType: "image/png" })) });
      const settled = await client.waitFor((record) => record.type === "agent_settled", 90_000);
      assert.ok(settled, client.stderr);
      assert.equal(settled.aborted, false);

      const toolEnds = client.records.filter((record) => record.type === "tool_execution_end");
      const market = toolEnds.find((record) => record.toolName === "panel_market_context");
      const badPlans = toolEnds.filter((record) => record.toolName === "panel_submit_trade_plan" && record.isError);
      const goodPlan = toolEnds.find(
        (record) => record.toolName === "panel_submit_trade_plan" && !record.isError && record.result?.details?.plan,
      );
      assert.ok(market && !market.isError, "market context toolfailed");
      assert.equal(badPlans.length, 3, "missing probability, no-trade and inverted levels must all be rejected");
      assert.ok(goodPlan, "valid plan must be accepted");
      assert.equal(goodPlan.result.details.plan.action, "long");
      assert.equal(goodPlan.result.details.plan.entry, 64250);
      assert.equal(goodPlan.result.details.plan.basisTimeframe, "5m");
      assert.equal(goodPlan.result.details.plan.probability, 62);
      assert.equal(goodPlan.result.details.plan.qty, 0.008);
      assert.ok(goodPlan.result.details.plan.riskReward >= 0.5);
      assert.ok(state.sawImage, "the image attachment never reached the provider");
      assert.equal(state.imageParts, 3, "all three chart snapshots must reach the provider request");
      assert.ok(
        state.requests.some((payload) => JSON.stringify(payload).includes(PNG)),
        "the attached PNG bytes never reached the provider request",
      );

      const text = client.records
        .filter((record) => record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta")
        .map((record) => record.assistantMessageEvent.delta)
        .join("");
      assert.match(text, /Plan submitted/);

      const sessionFiles = readdirSync(sessions, { recursive: true })
        .map(String)
        .filter((name) => name.endsWith("_ai-smoke.jsonl"));
      assert.ok(sessionFiles.length >= 1, "persistent session file missing");
      const sessionText = readFileSync(join(sessions, sessionFiles[0]), "utf8");
      assert.ok(sessionText.includes("panel_submit_trade_plan"));
    } finally {
      await client.stop();
    }
  } finally {
    state.releaseSlow?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(base, { recursive: true, force: true });
  }
});

test("bundled Pi runtime: abort settles the run", { skip, timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "tp-ai-abort-"));
  const agent = join(base, "agent");
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  for (const dir of [agent, workspace, sessions]) mkdirSync(dir, { recursive: true });
  const { server, state, port } = await startMockProvider();
  try {
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "mock",
            models: [{ id: "slow-model", name: "Slow", contextWindow: 32000, maxTokens: 4096, input: ["text"] }],
          },
        },
      }),
    );
    writeFileSync(join(agent, "context.json"), JSON.stringify(snapshot()));
    const client = startPi({ agent, workspace, sessions, sessionId: null, model: "slow-model" });
    try {
      await client.waitFor((record) => record.type === "response" && record.command === "get_state");
      client.send({ id: "p1", type: "prompt", message: "Start analysis." });
      const delta = await client.waitFor(
        (record) => record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta",
        30_000,
      );
      assert.ok(delta, "expected a streaming delta before abort");
      client.send({ id: "a1", type: "abort" });
      const settled = await client.waitFor((record) => record.type === "agent_settled", 30_000);
      assert.ok(settled, client.stderr);
      assert.equal(settled.aborted, true);
    } finally {
      await client.stop();
    }
  } finally {
    state.releaseSlow?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(base, { recursive: true, force: true });
  }
});
