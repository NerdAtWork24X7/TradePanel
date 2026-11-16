import { describe, expect, it } from "vitest";
import { planDrawing, POSITION_BARS } from "../plan-drawing";
import type { NewDrawing } from "lightweight-charts-drawing/core/types";
import type { DrawingStyle } from "lightweight-charts-drawing/core/types";

const plan = {
  symbol: "BINANCE:BTC/USDT",
  action: "long" as const,
  entry: 100,
  takeProfit: 105,
  stopLoss: 98,
  qty: 50,
};

const points = (d: NewDrawing) => (d as unknown as { points: { time: number; price: number }[] }).points;
const style = (d: NewDrawing) => (d as unknown as { style: DrawingStyle }).style;

describe("analyst plan drawing", () => {
  it("draws a long position with the plan's levels and quantity", () => {
    // 00:07:30 UTC on a 5m chart: the entry snaps to the 00:05 bar.
    const lastBarMs = Date.UTC(2024, 0, 1, 0, 7, 30);
    const d = planDrawing(plan, "5", lastBarMs)!;
    expect(d.kind).toBe("long-position");
    const [entry, close] = points(d);
    const entrySec = Date.UTC(2024, 0, 1, 0, 5) / 1000;
    expect(entry).toEqual({ time: entrySec, price: 100 });
    expect(close).toEqual({ time: entrySec + 5 * 60 * POSITION_BARS, price: 100 });
    const s = style(d);
    expect(s.stopLevel).toBe(2);
    expect(s.profitLevel).toBe(5);
    expect(s.riskDisplayMode).toBe("money");
    expect(s.riskAmount).toBe(100);
    expect(s.qtyPrecision).toBe("4");
  });

  it("draws a short position and keeps the order short: takeProfit < entry < stopLoss", () => {
    const d = planDrawing({ ...plan, action: "short", takeProfit: 95, stopLoss: 102 }, "5", Date.UTC(2024, 0, 1, 0, 7, 30))!;
    expect(d.kind).toBe("short-position");
    expect(style(d).stopLevel).toBe(2);
    expect(style(d).profitLevel).toBe(5);
  });

  it("hides the tool's Qty stat when the analysis had no risk-derived quantity", () => {
    const d = planDrawing({ ...plan, qty: null }, "5", Date.UTC(2024, 0, 1, 0, 7, 30))!;
    expect(style(d).positionStats?.qty).toBe(false);
    expect(style(d).riskAmount).toBeUndefined();
  });

  it("refuses levels that are not a long/short trade", () => {
    expect(planDrawing({ ...plan, stopLoss: 101 }, "5", Date.now())).toBeNull();
    expect(planDrawing({ ...plan, action: "short", takeProfit: 105 }, "5", Date.now())).toBeNull();
  });
});
