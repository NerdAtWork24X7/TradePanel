import * as marketData from "./services/market-data";
import * as indicators from "./services/indicators";
import * as workspace from "./services/workspace";
import * as credentials from "./services/credentials";
import { RpcError } from "./services/backend";
import type { IndicatorComputeResult, UnknownRecord } from "./types";

type Envelope =
  | { __ws: 1; type: "rpc"; id: number; method: string; args: unknown[] }
  | { __ws: 1; type: "event"; event: string; payload: unknown[] };

export interface WorkspaceHandlers {
  focusedChart(symbol: string, exchange: string, market: string, timeframe: string): void;
  positionDrawing(direction: string, entry: number, tp: number, sl: number): void;
  tradeOverlay(ok: boolean, message: string): void;
  configRequested(): void;
  openSettings(): void;
  toggleTheme(): void;
  toggleTopBar(): void;
  toggleFullscreen(): void;
  fullscreen(enabled: boolean): void;
  ready(): void;
  failed(message: string): void;
  log(message: string): void;
}

export interface WorkspaceTradeOverlay {
  direction: "long" | "short";
  symbol: string;
  exchange?: string;
  market?: string;
  timeframe?: string;
  entry: number;
  takeProfit: number;
  stopLoss: number;
}

const ORIGIN =
  window.location.origin && window.location.origin !== "null"
    ? window.location.origin
    : "*";

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Hosts the existing chart workspace in an iframe and translates its
 * QWebChannel-shaped bridge onto the typed backend services.
 *
 * The iframe is only loaded once the sidecar is ready, so the workspace boot
 * sequence never sees a half-initialised bridge. A single automatic reload is
 * allowed when the bridge does not announce readiness; after that the shell
 * shows an error instead of silently continuing.
 */
export class WorkspaceHost {
  private readonly frame: HTMLIFrameElement;
  private readonly handlers: WorkspaceHandlers;
  private ready = false;
  private started = false;
  private reloads = 0;
  private readyWaiters: Array<() => void> = [];
  private readyTimer: number | null = null;
  private readonly onMessage = (event: MessageEvent) => this.handleMessage(event);

  constructor(frame: HTMLIFrameElement, handlers: WorkspaceHandlers) {
    this.frame = frame;
    this.handlers = handlers;
    window.addEventListener("message", this.onMessage);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.load();
  }

  private load(): void {
    this.ready = false;
    this.frame.src = "/workspace.html";
    this.readyTimer = window.setTimeout(() => {
      if (this.ready) return;
      if (this.reloads === 0) {
        this.reloads += 1;
        this.handlers.log("Workspace did not report readiness; reloading once");
        this.frame.src = "about:blank";
        window.setTimeout(() => this.load(), 200);
        return;
      }
      this.handlers.failed(
        "The chart workspace started but its bridge did not initialise. " +
        "Check that frontend/web/workspace.js and frontend/web/tauri_bridge.js were bundled.",
      );
    }, 20_000);
  }

  reload(): void {
    this.reloads = 0;
    this.ready = false;
    this.load();
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  send(command: string, payload: unknown[] = []): void {
    if (!this.started) return;
    this.frame.contentWindow?.postMessage(
      { __ws: 1, type: "host", cmd: command, payload },
      ORIGIN,
    );
  }

  setFocusedCoin(coin: string): void {
    this.send("setFocusedCoin", [coin]);
  }

  setFocusedTimeframe(timeframe: string): void {
    this.send("setFocusedTimeframe", [timeframe]);
  }

  centerFocused(): void {
    this.send("centerFocused", []);
  }

  /**
   * Draw an AI trade plan on the workspace chart of its instrument. The
   * workspace resolves (or opens) the matching panel and reports the outcome
   * through the `tradeOverlay` event. It never fills the ticket or submits.
   */
  overlayTrade(trade: WorkspaceTradeOverlay): void {
    this.send("overlayTrade", [trade]);
  }

  setIndicatorConfig(config: UnknownRecord): void {
    this.send("setIndicatorConfig", [config]);
  }

  setActive(active: boolean): void {
    this.send("setActive", [active]);
  }

  setFullscreenState(enabled: boolean): void {
    this.send("setFullscreenState", [enabled]);
  }

  shutdown(): void {
    this.send("shutdown", []);
    window.removeEventListener("message", this.onMessage);
  }

  // ── Message handling ────────────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    if (event.origin !== ORIGIN && event.origin !== "null") return;
    if (event.source !== this.frame.contentWindow) return;
    const data = event.data as Envelope | undefined;
    if (!data || data.__ws !== 1) return;

    if (data.type === "rpc") {
      void this.handleRpc(data);
      return;
    }
    this.handleEvent(data.event, data.payload);
  }

