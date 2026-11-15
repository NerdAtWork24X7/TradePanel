import { describe, expect, it } from "vitest";
import {
  analystStudies,
  buildAnalystSnapshot,
  structuralLevels,
  swings,
  type AnalystBar,
  type AnalystStudyRun,
} from "../analyst-context";

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

/** A study runner that reports the last close of each timeframe (no indicator library in a test). */
const lastClose: AnalystStudyRun = (study, bars) => {
  const close = bars[bars.length - 1]?.close;
  return close == null ? { plots: [] } : { plots: [{ plot: 0, title: study.title, value: close }] };
};

const baseInput = {
  symbol: "BINANCE:BTC/USDT",
  exchange: "BINANCE",
  market: "spot",
  timeframe: "5",
  price: 399,
  studies: [{ id: "rsi", title: "RSI", inputs: "14", inputValues: { length: 14 }, plots: [{ plot: 0, value: 62.5 }] }],
  runStudy: lastClose,
  portfolio: { enabled: false },
  ticket: { side: "buy", qty: 1, orderType: "limit", risk: 100, limitPrice: 400, takeProfit: 410, stopLoss: 395, editing: null },
};

describe("analystStudies", () => {
  it("reports the chart's visible studies with their last finite plot values", () => {
    // The chart shows VWAP; the analysis must report VWAP, not a computed EMA.
    const studies = analystStudies([
      { id: "vwap", title: "VWAP", inputs: "1 close", inputValues: { anchor: "session" }, plots: [{ index: 0, value: 61_234.5 }, { index: 1, value: null }] },
      { id: "ema", title: "EMA", hidden: true, plots: [{ index: 0, value: 61_000 }] },
      { id: "mask", title: "MASK", offInterval: true, plots: [{ index: 0, value: 1 }] },
      { id: "cmp", title: "BTCUSDT", compare: {}, plots: [{ index: 0, value: 2 }] },
      { title: "RSI", plots: [{ index: 0, value: Number.NaN }, { index: 2, value: 55.2 }] },
    ]);
    expect(studies).toEqual([
      { id: "vwap", title: "VWAP", inputs: "1 close", inputValues: { anchor: "session" }, plots: [{ plot: 0, value: 61_234.5 }] },
      { id: "", title: "RSI", plots: [{ plot: 2, value: 55.2 }] },
    ]);
  });

  it("keeps a study without values, and caps the list at 24", () => {
    expect(analystStudies([{ id: "vwap", title: "VWAP" }])).toEqual([{ id: "vwap", title: "VWAP", plots: [] }]);
    expect(analystStudies(Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, plots: [] })))).toHaveLength(24);
  });
});

