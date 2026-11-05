/**
 * TradePanel read-only analysis tools for the Pi coding agent.
 *
 * This extension is the entire tool surface of the analysis agent. It never
 * writes files, never spawns commands, and never opens a network connection:
 * every tool reads the single context snapshot that the Tauri host writes
 * before a prompt is submitted. Chart images travel separately as prompt
 * attachments. The snapshot path is supplied by the host via
 * TRADEPANEL_AI_CONTEXT_FILE and is never taken from model-controlled input.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Type } from "typebox";

const CONTEXT_FILE = process.env.TRADEPANEL_AI_CONTEXT_FILE || "";
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const TOOL_NAMES = new Set([
  "panel_market_context",
  "panel_indicators",
  "panel_portfolio",
  "panel_order_ticket",
  "panel_submit_trade_plan",
]);

/** Context older than this is flagged as stale for the active timeframe. */
function staleAfterMs(timeframe) {
  switch (timeframe) {
    case "1d":
    case "1w":
    case "1M":
      return 60 * 60 * 1000;
    case "4h":
    case "6h":
    case "12h":
      return 30 * 60 * 1000;
    case "1h":
    case "2h":
      return 10 * 60 * 1000;
    default:
      return 3 * 60 * 1000;
  }
}

async function readSnapshot() {
  if (!CONTEXT_FILE || !isAbsolute(CONTEXT_FILE)) {
    throw new Error(
      "TradePanel context is not configured. The desktop host must set TRADEPANEL_AI_CONTEXT_FILE.",
    );
  }
  let text;
  try {
    text = await readFile(CONTEXT_FILE, "utf8");
  } catch (error) {
    throw new Error(
      `TradePanel context snapshot is unavailable (${error && error.code ? error.code : "read failed"}). Ask the user to run Start analysis again.`,
    );
  }
  if (text.length > MAX_SNAPSHOT_BYTES) {
    throw new Error("TradePanel context snapshot is unexpectedly large; refusing to read it.");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error("TradePanel context snapshot is not valid JSON.");
  }
  if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 1) {
    throw new Error("TradePanel context snapshot has an unsupported shape.");
  }
  return snapshot;
}

function freshness(snapshot) {
  const captured = Number(snapshot.capturedAtMs);
  const timeframe = snapshot.instrument && snapshot.instrument.timeframe;
  if (!Number.isFinite(captured) || captured <= 0) {
    return {
      ageMs: null,
      stale: true,
      note: "Snapshot timestamp is missing; treat all values as provisional.",
    };
  }
  const age = Math.max(0, Date.now() - captured);
  const stale = age > staleAfterMs(timeframe);
  return {
    ageMs: age,
    stale,
    note: stale
      ? `Snapshot is ${Math.round(age / 1000)}s old (stale for ${timeframe || "this"} timeframe); ask the user to run Start analysis again before relying on levels.`
      : `Snapshot is ${Math.round(age / 1000)}s old.`,
  };
}

