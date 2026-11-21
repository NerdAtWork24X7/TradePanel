import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Analyze chart client's stream handling: the prompt command returns as
 * soon as the run is accepted, so the client must keep reading until
 * `agent_settled` and turn the records into text, steps and the plan.
 *
 * Tauri's `Channel` and the generated `commands` are mocked: this tests the
 * parsing and the settle wait, not the app.
 */

const calls: { channel?: { onmessage: (frame: string) => void } } = {};

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((frame: string) => void) | null = null;
  },
}));

vi.mock("../../bindings", () => ({
  commands: {
    piAnalyze: vi.fn(async (_snapshot: string, _images: string, _message: string, channel: { onmessage: (frame: string) => void }) => {
      calls.channel = channel;
      return { status: "ok", data: null };
    }),
    piAbort: vi.fn(async () => ({ status: "ok", data: null })),
    piNewSession: vi.fn(async () => ({ status: "ok", data: null })),
    piSetSettings: vi.fn(async (_base: string, _model: string, _key: string | null, _prompt: string | null) => ({
      status: "ok",
      data: { state: "stopped", streaming: false, ready: false, configured: true, hasKey: true, baseUrl: _base, model: _model, systemPrompt: _prompt ?? "built-in", hasCustomPrompt: _prompt != null, target: null, runtimeRoot: null, nodeVersion: null, piVersion: null, contextFile: "", error: null },
    })),
    piUpdate: vi.fn(async (_channel: { onmessage: (step: string) => void }) => ({
      status: "ok",
      data: { state: "stopped", streaming: false, ready: false, configured: false, hasKey: false, baseUrl: "", model: "", target: "linux-x64", runtimeRoot: "/rt", nodeVersion: "v22.23.4", piVersion: "1.5.2", contextFile: "", error: null },
    })),
  },
}));

const { analyze, saveAnalystSettings, updatePiRuntime } = await import("../analyst");
const { commands } = await import("../../bindings");

const plan = {
  action: "long",
  entry: 100,
  takeProfit: 103,
  stopLoss: 98,
  probability: 68,
  basisTimeframe: "5m",
  rationale: "5m reclaimed the range high.",
  qty: 50,
  riskReward: 1.5,
  symbol: "BINANCE:BTC/USDT",
  timeframe: "5m",
  lastPrice: 100.5,
  acceptedAtMs: 1,
};

const emit = (record: unknown) => calls.channel?.onmessage(JSON.stringify(record));

beforeEach(() => {
  calls.channel = undefined;
  vi.clearAllMocks();
});

