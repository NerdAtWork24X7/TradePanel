/*
 * The analyst plan as a long / short position drawing (the chart's own
 * risk/reward tool): entry at the latest bar, a ten-bar box forward, the plan's
 * stop / target distances as the tool's levels, and the plan's quantity in the
 * tool's Qty readout.
 */
import { defaultStyleFor } from "lightweight-charts-drawing/core/specs";
import type { NewDrawing } from "lightweight-charts-drawing/core/types";
import { intervalSeconds } from "../../data/interval";
import type { AnalystTradeDrawingPlan } from "../../data/analyst-trade-drawing";

/** Bars the position box runs forward from the entry (the default right margin). */
export const POSITION_BARS = 10;

export function planDrawing(plan: AnalystTradeDrawingPlan, interval: string, lastBarMs: number = Date.now()): NewDrawing | null {
  const ordered =
    plan.action === "long"
      ? plan.stopLoss < plan.entry && plan.entry < plan.takeProfit
      : plan.takeProfit < plan.entry && plan.entry < plan.stopLoss;
  const stop = Math.abs(plan.entry - plan.stopLoss);
  const profit = Math.abs(plan.takeProfit - plan.entry);
  if (!ordered || !Number.isFinite(plan.entry) || !(stop > 0) || !(profit > 0)) return null;

  const seconds = intervalSeconds(interval) ?? 300;
  const ms = Number.isFinite(lastBarMs) ? lastBarMs : Date.now();
  const entryTime = Math.floor(ms / 1000 / seconds) * seconds;
  const riskAmount = plan.qty != null && Number.isFinite(plan.qty) && plan.qty > 0 ? plan.qty * stop : null;
  const kind = plan.action === "long" ? "long-position" : "short-position";
  const style = {
    ...defaultStyleFor(kind),
    stopLevel: stop,
    profitLevel: profit,
    // The tool derives Qty from account × risk: feed the plan's qty, or hide
    // the stat when the analysis had no risk setting to derive one.
    ...(riskAmount != null
      ? { riskDisplayMode: "money" as const, riskAmount, accountSize: Math.max(1000, riskAmount), qtyPrecision: "4", leverage: 1_000_000_000 }
      : { positionStats: { qty: false } }),
  };
  return {
    kind,
    points: [
      { time: entryTime, price: plan.entry },
      { time: entryTime + seconds * POSITION_BARS, price: plan.entry },
    ],
    style,
  } as unknown as NewDrawing;
}
