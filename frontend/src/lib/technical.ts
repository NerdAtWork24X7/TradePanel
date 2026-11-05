/**
 * Deterministic technical analysis used by the AI snapshot renderer and the
 * analysis context. Pure functions, no DOM, no network. Every value returned
 * here is computed from the supplied candles; nothing is estimated.
 */
import type { Candle } from "../types";

export interface EmaConfig {
  length1: number;
  length2: number;
  length3: number;
  maType: "ema" | "sma";
}

export const DEFAULT_EMA_CONFIG: EmaConfig = {
  length1: 20,
  length2: 50,
  length3: 200,
  maType: "ema",
};

export interface MacdValue {
  line: number;
  signal: number;
  histogram: number;
}

export interface BollingerValue {
  upper: number;
  middle: number;
  lower: number;
  bandwidthPct: number;
}

export interface IndicatorValues {
  close: number;
  rsi14: number | null;
  ema1: number | null;
  ema2: number | null;
  ema3: number | null;
  macd: MacdValue | null;
  bollinger: BollingerValue | null;
  atr14: number | null;
  atrPct: number | null;
  volumeLast: number | null;
  volumeAvg20: number | null;
  volumeRatio: number | null;
  changePct20: number | null;
}

export interface Levels {
  high20: number | null;
  low20: number | null;
  high50: number | null;
  low50: number | null;
  high120: number | null;
  low120: number | null;
  pivotHighs: number[];
  pivotLows: number[];
}

export interface TrendRead {
  bias: "up" | "down" | "sideways" | "unknown";
  reasons: string[];
}

export interface TimeframeAnalysis {
  timeframe: string;
  candles: number;
  values: IndicatorValues;
  levels: Levels;
  trend: TrendRead;
}

export interface IndicatorSeries {
  ema1: Array<number | null>;
  ema2: Array<number | null>;
  ema3: Array<number | null>;
  bbUpper: Array<number | null>;
  bbMiddle: Array<number | null>;
  bbLower: Array<number | null>;
  rsi: Array<number | null>;
  macd: Array<number | null>;
  macdSignal: Array<number | null>;
  macdHistogram: Array<number | null>;
  atr: Array<number | null>;
}

const NONE = (length: number): Array<number | null> => new Array(length).fill(null);

export function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Sort, dedupe and drop malformed candles. Never throws. */
export function normalizeCandles(candles: Candle[] | undefined | null): Candle[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    if (!candle || !Number.isFinite(candle.time)) continue;
    const values = [candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (!values.every((value) => Number.isFinite(value))) continue;
    if (candle.high < candle.low) continue;
    if (candle.volume < 0) continue;
    byTime.set(candle.time, candle);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function smaSeries(values: number[], period: number): Array<number | null> {
  const out = NONE(values.length);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values: number[], period: number): Array<number | null> {
  const out = NONE(values.length);
  if (period <= 0 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let previous = seed / period;
  out[period - 1] = previous;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    previous = values[i] * alpha + previous * (1 - alpha);
    out[i] = previous;
  }
  return out;
}

export function movingAverageSeries(
  values: number[],
  period: number,
  type: "ema" | "sma",
): Array<number | null> {
  return type === "sma" ? smaSeries(values, period) : emaSeries(values, period);
}

/** Wilder's RSI. Returns null until `period + 1` values exist. */
export function rsiSeries(values: number[], period = 14): Array<number | null> {
  const out = NONE(values.length);
  if (period <= 0 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const value = (g: number, l: number): number => {
    if (l === 0) return g === 0 ? 50 : 100;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  };
  out[period] = value(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const up = delta > 0 ? delta : 0;
    const down = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = value(avgGain, avgLoss);
  }
  return out;
}

export function macdSeries(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: Array<number | null>; signal: Array<number | null>; histogram: Array<number | null> } {
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const macd = NONE(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const a = fastSeries[i];
    const b = slowSeries[i];
    if (a !== null && b !== null) macd[i] = a - b;
  }
  // The signal EMA starts at the first non-null MACD value.
  const firstIndex = macd.findIndex((value) => value !== null);
  const signal = NONE(values.length);
  if (firstIndex >= 0) {
    const compact = macd.slice(firstIndex).map((value) => value as number);
    const compactSignal = emaSeries(compact, signalPeriod);
    compactSignal.forEach((value, index) => {
      signal[firstIndex + index] = value;
    });
  }
  const histogram = NONE(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const m = macd[i];
    const s = signal[i];
    if (m !== null && s !== null) histogram[i] = m - s;
  }
  return { macd, signal, histogram };
}

export function bollingerSeries(
  values: number[],
  period = 20,
  multiplier = 2,
): { upper: Array<number | null>; middle: Array<number | null>; lower: Array<number | null> } {
  const middle = smaSeries(values, period);
  const upper = NONE(values.length);
  const lower = NONE(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (values[j] - mean) ** 2;
    const deviation = Math.sqrt(variance / period);
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;
  }
  return { upper, middle, lower };
}

export function atrSeries(candles: Candle[], period = 14): Array<number | null> {
  const out = NONE(candles.length);
  if (candles.length <= period || period <= 0) return out;
  const trueRanges: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      trueRanges.push(candles[i].high - candles[i].low);
      continue;
    }
    const previousClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - previousClose),
        Math.abs(candles[i].low - previousClose),
      ),
    );
  }
  let previous = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = previous;
  for (let i = period; i < candles.length; i += 1) {
    previous = (previous * (period - 1) + trueRanges[i]) / period;
    out[i] = previous;
  }
  return out;
}

