/*
 * Bar Replay on the chart's own bars: the newest bar of the chart is the newest
 * REPLAYED one, so the status legend reads it (not the newest loaded bar, which
 * is in the future) and the bar slice never moves `raw` back to `allBars` (a
 * "scroll to the most recent bar", a reset or a Go to would otherwise put the
 * bars after the replay time back on the chart).
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import type { Time } from "lightweight-charts";
import type { OHLC } from "../chart-types";
import { legendBars } from "../view/helpers";
import { createBarSlice, type BarSliceApi } from "../view/bar-slice";
import type { ChartCx } from "../view/context";

// The node test environment has no animation frames; bar-slice's cleanup cancels one.
(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame ??= () => {};

const bar = (i: number): OHLC => ({ time: (1000 + i * 60) as Time, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 100 });
const allBars = [bar(0), bar(1), bar(2), bar(3)];
// A mid-history replay: everything loaded up to bar 1.
const replayed = allBars.slice(0, 2);

describe("legendBars", () => {
  const cx = (replayActive: boolean, sliceAtEnd: boolean) => ({ replayActive, sliceAtEnd: () => sliceAtEnd, raw: replayed, allBars });

  it("reads the newest replayed bar in Bar Replay, not the newest loaded one", () => {
    expect(legendBars(cx(true, false))).toBe(replayed);
  });

  it("keeps the newest loaded bar on a chart given a slice of older bars", () => {
    expect(legendBars(cx(false, false))).toBe(allBars);
  });

  it("reads the chart's own bars at the end and under the crosshair", () => {
    expect(legendBars(cx(false, true))).toBe(replayed);
    expect(legendBars(cx(true, false), 1000)).toBe(replayed);
  });
});

/** A chart context holding a mid-history replay (`raw` shorter than `allBars`). */
function sliceCtx(replayActive: boolean) {
  const raw = allBars.slice(0, 2);
  const cx = {
    activeType: "candle",
    replayActive,
    rawDaily: [],
    allBars,
    raw,
    chart: null,
    series: null,
  } as unknown as ChartCx;
  return { cx, raw };
}

function barSlice(cx: ChartCx): BarSliceApi {
  let api!: BarSliceApi;
  createRoot((dispose) => {
    api = createBarSlice(cx);
    dispose();
  });
  return api;
}

describe("createBarSlice in Bar Replay", () => {
  it("does not move the chart's bars back to the loaded ones", () => {
    const { cx, raw } = sliceCtx(true);
    const slice = barSlice(cx);
    expect(slice.sliceToEnd()).toBe(false);
    expect(slice.sliceToStart()).toBe(false);
    // A Go to a time outside the replayed bars.
    expect(slice.sliceAround((allBars[3].time as number) + 60)).toBe(false);
    expect(cx.raw).toBe(raw);
  });

  it("still moves the slice when the chart is not in replay", () => {
    const { cx } = sliceCtx(false);
    const slice = barSlice(cx);
    expect(slice.sliceToEnd()).toBe(true);
    expect(cx.raw).toBe(cx.allBars);
  });
});
