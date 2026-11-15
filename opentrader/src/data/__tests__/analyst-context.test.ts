import { describe, expect, it } from "vitest";
import { buildAnalystSnapshot, structuralLevels, type AnalystBar } from "../analyst-context";

function series(closes: number[], stepSeconds: number, volumes?: number[]): AnalystBar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: 1_760_000_000 + i * stepSeconds,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: volumes?.[i] ?? 100,
    };
  });
}

const ramp = (n: number, from = 100) => Array.from({ length: n }, (_, i) => from + i);

/** A loader that answers by resolution with a fixed ramp per timeframe. */
const loader = (overrides: Partial<Record<string, AnalystBar[]>> = {}, failing: string[] = []) => {
  return async (resolution: string) => {
    if (failing.includes(resolution)) throw new Error("no data");
    return overrides[resolution] ?? series(ramp(resolution === "5" ? 300 : 260), resolution === "5" ? 300 : resolution === "240" ? 14_400 : 86_400);
  };
};

const baseInput = {
  symbol: "BINANCE:BTC/USDT",
  exchange: "BINANCE",
  market: "spot",
  timeframe: "5",
  price: 399,
  studies: [{ title: "RSI", inputs: "14", plots: [{ plot: 0, value: 62.5 }] }],
  portfolio: { enabled: false },
  ticket: { side: "buy", qty: 1, orderType: "limit", risk: 100, limitPrice: 400, takeProfit: 410, stopLoss: 395, editing: null },
};

describe("buildAnalystSnapshot", () => {
  it("reports all three timeframes, their studies and the fixed analysis grid", async () => {
    const snapshot = await buildAnalystSnapshot({ ...baseInput, loadBars: loader(), now: () => 1_763_000_000_000 });
    expect(snapshot.version).toBe(1);
    expect(snapshot.capturedAtMs).toBe(1_763_000_000_000);
    expect(snapshot.generatedBy).toBe("OpenTrader");
    expect(snapshot.analysis.timeframes).toEqual(["1d", "4h", "5m"]);
    expect(snapshot.chart.missing).toEqual([]);
    expect(Object.keys(snapshot.indicators.perTimeframe).sort()).toEqual(["1d", "4h", "5m"]);
    expect(snapshot.indicators.available).toContain("rsi14");
    expect(snapshot.indicators.available).toContain("structural-levels");
    expect(snapshot.instrument.symbol).toBe("BINANCE:BTC/USDT");
    expect(snapshot.instrument.exchange).toBe("BINANCE");
    expect(snapshot.instrument.timeframe).toBe("5");
    expect(snapshot.instrument.price).toBe(399);
    expect(snapshot.chart.studies).toHaveLength(1);
    expect(snapshot.ticket).toMatchObject({ side: "buy", risk: 100, takeProfit: 410 });
    expect(snapshot.analysis.notes[0]).toContain("5m");
  });

  it("reuses the focused chart's bars instead of fetching its timeframe", async () => {
    const asked: string[] = [];
    const chartBars = series(ramp(120, 500), 300);
    await buildAnalystSnapshot({
      ...baseInput,
      chartBars: { interval: "5", bars: chartBars },
      loadBars: async (resolution) => {
        asked.push(resolution);
        return loader()(resolution);
      },
    });
    expect(asked.sort()).toEqual(["1D", "240"]);
  });

  it("keeps going when a timeframe fails and says which one", async () => {
    const snapshot = await buildAnalystSnapshot({ ...baseInput, loadBars: loader({}, ["240"]) });
    expect(snapshot.analysis.timeframes).toEqual(["1d", "5m"]);
    expect(snapshot.chart.missing).toEqual([{ timeframe: "4h", error: "no data" }]);
    expect(snapshot.indicators.summary.alignment).toContain("unknown");
    expect(snapshot.analysis.notes.join(" ")).toContain("4h (no data)");
    expect(snapshot.indicators.unavailable).toContain("4h: no data");
  });

  it("falls back to the last close when no price is given and takes the 5m close first", async () => {
    const snapshot = await buildAnalystSnapshot({ ...baseInput, price: null, loadBars: loader() });
    // The 5m ramp ends at 100 + 299 (high/low offsets do not touch closes).
    expect(snapshot.instrument.price).toBe(399);
    expect(snapshot.indicators.perTimeframe["5m"].close).toBe(399);
  });

  it("refuses a series that is too short and reports the other timeframes", async () => {
    const snapshot = await buildAnalystSnapshot({
      ...baseInput,
      loadBars: loader({ "5": series([100, 101], 300) }),
    });
    expect(snapshot.chart.missing).toEqual([{ timeframe: "5m", error: "not enough bars" }]);
    expect(snapshot.indicators.perTimeframe["5m"]).toBeUndefined();
  });

  it("marks EMA200 unavailable when the history is short", async () => {
    const snapshot = await buildAnalystSnapshot({
      ...baseInput,
      loadBars: loader({ "1D": series(ramp(60), 86_400), "240": series(ramp(60), 14_400), "5": series(ramp(60), 300) }),
    });
    expect(snapshot.indicators.unavailable).toContain("ema200: not enough bars in the fetched history");
    expect(snapshot.indicators.available).not.toContain("ema200");
    expect(snapshot.indicators.available).toContain("rsi14");
  });

  it("passes the portfolio and ticket through unchanged", async () => {
    const portfolio = { enabled: true, position: { side: "buy", qty: 0.5, avgPrice: 390, unrealizedPnl: 12, takeProfit: null, stopLoss: null } };
    const snapshot = await buildAnalystSnapshot({ ...baseInput, portfolio, loadBars: loader() });
    expect(snapshot.portfolio).toEqual(portfolio);
    expect(snapshot.portfolio.enabled).toBe(true);
    expect(snapshot.ticket?.orderType).toBe("limit");
  });

  it("defaults to a disabled portfolio and a null ticket", async () => {
    const snapshot = await buildAnalystSnapshot({ ...baseInput, portfolio: null, ticket: null, loadBars: loader() });
    expect(snapshot.portfolio).toEqual({ enabled: false });
    expect(snapshot.ticket).toBeNull();
  });
});

