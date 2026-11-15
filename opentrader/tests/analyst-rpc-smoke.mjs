#!/usr/bin/env node
/**
 * End-to-end check of the Analyze chart runtime (Pi coding agent, RPC mode).
 *
 *   npm run test:ai
 *
 * It starts a mock OpenAI-compatible provider, then runs the staged runtime
 * exactly as `src-tauri/src/pi/spawn.rs` and `manager.rs` do — cleared
 * environment, the analysis extension, the five `panel_*` tools, the bundled
 * prompt, an isolated HOME and a version-1 context snapshot — and asserts the
 * whole round trip:
 *
 *   1. the prompt is accepted with an image attachment,
 *   2. the model's first plan is rejected (levels out of order) and Pi feeds
 *      the tool error back,
 *   3. the corrected plan arrives validated, with the quantity derived from
 *      the ticket's RISK,
 *   4. only the declared tools exist (a `bash` tool call is blocked),
 *   5. `agent_settled` closes the run.
 *
 * The staged runtime is a build artifact, so the check skips (exit 0) when it
 * has not been staged yet: `npm run ai:runtime`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RUNTIME_ROOT = join(ROOT, "src-tauri", "ai-runtime");
const TARGET = { linux: "linux", darwin: "darwin", win32: "win" }[process.platform] + "-" + { x64: "x64", arm64: "arm64" }[process.arch];
const TOOL_ALLOWLIST = "panel_market_context,panel_indicators,panel_portfolio,panel_order_ticket,panel_submit_trade_plan";

const manifestPath = join(RUNTIME_ROOT, TARGET, "manifest.json");
if (!existsSync(manifestPath)) {
  console.log(`[test:ai] no staged runtime for ${TARGET}; run \`npm run ai:runtime\` first — skipping.`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const runtime = join(RUNTIME_ROOT, TARGET);
const files = {
  node: join(runtime, manifest.node),
  cli: join(runtime, manifest.piCli),
  extension: join(runtime, manifest.extension),
  prompt: join(runtime, manifest.systemPrompt),
};
for (const [name, path] of Object.entries(files)) {
  if (!existsSync(path)) throw new Error(`the staged runtime is incomplete: ${name} (${path})`);
}

// ── The mock provider ───────────────────────────────────────────────────────
const PROMPT_LOGS = [];
const sse = (res, record) => res.write(`data: ${JSON.stringify(record)}\n\n`);
const chunk = (payload) => ({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: Date.now(), model: payload.model || "mock" });
const toolCall = (res, payload, id, name, args) => {
  const base = chunk(payload);
  sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (part) => (body += part));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* a stray request: answer with an empty stream */
    }
    const messages = payload.messages ?? [];
    const tools = messages.filter((m) => m.role === "tool");
    PROMPT_LOGS.push({
      model: payload.model,
      toolResults: tools.length,
      images: JSON.stringify(messages).includes("image_url") || JSON.stringify(messages).includes('"image"'),
      toolNames: messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function?.name)).filter(Boolean),
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (tools.length === 0) return toolCall(res, payload, "c1", "panel_market_context", {});
    if (tools.length === 1) return toolCall(res, payload, "c2", "panel_indicators", {});
    if (tools.length === 2) {
      // Levels out of order for a long: the extension must refuse it.
      return toolCall(res, payload, "c3", "panel_submit_trade_plan", {
        action: "long",
        entry: 100,
        takeProfit: 96,
        stopLoss: 104,
        probability: 55,
        basisTimeframe: "5m",
        rationale: "deliberately inconsistent",
      });
    }
    if (tools.length === 3) {
      return toolCall(res, payload, "c4", "panel_submit_trade_plan", {
        action: "long",
        entry: 100,
        takeProfit: 103,
        stopLoss: 98,
        probability: 68,
        basisTimeframe: "5m",
        rationale: "5m reclaimed the prior range high above the 1d and 4h uptrend.",
      });
    }
    // A tool that the host did not declare: the extension must block it.
    if (tools.length === 4) return toolCall(res, payload, "c5", "bash", { command: "rm -rf /" });
    if (tools.length === 5) {
      const base = chunk(payload);
      for (const piece of ["Long while the 5m structure holds above 98."]) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const base = chunk(payload);
    sse(res, { ...base, choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] });
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();

