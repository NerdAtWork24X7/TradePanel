/**
 * Offscreen chart snapshot renderer for TradePanel AI Analysis.
 *
 * Runs inside a hidden, same-origin iframe. It never talks to the network:
 * the host posts candles and the renderer draws the panes with the bundled
 * Lightweight Charts build, composites them into one PNG and posts the data
 * URL back. This replaces sending hundreds of candles to the model as text.
 */
import type { Candle } from "../types";
import {
  DEFAULT_EMA_CONFIG,
  computeIndicatorSeries,
  normalizeCandles,
  type EmaConfig,
  type IndicatorSeries,
} from "../lib/technical";

const WIDTH = 960;
const HEIGHT = 680;
const HEADER = 56;
const MAIN_HEIGHT = 380;
const MAIN_TOP = HEADER;
const RSI_TOP = MAIN_TOP + MAIN_HEIGHT + 4;
const RSI_HEIGHT = 96;
const MACD_TOP = RSI_TOP + RSI_HEIGHT + 4;
const MACD_HEIGHT = HEIGHT - MACD_TOP - 34;
const FOOTER_TOP = HEIGHT - 34;

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
  ema?: Partial<EmaConfig>;
  capturedAtMs: number;
}

type Lwc = {
  createChart: (element: HTMLElement, options: Record<string, unknown>) => any;
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
  blue: "#6aa2f0",
  orange: "#e3b24f",
  purple: "#ad8cf2",
};

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function chartOptions(height: number, showTime: boolean, bottomMargin = 0.08): Record<string, unknown> {
  return {
    width: WIDTH,
    height,
    layout: {
      background: { type: LWC.ColorType.Solid, color: COLORS.background },
      textColor: COLORS.muted,
      fontSize: 11,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
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
      visible: showTime,
      borderColor: COLORS.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 2,
    },
    handleScroll: false,
    handleScale: false,
  };
}

function pane(): HTMLElement {
  const element = document.createElement("div");
  element.className = "pane";
  stage.appendChild(element);
  return element;
}

function lineData(
  candles: Candle[],
  series: Array<number | null>,
): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  for (let i = 0; i < candles.length; i += 1) {
    const value = series[i];
    if (value !== null && Number.isFinite(value)) {
      out.push({ time: Math.floor(candles[i].time), value });
    }
  }
  return out;
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
  ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
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

function drawLabel(ctx: CanvasRenderingContext2D, text: string, top: number): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, top, WIDTH, 18);
  ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, top + 9);
}

function drawFooter(ctx: CanvasRenderingContext2D, request: SnapshotRequest): void {
  ctx.fillStyle = "#1b1b17";
  ctx.fillRect(0, FOOTER_TOP, WIDTH, HEIGHT - FOOTER_TOP);
  ctx.font = "500 10px ui-sans-serif, system-ui, sans-serif";
  ctx.fillStyle = COLORS.faint;
  ctx.textBaseline = "middle";
  const stamp = new Date(request.capturedAtMs).toISOString().replace("T", " ").slice(0, 19);
  ctx.fillText(
    `TradePanel read-only AI snapshot · ${request.symbol} · ${request.timeframe} · ${request.candles.length} candles · ${stamp}Z`,
    14,
    FOOTER_TOP + 17,
  );
  const ema = request.ema ?? DEFAULT_EMA_CONFIG;
  ctx.textAlign = "right";
  ctx.fillText(
    `EMA ${ema.length1}/${ema.length2}/${ema.length3} · BB 20,2 · RSI 14 · MACD 12/26/9`,
    WIDTH - 14,
    FOOTER_TOP + 17,
  );
  ctx.textAlign = "left";
}

