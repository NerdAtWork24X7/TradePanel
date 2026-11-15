import { describe, expect, it } from "vitest";
import { atr, biasOf, bollinger, ema, lastEma, macd, rsi, swings, timeframeSummary, volumeStats, type AnalystBar } from "../analyst-indicators";

/** A bar series from closes, with a symmetric high/low and a volume. */
function bars(closes: number[], volumes?: number[]): AnalystBar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      time: 1_700_000_000 + i * 300,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: volumes?.[i] ?? 100,
    };
  });
}

/** The closes of a linear ramp: 1..n. */
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("ema", () => {
  it("starts with the SMA of the first period and then follows the smoothing factor", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2);
    // k = 2 / (3 + 1) = 0.5: 4 * 0.5 + 2 * 0.5 = 3, then 5 * 0.5 + 3 * 0.5 = 4.
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
    expect(lastEma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 10);
  });

  it("has no value before a full period", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
    expect(lastEma([], 5)).toBeNull();
  });
});

describe("rsi", () => {
  it("is 100 for a series that only rises and 0 for one that only falls", () => {
    expect(rsi(ramp(20), 14)).toBe(100);
    expect(rsi(ramp(20).map((v) => 100 - v), 14)).toBe(0);
  });

  it("stays near 50 for an alternating series and needs period + 1 bars", () => {
    const alternating = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const value = rsi(alternating, 14);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(40);
    expect(value!).toBeLessThan(60);
    expect(rsi(ramp(14), 14)).toBeNull();
  });
});

describe("macd", () => {
  it("is positive and above its signal on a rising series", () => {
    const values = ramp(200);
    const m = macd(values);
    expect(m.line).not.toBeNull();
    expect(m.line!).toBeGreaterThan(0);
    expect(m.signal).not.toBeNull();
    // A steady ramp keeps the histogram near zero.
    expect(Math.abs(m.histogram!)).toBeLessThan(0.5);
  });

  it("is null without the warm-up bars and turns negative when the ramp breaks", () => {
    expect(macd(ramp(20))).toEqual({ line: null, signal: null, histogram: null });
    const falling = [...ramp(150), ...Array.from({ length: 40 }, (_, i) => 150 - i)];
    expect(macd(falling).line!).toBeLessThan(0);
  });
});

describe("bollinger", () => {
  it("wraps the mean with 2σ and reports the bandwidth", () => {
    const b = bollinger(Array.from({ length: 20 }, () => 10));
    expect(b.middle).toBe(10);
    expect(b.upper).toBe(10);
    expect(b.lower).toBe(10);
    expect(b.bandwidthPct).toBe(0);

    const wide = bollinger([...ramp(19), 40]);
    expect(wide.middle!).toBeGreaterThan(10);
    expect(wide.upper!).toBeGreaterThan(wide.middle!);
    expect(wide.lower!).toBeLessThan(wide.middle!);
    expect(wide.bandwidthPct!).toBeGreaterThan(0);
  });

  it("is empty without a full window", () => {
    expect(bollinger(ramp(5))).toEqual({ middle: null, upper: null, lower: null, bandwidthPct: null });
  });
});

describe("atr", () => {
  it("averages the true range of a steady series", () => {
    const flat = bars(Array.from({ length: 20 }, () => 100));
    // high = 101, low = 99, previous close = 100 → true range 2.
    expect(atr(flat, 14)).toBeCloseTo(2, 6);
  });

  it("widens with a gap and is null without the warm-up", () => {
    const gap = bars(Array.from({ length: 20 }, () => 100));
    gap[19] = { ...gap[19], high: 130, low: 99, close: 129 };
    expect(atr(gap, 14)!).toBeGreaterThan(2);
    expect(atr(bars([1, 2, 3]), 14)).toBeNull();
  });
});

describe("volumeStats", () => {
  it("compares the last bar with the average", () => {
    const stats = volumeStats(bars(ramp(25), Array.from({ length: 25 }, (_, i) => (i === 24 ? 300 : 100))));
    expect(stats.last).toBe(300);
    expect(stats.average!).toBeCloseTo(110, 6);
    expect(stats.ratio!).toBeCloseTo(300 / 110, 6);
  });

  it("has no ratio without volume", () => {
    const noVolume = bars(ramp(5)).map(({ volume: _ignored, ...bar }) => bar);
    expect(volumeStats(noVolume)).toEqual({ last: 0, average: 0, ratio: null });
    expect(volumeStats([])).toEqual({ last: null, average: null, ratio: null });
  });
});

describe("swings", () => {
  it("finds the pivot high and low of a V shape", () => {
    const values = [10, 11, 12, 11, 10, 9, 8, 9, 10, 11];
    const pivots = swings(bars(values), 20, 2);
    expect(pivots.some((p) => p.kind === "high" && p.price >= 13)).toBe(true);
    expect(pivots.some((p) => p.kind === "low" && p.price <= 7)).toBe(true);
  });

  it("returns nothing for a monotonic series", () => {
    expect(swings(bars(ramp(40)), 40, 2)).toEqual([]);
  });
});

describe("timeframeSummary", () => {
  it("reports the close, the change and each study", () => {
    const summary = timeframeSummary(bars(ramp(220)));
    expect(summary.bars).toBe(220);
    expect(summary.close).toBe(220);
    expect(summary.changePct!).toBeGreaterThan(0);
    expect(summary.ema.ema9!).toBeGreaterThan(summary.ema.ema21!);
    expect(summary.rsi14).toBe(100);
    expect(summary.macd.line!).toBeGreaterThan(0);
    expect(summary.bollinger.middle!).toBeGreaterThan(0);
    expect(summary.atr14!).toBeGreaterThan(0);
    expect(summary.atrPct!).toBeGreaterThan(0);
    expect(summary.volume.average).toBe(100);
  });

  it("degrades to nulls on a short series instead of throwing", () => {
    const summary = timeframeSummary(bars([1, 2]));
    expect(summary.close).toBe(2);
    expect(summary.ema.ema9).toBeNull();
    expect(summary.rsi14).toBeNull();
    expect(summary.macd.line).toBeNull();
    expect(summary.bollinger.middle).toBeNull();
    expect(summary.atr14).toBeNull();
    expect(summary.changePct!).toBeCloseTo(100, 6);
  });

  it("handles an empty series", () => {
    const summary = timeframeSummary([]);
    expect(summary.close).toBeNull();
    expect(summary.changePct).toBeNull();
    expect(summary.volume.last).toBeNull();
  });
});

describe("biasOf", () => {
  const up = timeframeSummary(bars(ramp(220)));
  it("reads a stacked EMA set as the trend it is", () => {
    expect(biasOf(up)).toBe("up");
  });

  it("reads a falling series as down and a flat one as mixed", () => {
    const down = timeframeSummary(bars(ramp(220).map((v) => 300 - v)));
    expect(biasOf(down)).toBe("down");
    const flat = timeframeSummary(bars(Array.from({ length: 220 }, () => 100)));
    expect(biasOf(flat)).toBe("mixed");
  });

  it("says unknown without data", () => {
    expect(biasOf(null)).toBe("unknown");
    expect(biasOf(undefined)).toBe("unknown");
  });
});