export function pivotLevels(
  candles: Candle[],
  left = 2,
  right = 2,
  lookback = 160,
): { highs: number[]; lows: number[] } {
  const window = candles.slice(Math.max(0, candles.length - lookback));
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < window.length - right; i += 1) {
    const candle = window[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (window[j].high >= candle.high) isHigh = false;
      if (window[j].low <= candle.low) isLow = false;
    }
    if (isHigh) highs.push(candle.high);
    if (isLow) lows.push(candle.low);
  }
  return { highs: dedupeLevels(highs).slice(-6), lows: dedupeLevels(lows).slice(-6) };
}

function dedupeLevels(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const value of sorted) {
    const previous = out[out.length - 1];
    if (previous === undefined || Math.abs(value - previous) / previous > 0.0015) {
      out.push(value);
    }
  }
  return out;
}

function rollingExtreme(candles: Candle[], period: number): { high: number | null; low: number | null } {
  if (candles.length < period) return { high: null, low: null };
  const window = candles.slice(-period);
  return {
    high: Math.max(...window.map((candle) => candle.high)),
    low: Math.min(...window.map((candle) => candle.low)),
  };
}

export function computeLevels(candles: Candle[]): Levels {
  const r20 = rollingExtreme(candles, 20);
  const r50 = rollingExtreme(candles, 50);
  const r120 = rollingExtreme(candles, 120);
  const pivots = pivotLevels(candles);
  return {
    high20: r20.high,
    low20: r20.low,
    high50: r50.high,
    low50: r50.low,
    high120: r120.high,
    low120: r120.low,
    pivotHighs: pivots.highs,
    pivotLows: pivots.lows,
  };
}

export function computeIndicatorSeries(
  candles: Candle[],
  config: EmaConfig = DEFAULT_EMA_CONFIG,
): IndicatorSeries {
  const closes = candles.map((candle) => candle.close);
  const ma = (period: number) => movingAverageSeries(closes, period, config.maType);
  const macd = macdSeries(closes);
  const bollinger = bollingerSeries(closes);
  return {
    ema1: ma(config.length1),
    ema2: ma(config.length2),
    ema3: ma(config.length3),
    bbUpper: bollinger.upper,
    bbMiddle: bollinger.middle,
    bbLower: bollinger.lower,
    rsi: rsiSeries(closes),
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    atr: atrSeries(candles),
  };
}

function lastDefined(series: Array<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i] !== null) return series[i];
  }
  return null;
}

export function readTrend(
  close: number,
  ema1: number | null,
  ema2: number | null,
  ema3: number | null,
  ema1Slope: number | null,
  rsi: number | null,
): TrendRead {
  const reasons: string[] = [];
  let score = 0;
  if (ema3 !== null) {
    if (close > ema3) {
      score += 1;
      reasons.push("price above the long moving average");
    } else {
      score -= 1;
      reasons.push("price below the long moving average");
    }
  }
  if (ema2 !== null && ema3 !== null) {
    if (ema2 > ema3) {
      score += 1;
      reasons.push("medium average above the long average");
    } else {
      score -= 1;
      reasons.push("medium average below the long average");
    }
  }
  if (ema1 !== null && ema2 !== null) {
    if (ema1 > ema2) {
      score += 1;
      reasons.push("short average above the medium average");
    } else {
      score -= 1;
      reasons.push("short average below the medium average");
    }
  }
  if (ema1Slope !== null) {
    if (ema1Slope > 0) {
      score += 1;
      reasons.push("short average rising");
    } else if (ema1Slope < 0) {
      score -= 1;
      reasons.push("short average falling");
    }
  }
  if (rsi !== null) {
    if (rsi >= 55) {
      score += 1;
      reasons.push(`RSI ${round(rsi, 2)} above 55`);
    } else if (rsi <= 45) {
      score -= 1;
      reasons.push(`RSI ${round(rsi, 2)} below 45`);
    } else {
      reasons.push(`RSI ${round(rsi, 2)} neutral`);
    }
  }
  if (ema1 === null && ema2 === null && ema3 === null) {
    return { bias: "unknown", reasons: ["not enough candles for moving averages"] };
  }
  const bias = score >= 3 ? "up" : score <= -3 ? "down" : "sideways";
  return { bias, reasons };
}