// ── Host furniture (what the Rust manager writes) ───────────────────────────
const home = mkdtempSync(join(tmpdir(), "opentrader-ai-smoke-"));
const agent = join(home, "agent");
const sessions = join(home, "sessions");
const workspace = join(home, "workspace");
const contextFile = join(home, "context.json");
for (const dir of [agent, sessions, workspace]) mkdirSync(dir, { recursive: true });

writeFileSync(
  join(agent, "models.json"),
  JSON.stringify({
    providers: {
      tradepanel: {
        name: "TradePanel provider",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "$TRADEPANEL_API_KEY",
        authHeader: true,
        models: [
          {
            id: "mock-model",
            name: "mock-model",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);

const snapshot = {
  version: 1,
  capturedAtMs: Date.now(),
  generatedBy: "OpenTrader",
  instrument: { symbol: "BINANCE:BTC/USDT", exchange: "BINANCE", market: "spot", timeframe: "5", price: 100.5 },
  chart: { title: "BINANCE:BTC/USDT, 5", interval: "5", studies: [{ title: "RSI", inputs: "14", plots: [{ plot: 0, value: 55.2 }] }], timeframes: ["1d", "4h", "5m"], missing: [] },
  analysis: { timeframes: ["1d", "4h", "5m"], chartTimeframe: "5", notes: ["Computed by OpenTrader from 1d, 4h, 5m candles."] },
  indicators: {
    available: ["ema9", "ema21", "rsi14", "macd", "bollinger", "atr14", "volume"],
    unavailable: [],
    summary: { bias: "1d up, 4h up, 5m up", alignment: "bullish (1d and 4h up)", momentum: "55.2 RSI on 5m", note: "context" },
    perTimeframe: { "5m": { close: 100.5, rsi14: 55.2 } },
    levels: { last: 100.5, support: [98.0], resistance: [103.0], priorDay: null, timeframes: {} },
  },
  portfolio: { enabled: false },
  ticket: { side: "buy", qty: null, orderType: "limit", risk: 100, limitPrice: 100, takeProfit: 103, stopLoss: 98, editing: null },
};
writeFileSync(contextFile, JSON.stringify(snapshot));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ── The child, launched as the host launches it ─────────────────────────────
const args = [
  files.cli,
  "--mode", "rpc",
  "--provider", "tradepanel",
  "--model", "mock-model",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-extensions",
  "--no-mcp",
  "--no-builtin-tools",
  "--no-approve",
  "--extension", files.extension,
  "--tools", TOOL_ALLOWLIST,
  "--system-prompt", files.prompt,
  "--no-session",
];
const child = spawn(files.node, args, {
  cwd: workspace,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TRADEPANEL_AI_CONTEXT_FILE: contextFile,
    TRADEPANEL_API_KEY: "smoke-key",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const events = [];
const plans = [];
const toolResults = [];
let text = "";
let stderr = "";
let buffer = Buffer.alloc(0);
let settled = false;
const responses = new Map();

child.stderr.on("data", (part) => (stderr += part));
child.stdout.on("data", (part) => {
  buffer = Buffer.concat([buffer, part]);
  for (;;) {
    const index = buffer.indexOf(10);
    if (index < 0) break;
    const line = buffer.subarray(0, index).toString("utf8");
    buffer = buffer.subarray(index + 1);
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(record.type);
    if (record.type === "response" && record.id) responses.set(record.id, record.success !== false ? record.data : { error: record.error });
    if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") text += record.assistantMessageEvent.delta;
    if (record.type === "tool_execution_end") {
      toolResults.push({
        name: record.toolName,
        isError: record.isError === true,
        details: record.result?.details ?? null,
        text: (record.result?.content ?? []).map((block) => block.text ?? "").join("\n"),
      });
      const plan = record.result?.details?.plan;
      if (plan) plans.push(plan);
    }
    if (record.type === "agent_settled") settled = true;
  }
});

const fail = (message) => {
  console.error(`[test:ai] FAIL ${message}`);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  server.close();
  process.exit(1);
};

const waitFor = async (test, what, timeoutMs = 45_000) => {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeoutMs) fail(`timed out waiting for ${what}; stderr: ${stderr.slice(-600)}`);
    await new Promise((done) => setTimeout(done, 50));
  }
};

// The host waits for `get_state` before prompting: the runtime is ready when
// the provider catalogue, the extension and the model are.
child.stdin.write(JSON.stringify({ id: "s1", type: "get_state" }) + "\n");
await waitFor(() => responses.has("s1"), "the runtime to answer get_state", 60_000);
child.stdin.write(
  JSON.stringify({
    id: "p1",
    type: "prompt",
    message: "Analyze BINANCE:BTC/USDT on the 5m chart. The three attached images are its 1d, 4h and 5m charts.",
    images: [
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
  }) + "\n",
);

await waitFor(() => settled, "agent_settled");

// ── Assertions ──────────────────────────────────────────────────────────────
const calls = toolResults.map((r) => r.name);
const expect = (condition, message) => {
  if (!condition) fail(message);
};
expect(events.includes("agent_start"), "no agent_start event");
expect(calls[0] === "panel_market_context", `first tool was ${calls[0]}`);
expect(calls[1] === "panel_indicators", `second tool was ${calls[1]}`);
expect(toolResults[2]?.name === "panel_submit_trade_plan" && toolResults[2].isError, "the inconsistent plan was not rejected");
expect(plans.length === 1, `expected one accepted plan, got ${plans.length}`);
const plan = plans[0] ?? {};
expect(plan.action === "long" && plan.entry === 100 && plan.takeProfit === 103 && plan.stopLoss === 98, `plan levels wrong: ${JSON.stringify(plan)}`);
expect(plan.probability === 68, `probability wrong: ${plan.probability}`);
expect(plan.riskReward === 1.5, `risk/reward wrong: ${plan.riskReward}`);
// qty = risk / |entry - stop| = 100 / 2, rounded to the instrument's szDecimals (absent → 4).
expect(plan.qty === 50, `quantity not derived from the ticket risk: ${plan.qty}`);
expect(toolResults.some((r) => r.name === "bash" && r.isError), "an undeclared tool was not blocked");
// The numeric block carries the chart's own visible studies as well as the fixed set.
const indicators = toolResults.find((r) => r.name === "panel_indicators")?.text ?? "";
expect(indicators.includes('"chartStudies"'), "panel_indicators did not report the chart's studies");
expect(indicators.includes("RSI"), "the chart's study values did not reach the tool output");
expect(indicators.includes('"perTimeframe"'), "panel_indicators did not report the per-timeframe values");
expect(PROMPT_LOGS[0]?.images === true, "the chart images never reached the provider");
expect(PROMPT_LOGS.every((log) => log.model === "mock-model"), "the provider model was not used");
expect(text.includes("Long while the 5m structure holds"), `the final text did not stream: ${text}`);
// Pi may warn on stderr; only its exit code and the documented records matter.
void stderr;

child.stdin.end();
await new Promise((done) => {
  const timer = setTimeout(() => fail("the runtime did not exit after stdin closed"), 15_000);
  child.on("exit", () => {
    clearTimeout(timer);
    done();
  });
});
server.close();
console.log(
  `[test:ai] ok — ${events.length} events, tools ${calls.join(" → ")}, plan ${plan.action} ${plan.entry}/${plan.takeProfit}/${plan.stopLoss} @ ${plan.probability}% (qty ${plan.qty}, R:R ${plan.riskReward})`,
);
process.exit(0);
