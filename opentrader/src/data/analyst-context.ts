/*
 * The read-only snapshot handed to the Pi analysis extension.
 *
 * Shape (version 1) — the extension validates levels against `instrument.price`
 * and reads exactly these fields:
 *
 *   instrument  symbol, exchange, market, timeframe, price
 *   chart       the focused chart's title, interval and visible studies
 *   analysis    the timeframes that produced numbers, the ones that failed
 *   indicators  per-timeframe EMA/RSI/MACD/Bollinger/ATR/volume + levels
 *   portfolio   the optional position/balance context
 *   ticket      the order ticket's unsent values (read-only)
 *
 * The three analysis timeframes are fixed (1d/4h/5m), like the reference
 * runtime: the higher timeframes give the bias, the 5-minute chart the trigger.
 * The focused chart's own bars are reused when its interval is one of them.
 */
import { getBars } from "./datafeed";
import { parseInterval } from "./interval";
import { biasOf, crisp, swings, timeframeSummary, type AnalystBar, type TimeframeSummary } from "./analyst-indicators";

export type { AnalystBar };

export type AnalystStudy = { title: string; inputs?: string; plots: { plot: number; value: number }[] };

export type AnalystPortfolio = {
  enabled: boolean;
  position?: {
    side: string;
    qty: number | null;
    avgPrice: number | null;
    unrealizedPnl: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
  } | null;
  openOrders?: {
    side: string;
    type: string;
    qty: number | null;
    limitPrice: number | null;
    stopPrice: number | null;
    takeProfit: number | null;
    stopLoss: number | null;
  }[];
  balance?: { currency: string | null; balance: number | null; equity: number | null; unrealizedPnl: number | null; isDemo: boolean } | null;
};

export type AnalystTicket = {
  side?: string;
  qty?: number | null;
  orderType?: string;
  risk?: number | null;
  limitPrice?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  editing?: string | null;
};

export type AnalystSnapshot = {
  version: 1;
  capturedAtMs: number;
  generatedBy: "OpenTrader";
  instrument: { symbol: string; exchange?: string; market?: string; timeframe: string; price: number | null };
  chart: {
    title: string;
    interval: string;
    studies: AnalystStudy[];
    timeframes: string[];
    missing: { timeframe: string; error: string }[];
  };
  analysis: { timeframes: string[]; chartTimeframe: string; notes: string[] };
  indicators: {
    available: string[];
    unavailable: string[];
    summary: { bias: string; alignment: string; momentum: string; note: string };
    perTimeframe: Record<string, TimeframeSummary>;
    levels: ReturnType<typeof structuralLevels>;
  };
  portfolio: AnalystPortfolio;
  ticket: AnalystTicket | null;
};

export type AnalystSnapshotInput = {
  /** Full chart symbol ("BINANCE:BTC/USDT"). */
  symbol: string;
  exchange?: string;
  market?: string;
  /** The focused chart's interval id ("5", "4H", "1D"). */
  timeframe: string;
  /** Latest traded price, when known. */
  price: number | null;
  studies: AnalystStudy[];
  portfolio: AnalystPortfolio | null;
  ticket: AnalystTicket | null;
  /** The focused chart's loaded bars, for its own interval. */
  chartBars?: { interval: string; bars: AnalystBar[] };
  /** Fetch another resolution; defaults to the app datafeed. */
  loadBars?: (resolution: string) => Promise<AnalystBar[]>;
  now?: () => number;
};

/**
 * The fixed analysis grid: [datafeed resolution, snapshot label, seconds].
 * The datafeed speaks minute counts ("240" = 4h) and daily ids ("1D"); the
 * chart's display ids ("4H") are only labels, and `getBars("4H")` is rejected.
 */
const TIMEFRAMES: { resolution: string; label: string; seconds: number }[] = [
  { resolution: "1D", label: "1d", seconds: 86_400 },
  { resolution: "240", label: "4h", seconds: 14_400 },
  { resolution: "5", label: "5m", seconds: 300 },
];