export function analyzeTimeframe(
  timeframe: string,
  rawCandles: Candle[],
  config: EmaConfig = DEFAULT_EMA_CONFIG,
): TimeframeAnalysis {
  const candles = normalizeCandles(rawCandles);
  const series = computeIndicatorSeries(candles, config);
  const closes = candles.map((candle) => candle.close);
  const close = closes[closes.length - 1] ?? 0;
  const ema1 = lastDefined(series.ema1);
  const ema2 = lastDefined(series.ema2);
  const ema3 = lastDefined(series.ema3);
  const lastIndex = series.ema1.length - 1;
  const slopeIndex = Math.max(0, lastIndex - 10);
  const slopeBase = series.ema1[slopeIndex];
  const ema1Slope =
    ema1 !== null && slopeBase !== null && slopeBase !== 0
      ? ((ema1 - slopeBase) / slopeBase) * 100
      : null;
  const rsi14 = lastDefined(series.rsi);
  const macdLine = lastDefined(series.macd);
  const macdSignal = lastDefined(series.macdSignal);
  const macdHistogram = lastDefined(series.macdHistogram);
  const bbUpper = lastDefined(series.bbUpper);
  const bbMiddle = lastDefined(series.bbMiddle);
  const bbLower = lastDefined(series.bbLower);
  const atr14 = lastDefined(series.atr);
  const volumes = candles.map((candle) => candle.volume);
  const volumeLast = volumes.length ? volumes[volumes.length - 1] : null;
  const volumeAvg20 =
    volumes.length >= 20
      ? volumes.slice(-20).reduce((sum, value) => sum + value, 0) / 20
      : null;
  const changePct20 =
    closes.length > 20 && closes[closes.length - 21] !== 0
      ? ((close - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
      : null;

  const values: IndicatorValues = {
    close: round(close),
    rsi14: rsi14 === null ? null : round(rsi14, 2),
    ema1: ema1 === null ? null : round(ema1),
    ema2: ema2 === null ? null : round(ema2),
    ema3: ema3 === null ? null : round(ema3),
    macd:
      macdLine === null || macdSignal === null || macdHistogram === null
        ? null
        : {
            line: round(macdLine),
            signal: round(macdSignal),
            histogram: round(macdHistogram),
          },
    bollinger:
      bbUpper === null || bbMiddle === null || bbLower === null
        ? null
        : {
            upper: round(bbUpper),
            middle: round(bbMiddle),
            lower: round(bbLower),
            bandwidthPct: bbMiddle === 0 ? 0 : round(((bbUpper - bbLower) / bbMiddle) * 100, 3),
          },
    atr14: atr14 === null ? null : round(atr14),
    atrPct: atr14 === null || close === 0 ? null : round((atr14 / close) * 100, 3),
    volumeLast: volumeLast === null ? null : round(volumeLast, 4),
    volumeAvg20: volumeAvg20 === null ? null : round(volumeAvg20, 4),
    volumeRatio:
      volumeLast === null || volumeAvg20 === null || volumeAvg20 === 0
        ? null
        : round(volumeLast / volumeAvg20, 3),
    changePct20: changePct20 === null ? null : round(changePct20, 3),
  };

  return {
    timeframe,
    candles: candles.length,
    values,
    levels: computeLevels(candles),
    trend: readTrend(close, ema1, ema2, ema3, ema1Slope, rsi14),
  };
}

/** Compact availability report for the model: never claims a value it lacks. */
export function indicatorAvailability(analysis: TimeframeAnalysis[]): {
  available: string[];
  unavailable: string[];
} {
  const names: Record<string, (value: unknown) => boolean> = {
    rsi14: (value) => typeof value === "number",
    macd: (value) => value !== null,
    ema: (value) => value !== null,
    bollinger: (value) => value !== null,
    atr14: (value) => typeof value === "number",
    volume: (value) => typeof value === "number",
    levels: (value) => value !== null,
  };
  const available = new Set<string>();
  const unavailable = new Set<string>();
  for (const item of analysis) {
    const checks: Record<string, unknown> = {
      rsi14: item.values.rsi14,
      macd: item.values.macd,
      ema: item.values.ema3 ?? item.values.ema1,
      bollinger: item.values.bollinger,
      atr14: item.values.atr14,
      volume: item.values.volumeAvg20,
      levels: item.levels.high20 ?? item.levels.low20,
    };
    for (const [name, value] of Object.entries(checks)) {
      if (names[name](value)) available.add(name);
      else unavailable.add(name);
    }
  }
  return { available: [...available], unavailable: [...unavailable] };
}
