/**
 * Offscreen chart snapshot renderer for TradePanel AI Analysis.
 *
 * Runs inside a hidden, same-origin iframe. It never talks to the network:
 * the host posts candles and the renderer draws the price pane plus the
 * user-selected lightweight-charts-indicators studies, composites them into
 * one PNG and posts the data URL back.
 */
import type { Candle } from "../types";
import { normalizeCandles } from "../lib/candles";
import {
  findRegistryEntry,
  indicatorBars,
  loadIndicatorEngine,
  mergeIndicatorInputs,
  type IndicatorSelection,
  type RegistryEntry,
} from "../lib/indicator-kit";

const WIDTH = 960;
const HEIGHT = 680;
const HEADER = 56;
const FOOTER = 34;
const CHART_HEIGHT = HEIGHT - HEADER - FOOTER;
const MAIN_PANE_HEIGHT = 340;
const MAX_OSCILLATORS = 3;

interface TicketLevels {
  entry?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

interface SnapshotRequest {
  id: string;
  symbol: string;
  exchange: string;
  market: string;
  timeframe: string;
  candles: Candle[];
  price?: number | null;
  change24h?: number | null;
  levels?: TicketLevels;
  indicators: IndicatorSelection[];
  capturedAtMs: number;
}

interface PaneApiLike {
  setHeight(height: number): void;
  getHTMLElement(): HTMLElement;
}

type Lwc = {
  createChart: (element: HTMLElement, options: Record<string, unknown>) => any;
  CandlestickSeries: unknown;
  LineSeries: unknown;
  HistogramSeries: unknown;
  LineStyle: { Solid: number; Dashed: number; Dotted: number };
  ColorType: { Solid: string };
  CrosshairMode: { Normal: number; Magnet: number };
};

const LWC = (window as unknown as { LightweightCharts: Lwc }).LightweightCharts;
const stage = document.getElementById("stage") as HTMLElement;

const COLORS = {
  background: "#12120f",
  text: "#f3f1e9",
  muted: "#a09f95",
  faint: "#71716c",
  grid: "rgba(255,255,255,0.055)",
  border: "rgba(255,255,255,0.1)",
  accent: "#ffd43b",
  up: "#83cf9c",
  down: "#ff9e96",
};

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function chartOptions(height: number, bottomMargin = 0.08): Record<string, unknown> {
  return {
    width: WIDTH,
    height,
    layout: {
      background: { type: LWC.ColorType.Solid, color: COLORS.background },
      textColor: COLORS.muted,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      panes: { separatorColor: COLORS.border, separatorHoverColor: COLORS.border },
    },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { visible: false },
      horzLine: { visible: false },
    },
    rightPriceScale: {
      borderColor: COLORS.border,
      scaleMargins: { top: 0.08, bottom: bottomMargin },
    },
    timeScale: {
      visible: true,
      borderColor: COLORS.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 2,
    },
    handleScroll: false,
    handleScale: false,
  };
}

function setRange(chart: any, count: number): void {
  const from = Math.max(0, count - 150);
  chart.timeScale().setVisibleLogicalRange({ from, to: count + 2 });
}

function formatPrice(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(6);
}

