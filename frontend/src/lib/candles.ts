import type { Candle } from "../types";

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
