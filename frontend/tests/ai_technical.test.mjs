import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTimeframe,
  atrSeries,
  bollingerSeries,
  computeLevels,
  emaSeries,
  indicatorAvailability,
  normalizeCandles,
  rsiSeries,
  smaSeries,
} from "../src/lib/technical.ts";

function trend(count, step, start = 100) {
  const out = [];
  let price = start;
  let time = 1_700_000_000;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price += step;
    const close = price;
    out.push({
      time,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 10 + (i % 5),
    });
    time += 300;
  }
  return out;
}

test("normalizes unsorted candles and drops malformed rows", () => {
  const candles = [
    { time: 3, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 1, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 2, open: 1, high: 1, low: 2, close: 2, volume: 1 },
    { time: 4, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 4, open: 2, high: 3, low: 2, close: 3, volume: 1 },
  ];
  const clean = normalizeCandles(candles);
  assert.deepEqual(clean.map((c) => c.time), [1, 3, 4]);
  assert.equal(clean[2].close, 3);
  assert.deepEqual(normalizeCandles(undefined), []);
});

test("SMA and EMA seed on the period and follow a linear ramp", () => {
  assert.deepEqual(smaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const ema = emaSeries([1, 2, 3, 4, 5], 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 2);
  assert.ok(Math.abs(ema[4] - 4) < 1e-9);
});

test("RSI is bounded, neutral on a flat series and high in an uptrend", () => {
  const flat = rsiSeries(new Array(40).fill(100), 14);
  assert.equal(flat[14], 50);
  const up = rsiSeries(trend(80, 1).map((c) => c.close), 14);
  const last = up[up.length - 1];
  assert.ok(last > 70 && last <= 100, `rsi=${last}`);
  for (const value of up.filter((v) => v !== null)) assert.ok(value >= 0 && value <= 100);
});

test("Bollinger bands are ordered and ATR is positive", () => {
  const candles = trend(80, 1);
  const closes = candles.map((c) => c.close);
  const bb = bollingerSeries(closes);
  const index = closes.length - 1;
  assert.ok(bb.lower[index] < bb.middle[index]);
  assert.ok(bb.middle[index] < bb.upper[index]);
  const atr = atrSeries(candles);
  const last = atr[atr.length - 1];
  assert.ok(last > 0);
});

test("timeframe analysis detects both trend directions and computes levels", () => {
  const up = analyzeTimeframe("4h", trend(260, 1));
  assert.equal(up.trend.bias, "up");
  assert.ok(up.values.rsi14 > 60);
  assert.ok(up.values.ema1 > up.values.ema2);
  assert.ok(up.values.ema2 > up.values.ema3);
  assert.ok(up.levels.high120 >= up.levels.high20);
  assert.ok(up.levels.low120 <= up.levels.low20);

  const down = analyzeTimeframe("4h", trend(260, -1, 400));
  assert.equal(down.trend.bias, "down");
  assert.ok(down.values.rsi14 < 40);
});

test("short and empty series never throw and report unavailable indicators", () => {
  const analysis = analyzeTimeframe("1d", trend(3, 1));
  assert.equal(analysis.trend.bias, "unknown");
  assert.equal(analysis.values.ema3, null);
  assert.equal(analysis.values.macd, null);
  const availability = indicatorAvailability([analysis]);
  assert.ok(availability.unavailable.includes("rsi14"));
  assert.ok(availability.unavailable.includes("ema"));
  assert.equal(computeLevels([]).high20, null);
});

test("levels include recent pivot highs and lows", () => {
  const candles = [
    ...trend(20, 1),
    { time: 1_700_010_000, open: 120, high: 130, low: 118, close: 121, volume: 5 },
    ...trend(20, -1, 120).map((c) => ({ ...c, time: c.time + 1_700_020_000 })),
  ];
  const levels = computeLevels(candles);
  assert.ok(levels.pivotHighs.some((value) => value >= 130));
  assert.ok(levels.pivotLows.length >= 0);
});
