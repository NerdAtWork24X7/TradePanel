/*
 * The indicator values the AI analyst reads for each timeframe.
 *
 * They are computed from the bars the app already fetched, with the standard
 * definitions (Wilder's RSI/ATR, an SMA-seeded EMA, MACD 12/26/9, a 20-period
 * 2σ Bollinger band), so the numbers the model quotes match what a chart of
 * the same study would show closely enough for a plan. This is deliberately a
 * small, dependency-free set: the extension validates the model's levels
 * against the snapshot price, and these values are context, not signals.
 *
 * Pure functions over arrays: tested in `__tests__/analyst-indicators.test.ts`.
 */

export type AnalystBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };

/** An SMA-seeded EMA; `null` until the first full period. */
export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function lastEma(values: readonly number[], period: number): number | null {
  const series = ema(values, period);
  return series.length ? series[series.length - 1] : null;
}

/** Wilder's RSI of the last close (0–100), or null without enough bars. */
export function rsi(values: readonly number[], period = 14): number | null {
  if (period < 1 || values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export type Macd = { line: number | null; signal: number | null; histogram: number | null };

/** MACD (12/26/9 by default): the latest line, signal and histogram. */
export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  if (values.length < slow + signalPeriod) return { line: null, signal: null, histogram: null };
  const fastSeries = ema(values, fast);
  const slowSeries = ema(values, slow);
  const line: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (f != null && s != null) line.push(f - s);
  }
  if (!line.length) return { line: null, signal: null, histogram: null };
  const lastLine = line[line.length - 1];
  const signal = lastEma(line, signalPeriod);
  return {
    line: lastLine,
    signal,
    histogram: signal == null ? null : lastLine - signal,
  };
}

export type Bollinger = {
  middle: number | null;
  upper: number | null;
  lower: number | null;
  /** (upper − lower) / middle as a percentage: how wide the band is. */
  bandwidthPct: number | null;
};

/** Bollinger Bands of the last close (20 periods, 2 standard deviations). */
export function bollinger(values: readonly number[], period = 20, mult = 2): Bollinger {
  if (values.length < period) return { middle: null, upper: null, lower: null, bandwidthPct: null };
  const window = values.slice(-period);
  const middle = window.reduce((sum, v) => sum + v, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  const upper = middle + mult * deviation;
  const lower = middle - mult * deviation;
  return {
    middle,
    upper,
    lower,
    bandwidthPct: middle === 0 ? null : ((upper - lower) / middle) * 100,
  };
}

/** Wilder's ATR of the last bar, or null without enough bars. */
export function atr(bars: readonly AnalystBar[], period = 14): number | null {
  if (period < 1 || bars.length < period + 1) return null;
  const ranges: number[] = [bars[0].high - bars[0].low];
  for (let i = 1; i < bars.length; i += 1) {
    const previous = bars[i - 1].close;
    ranges.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - previous), Math.abs(bars[i].low - previous)));
  }
  let value = ranges.slice(1, period + 1).reduce((sum, r) => sum + r, 0) / period;
  for (let i = period + 1; i < ranges.length; i += 1) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

export type VolumeStats = { last: number | null; average: number | null; ratio: number | null };

export function volumeStats(bars: readonly AnalystBar[], period = 20): VolumeStats {
  const volumes = bars.map((b) => (typeof b.volume === "number" && Number.isFinite(b.volume) ? b.volume : 0));
  if (!volumes.length) return { last: null, average: null, ratio: null };
  const window = volumes.slice(-period);
  const average = window.reduce((sum, v) => sum + v, 0) / window.length;
  const last = volumes[volumes.length - 1];
  return { last, average, ratio: average > 0 ? last / average : null };
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

export type TimeframeSummary = {
  bars: number;
  close: number | null;
  changePct: number | null;
  ema: { ema9: number | null; ema21: number | null; ema50: number | null; ema200: number | null };
  rsi14: number | null;
  macd: Macd;
  bollinger: Bollinger;
  atr14: number | null;
  atrPct: number | null;
  volume: VolumeStats;
};

/** Everything the snapshot reports for one timeframe. */
export function timeframeSummary(bars: readonly AnalystBar[]): TimeframeSummary {
  const closes = bars.map((b) => b.close).filter((v) => Number.isFinite(v));
  const close = closes.length ? closes[closes.length - 1] : null;
  const window = closes.slice(-100);
  const changePct = window.length > 1 && window[0] !== 0 ? ((window[window.length - 1] - window[0]) / window[0]) * 100 : null;
  const atr14 = atr(bars, 14);
  return {
    bars: bars.length,
    close,
    changePct,
    ema: {
      ema9: lastEma(closes, 9),
      ema21: lastEma(closes, 21),
      ema50: lastEma(closes, 50),
      ema200: lastEma(closes, 200),
    },
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    bollinger: bollinger(closes),
    atr14,
    atrPct: atr14 != null && close ? (atr14 / close) * 100 : null,
    volume: volumeStats(bars),
  };
}

/** "up" when price and the 21/50 EMAs stack that way, else "down" / "mixed". */
export function biasOf(summary: TimeframeSummary | undefined | null): "up" | "down" | "mixed" | "unknown" {
  if (!summary) return "unknown";
  const { close, ema } = summary;
  if (close != null && ema.ema21 != null && ema.ema50 != null) {
    if (close > ema.ema21 && ema.ema21 > ema.ema50) return "up";
    if (close < ema.ema21 && ema.ema21 < ema.ema50) return "down";
  }
  if (close != null && ema.ema21 != null && close !== ema.ema21) return close > ema.ema21 ? "up" : "down";
  return "mixed";
}

/** A price rounded to a sane number of decimals (10 significant figures). */
export function crisp(value: number): number {
  return Number(value.toPrecision(10));
}