async function render(
  request: SnapshotRequest,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const candles = normalizeCandles(request.candles);
  if (candles.length < 5) {
    throw new Error("Not enough candles to render a chart (need at least 5).");
  }
  const config: EmaConfig = {
    length1: Math.max(2, Number(request.ema?.length1) || DEFAULT_EMA_CONFIG.length1),
    length2: Math.max(3, Number(request.ema?.length2) || DEFAULT_EMA_CONFIG.length2),
    length3: Math.max(4, Number(request.ema?.length3) || DEFAULT_EMA_CONFIG.length3),
    maType: request.ema?.maType === "sma" ? "sma" : "ema",
  };
  const series: IndicatorSeries = computeIndicatorSeries(candles, config);

  stage.replaceChildren();
  const mainElement = pane();
  const rsiElement = pane();
  const macdElement = pane();

  const main = LWC.createChart(mainElement, chartOptions(MAIN_HEIGHT, false, 0.28));
  const candleSeries = main.addCandlestickSeries({
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

  const emaColors = [COLORS.blue, COLORS.orange, COLORS.purple];
  [series.ema1, series.ema2, series.ema3].forEach((values, index) => {
    const line = main.addLineSeries({
      color: emaColors[index],
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    line.setData(lineData(candles, values));
  });
  for (const [values, color] of [
    [series.bbUpper, COLORS.faint],
    [series.bbLower, COLORS.faint],
  ] as const) {
    const line = main.addLineSeries({
      color,
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    line.setData(lineData(candles, values));
  }

  const volume = main.addHistogramSeries({
    priceScaleId: "volume",
    priceFormat: { type: "volume" },
    priceLineVisible: false,
    lastValueVisible: false,
  });
  main.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
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
  setRange(main, candles.length);

  const rsiChart = LWC.createChart(rsiElement, chartOptions(RSI_HEIGHT, false, 0.08));
  const rsiLine = rsiChart.addLineSeries({
    color: COLORS.purple,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: true,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
  });
  rsiLine.setData(lineData(candles, series.rsi));
  rsiLine.createPriceLine({
    price: 70,
    color: COLORS.faint,
    lineWidth: 1,
    lineStyle: LWC.LineStyle.Dashed,
    axisLabelVisible: false,
    title: "",
  });
  rsiLine.createPriceLine({
    price: 30,
    color: COLORS.faint,
    lineWidth: 1,
    lineStyle: LWC.LineStyle.Dashed,
    axisLabelVisible: false,
    title: "",
  });
  setRange(rsiChart, candles.length);

  const macdChart = LWC.createChart(macdElement, chartOptions(MACD_HEIGHT, true, 0.08));
  const histogram = macdChart.addHistogramSeries({
    priceLineVisible: false,
    lastValueVisible: false,
  });
  histogram.setData(
    candles.map((candle, index) => ({
      time: Math.floor(candle.time),
      value: series.macdHistogram[index] ?? 0,
      color:
        (series.macdHistogram[index] ?? 0) >= 0
          ? "rgba(131,207,156,0.45)"
          : "rgba(255,158,150,0.45)",
    })),
  );
  const macdLine = macdChart.addLineSeries({
    color: COLORS.blue,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  macdLine.setData(lineData(candles, series.macd));
  const signalLine = macdChart.addLineSeries({
    color: COLORS.orange,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  signalLine.setData(lineData(candles, series.macdSignal));
  setRange(macdChart, candles.length);

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

  const drawPane = (chart: any, top: number, height: number): void => {
    const shot = chart.takeScreenshot();
    ctx.drawImage(shot, 0, 0, shot.width, shot.height, 0, top, WIDTH, height);
  };
  drawHeader(ctx, request, candles);
  drawPane(main, MAIN_TOP, MAIN_HEIGHT);
  drawLabel(ctx, "RSI 14", RSI_TOP - 18);
  drawPane(rsiChart, RSI_TOP, RSI_HEIGHT);
  drawLabel(ctx, "MACD 12/26/9", MACD_TOP - 18);
  drawPane(macdChart, MACD_TOP, MACD_HEIGHT);
  drawFooter(ctx, request);

  ctx.fillStyle = COLORS.border;
  ctx.fillRect(0, MAIN_TOP + MAIN_HEIGHT, WIDTH, 1);
  ctx.fillRect(0, RSI_TOP + RSI_HEIGHT, WIDTH, 1);

  main.remove();
  rsiChart.remove();
  macdChart.remove();
  stage.replaceChildren();
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