describe("analyze", () => {
  it("waits for agent_settled and returns the text, the steps and the plan", async () => {
    const seen: string[] = [];
    let settled = false;
    const promise = analyze({ version: 1 }, [], "Analyze BTC", {
      onText: (text) => seen.push(text),
      onTool: (tools) => seen.push(tools.map((t) => `${t.name}:${t.state}`).join(",")),
    }).then((run) => {
      settled = true;
      return run;
    });

    // The prompt is accepted while the run is still going: the promise must not settle yet.
    await new Promise((done) => setTimeout(done, 0));
    expect(settled).toBe(false);

    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "panel_market_context", args: {} });
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "panel_market_context", isError: false, result: { details: { ok: true } } });
    emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "panel_submit_trade_plan", args: {} });
    emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "panel_submit_trade_plan", isError: false, result: { details: { plan } } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Long " } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "above 98." } });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Long above 98." }] } });
    expect(settled).toBe(false);
    emit({ type: "agent_settled", aborted: false });

    const run = await promise;
    expect(run.ended).toBe("settled");
    expect(run.text).toBe("Long above 98.");
    expect(run.plan).toMatchObject({ action: "long", entry: 100, takeProfit: 103, stopLoss: 98, probability: 68, qty: 50 });
    expect(run.tools.map((t) => `${t.name}:${t.state}`)).toEqual([
      "panel_market_context:done",
      "panel_submit_trade_plan:done",
    ]);
    expect(seen).toContain("Long ");
    expect(seen).toContain("Long above 98.");
    expect(commands.piAnalyze).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected plan and clears the error once one is accepted", async () => {
    const promise = analyze({ version: 1 }, [], "Analyze BTC");
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "panel_submit_trade_plan", isError: true, result: { content: [{ type: "text", text: "For a long plan, stopLoss < entry < takeProfit is required." }] } });
    emit({ type: "tool_execution_end", toolCallId: "c2", toolName: "panel_submit_trade_plan", isError: false, result: { details: { plan } } });
    emit({ type: "agent_settled", aborted: false });
    const run = await promise;
    expect(run.plan).not.toBeNull();
    expect(run.error).toBeNull();
    expect(run.ended).toBe("settled");
  });

  it("reports the extension's reason when every plan is rejected", async () => {
    const promise = analyze({ version: 1 }, [], "Analyze BTC");
    emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "panel_submit_trade_plan", isError: true, result: { content: [{ type: "text", text: "Risk/reward 0.3 is below 0.5." }] } });
    emit({ type: "agent_settled", aborted: false });
    const run = await promise;
    expect(run.plan).toBeNull();
    expect(run.error).toBe("Risk/reward 0.3 is below 0.5.");
    expect(run.ended).toBe("error");
  });

  it("reports a provider error from the assistant message and an aborted run", async () => {
    const failed = analyze({ version: 1 }, [], "Analyze BTC");
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "The provider answered 404." } });
    emit({ type: "agent_settled", aborted: false });
    const run = await failed;
    expect(run.error).toBe("The provider answered 404.");
    expect(run.ended).toBe("error");

    const aborted = analyze({ version: 1 }, [], "Analyze BTC");
    emit({ type: "assistant-event" });
    emit({ type: "agent_settled", aborted: true });
    const stopped = await aborted;
    expect(stopped.aborted).toBe(true);
    expect(stopped.ended).toBe("settled");
  });

  it("reports a process exit while no answer arrived", async () => {
    const promise = analyze({ version: 1 }, [], "Analyze BTC");
    emit({ type: "process_exit", code: 1, error: "The analysis runtime exited unexpectedly." });
    const run = await promise;
    expect(run.ended).toBe("exit");
    expect(run.error).toBe("The analysis runtime exited unexpectedly.");
  });

  it("streams each update step and returns the refreshed runtime status", async () => {
    const steps: string[] = [];
    vi.mocked(commands.piUpdate).mockImplementationOnce((async (channel: { onmessage: (step: string) => void }) => {
      channel.onmessage("Preparing the update…");
      channel.onmessage("Pi 1.5.2 is ready.");
      return { status: "ok", data: { piVersion: "1.5.2" } } as never;
    }) as never);
    const result = await updatePiRuntime((step) => steps.push(step));
    expect(steps).toEqual(["Preparing the update…", "Pi 1.5.2 is ready."]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.piVersion).toBe("1.5.2");
  });

  it("rejects when the request never started", async () => {
    vi.mocked(commands.piAnalyze).mockResolvedValueOnce({ status: "error", error: "Set the analyst's API key in its settings." } as never);
    await expect(analyze({ version: 1 }, [], "Analyze BTC")).rejects.toThrow("Set the analyst's API key");
  });

  it("forwards a custom prompt, or null to restore the built-in one", async () => {
    const custom = await saveAnalystSettings("https://api.example.com/v1", "m", "sk-1", "Trade only the 5m trigger.");
    expect(custom.status).toBe("ok");
    expect(commands.piSetSettings).toHaveBeenLastCalledWith("https://api.example.com/v1", "m", "sk-1", "Trade only the 5m trigger.");

    await saveAnalystSettings("https://api.example.com/v1", "m", null, null);
    expect(commands.piSetSettings).toHaveBeenLastCalledWith("https://api.example.com/v1", "m", null, null);
  });
});