  private handleEvent(name: string, payload: unknown[]): void {
    switch (name) {
      case "ready":
        this.ready = true;
        if (this.readyTimer !== null) window.clearTimeout(this.readyTimer);
        this.readyWaiters.splice(0).forEach((resolve) => resolve());
        this.handlers.ready();
        break;
      case "focusedChart":
        this.handlers.focusedChart(
          asString(payload[0]), asString(payload[1]),
          asString(payload[2]), asString(payload[3]),
        );
        break;
      case "positionDrawing":
        this.handlers.positionDrawing(
          asString(payload[0]), asNumber(payload[1]),
          asNumber(payload[2]), asNumber(payload[3]),
        );
        break;
      case "tradeOverlay":
        this.handlers.tradeOverlay(Boolean(payload[0]), asString(payload[1]));
        break;
      case "configRequested":
        this.handlers.configRequested();
        break;
      case "openSettings":
        this.handlers.openSettings();
        break;
      case "toggleTheme":
        this.handlers.toggleTheme();
        break;
      case "toggleTopBar":
        this.handlers.toggleTopBar();
        break;
      case "toggleFullscreen":
        this.handlers.toggleFullscreen();
        break;
      case "fullscreen":
        this.handlers.fullscreen(Boolean(payload[0]));
        break;
      case "error":
        this.handlers.failed(asString(payload[0]) || "Workspace failed to start");
        break;
      case "log":
        this.handlers.log(asString(payload[0]));
        break;
      default:
        this.handlers.log(`Unhandled workspace event: ${name}`);
    }
  }

  private async handleRpc(message: Extract<Envelope, { type: "rpc" }>): Promise<void> {
    const args = message.args;
    let ok = false;
    let result: unknown;
    let error = "Request failed";
    try {
      result = await this.dispatch(message.method, args);
      ok = true;
    } catch (cause) {
      error = cause instanceof RpcError ? cause.message : String(cause);
      this.handlers.log(`workspace rpc ${message.method} failed: ${error}`);
    }
    this.frame.contentWindow?.postMessage(
      { __ws: 1, type: "rpc-result", id: message.id, ok, result, error },
      ORIGIN,
    );
  }

  /** Maps the QWebChannel bridge method names onto the typed services. */
  private async dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "meta":
        return marketData.getMeta();
      case "loadStore":
        return workspace.loadWorkspaceStore();
      case "saveStore": {
        const raw = JSON.parse(asString(args[0]));
        return workspace.saveWorkspaceStore(raw as UnknownRecord);
      }
      case "indicatorConfig":
        return { ok: true, config: await indicators.getIndicatorConfig() };
      case "requestCandles":
        return marketData.getCandles(
          asString(args[0]), asString(args[1]), asString(args[2]),
          asString(args[3]), asNumber(args[4]) || 600,
          asNumber(args[5]) || null,
        );
      case "requestTick":
        return marketData.getTick(
          asString(args[0]), asString(args[1]), asString(args[2]), asString(args[3]),
        );
      case "requestIndicators": {
        const flags = JSON.parse(asString(args[4]) || "{}") as UnknownRecord;
        return indicators.computeIndicators(
          asString(args[0]), asString(args[1]), asString(args[2]), asString(args[3]), flags,
        ) as Promise<IndicatorComputeResult>;
      }
      case "searchSymbols": {
        const symbols = await marketData.searchSymbols(
          asString(args[0]), asString(args[1]), asString(args[2]),
        );
        return { ok: true, symbols };
      }
      case "credentialStatus": {
        const fields = await credentials.credentialStatus();
        return { ok: true, fields };
      }
      case "saveCredentials": {
        const payload = JSON.parse(asString(args[0]) || "{}") as {
          values?: Record<string, string>;
          clear?: string[];
        };
        const saved = await credentials.saveCredentials(
          payload.values ?? {},
          payload.clear ?? [],
        );
        return { ok: true, keys: saved.keys, fields: saved.fields };
      }
      default:
        throw new Error(`Unknown workspace bridge method: ${method}`);
    }
  }
}