/** The label of an interval id ("5", "4H", "240", "1D"), or null. */
function labelFor(interval: string): string | null {
  const parsed = parseInterval(interval);
  if (!parsed) return null;
  const seconds = parsed.count * (parsed.unit === "hour" ? 3600 : parsed.unit === "day" ? 86_400 : parsed.unit === "minute" ? 60 : parsed.unit === "second" ? 1 : 0);
  const match = TIMEFRAMES.find((t) => t.seconds === seconds);
  return match?.label ?? null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function buildAnalystSnapshot(input: AnalystSnapshotInput): Promise<AnalystSnapshot> {
  const loader = input.loadBars ?? ((resolution: string) => getBars(input.symbol, resolution).then((r) => r.bars as AnalystBar[]));
  const chartLabel = labelFor(input.timeframe);
  const perTimeframe: Record<string, TimeframeSummary> = {};
  const barsByLabel: Record<string, AnalystBar[]> = {};
  const missing: { timeframe: string; error: string }[] = [];

  await Promise.all(
    TIMEFRAMES.map(async ({ resolution, label }) => {
      try {
        const bars =
          chartLabel === label && input.chartBars?.bars.length
            ? input.chartBars.bars
            : ((await loader(resolution)) as AnalystBar[]);
        if (!bars || bars.length < 3) throw new Error("not enough bars");
        perTimeframe[label] = timeframeSummary(bars);
        barsByLabel[label] = bars;
      } catch (error) {
        missing.push({ timeframe: label, error: message(error) });
      }
    }),
  );
  missing.sort((a, b) => TIMEFRAMES.findIndex((t) => t.label === a.timeframe) - TIMEFRAMES.findIndex((t) => t.label === b.timeframe));

  const timeframes = TIMEFRAMES.map((t) => t.label).filter((label) => perTimeframe[label]);
  const lastClose = perTimeframe["5m"]?.close ?? perTimeframe["4h"]?.close ?? perTimeframe["1d"]?.close ?? null;
  const price = input.price ?? lastClose;
  const levels = structuralLevels(barsByLabel, price);
  const bias = { "1d": biasOf(perTimeframe["1d"]), "4h": biasOf(perTimeframe["4h"]), "5m": biasOf(perTimeframe["5m"]) };
  const alignment =
    bias["1d"] === "up" && bias["4h"] === "up"
      ? "bullish (1d and 4h up)"
      : bias["1d"] === "down" && bias["4h"] === "down"
        ? "bearish (1d and 4h down)"
        : bias["1d"] === "unknown" || bias["4h"] === "unknown"
          ? "unknown (missing higher-timeframe data)"
          : "conflicting (1d and 4h disagree)";
  const five = perTimeframe["5m"];
  const momentum =
    five?.rsi14 == null
      ? "unknown"
      : `${five.rsi14.toFixed(1)} RSI on 5m, MACD histogram ${five.macd.histogram == null ? "unavailable" : five.macd.histogram >= 0 ? "positive" : "negative"}`;

  const available: string[] = [];
  const unavailable: string[] = [...missing.map((m) => `${m.timeframe}: ${m.error}`)];
  const summaries = Object.values(perTimeframe);
  const has = (test: (s: TimeframeSummary) => boolean) => summaries.some(test);
  if (has((s) => s.ema.ema9 != null)) available.push("ema9");
  if (has((s) => s.ema.ema21 != null)) available.push("ema21");
  if (has((s) => s.ema.ema50 != null)) available.push("ema50");
  if (has((s) => s.ema.ema200 != null)) available.push("ema200");
  else unavailable.push("ema200: not enough bars in the fetched history");
  if (has((s) => s.rsi14 != null)) available.push("rsi14");
  else unavailable.push("rsi14: not enough bars in the fetched history");
  if (has((s) => s.macd.line != null)) available.push("macd");
  else unavailable.push("macd: not enough bars in the fetched history");
  if (has((s) => s.bollinger.middle != null)) available.push("bollinger");
  else unavailable.push("bollinger: not enough bars in the fetched history");
  if (has((s) => s.atr14 != null)) available.push("atr14");
  else unavailable.push("atr14: not enough bars in the fetched history");
  if (has((s) => s.volume.average != null)) available.push("volume");
  if (levels.support.length || levels.resistance.length) available.push("structural-levels");

  const titleInterval = input.timeframe;
  return {
    version: 1,
    capturedAtMs: (input.now ?? Date.now)(),
    generatedBy: "OpenTrader",
    instrument: {
      symbol: input.symbol,
      ...(input.exchange ? { exchange: input.exchange } : {}),
      ...(input.market ? { market: input.market } : {}),
      timeframe: titleInterval,
      price: price == null ? null : crisp(price),
    },
    chart: {
      title: `${input.symbol}, ${titleInterval}`,
      interval: titleInterval,
      studies: input.studies.slice(0, 24),
      timeframes,
      missing,
    },
    analysis: {
      timeframes,
      chartTimeframe: titleInterval,
      notes: [
        `Computed by OpenTrader from ${timeframes.join(", ")} candles; the attached image is the focused chart (${titleInterval}).`,
        ...(missing.length ? [`Unavailable: ${missing.map((m) => `${m.timeframe} (${m.error})`).join("; ")}.`] : []),
      ],
    },
    indicators: {
      available,
      unavailable,
      summary: {
        bias: `1d ${bias["1d"]}, 4h ${bias["4h"]}, 5m ${bias["5m"]}`,
        alignment,
        momentum,
        note: "Indicator values are computed from the loaded bars; they are context for the visual read, not a signal by themselves.",
      },
      perTimeframe,
      levels,
    },
    portfolio: input.portfolio ?? { enabled: false },
    ticket: input.ticket,
  };
}

/** Swing pivots, per-timeframe extremes and the previous day's pivot levels,
 *  split around the last price (nearest support / resistance first). */
export function structuralLevels(barsByLabel: Record<string, AnalystBar[]>, price: number | null) {
  const tail = (label: string) => {
    const bars = barsByLabel[label];
    return bars && bars.length ? bars[bars.length - 1].close : null;
  };
  const last = price ?? tail("5m") ?? tail("4h") ?? null;
  const support: number[] = [];
  const resistance: number[] = [];
  const extremes: Record<string, { high: number | null; low: number | null }> = {};

  const add = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    if (last == null) return;
    if (value < last) support.push(value);
    else if (value > last) resistance.push(value);
  };

  for (const [label, bars] of Object.entries(barsByLabel)) {
    if (!bars.length) continue;
    const lookback = label === "1d" ? 90 : 120;
    const window = bars.slice(-lookback);
    const high = Math.max(...window.map((b) => b.high));
    const low = Math.min(...window.map((b) => b.low));
    extremes[label] = { high: crisp(high), low: crisp(low) };
    add(high);
    add(low);
    const pivots = swings(bars, lookback, 2);
    pivots
      .filter((p) => p.kind === "high")
      .slice(-3)
      .forEach((p) => add(p.price));
    pivots
      .filter((p) => p.kind === "low")
      .slice(-3)
      .forEach((p) => add(p.price));
  }

  const daily = barsByLabel["1d"];
  let priorDay: { high: number; low: number; close: number; pivot: number; r1: number; s1: number } | null = null;
  if (daily && daily.length >= 2) {
    const bar = daily[daily.length - 2];
    const pivot = (bar.high + bar.low + bar.close) / 3;
    priorDay = {
      high: crisp(bar.high),
      low: crisp(bar.low),
      close: crisp(bar.close),
      pivot: crisp(pivot),
      r1: crisp(2 * pivot - bar.low),
      s1: crisp(2 * pivot - bar.high),
    };
    add(priorDay.r1);
    add(priorDay.s1);
    add(priorDay.high);
    add(priorDay.low);
  }

  const tolerance = last == null ? 0 : Math.max(Math.abs(last) * 1e-4, 1e-9);
  const tidy = (values: number[]) => {
    const unique: number[] = [];
    for (const value of values.map(crisp)) {
      if (!unique.some((seen) => Math.abs(seen - value) <= tolerance)) unique.push(value);
    }
    return unique;
  };
  return {
    last: last == null ? null : crisp(last),
    support: tidy(support).sort((a, b) => b - a).slice(0, 4),
    resistance: tidy(resistance).sort((a, b) => a - b).slice(0, 4),
    priorDay,
    timeframes: extremes,
  };
}
