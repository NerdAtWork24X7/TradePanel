/*
 * The Analyze chart client: one read-only Pi run per request (Rust: src-tauri/src/pi).
 *
 * The window sends a versioned context snapshot, the rendered chart as data
 * URLs, and the prompt. Rust supervises the bundled Pi process; its output
 * arrives here as JSON records, which this module turns into the pieces the
 * panel renders: streamed text, tool steps, the validated trade plan and the
 * error the run ended with.
 *
 * The provider key never passes through here: Rust reads it from the OS
 * credential store.
 */
import { Channel } from "@tauri-apps/api/core";
import { commands, type PiStatus } from "../bindings";

/** The plan `panel_submit_trade_plan` returned (validated by the extension). */
export type AnalystPlan = {
  action: "long" | "short";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  probability: number;
  basisTimeframe: string;
  rationale: string;
  qty: number | null;
  riskReward: number;
  symbol: string | null;
  timeframe: string | null;
  lastPrice: number | null;
  acceptedAtMs: number;
};

/** One tool the model called, as the panel lists it. */
export type ToolStep = { id: string; name: string; state: "running" | "done" | "failed" };

export type AnalystRun = {
  text: string;
  plan: AnalystPlan | null;
  tools: ToolStep[];
  /** The run ended because Stop was pressed. */
  aborted: boolean;
  /** How the run ended: the settled record, a process exit, or a provider error. */
  ended: "settled" | "exit" | "error";
  error: string | null;
};

export type AnalystHandlers = {
  /** The answer so far, each time a block of it arrives. */
  onText?: (text: string) => void;
  onTool?: (tools: ToolStep[]) => void;
  onPlan?: (plan: AnalystPlan) => void;
};

let sequence = 0;
let current: number | null = null;

/** The runtime's view of itself: versions, target, readiness and the last error. */
export async function loadRuntimeStatus(): Promise<PiStatus | null> {
  try {
    return await commands.piStatus();
  } catch (e) {
    console.warn("[analyst] status", e);
    return null;
  }
}

export type AnalystResult = { status: "ok"; data: PiStatus } | { status: "error"; error: string };