describe("structuralLevels", () => {
  it("splits swing levels around the price: nearest support and resistance first", () => {
    const five = series([100, 101, 102, 101, 100, 99, 100, 101, 102, 103, 102, 101, 100, 99, 100, 101], 300);
    const levels = structuralLevels({ "5m": five }, 100);
    expect(levels.last).toBe(100);
    for (const level of levels.support) expect(level).toBeLessThan(100);
    for (const level of levels.resistance) expect(level).toBeGreaterThan(100);
    expect(levels.support).toEqual([...levels.support].sort((a, b) => b - a));
    expect(levels.resistance).toEqual([...levels.resistance].sort((a, b) => a - b));
    expect(levels.support.length).toBeLessThanOrEqual(4);
    expect(levels.resistance.length).toBeLessThanOrEqual(4);
  });

  it("computes the prior day's pivot and its first bands", () => {
    const daily = [
      ...series(ramp(10, 100), 86_400),
      // The previous day: high 112, low 98, close 110 → pivot 106.67, r1 115.33, s1 101.33.
      { time: 1_760_900_000, open: 100, high: 112, low: 98, close: 110, volume: 100 },
      { time: 1_760_986_400, open: 110, high: 111, low: 109, close: 110, volume: 100 },
    ];
    const levels = structuralLevels({ "1d": daily }, 110);
    expect(levels.priorDay).toMatchObject({ high: 112, low: 98, close: 110 });
    expect(levels.priorDay!.pivot).toBeCloseTo(106.6667, 3);
    expect(levels.priorDay!.r1).toBeCloseTo(115.3333, 3);
    expect(levels.priorDay!.s1).toBeCloseTo(101.3333, 3);
  });

  it("is empty without bars or a price", () => {
    const levels = structuralLevels({}, null);
    expect(levels).toMatchObject({ last: null, support: [], resistance: [], priorDay: null });
  });

  it("dedupes levels inside a tick-scale tolerance", () => {
    const five = series([100, 100.000001, 100, 100.000001, 100], 300);
    const levels = structuralLevels({ "5m": five }, 50);
    const all = [...levels.support, ...levels.resistance];
    for (let i = 1; i < all.length; i += 1) expect(Math.abs(all[i] - all[i - 1])).toBeGreaterThan(0);
  });
});