function ok(text, details) {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function json(value) {
  return JSON.stringify(value);
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Quantity implied by the user's RISK setting for this plan. Mirrors the
 * backend `trading.calc_qty` rounding, so the card and the ticket agree.
 */
function planQty(snapshot, entry, stopLoss) {
  const risk = Number(snapshot.ticket && snapshot.ticket.risk);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const sz = Number(snapshot.instrument && snapshot.instrument.szDecimals);
  const digits = Number.isInteger(sz) ? Math.min(Math.max(sz, 0), 8) : 4;
  const distance = Math.abs(entry - stopLoss);
  if (!(distance > 0)) return null;
  const qty = round(risk / distance, digits);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

/**
 * Validate a proposed plan against the current snapshot and return it in a
 * shape the UI can render directly. Throwing makes Pi correct the plan instead
 * of silently accepting nonsense.
 */
function validatePlan(snapshot, params) {
  const action = params.action;
  if (action !== "long" && action !== "short") {
    throw new Error("action must be 'long' or 'short': TradePanel analysis always returns a trade.");
  }
  const probability = Number(params.probability);
  if (!Number.isFinite(probability) || probability < 1 || probability > 99) {
    throw new Error("probability is required and must be a percentage between 1 and 99.");
  }
  const probabilityOut = Math.round(probability);
  const rationale = String(params.rationale || "").trim().slice(0, 1200);
  if (!rationale) throw new Error("rationale is required.");
  const instrument = snapshot.instrument || {};
  const timeframes = Array.isArray(snapshot.analysis && snapshot.analysis.timeframes)
    ? snapshot.analysis.timeframes
    : [];
  const fiveMinuteBasis = timeframes.includes("5m");
  let basisTimeframe = String(params.basisTimeframe || "").trim().slice(0, 12);
  if (fiveMinuteBasis) {
    if (basisTimeframe && basisTimeframe !== "5m") {
      throw new Error("basisTimeframe must be '5m': TradePanel trade cards are 5-minute execution plans.");
    }
    basisTimeframe = "5m";
  } else if (!basisTimeframe) {
    basisTimeframe = String(instrument.timeframe || "");
  }

  const numbers = [params.entry, params.takeProfit, params.stopLoss].map(Number);
  if (!numbers.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("entry, takeProfit and stopLoss must be positive finite numbers.");
  }
  const [entry, takeProfit, stopLoss] = numbers;
  if (action === "long") {
    if (!(stopLoss < entry && entry < takeProfit)) {
      throw new Error("For a long plan, stopLoss < entry < takeProfit is required.");
    }
  } else if (!(takeProfit < entry && entry < stopLoss)) {
    throw new Error("For a short plan, takeProfit < entry < stopLoss is required.");
  }
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  const riskReward = round(reward / risk, 3);
  if (!Number.isFinite(riskReward) || riskReward < 0.5) {
    throw new Error(
      `Risk/reward ${riskReward} is below 0.5. Widen the target, move the stop closer to structure, or take the other side.`,
    );
  }
  const last = Number(instrument.price);
  if (Number.isFinite(last) && last > 0) {
    for (const [label, value] of [["entry", entry], ["takeProfit", takeProfit], ["stopLoss", stopLoss]]) {
      if (Math.abs(value - last) / last > 0.6) {
        throw new Error(`${label} is more than 60% away from the snapshot price (${last}). Re-check the levels.`);
      }
    }
    if (Math.abs(entry - last) / last > 0.25) {
      throw new Error(
        `entry is more than 25% away from the snapshot price (${last}). Use levels anchored to the supplied charts.`,
      );
    }
  }
  const entryOut = round(entry);
  const takeProfitOut = round(takeProfit);
  const stopLossOut = round(stopLoss);
  return {
    action,
    probability: probabilityOut,
    basisTimeframe,
    rationale,
    entry: entryOut,
    takeProfit: takeProfitOut,
    stopLoss: stopLossOut,
    qty: planQty(snapshot, entryOut, stopLossOut),
    riskReward,
    symbol: instrument.symbol ?? null,
    timeframe: instrument.timeframe ?? null,
    lastPrice: Number.isFinite(last) ? last : null,
    acceptedAtMs: Date.now(),
  };
}

export default function tradepanelAnalysis(pi) {
  // Defence in depth: refuse any tool this extension did not define, even if
  // the host configuration is ever changed by mistake.
  pi.on("tool_call", async (event) => {
    if (!TOOL_NAMES.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not available in TradePanel analysis mode (read-only).`,
      };
    }
    return undefined;
  });

  pi.registerTool({
    name: "panel_market_context",
    label: "TradePanel market context",
    description:
      "Return the user's current TradePanel view: instrument, exchange, market, timeframe, last price, 24h change/volume, data freshness, per-timeframe indicator values, computed levels, portfolio availability and a read-only order-ticket summary. Call this before making any market claim. The attached chart images are the visual source for structure.",
    promptSnippet: "Read the current TradePanel instrument snapshot (always call before analysis)",
    promptGuidelines: [
      "Call panel_market_context before any statement about the instrument, price, trend, indicators, portfolio, or order ticket.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      const snapshot = await readSnapshot();
      const fresh = freshness(snapshot);
      const out = {
        source: "TradePanel snapshot (read-only)",
        capturedAtMs: snapshot.capturedAtMs,
        freshness: fresh,
        instrument: snapshot.instrument,
        analysis: snapshot.analysis ?? null,
        indicatorSummary: snapshot.indicators ? snapshot.indicators.summary : null,
        perTimeframe: snapshot.indicators ? snapshot.indicators.perTimeframe : null,
        indicatorsAvailable: snapshot.indicators ? snapshot.indicators.available : [],
        indicatorsUnavailable: snapshot.indicators ? snapshot.indicators.unavailable : [],
        levels: snapshot.indicators ? snapshot.indicators.levels : null,
        portfolio: snapshot.portfolio
          ? snapshot.portfolio.enabled
            ? {
                enabled: true,
                position: snapshot.portfolio.position,
                openOrders: snapshot.portfolio.openOrders,
                balance: snapshot.portfolio.balance ?? null,
              }
            : { enabled: false, note: "Portfolio context is disabled by the user." }
          : null,
        orderTicket: snapshot.ticket ?? null,
      };
      return ok(json(out), { ok: true });
    },
  });

  pi.registerTool({
    name: "panel_indicators",
    label: "TradePanel indicators",
    description:
      "Return every indicator value TradePanel computed for the 1d/4h/5m screenshots: RSI, MACD, EMA ribbon, Bollinger Bands, ATR, volume statistics and structural levels, plus which indicators could not be computed. Values are factual tool output, not model estimates.",
    promptSnippet: "Read the indicator values computed by TradePanel for each timeframe",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      const snapshot = await readSnapshot();
      const indicators = snapshot.indicators || {};
      return ok(
        json({
          source: "TradePanel snapshot (read-only)",
          capturedAtMs: snapshot.capturedAtMs,
          freshness: freshness(snapshot),
          timeframes: snapshot.analysis ? snapshot.analysis.timeframes : [],
          available: indicators.available ?? [],
          unavailable: indicators.unavailable ?? [],
          summary: indicators.summary ?? null,
          perTimeframe: indicators.perTimeframe ?? {},
          levels: indicators.levels ?? {},
        }),
        { available: indicators.available ?? [] },
      );
    },
  });

  pi.registerTool({
    name: "panel_portfolio",
    label: "TradePanel portfolio",
    description:
      "Return the user's position, exposure and unrealised P&L for the selected instrument when portfolio context is enabled. Returns an explicit disabled notice otherwise. Balance is only present when the trading backend exposes it.",
    promptSnippet: "Read the user's position and P&L (only when portfolio context is enabled)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      const snapshot = await readSnapshot();
      const portfolio = snapshot.portfolio;
      if (!portfolio || !portfolio.enabled) {
        return ok(
          json({
            enabled: false,
            note: "Portfolio context is disabled. The user can enable it in the AI Analysis header. Do not infer positions from the order ticket.",
          }),
          { enabled: false },
        );
      }
      return ok(
        json({
          source: "TradePanel snapshot (read-only)",
          enabled: true,
          capturedAtMs: snapshot.capturedAtMs,
          position: portfolio.position ?? null,
          openOrders: portfolio.openOrders ?? [],
          balance: portfolio.balance ?? null,
          balanceNote: portfolio.balance ? null : "Account balance is not exposed by the trading backend.",
          freshness: freshness(snapshot),
        }),
        { enabled: true },
      );
    },
  });

  pi.registerTool({
    name: "panel_order_ticket",
    label: "TradePanel order ticket",
    description:
      "Return the values currently typed into the TradePanel order ticket in read-only mode: direction, quantity, risk, limit, take-profit and stop-loss. You can explain and evaluate these values but cannot change or submit anything.",
    promptSnippet: "Read the current order ticket fields (read-only)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      const snapshot = await readSnapshot();
      return ok(
        json({
          source: "TradePanel snapshot (read-only)",
          mode: "read-only",
          capturedAtMs: snapshot.capturedAtMs,
          ticket: snapshot.ticket ?? null,
          note: "These are unsent form values. Nothing here has been submitted to an exchange.",
        }),
        { readOnly: true },
      );
    },
  });

  pi.registerTool({
    name: "panel_submit_trade_plan",
    label: "Submit trade plan",
    description:
      "Submit the final actionable 5-minute plan for this analysis. Call exactly once. The host validates the levels against the snapshot, derives quantity from the user's RISK setting, and rejects inconsistent plans. This does not place an order; it only returns a trade card to the user.",
    promptSnippet: "Submit the final 5m long/short trade with entry, take-profit, stop-loss and probability",
    promptGuidelines: [
      "For every Start analysis request, call panel_submit_trade_plan exactly once at the end with a coherent 5m long or short plan. Never return no-trade: choose the better-evidenced side and reflect weak evidence in a lower probability.",
      "Set basisTimeframe to '5m' and take entry, takeProfit and stopLoss from the 5m chart.",
      "Always pass probability as an integer percentage (1–99): the estimated chance that takeProfit is reached before stopLoss.",
      "panel_submit_trade_plan levels must follow long: stopLoss < entry < takeProfit, short: takeProfit < entry < stopLoss, and risk/reward of at least 0.5.",
      "Do not pass a quantity; the host derives it from the user's RISK setting.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("long"), Type.Literal("short")], {
        description: "Trade direction. Analysis always returns a trade.",
      }),
      entry: Type.Optional(Type.Number({ description: "Entry / buy price for the plan." })),
      takeProfit: Type.Optional(Type.Number({ description: "Take-profit price." })),
      stopLoss: Type.Optional(Type.Number({ description: "Stop-loss price." })),
      probability: Type.Integer({
        minimum: 1,
        maximum: 99,
        description:
          "Estimated chance (integer percentage) that takeProfit is reached before stopLoss, based on timeframe alignment and the 5m trigger.",
      }),
      basisTimeframe: Type.Optional(
        Type.String({ description: "Timeframe that anchors the setup, e.g. 4h." }),
      ),
      rationale: Type.String({
        description: "One or two sentences tying the plan and its probability to the supplied charts.",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      const snapshot = await readSnapshot();
      const plan = validatePlan(snapshot, params);
      return ok(
        `${plan.action.toUpperCase()} 5m plan accepted (${plan.probability}% probability): entry ${plan.entry}, take-profit ${plan.takeProfit}, stop-loss ${plan.stopLoss}, qty ${plan.qty ?? "—"}, R:R ${plan.riskReward}.`,
        { plan },
      );
    },
  });
}