function drawHeader(ctx: CanvasRenderingContext2D, request: SnapshotRequest, candles: Candle[]): void {
  ctx.fillStyle = "#1b1b17";
  ctx.fillRect(0, 0, WIDTH, HEADER);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(0, 0, 4, HEADER);

  const last = candles[candles.length - 1];
  const close = request.price ?? last?.close ?? null;
  const change =
    request.change24h ??
    (candles.length > 1 ? ((last.close - candles[0].open) / candles[0].open) * 100 : null);

  ctx.font = "700 20px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = "middle";
  ctx.fillText(request.symbol, 20, 24);

  const symbolWidth = ctx.measureText(request.symbol).width;
  ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${request.exchange} · ${request.market}`, 20, 42);

  const badge = request.timeframe.toUpperCase();
  ctx.font = "700 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  const badgeWidth = ctx.measureText(badge).width + 18;
  const badgeX = 20 + symbolWidth + 14;
  ctx.fillStyle = COLORS.accent;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(badgeX, 10, badgeWidth, 22);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.accent;
  ctx.fillText(badge, badgeX + 9, 22);

  if (close !== null) {
    ctx.textAlign = "right";
    ctx.font = "700 20px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = COLORS.text;
    ctx.fillText(formatPrice(close), WIDTH - 20, 22);
    if (change !== null && Number.isFinite(change)) {
      ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = change >= 0 ? COLORS.up : COLORS.down;
      const label =
        request.change24h !== null && request.change24h !== undefined ? "24h" : "range";
      ctx.fillText(`${change >= 0 ? "+" : ""}${change.toFixed(2)}% ${label}`, WIDTH - 20, 42);
    }
    ctx.textAlign = "left";
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, request: SnapshotRequest, names: string[]): void {
  ctx.fillStyle = "#1b1b17";
  ctx.fillRect(0, HEIGHT - FOOTER, WIDTH, FOOTER);
  ctx.font = "500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = COLORS.faint;
  ctx.textBaseline = "middle";
  const stamp = new Date(request.capturedAtMs).toISOString().replace("T", " ").slice(0, 19);
  ctx.fillText(
    `TradePanel read-only AI snapshot · ${request.symbol} · ${request.timeframe} · ${request.candles.length} candles · ${stamp}Z`,
    14,
    HEIGHT - FOOTER + 17,
  );
  ctx.textAlign = "right";
  ctx.fillText(names.length ? names.join(" · ") : "price + volume", WIDTH - 14, HEIGHT - FOOTER + 17);
  ctx.textAlign = "left";
}

function drawPaneLabel(ctx: CanvasRenderingContext2D, text: string, top: number): void {
  ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const width = ctx.measureText(text).width + 16;
  ctx.fillStyle = "rgba(18,18,15,0.82)";
  ctx.fillRect(8, top + 6, width, 19);
  ctx.fillStyle = COLORS.muted;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 16, top + 16);
}

async function render(
  request: SnapshotRequest,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const candles = normalizeCandles(request.candles);
  if (candles.length < 5) {
    throw new Error("Not enough candles to render a chart (need at least 5).");
  }

  stage.replaceChildren();
  const chartElement = document.createElement("div");
  stage.appendChild(chartElement);

  const chart = LWC.createChart(chartElement, chartOptions(CHART_HEIGHT, 0.24));
  const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
    upColor: COLORS.up,
    downColor: COLORS.down,
    borderVisible: false,
    wickUpColor: COLORS.up,
    wickDownColor: COLORS.down,
    priceLineVisible: false,
    lastValueVisible: true,
  });
  candleSeries.setData(
    candles.map((candle) => ({
      time: Math.floor(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })),
  );

  const volume = chart.addSeries(LWC.HistogramSeries, {
    priceScaleId: "volume",
    priceFormat: { type: "volume" },
    priceLineVisible: false,
    lastValueVisible: false,
  });
  chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  volume.setData(
    candles.map((candle) => ({
      time: Math.floor(candle.time),
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(131,207,156,0.38)" : "rgba(255,158,150,0.38)",
    })),
  );

  const levels = request.levels ?? {};
  const priceLines: Array<[number | null | undefined, string, string, number]> = [
    [levels.entry, COLORS.accent, "entry", LWC.LineStyle.Solid],
    [levels.takeProfit, COLORS.up, "TP", LWC.LineStyle.Dashed],
    [levels.stopLoss, COLORS.down, "SL", LWC.LineStyle.Dashed],
  ];
  for (const [price, color, title, style] of priceLines) {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      candleSeries.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      });
    }
  }

  const notes: string[] = [];
  const renderedNames: string[] = [];
  const selection = Array.isArray(request.indicators) ? request.indicators : [];
  let oscillatorCount = 0;

  if (selection.length) {
    let engineReady = true;
    try {
      await loadIndicatorEngine();
    } catch (error) {
      engineReady = false;
      notes.push(`engine: ${(error as Error).message || String(error)}`);
    }
    const bars = indicatorBars(candles);
    const entries: Array<{ entry: RegistryEntry; inputs: Record<string, unknown> }> = [];
    if (engineReady) {
      for (const item of selection) {
        const entry = findRegistryEntry(item.id);
        if (!entry) {
          notes.push(`${item.id}: unknown`);
          continue;
        }
        entries.push({ entry, inputs: mergeIndicatorInputs(entry, item.inputs) });
      }
    }
    const overlays = entries.filter(({ entry }) => entry.overlay === true);
    const oscillators = entries.filter(({ entry }) => entry.overlay !== true).slice(0, MAX_OSCILLATORS);
    oscillatorCount = oscillators.length;
    const oscPaneHeight = oscillatorCount
      ? Math.max(64, Math.floor((CHART_HEIGHT - MAIN_PANE_HEIGHT) / oscillatorCount))
      : CHART_HEIGHT;

    const drawSet = async (
      set: Array<{ entry: RegistryEntry; inputs: Record<string, unknown> }>,
      paneIndex: number,
    ): Promise<void> => {
      const kit = (window as unknown as { TradePanelIndicators: any }).TradePanelIndicators;
      for (const { entry, inputs } of set) {
        try {
          const result = entry.calculate(bars, inputs);
          const renderer = new kit.IndicatorRenderer(chart, {
            paneIndex,
            mainSeries: candleSeries,
          });
          renderer.render(entry, result, bars, { inputs, lastValueVisible: false });
          renderedNames.push(entry.shortName || entry.name);
        } catch (error) {
          notes.push(`${entry.id}: ${(error as Error).message || String(error)}`);
        }
      }
    };

    await drawSet(overlays, 0);
    for (let index = 0; index < oscillators.length; index += 1) {
      await drawSet([oscillators[index]], index + 1);
    }

    const panes = chart.panes() as PaneApiLike[];
    try {
      panes[0]?.setHeight(oscillatorCount ? MAIN_PANE_HEIGHT : CHART_HEIGHT);
      for (let index = 0; index < oscillatorCount; index += 1) {
        panes[index + 1]?.setHeight(oscPaneHeight);
      }
    } catch {
      /* pane sizing is cosmetic */
    }
  }
  setRange(chart, candles.length);

  await raf();
  await raf();
  await sleep(80);

  const composite = document.createElement("canvas");
  composite.width = WIDTH;
  composite.height = HEIGHT;
  const ctx = composite.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is unavailable");
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const shot = chart.takeScreenshot();
  ctx.drawImage(shot, 0, 0, shot.width, shot.height, 0, HEADER, WIDTH, CHART_HEIGHT);
  drawHeader(ctx, request, candles);
  drawFooter(ctx, request, renderedNames);

  if (oscillatorCount) {
    const paneHeight = Math.max(64, Math.floor((CHART_HEIGHT - MAIN_PANE_HEIGHT) / oscillatorCount));
    drawPaneLabel(ctx, request.timeframe.toUpperCase(), HEADER);
    let top = HEADER + MAIN_PANE_HEIGHT;
    const selectedEntries = selection
      .map((item) => findRegistryEntry(item.id))
      .filter((entry): entry is RegistryEntry => entry !== null && entry.overlay !== true)
      .slice(0, MAX_OSCILLATORS);
    for (const entry of selectedEntries) {
      drawPaneLabel(ctx, entry.shortName || entry.name, top);
      top += paneHeight;
    }
  }

  chart.remove();
  stage.replaceChildren();

  if (notes.length) {
    ctx.font = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = COLORS.down;
    ctx.textAlign = "right";
    ctx.fillText(`skipped: ${notes.slice(0, 2).join("; ")}`, WIDTH - 14, HEIGHT - FOOTER - 6);
    ctx.textAlign = "left";
  }

  return { dataUrl: composite.toDataURL("image/png"), width: WIDTH, height: HEIGHT };
}

function respond(message: Record<string, unknown>): void {
  window.parent.postMessage({ __aiSnapshot: 1, ...message }, "*");
}

let queue: Promise<unknown> = Promise.resolve();
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent) return;
  const data = event.data as {
    __aiSnapshot?: number;
    type?: string;
    id?: string;
    payload?: SnapshotRequest;
  };
  if (!data || data.__aiSnapshot !== 1 || data.type !== "render" || !data.id) return;
  const id = data.id;
  queue = queue
    .then(async () => {
      try {
        const result = await render(data.payload as SnapshotRequest);
        respond({ type: "rendered", id, ok: true, ...result });
      } catch (error) {
        respond({ type: "rendered", id, ok: false, error: (error as Error).message });
      }
    })
    .catch(() => undefined);
});

respond({ type: "ready" });
