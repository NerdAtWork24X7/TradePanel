/*
 * The read-only snapshot handed to the Pi analysis extension.
 *
 * Shape (version 1) — the extension validates levels against `instrument.price`
 * and reads exactly these fields:
 *
 *   instrument  symbol, exchange, market, timeframe, price
 *   chart       the focused chart's title, interval and visible studies
 *   analysis    the timeframes that produced numbers, the ones that failed
 *   indicators  the chart's studies recomputed for each timeframe + levels
 *   portfolio   the optional position/balance context
 *   ticket      the order ticket's unsent values (read-only)
 *
 * The three analysis timeframes are fixed (1d/4h/5m), like the reference
 * runtime: the higher timeframes give the bias, the 5-minute chart the trigger.
 * The focused chart's own bars are reused when its interval is one of them.
 *
 * There is NO fixed indicator set: the studies the user's chart shows (their
 * ids and inputs, read from that chart) are recomputed on every analysis
 * timeframe through the app's study engine (`runStudy`, injected), so the
 * numbers the model reads are the user's own studies on 1d, 4h and 5m.
 */
import { getBars } from "./datafeed";
import { parseInterval } from "./interval";
import type { SessionId } from "./session";

export type AnalystBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

/** A study active on the focused chart, as the analyst reads it: what to run (its id and inputs) and
 *  its values at the chart's own interval (its legend row). */
export type AnalystStudyInput = {
  /** The study instance id ("rsi", "rsi#2", "user:abc", "strategy:key"). */
  id: string;
  title: string;
  /** The inputs as the chart's legend shows them (display). */
  inputs?: string;
  /** The study's inputs (defaults + the user's changes), to recompute it on the analysis timeframes. */
  inputValues?: Record<string, unknown>;
  /** Its last plot values at the chart's own interval, from the chart's legend. */
  plots: { plot: number; value: number }[];
};

/** One legend row of the focused chart, as `ChartExportSource.studies()` reports it. */
export type AnalystStudyRow = {
  id?: string;
  title: string;
  hidden?: boolean;
  offInterval?: boolean;
  compare?: unknown;
  inputs?: string;
  inputValues?: Record<string, unknown>;
  plots?: { index: number; value: number | null }[];
};

/** The studies the analyst reports for the focused chart: its visible ones, each with its last plot
 *  values. Read from that chart (`studies()`), never from the symbol-keyed registry: two charts of
 *  the same symbol there are one entry, so a reader could name another chart's study (VWAP vs EMA). */
export function analystStudies(rows: readonly AnalystStudyRow[]): AnalystStudyInput[] {
  return rows
    .filter((row) => !row.hidden && !row.offInterval && !row.compare)
    .slice(0, 24)
    .map((row) => ({
      id: row.id ?? "",
      title: row.title,
      ...(row.inputs ? { inputs: row.inputs } : {}),
      ...(row.inputValues ? { inputValues: row.inputValues } : {}),
      plots: (row.plots ?? [])
        .filter((plot) => plot.value != null && Number.isFinite(plot.value))
        .map((plot) => ({ plot: plot.index, value: Number(plot.value) })),
    }));
}

/** A study as the snapshot reports it to the model: its values are already values, not inputs. */
export type AnalystStudy = { id: string; title: string; inputs?: string; plots: { plot: number; value: number }[] };

/** One study's values on one timeframe: the last finite value of each of its plots, or why it has none. */
export type StudyValue = { plots: { plot: number; title: string; value: number }[]; error?: string };

/** Runs one of the chart's studies on one timeframe's bars. The app injects the study engine
 *  (`alert-studies.runStudy`); a test injects its own, so the snapshot is computed without a chart. */
export type AnalystStudyRun = (
  study: AnalystStudyInput,
  bars: readonly AnalystBar[],
  resolution: string,
  session: SessionId,
) => StudyValue | Promise<StudyValue>;

/** One timeframe's numbers: its bars' shape and the chart's studies recomputed on it. */
export type TimeframeStudies = {
  bars: number;
  close: number | null;
  changePct: number | null;
  studies: { id: string; title: string; plots: { plot: number; title: string; value: number }[]; error?: string }[];
};

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
    /** The chart's studies computed on every analysis timeframe (their titles). */
    available: string[];
    /** The chart's studies that did not compute on some timeframe, and why. */
    unavailable: string[];
    summary: { studies: string[]; note: string };
    perTimeframe: Record<string, TimeframeStudies>;
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
  /** The chart's session ("RTH" / "ETH"): the bars and the studies are read the way the chart shows them. */
  session?: SessionId;
  /** Latest traded price, when known. */
  price: number | null;
  /** The studies the focused chart shows, in chart order. */
  studies: AnalystStudyInput[];
  /** How to compute one of them on a timeframe's bars (the app: the study engine). */
  runStudy: AnalystStudyRun;
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

