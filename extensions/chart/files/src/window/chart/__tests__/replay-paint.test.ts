/*
 * Bar Replay draws the main series itself: on a mid-history replay the chart's
 * bars (`raw`) are the replayed ones, not every loaded bar, so the paint must
 * not take them for the "slice at the end" case (bar-slice.ts) and skip the
 * candle series. The studies already read `raw` in replay; the candles must be
 * cut with them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../bindings", () => ({ commands: {} }));
vi.mock("../../../data/kv", () => ({ getItem: () => null, setItem: () => {}, onExternalChange: () => () => {} }));
vi.mock("../../../data/datafeed", () => ({
  setLiveSymbol: () => Promise.resolve(),
  subscribeBars: () => Promise.resolve(() => {}),
  getBars: () => Promise.resolve({ bars: [], daily: null }),
  getSecondBarsTail: () => null,
  isIntradayInterval: () => false,
  isIntradayResolution: () => false,
  isSecondResolution: () => false,
}));

import { createRoot } from "solid-js";
import type { Time } from "lightweight-charts";
import type { ChartTokens } from "../chart-tokens";
import type { AnySeries, OHLC } from "../chart-types";
import { DEFAULT_SERIES_STYLES } from "../../header/chart-settings";
import { createLive, type LiveApi } from "../view/live";
import type { ChartCx } from "../view/context";

const bar = (i: number): OHLC => ({ time: (1000 + i * 60) as Time, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 100 });

/** A fake series recording the bars set on it. */
function fakeSeries() {
  const calls = { data: [] as unknown[], updated: [] as unknown[] };
  const series = {
    setData: (d: unknown[]) => void (calls.data = d),
    applyOptions: () => {},
    update: (d: unknown) => void calls.updated.push(d),
  } as unknown as AnySeries;
  return { series, calls };
}

const tokens = () => ({ styles: structuredClone(DEFAULT_SERIES_STYLES) }) as unknown as ChartTokens;

/** The chart context fields createLive's paint reads, with the series at a mid-history replay (`raw` shorter
 *  than every loaded bar) or a loaded slice. */
function chartCtx(live: { replayActive: boolean; sliceAtEnd: boolean }) {
  const { series, calls } = fakeSeries();
  const all = [bar(0), bar(1), bar(2), bar(3)];
  const cx = {
    paneId: 1,
    props: { symbol: "AAPL", interval: "1D", chartType: "candle", session: "RTH" },
    hidden: () => true,
    currentTokens: tokens,
    history: { loading: false },
    onShownHooks: new Set<() => void>(),
    refreshIndicatorLegend: () => {},
    refreshLegend: () => {},
    controller: null,
    series,
    activeType: "candle",
    // The replayed bars: everything loaded up to bar 1.
    raw: all.slice(0, 2),
    allBars: all,
    rawDaily: [],
    get replayActive() {
      return live.replayActive;
    },
    sliceAtEnd: () => live.sliceAtEnd,
    crosshairActive: false,
    crosshairAt: null,
    lastLegendTime: undefined,
    swapping: false,
    chart: null,
    pastWindowEnd: null,
    dataExtras: () => ({}),
    afterSeriesData: () => {},
    updateSessionBreaks: () => {},
    renderCompareAll: () => {},
    syncJournalMarks: () => {},
    updateHighLowLines: () => {},
    liveBar: () => {},
  } as unknown as ChartCx;
  return { cx, calls, all };
}

function paintCut(cx: ChartCx): LiveApi {
  let api!: LiveApi;
  createRoot((dispose) => {
    api = createLive(cx);
    api.paintLive(null, true);
    dispose();
  });
  return api;
}

describe("paintLive in Bar Replay", () => {
  it("cuts the candle series at the replay time and advances it one step at a time", () => {
    const { cx, calls, all } = chartCtx({ replayActive: true, sliceAtEnd: false });
    const api = paintCut(cx);
    expect(calls.data.map((b) => (b as OHLC).time)).toEqual(all.slice(0, 2).map((b) => b.time));
    // One update: the next replay bar goes onto the cut series (not a full set of every loaded bar).
    const next = bar(2);
    api.paintLive(next, true);
    expect(calls.updated).toEqual([next]);
    expect(calls.data.map((b) => (b as OHLC).time)).toEqual(all.slice(0, 2).map((b) => b.time));
  });

  it("leaves the series alone on a loaded slice that is not at the end (bar-slice.ts)", () => {
    const { cx, calls } = chartCtx({ replayActive: false, sliceAtEnd: false });
    paintCut(cx);
    expect(calls.data).toEqual([]);
    expect(calls.updated).toEqual([]);
  });
});