describe("buildAnalystSnapshot", () => {
  it("reports all three timeframes and the chart's studies on each of them", async () => {
    const snapshot = await buildAnalystSnapshot({ ...baseInput, loadBars: loader(), now: () => 1_763_000_000_000 });
    expect(snapshot.version).toBe(1);
    expect(snapshot.capturedAtMs).toBe(1_763_000_000_000);
    expect(snapshot.generatedBy).toBe("OpenTrader");
    expect(snapshot.analysis.timeframes).toEqual(["1d", "4h", "5m"]);
    expect(snapshot.chart.missing).toEqual([]);
    expect(Object.keys(snapshot.indicators.perTimeframe).sort()).toEqual(["1d", "4h", "5m"]);
    expect(snapshot.indicators.available).toEqual(["RSI"]);
    expect(snapshot.indicators.unavailable).toEqual([]);
    expect(snapshot.indicators.summary.studies).toEqual(["RSI"]);
    // The chart's study, with its chart-interval value, and no raw inputs in the model's copy.
    expect(snapshot.chart.studies).toEqual([{ id: "rsi", title: "RSI", inputs: "14", plots: [{ plot: 0, value: 62.5 }] }]);
    expect(snapshot.indicators.perTimeframe["5m"].studies).toEqual([{ id: "rsi", title: "RSI", plots: [{ plot: 0, title: "RSI", value: 399 }] }]);
    expect(snapshot.instrument.symbol).toBe("BINANCE:BTC/USDT");
    expect(snapshot.instrument.exchange).toBe("BINANCE");
    expect(snapshot.instrument.timeframe).toBe("5");
    expect(snapshot.instrument.price).toBe(399);
    expect(snapshot.ticket).toMatchObject({ side: "buy", risk: 100, takeProfit: 410 });
    expect(snapshot.analysis.notes[0]).toContain("5m");
  });

  it("runs the chart's studies with their own inputs on every timeframe (no fixed set)", async () => {
    const seen: { id: string; inputs: unknown; resolution: string; session: string }[] = [];
    const runStudy: AnalystStudyRun = (study, _bars, resolution, session) => {
      seen.push({ id: study.id, inputs: study.inputValues, resolution, session });
      return { plots: [{ plot: 0, title: study.title, value: 1 }] };
    };
    await buildAnalystSnapshot({ ...baseInput, session: "RTH", runStudy, loadBars: loader() });
    expect(seen.map((s) => s.resolution).sort()).toEqual(["1D", "240", "5"]);
    expect(seen.every((s) => s.id === "rsi" && s.session === "RTH")).toBe(true);
    expect(seen[0].inputs).toEqual({ length: 14 });
  });

  it("reports only the chart's studies, whatever they are", async () => {
    const studies = [
      { id: "vwap", title: "VWAP", inputValues: { anchor: "session" }, plots: [{ plot: 0, value: 100 }] },
      { id: "ema#2", title: "EMA", inputValues: { length: 21 }, plots: [] },
    ];
    const runStudy: AnalystStudyRun = (study) => (study.id === "ema#2" ? { plots: [] } : { plots: [{ plot: 0, title: study.title, value: 1 }] });
    const snapshot = await buildAnalystSnapshot({ ...baseInput, studies, runStudy, loadBars: loader() });
    expect(snapshot.indicators.summary.studies).toEqual(["VWAP", "EMA"]);
    expect(snapshot.indicators.available).toEqual(["VWAP"]);
    expect(snapshot.indicators.unavailable).toEqual(["EMA: 1d: no value; 4h: no value; 5m: no value"]);
    // The chart's own studies only: nothing else is invented.
    expect(Object.keys(snapshot.indicators.perTimeframe["5m"].studies[0])).toEqual(["id", "title", "plots"]);
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
    expect(snapshot.indicators.available).toEqual([]);
    expect(snapshot.indicators.unavailable).toEqual(["RSI: 4h: no data"]);
    expect(snapshot.analysis.notes.join(" ")).toContain("4h (no data)");
  });

  it("says why a study did not compute on a timeframe", async () => {
    const runStudy: AnalystStudyRun = (study, _bars, resolution) =>
      resolution === "240" ? { plots: [], error: "no volume in these bars" } : { plots: [{ plot: 0, title: study.title, value: 1 }] };
    const snapshot = await buildAnalystSnapshot({ ...baseInput, runStudy, loadBars: loader() });
    expect(snapshot.indicators.available).toEqual([]);
    expect(snapshot.indicators.unavailable).toEqual(["RSI: 4h: no volume in these bars"]);
    expect(snapshot.indicators.perTimeframe["4h"].studies).toEqual([{ id: "rsi", title: "RSI", plots: [], error: "no volume in these bars" }]);
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

  it("survives a runner that throws", async () => {
    const runStudy: AnalystStudyRun = () => {
      throw new Error("study exploded");
    };
    const snapshot = await buildAnalystSnapshot({ ...baseInput, runStudy, loadBars: loader() });
    expect(snapshot.indicators.available).toEqual([]);
    expect(snapshot.indicators.unavailable).toEqual(["RSI: 1d: study exploded; 4h: study exploded; 5m: study exploded"]);
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

describe("swings", () => {
  it("finds the pivot high and low of a V shape", () => {
    const pivots = swings(series([10, 11, 12, 11, 10, 9, 8, 9, 10, 11], 300), 20, 2);
    expect(pivots.some((p) => p.kind === "high" && p.price >= 13)).toBe(true);
    expect(pivots.some((p) => p.kind === "low" && p.price <= 7)).toBe(true);
  });

  it("returns nothing for a monotonic series", () => {
    expect(swings(series(ramp(40), 300), 40, 2)).toEqual([]);
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