/** Install the newest Pi in the user's runtime overlay; progress arrives on `onStep`. */
export async function updatePiRuntime(onStep: (step: string) => void): Promise<AnalystResult> {
  try {
    const channel = new Channel<string>();
    channel.onmessage = (step) => onStep(step);
    const r = await commands.piUpdate(channel);
    if (r.status === "error") return { status: "error", error: r.error };
    return { status: "ok", data: r.data };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Save the provider and the system prompt. `apiKey` (when given) replaces the
 * stored key; a null `systemPrompt` restores the runtime's built-in prompt.
 */
export async function saveAnalystSettings(
  baseUrl: string,
  model: string,
  apiKey: string | null,
  systemPrompt: string | null,
): Promise<AnalystResult> {
  try {
    const r = await commands.piSetSettings(baseUrl, model, apiKey?.trim() ? apiKey : null, systemPrompt);
    if (r.status === "error") return { status: "error", error: r.error };
    return { status: "ok", data: r.data };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function clearAnalystKey(): Promise<AnalystResult> {
  try {
    const r = await commands.piClearKey();
    if (r.status === "error") return { status: "error", error: r.error };
    return { status: "ok", data: r.data };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Start a new conversation: the next run gets a fresh Pi session. */
export function newAnalystSession(): void {
  void commands.piNewSession();
}

const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The text of a tool result (the extension's tool errors explain themselves). */
function toolText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string; text?: string }).type === "text" ? ((block as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** A validated plan object, or null when it lacks the levels the card needs. */
export function asAnalystPlan(value: unknown): AnalystPlan | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const action = p.action;
  if (action !== "long" && action !== "short") return null;
  const entry = asNumber(p.entry);
  const takeProfit = asNumber(p.takeProfit);
  const stopLoss = asNumber(p.stopLoss);
  if (entry == null || takeProfit == null || stopLoss == null) return null;
  return {
    action,
    entry,
    takeProfit,
    stopLoss,
    probability: asNumber(p.probability) ?? 0,
    basisTimeframe: typeof p.basisTimeframe === "string" ? p.basisTimeframe : "",
    rationale: typeof p.rationale === "string" ? p.rationale : "",
    qty: asNumber(p.qty),
    riskReward: asNumber(p.riskReward) ?? 0,
    symbol: typeof p.symbol === "string" ? p.symbol : null,
    timeframe: typeof p.timeframe === "string" ? p.timeframe : null,
    lastPrice: asNumber(p.lastPrice),
    acceptedAtMs: asNumber(p.acceptedAtMs) ?? 0,
  };
}

/** A `panel_submit_trade_plan` result, or null when the record carries none. */
function planOf(details: unknown): AnalystPlan | null {
  if (!details || typeof details !== "object") return null;
  return asAnalystPlan((details as { plan?: unknown }).plan);
}

/**
 * One analysis. Events stream into `handlers`; the promise resolves with the
 * final run — it rejects only when the request never started (no runtime, no
 * provider key, an already running analysis).
 */
export async function analyze(
  snapshot: unknown,
  images: string[],
  message: string,
  handlers: AnalystHandlers = {},
): Promise<AnalystRun> {
  const run: AnalystRun = { text: "", plan: null, tools: [], aborted: false, ended: "settled", error: null };
  const request = ++sequence;
  current = request;
  const channel = new Channel<string>();
  const tools = new Map<string, ToolStep>();
  const publish = () => handlers.onTool?.(run.tools.map((t) => ({ ...t })));
  // The command returns once the prompt is accepted; the run itself ends at
  // `agent_settled` (or a process exit). Without this wait the caller would
  // read an empty answer the moment the prompt starts.
  let settled = false;
  let settle: (value: AnalystRun) => void = () => {};
  const done = new Promise<AnalystRun>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    settle(run);
  };

  channel.onmessage = (frame) => {
    let value: { type?: string; [key: string]: unknown };
    try {
      value = JSON.parse(frame) as typeof value;
    } catch {
      return;
    }
    switch (value.type) {
      case "message_update": {
        const update = value.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (!update) return;
        if (update.type === "text_delta" && update.delta) {
          run.text += update.delta;
          handlers.onText?.(run.text);
        }
        return;
      }
      case "tool_execution_start": {
        const id = String(value.toolCallId ?? "");
        tools.set(id, { id, name: String(value.toolName ?? ""), state: "running" });
        run.tools = [...tools.values()];
        publish();
        return;
      }
      case "tool_execution_end": {
        const id = String(value.toolCallId ?? "");
        const existing = tools.get(id);
        const step: ToolStep = { id, name: String(value.toolName ?? existing?.name ?? ""), state: value.isError ? "failed" : "done" };
        tools.set(id, step);
        run.tools = [...tools.values()];
        publish();
        const result = value.result as { details?: unknown } | undefined;
        const plan = planOf(result?.details);
        if (plan) {
          run.plan = plan;
          run.error = null;
          handlers.onPlan?.(plan);
        } else if (value.isError && step.name === "panel_submit_trade_plan") {
          // A rejected card: keep the extension's reason for the panel.
          run.error = toolText(value.result) || "The trade plan was rejected.";
        }
        return;
      }
      case "message_end": {
        const message = value.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (message?.role !== "assistant") return;
        if (message.stopReason === "error" && message.errorMessage) {
          run.ended = "error";
          run.error = message.errorMessage;
        }
        if (message.stopReason === "aborted") run.aborted = true;
        return;
      }
      case "agent_settled": {
        if (value.aborted === true) run.aborted = true;
        run.ended = run.error ? "error" : "settled";
        finish();
        return;
      }
      case "process_exit": {
        run.ended = "exit";
        run.error = typeof value.error === "string" ? value.error : run.error ?? "The analysis runtime exited.";
        finish();
        return;
      }
      default:
        return;
    }
  };

  try {
    const r = await commands.piAnalyze(JSON.stringify(snapshot), JSON.stringify(images), message, channel);
    if (r.status === "error") throw new Error(r.error);
    return await done;
  } finally {
    if (current === request) current = null;
    // A provider failure arrives inside the stream: the run resolves, its error
    // is reported, and the text received so far stays available.
    if (settled && run.ended === "settled" && run.error) run.ended = "error";
  }
}

/** Stop the run under way; the text received so far stays. */
export function stopAnalysis(): void {
  current = null;
  void commands.piAbort();
}