/** The chart's studies recomputed on one timeframe's bars, in chart order, each with its own error. */
async function studiesOn(input: AnalystSnapshotInput, bars: readonly AnalystBar[], resolution: string, session: SessionId): Promise<TimeframeStudies["studies"]> {
  const out: TimeframeStudies["studies"] = [];
  for (const study of input.studies) {
    try {
      const value = await input.runStudy(study, bars, resolution, session);
      out.push({ id: study.id, title: study.title, plots: value.plots, ...(value.error ? { error: value.error } : {}) });
    } catch (error) {
      out.push({ id: study.id, title: study.title, plots: [], error: message(error) });
    }
  }
  return out;
}

/** A timeframe's close and its change over the last 100 bars (context, not an indicator). */
function priceShape(bars: readonly AnalystBar[]): { close: number | null; changePct: number | null } {
  const closes = bars.map((b) => b.close).filter((v) => Number.isFinite(v));
  const close = closes.length ? closes[closes.length - 1] : null;
  const window = closes.slice(-100);
  const changePct = window.length > 1 && window[0] !== 0 ? ((window[window.length - 1] - window[0]) / window[0]) * 100 : null;
  return { close, changePct };
}

export async function buildAnalystSnapshot(input: AnalystSnapshotInput): Promise<AnalystSnapshot> {
  const session = input.session ?? "ETH";
  const loader = input.loadBars ?? ((resolution: string) => getBars(input.symbol, resolution, session).then((r) => r.bars as AnalystBar[]));
  const chartLabel = labelFor(input.timeframe);
  const perTimeframe: Record<string, TimeframeStudies> = {};
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
        perTimeframe[label] = { bars: bars.length, ...priceShape(bars), studies: await studiesOn(input, bars, resolution, session) };
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

  // Which of the chart's studies computed on every timeframe, and why the others did not.
  const on = (label: string, id: string) => perTimeframe[label]?.studies.find((s) => s.id === id);
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const study of input.studies) {
    const computed = TIMEFRAMES.every((t) => (on(t.label, study.id)?.plots.length ?? 0) > 0);
    if (computed) {
      if (!available.includes(study.title)) available.push(study.title);
      continue;
    }
    const why = TIMEFRAMES.flatMap((t) => {
      const value = on(t.label, study.id);
      if (value && !value.error && value.plots.length) return [];
      if (!value) return [`${t.label}: ${missing.find((m) => m.timeframe === t.label)?.error ?? "no bars"}`];
      return [`${t.label}: ${value.error ?? "no value"}`];
    }).join("; ");
    unavailable.push(`${study.title}: ${why}`);
  }

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
      studies: input.studies.map(({ id, title, inputs, plots }) => ({ id, title, ...(inputs ? { inputs } : {}), plots })),
      timeframes,
      missing,
    },
    analysis: {
      timeframes,
      chartTimeframe: titleInterval,
      notes: [
        `Computed by OpenTrader from ${timeframes.join(", ")} candles with the studies the user's chart shows (${
          input.studies.map((s) => s.title).join(", ") || "none"
        }); the attached image is the focused chart (${titleInterval}).`,
        ...(missing.length ? [`Unavailable: ${missing.map((m) => `${m.timeframe} (${m.error})`).join("; ")}.`] : []),
      ],
    },
    indicators: {
      available,
      unavailable,
      summary: {
        studies: [...new Set(input.studies.map((s) => s.title))],
        note: "These are the studies the user's chart shows, recomputed by OpenTrader on each timeframe; there is no fixed indicator set.",
      },
      perTimeframe,
      levels,
    },
    portfolio: input.portfolio ?? { enabled: false },
    ticket: input.ticket,
  };
}

/** A pivot high / low with `strength` bars on each side. */
export type Swing = { price: number; time: number; kind: "high" | "low" };

/** Swing pivots of the last `lookback` bars (2 bars each side), newest last. */
export function swings(bars: readonly AnalystBar[], lookback = 120, strength = 2): Swing[] {
  const slice = bars.slice(-lookback);
  const out: Swing[] = [];
  for (let i = strength; i < slice.length - strength; i += 1) {
    const bar = slice[i];
    let high = true;
    let low = true;
    for (let j = 1; j <= strength; j += 1) {
      if (slice[i - j].high >= bar.high || slice[i + j].high > bar.high) high = false;
      if (slice[i - j].low <= bar.low || slice[i + j].low < bar.low) low = false;
    }
    if (high) out.push({ price: bar.high, time: bar.time, kind: "high" });
    if (low) out.push({ price: bar.low, time: bar.time, kind: "low" });
  }
  return out;
}

/** A price rounded to a sane number of decimals (10 significant figures). */
export function crisp(value: number): number {
  return Number(value.toPrecision(10));
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
