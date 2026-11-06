/**
 * Structural levels derived from raw candles (rolling extremes and swing
 * pivots). No indicator math lives here — this is the price structure the AI
 * analysis gets on top of the user-selected indicators.
 */
import type { Candle } from "../types";

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
