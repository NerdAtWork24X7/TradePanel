/**
 * Host side of the offscreen chart snapshot renderer.
 *
 * A hidden same-origin iframe runs `snapshot.html` (Lightweight Charts). The
 * host posts one request at a time, receives a PNG data URL and returns the
 * raw base64 that the Rust host attaches to the Pi prompt as an image.
 */
import type { Candle } from "../types";
import type { IndicatorSelection } from "./indicator-kit";

export interface SnapshotChartInput {
  symbol: string;
  exchange: string;
  market: string;
  timeframe: string;
  candles: Candle[];
  price: number | null;
  change24h: number | null;
  levels: { entry?: number | null; takeProfit?: number | null; stopLoss?: number | null };
  indicators: IndicatorSelection[];
  capturedAtMs: number;
}

export interface SnapshotImage {
  timeframe: string;
  base64: string;
  width: number;
  height: number;
}

export interface SnapshotFailure {
  timeframe: string;
  error: string;
}

export interface SnapshotResult {
  images: SnapshotImage[];
  failures: SnapshotFailure[];
}

interface PendingRender {
  resolve: (value: SnapshotImage | SnapshotFailure) => void;
  timer: number;
  timeframe: string;
}

const READY_TIMEOUT_MS = 15_000;

export class ChartSnapshotHost {
  private readonly frame: HTMLIFrameElement;
  private readonly listener: (event: MessageEvent) => void;
  private readonly pending = new Map<string, PendingRender>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer: number;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly renderTimeoutMs = 25_000) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.frame = document.createElement("iframe");
    this.frame.title = "AI chart snapshot renderer";
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    this.frame.src = "/snapshot.html";
    this.frame.style.cssText =
      "position:fixed;left:-12000px;top:0;width:1000px;height:720px;border:0;" +
      "opacity:0;pointer-events:none;z-index:-1;";
    this.listener = (event: MessageEvent) => this.onMessage(event);
    window.addEventListener("message", this.listener);
    this.readyTimer = window.setTimeout(() => {
      this.rejectReady(new Error("The chart snapshot renderer did not start."));
    }, READY_TIMEOUT_MS);
    document.body.appendChild(this.frame);
  }

  /** Render every input serially. Failures are reported, never thrown. */
  async capture(
    inputs: SnapshotChartInput[],
    onProgress?: (index: number, total: number, timeframe: string) => void,
  ): Promise<SnapshotResult> {
    const images: SnapshotImage[] = [];
    const failures: SnapshotFailure[] = [];
    try {
      await this.ready;
    } catch (error) {
      for (const input of inputs) {
        failures.push({ timeframe: input.timeframe, error: (error as Error).message });
      }
      return { images, failures };
    }
    for (const [index, input] of inputs.entries()) {
      onProgress?.(index, inputs.length, input.timeframe);
      const result = await this.renderOne(input);
      if ("base64" in result) images.push(result);
      else failures.push(result);
    }
    return { images, failures };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.readyTimer);
    window.removeEventListener("message", this.listener);
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.resolve({ timeframe: pending.timeframe, error: "Snapshot renderer closed" });
      this.pending.delete(id);
    }
    this.frame.remove();
  }

  private renderOne(input: SnapshotChartInput): Promise<SnapshotImage | SnapshotFailure> {
    if (this.disposed) {
      return Promise.resolve({ timeframe: input.timeframe, error: "Snapshot renderer closed" });
    }
    const id = `snap-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve({ timeframe: input.timeframe, error: "Chart rendering timed out" });
      }, this.renderTimeoutMs);
      this.pending.set(id, { resolve, timer, timeframe: input.timeframe });
      this.frame.contentWindow?.postMessage(
        {
          __aiSnapshot: 1,
          type: "render",
          id,
          payload: { id, ...input },
        },
        "*",
      );
    });
  }

  private onMessage(event: MessageEvent): void {
    if (event.source !== this.frame.contentWindow) return;
    const data = event.data as {
      __aiSnapshot?: number;
      type?: string;
      id?: string;
      ok?: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    };
    if (!data || data.__aiSnapshot !== 1) return;
    if (data.type === "ready") {
      window.clearTimeout(this.readyTimer);
      this.resolveReady();
      return;
    }
    if (data.type !== "rendered" || !data.id) return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    window.clearTimeout(pending.timer);
    if (!data.ok || !data.dataUrl) {
      pending.resolve({
        timeframe: pending.timeframe,
        error: data.error || "Chart rendering failed",
      });
      return;
    }
    const base64 = data.dataUrl.replace(/^data:image\/png;base64,/, "");
    if (!base64.startsWith("iVBORw0KGgo")) {
      pending.resolve({ timeframe: pending.timeframe, error: "Renderer returned an invalid image" });
      return;
    }
    pending.resolve({
      timeframe: pending.timeframe,
      base64,
      width: data.width ?? 960,
      height: data.height ?? 680,
    });
  }
}
