/**
 * AI Analysis panel: Pi connection state, explicit Start Analysis workflow,
 * streaming transcript, structured trade-plan cards and conversation settings.
 *
 * The panel only talks to the typed `ai` service (Rust allow-list). It owns no
 * trading action: "Fill ticket" writes the form through the controller and
 * never submits an order.
 */
import * as ai from "../services/ai";
import * as account from "../services/account";
import * as marketData from "../services/market-data";
import * as shell from "../services/shell";
import { ChartSnapshotHost, type SnapshotImage } from "../lib/chart-snapshot";
import { markdownToHtml, messageText } from "../lib/markdown";
import {
  DEFAULT_EMA_CONFIG,
  analyzeTimeframe,
  indicatorAvailability,
  type EmaConfig,
  type TimeframeAnalysis,
} from "../lib/technical";
import { toast } from "./toast";
import type {
  AiAuthCredential,
  AiAuthEvent,
  AiAuthModel,
  AiAuthPrompt,
  AiAuthProvider,
  AiAuthSession,
  AiConversation,
  AiConversationStore,
  AiEvent,
  AiPlanAction,
  AiProvider,
  AiStatus,
  AiTradePlan,
  Candle,
  IndicatorConfig,
  Position,
  UnknownRecord,
} from "../types";
import { iconSpan, setIcon } from "../lib/icons";

export interface AiFocus {
  symbol: string;
  exchange: string;
  market: string;
  timeframe: string;
}

export interface AiTicket {
  direction: "long" | "short";
  qty: string;
  risk: string;
  limit: string;
  tp: string;
  sl: string;
}

export interface AiPanelHandlers {
  focus(): AiFocus | null;
  ticket(): AiTicket;
  indicatorConfig(): IndicatorConfig | null;
  precision(coin: string): Promise<number | null>;
  applyPlan(plan: AiTradePlan): void;
  showPlanOnChart(plan: AiTradePlan, focus: AiFocus | null): void;
  openSettings(tab?: "ai"): void;
  closeSettings(): void;
  log(message: string): void;
}

const ANALYSIS_TIMEFRAMES = ["1d", "4h", "5m"] as const;
const MAX_MESSAGES = 140;
const TOOL_LABELS: Record<string, string> = {
  panel_market_context: "Reading market context",
  panel_indicators: "Reading indicator values",
  panel_portfolio: "Reading position",
  panel_order_ticket: "Reading order ticket",
  panel_submit_trade_plan: "Validating trade plan",
};

/** Icon per Pi tool call, matching the chart workspace's icon language. */
const TOOL_ICONS: Record<string, string> = {
  panel_market_context: "chart-reset-view",
  panel_indicators: "header-indicators-metrics-and-strategies",
  panel_portfolio: "draw-position",
  panel_order_ticket: "dt-add-alert",
  panel_submit_trade_plan: "scr-check",
};

interface BuiltContext {
  snapshot: UnknownRecord;
  images: SnapshotImage[];
  failures: string[];
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing AI panel element #${id}`);
  return node as T;
}

function numberValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function relativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function planPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function planQty(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function lastCandle(candles: Candle[]): Candle | null {
  return candles.length ? candles[candles.length - 1] : null;
}

export class AiPanel {
  private readonly handlers: AiPanelHandlers;

  private readonly panel = must<HTMLElement>("ai-panel");
  private readonly sidebarRoot = this.panel.closest(".trade-sidebar");
  private readonly dot = must<HTMLElement>("ai-status-dot");
  private readonly contextSymbol = must<HTMLElement>("ai-context-symbol");
  private readonly contextMarket = must<HTMLElement>("ai-context-market");
  private readonly contextTimeframe = must<HTMLElement>("ai-context-tf");
  private readonly freshness = must<HTMLElement>("ai-freshness");
  private readonly portfolioToggle = must<HTMLInputElement>("ai-portfolio");
  private readonly messages = must<HTMLElement>("ai-messages");
  private readonly empty = must<HTMLElement>("ai-empty");
  private readonly emptyTitle = must<HTMLElement>("ai-empty-title");
  private readonly emptyText = must<HTMLElement>("ai-empty-text");
  private readonly settingsView = must<HTMLElement>("ai-settings-view");
  private readonly historyView = must<HTMLElement>("ai-history-view");
  private readonly compose = must<HTMLFormElement>("ai-form");
  private readonly startButton = must<HTMLButtonElement>("ai-start");
  private readonly input = must<HTMLTextAreaElement>("ai-input");
  private readonly sendButton = must<HTMLButtonElement>("ai-send");
  private readonly stopButton = must<HTMLButtonElement>("ai-stop");
  private readonly composeHint = must<HTMLElement>("ai-compose-hint");
  private readonly settingsButton = must<HTMLButtonElement>("ai-settings-btn");
  private readonly historyButton = must<HTMLButtonElement>("ai-history-btn");
  private readonly expandButton = must<HTMLButtonElement>("ai-expand");
  private readonly providerSelect = must<HTMLSelectElement>("ai-provider");
  private readonly modelSelect = must<HTMLSelectElement>("ai-model");
  private readonly thinkingSelect = must<HTMLSelectElement>("ai-thinking");
  private readonly settingsPortfolio = must<HTMLInputElement>("ai-settings-portfolio");
  private readonly settingsSave = must<HTMLButtonElement>("ai-settings-save");
  private readonly settingsRefresh = must<HTMLButtonElement>("ai-settings-refresh");
  private readonly authCurrent = must<HTMLElement>("ai-auth-current");
  private readonly authSearch = must<HTMLInputElement>("ai-auth-search");
  private readonly authList = must<HTMLElement>("ai-auth-list");
  private readonly credentialsList = must<HTMLElement>("ai-auth-credentials");
  private readonly authLogin = must<HTMLElement>("ai-auth-login");
  private readonly authLoginTitle = must<HTMLElement>("ai-auth-login-title");
  private readonly authLoginEvents = must<HTMLElement>("ai-auth-login-events");
  private readonly authLoginPrompt = must<HTMLElement>("ai-auth-login-prompt");
  private readonly authLoginStatus = must<HTMLElement>("ai-auth-login-status");
  private readonly authCancel = must<HTMLButtonElement>("ai-auth-cancel");
  private readonly diagnostics = must<HTMLElement>("ai-diagnostics");
  private readonly diagnosticsRefresh = must<HTMLButtonElement>("ai-diagnostics-refresh");
  private readonly historyBack = must<HTMLButtonElement>("ai-history-back");
  private readonly newConversation = must<HTMLButtonElement>("ai-new-conversation");
  private readonly conversationList = must<HTMLElement>("ai-conversation-list");

  private focus: AiFocus | null = null;
  /** Instrument captured when the current analysis started.  The plan card
   *  uses it so a later chart switch cannot retarget the overlay. */
  private planFocus: AiFocus | null = null;
  private status: AiStatus = {
    state: "stopped",
    message: null,
    pid: null,
    runtimeReady: false,
    runtimeError: null,
    nodeVersion: null,
    piVersion: null,
    configured: false,
    hasKey: false,
    provider: null,
    providerLabel: null,
    model: null,
    thinking: "medium",
    portfolioContext: false,
    sessionId: null,
    streaming: false,
    attempt: 0,
    models: 0,
    updatedAtMs: 0,
  };
  private providers: AiProvider[] = [];
  private authProviders: AiAuthProvider[] = [];
  private authCredentials: AiAuthCredential[] = [];
  private authReady = true;
  private authReason: string | null = null;
  private authModels: AiAuthModel[] = [];
  private authQuery = "";
  private authSession: AiAuthSession | null = null;
  private authSig = "";
  private authDraft = "";
  private authPoll: number | null = null;
  private conversations: AiConversationStore = { version: 1, active: "", items: [] };
  private view: "chat" | "history" = "chat";
  private analysisStarted = false;
  private busy = false;
  private streaming = false;
  private lastSnapshotAt = 0;
  private assistant: {
    element: HTMLElement;
    body: HTMLElement;
    text: string;
    timer: number | null;
  } | null = null;
  private readonly toolRows = new Map<string, HTMLElement>();
  private readonly freshnessTimer: number;
  private readonly cleanup: Array<() => void> = [];

  constructor(handlers: AiPanelHandlers) {
    this.handlers = handlers;
    this.providerSelect.replaceChildren();
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const option = document.createElement("option");
      option.value = thinking;
      option.textContent = thinking;
      this.thinkingSelect.appendChild(option);
    }
    this.bindEvents();
    this.updateControls();
    this.setDot("idle");
    this.freshnessTimer = window.setInterval(() => this.updateFreshness(), 5000);
    void this.initialize();
  }

  setFocus(focus: AiFocus | null): void {
    this.focus = focus;
    this.contextSymbol.textContent = focus?.symbol || "No chart";
    this.contextMarket.textContent = focus ? `${focus.exchange} · ${focus.market}` : "select a chart";
    this.contextTimeframe.textContent = focus?.timeframe || "—";
    this.contextSymbol.title = focus ? `${focus.symbol} on ${focus.exchange} ${focus.market}` : "";
  }

  dispose(): void {
    window.clearInterval(this.freshnessTimer);
    this.stopAuthPoll();
    for (const off of this.cleanup) off();
  }

  /** The AI view became visible (the trade ticket no longer shares the column). */
  onShow(): void {
    this.updateFreshness();
    // The transcript has no measurable height while the panel is hidden, so
    // the scroll position from a background run must be re-applied.
    this.scrollToBottom(true);
  }

  /** The AI view was hidden: drop the widened column so the ticket keeps its
   *  own width, and remember the chat view for the next visit. */
  onHide(): void {
    this.setExpanded(false);
    if (this.view !== "chat") this.setView("chat");
  }

  /** Called by the settings page when its AI tab becomes visible. */
  openSettings(): void {
    this.settingsView.hidden = false;
    void this.refreshSettings();
  }

  // ── Boot ──────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const [status, conversations] = await Promise.allSettled([
      ai.getStatus(),
      ai.getConversations(),
    ]);
    if (conversations.status === "fulfilled") {
      this.conversations = conversations.value;
    }
    if (status.status === "fulfilled") {
      this.applyStatus(status.value);
    } else {
      this.showFatal((status.reason as Error).message);
    }
    await this.bindStreams();
    this.renderConversations();
    this.setFocus(this.handlers.focus());
    if (this.conversations.active) {
      await this.loadConversation(this.conversations.active, false);
    } else {
      this.showEmpty();
    }
    this.updateFreshness();
  }

  private async bindStreams(): Promise<void> {
    try {
      const offEvent = await ai.onEvent((event) => this.handleEvent(event));
      this.cleanup.push(offEvent);
    } catch (error) {
      this.handlers.log(`ai event channel unavailable: ${(error as Error).message}`);
    }
    try {
      const offStatus = await ai.onStatus((status) => this.applyStatus(status));
      this.cleanup.push(offStatus);
    } catch (error) {
      this.handlers.log(`ai status channel unavailable: ${(error as Error).message}`);
    }
    try {
      const offAuth = await ai.onAuth((session) => this.applyAuthSession(session));
      this.cleanup.push(offAuth);
    } catch (error) {
      this.handlers.log(`ai auth channel unavailable: ${(error as Error).message}`);
    }
  }

  private applyStatus(status: AiStatus): void {
    this.status = status;
    this.streaming = status.streaming;
    this.portfolioToggle.checked = status.portfolioContext;
    this.settingsPortfolio.checked = status.portfolioContext;
    this.thinkingSelect.value = status.thinking || "medium";
    this.setDot(this.dotTone(status));
    this.dot.title = status.message || status.state;
    this.dot.setAttribute("aria-label", `AI status: ${status.state}`);
    if (status.state === "unavailable" || !status.runtimeReady) {
      this.emptyTitle.textContent = "AI runtime unavailable";
      this.emptyText.textContent =
        status.runtimeError ||
        "The bundled Node + Pi runtime was not found. Reinstall TradePanel or rebuild the runtime.";
    } else if (!status.configured) {
      this.emptyTitle.textContent = "Connect a provider";
      this.emptyText.textContent =
        "Sign in to a provider in AI settings. Credentials stay in TradePanel's own Pi agent folder and never reach the model.";
    } else {
      this.emptyTitle.textContent = "Start a read-only analysis";
      this.emptyText.textContent =
        "TradePanel renders 1d, 4h and 5m charts with indicators and sends them to Pi with a compact snapshot. Only Start analysis begins a run.";
    }
    this.updateControls();
    this.renderComposeHint();
  }

  private dotTone(status: AiStatus): string {
    if (!status.runtimeReady || status.state === "error" || status.state === "unavailable") return "error";
    if (status.streaming || status.state === "streaming") return "streaming";
    if (status.state === "starting") return "pending";
    if (status.configured) return "ok";
    return "idle";
  }

  private updateControls(): void {
    const configured = this.status.configured;
    const runtimeReady = this.status.runtimeReady;
    const blocked = this.busy || this.streaming;
    this.startButton.disabled = blocked;
    const startLabel = blocked
      ? "Working…"
      : configured
        ? "Start analysis"
        : "Connect provider";
    this.startButton.replaceChildren(
      iconSpan("ai-sparkle", 17, "ai-start-spark"),
      document.createTextNode(startLabel),
    );
    this.startButton.title = runtimeReady
      ? configured
        ? "Render 1d, 4h and 5m charts and start a read-only analysis"
        : "Connect an AI provider first"
      : this.status.runtimeError || "The bundled AI runtime is unavailable";
    const canChat = configured && this.analysisStarted && !blocked;
    this.input.disabled = !canChat;
    this.sendButton.disabled = !canChat || this.input.value.trim().length === 0;
    this.stopButton.hidden = !this.streaming;
    this.input.placeholder = !configured
      ? "Connect a provider"
      : this.analysisStarted
        ? "Ask a follow-up…"
        : "Start analysis first";
    this.settingsButton.disabled = false;
  }

  private renderComposeHint(): void {
    if (this.streaming) {
      this.composeHint.textContent = "Pi is analysing…";
      return;
    }
    if (!this.status.configured) {
      this.composeHint.textContent = "Provider not connected · analysis is read-only";
      return;
    }
    const model = this.status.model ? this.status.model.split("/").pop() : "model";
    this.composeHint.textContent = `${model} · 1d · 4h · 5m screenshots · read-only`;
  }

  // ── Views ─────────────────────────────────────────────────────────────

  private setView(view: "chat" | "history"): void {
    this.view = view;
    this.panel.dataset.view = view;
    this.historyView.hidden = view !== "history";
    this.messages.hidden = view !== "chat";
    this.compose.hidden = view !== "chat";
    this.empty.hidden = view !== "chat" || this.hasMessages();
    if (view === "history") {
      this.renderConversations();
    }
  }

  private hasMessages(): boolean {
    return this.messages.childElementCount > 0;
  }

  private showEmpty(): void {
    this.empty.hidden = this.view !== "chat" || this.hasMessages();
  }

  private clearMessages(): void {
    this.messages.replaceChildren();
    this.toolRows.clear();
    this.assistant = null;
    this.showEmpty();
  }

  private trimMessages(): void {
    while (this.messages.childElementCount > MAX_MESSAGES) {
      this.messages.firstElementChild?.remove();
    }
  }

  private atBottom(): boolean {
    return this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 90;
  }

  private scrollToBottom(force = false): void {
    if (!force && !this.atBottom()) return;
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  // ── Start analysis ────────────────────────────────────────────────────

  private async startAnalysis(): Promise<void> {
    if (this.busy || this.streaming) return;
    if (!this.status.runtimeReady) {
      this.handlers.openSettings("ai");
      toast(this.status.runtimeError || "The AI runtime is unavailable.", "error");
      return;
    }
    if (!this.status.configured) {
      this.handlers.openSettings("ai");
      toast("Sign in to a provider and choose a model first.", "info");
      return;
    }
    const focus = this.focus ?? this.handlers.focus();
    if (!focus) {
      toast("Select a chart first — the analysis needs an instrument.", "error");
      return;
    }
    this.planFocus = { ...focus };
    this.busy = true;
    this.setView("chat");
    this.updateControls();
    const progress = this.addSystemRow("Preparing 1d · 4h · 5m charts…", true);
    try {
      const store = await ai.getConversations();
      if (!store.active) {
        this.conversations = await ai.createConversation();
        this.renderConversations();
      } else {
        this.conversations = store;
      }
      const context = await this.buildContext(focus, true, (index, total, timeframe) => {
        progress.setText(`Rendering ${timeframe} (${index + 1}/${total})…`);
      });
      if (context.images.length === 0) {
        throw new Error(
          context.failures[0] || "Chart rendering failed for all timeframes; the analysis was not started.",
        );
      }
      progress.remove();
      this.addUserBubble(focus, context.images);
      const prompt = this.buildAnalysisPrompt(focus, context);
      this.setStreaming(true);
      try {
        await ai.send(prompt, context.snapshot, context.images.map((image) => image.base64));
      } catch (error) {
        this.setStreaming(false);
        throw error;
      }
      this.analysisStarted = true;
      this.lastSnapshotAt = Date.now();
      this.updateFreshness();
      this.updateControls();
      if (this.conversations.active) {
        const title = `${focus.symbol} · ${ANALYSIS_TIMEFRAMES.join("/")}`;
        try {
          this.conversations = await ai.renameConversation(this.conversations.active, title);
          this.renderConversations();
        } catch {
          /* the automatic title is still usable */
        }
      }
      if (context.failures.length) {
        this.addSystemRow(`Partial snapshot: ${context.failures.join(" · ")}`, false);
      }
    } catch (error) {
      progress.remove();
      this.showError((error as Error).message);
    } finally {
      this.busy = false;
      this.updateControls();
    }
  }

  private async sendFollowUp(): Promise<void> {
    const message = this.input.value.trim();
    if (!message || this.streaming || this.busy) return;
    if (!this.analysisStarted) {
      toast("Click Start analysis first.", "info");
      return;
    }
    const focus = this.focus ?? this.handlers.focus();
    if (!focus) {
      toast("Select a chart first.", "error");
      return;
    }
    this.planFocus = { ...focus };
    this.input.value = "";
    this.autoGrow();
    this.updateControls();
    this.addUserBubbleText(message);
    try {
      const context = await this.buildContext(focus, false);
      this.lastSnapshotAt = Date.now();
      this.setStreaming(true);
      await ai.send(message, context.snapshot, []);
    } catch (error) {
      this.setStreaming(false);
      this.showError((error as Error).message);
    }
  }

  private async buildContext(
    focus: AiFocus,
    withImages: boolean,
    onProgress?: (index: number, total: number, timeframe: string) => void,
  ): Promise<BuiltContext> {
    const results = await Promise.allSettled(
      ANALYSIS_TIMEFRAMES.map((timeframe) =>
        marketData.getCandles(focus.exchange, focus.market, focus.symbol, timeframe, 300),
      ),
    );
    const candlesByTimeframe: Partial<Record<(typeof ANALYSIS_TIMEFRAMES)[number], Candle[]>> = {};
    const failures: string[] = [];
    results.forEach((result, index) => {
      const timeframe = ANALYSIS_TIMEFRAMES[index];
      if (result.status === "fulfilled") {
        const candles = result.value.candles ?? [];
        if (candles.length >= 5) candlesByTimeframe[timeframe] = candles;
        else failures.push(`${timeframe}: not enough candles`);
      } else {
        failures.push(`${timeframe}: ${(result.reason as Error).message}`);
      }
    });

    const availableTimeframes = ANALYSIS_TIMEFRAMES.filter((timeframe) => candlesByTimeframe[timeframe]);
    if (!availableTimeframes.length) {
      throw new Error("No candle data is available for 1d, 4h or 5m. Check the market data backend.");
    }
    const primaryTimeframe = candlesByTimeframe["5m"] ? "5m" : availableTimeframes[0];
    const primaryCandles = candlesByTimeframe[primaryTimeframe] as Candle[];
    const ema = this.emaConfig();
    const analyses: TimeframeAnalysis[] = availableTimeframes.map((timeframe) =>
      analyzeTimeframe(timeframe, candlesByTimeframe[timeframe] as Candle[], ema),
    );
    const primary = analyses.find((analysis) => analysis.timeframe === primaryTimeframe) as TimeframeAnalysis;
    const daily = analyses.find((analysis) => analysis.timeframe === "1d");
    const fourHour = analyses.find((analysis) => analysis.timeframe === "4h");
    const close = lastCandle(primaryCandles)?.close ?? primary.values.close;
    const dailyCandles = candlesByTimeframe["1d"];
    const change24h =
      dailyCandles && dailyCandles.length >= 2 && dailyCandles[dailyCandles.length - 2].close !== 0
        ? ((dailyCandles[dailyCandles.length - 1].close - dailyCandles[dailyCandles.length - 2].close) /
            dailyCandles[dailyCandles.length - 2].close) *
          100
        : null;
    const availability = indicatorAvailability(analyses);
    const ticket = this.handlers.ticket();
    const levels = {
      entry: numberValue(ticket.limit),
      takeProfit: numberValue(ticket.tp),
      stopLoss: numberValue(ticket.sl),
    };
    const portfolio = await this.buildPortfolio(focus, this.status.portfolioContext);
    const szDecimals = await this.handlers.precision(focus.symbol.split("/")[0] || focus.symbol);
    const capturedAtMs = Date.now();

    let images: SnapshotImage[] = [];
    if (withImages) {
      const screenshots = availableTimeframes.map((timeframe) => ({
        symbol: focus.symbol,
        exchange: focus.exchange,
        market: focus.market,
        timeframe,
        candles: candlesByTimeframe[timeframe] as Candle[],
        price: close,
        change24h,
        levels,
        ema,
        capturedAtMs,
      }));
      const host = new ChartSnapshotHost();
      try {
        const result = await host.capture(screenshots, onProgress);
        images = result.images;
        for (const failure of result.failures) {
          failures.push(`${failure.timeframe} render: ${failure.error}`);
        }
      } finally {
        host.dispose();
      }
    }

    const perTimeframe: UnknownRecord = {};
    for (const analysis of analyses) {
      const candles = candlesByTimeframe[
        analysis.timeframe as (typeof ANALYSIS_TIMEFRAMES)[number]
      ] as Candle[];
      perTimeframe[analysis.timeframe] = {
        candles: analysis.candles,
        firstCandleMs: candles.length ? Math.floor(candles[0].time * 1000) : null,
        lastCandleMs: candles.length ? Math.floor(candles[candles.length - 1].time * 1000) : null,
        values: analysis.values,
        levels: analysis.levels,
        trend: analysis.trend,
      };
    }

    const snapshot: UnknownRecord = {
      version: 1,
      capturedAtMs,
      generatedBy: "TradePanel AI Analysis",
      instrument: {
        symbol: focus.symbol,
        base: focus.symbol.split("/")[0] ?? focus.symbol,
        quote: focus.symbol.split("/")[1] ?? "",
        exchange: focus.exchange,
        market: focus.market,
        szDecimals,
        timeframe: primaryTimeframe,
        chartTimeframe: focus.timeframe,
        price: close,
        priceSource: `last ${primaryTimeframe} candle close`,
        change24h: change24h === null ? null : Number(change24h.toFixed(3)),
        volume24h: null,
        source: "TradePanel market data",
      },
      analysis: {
        timeframes: availableTimeframes,
        primaryTimeframe,
        imageOrder: images.map((image) => image.timeframe),
        screenshots: images.map((image) => ({
          timeframe: image.timeframe,
          width: image.width,
          height: image.height,
        })),
        missing: failures,
        note: "Screenshots include EMA ribbon, Bollinger 20/2, volume, RSI 14 and MACD 12/26/9.",
      },
      indicators: {
        available: availability.available,
        unavailable: availability.unavailable,
        summary: {
          primaryBias: primary.trend.bias,
          dailyBias: daily?.trend.bias ?? "unknown",
          fourHourBias: fourHour?.trend.bias ?? "unknown",
          alignment:
            daily && fourHour
              ? daily.trend.bias === fourHour.trend.bias
                ? "aligned"
                : "conflicting"
              : "unknown",
          rsi14: primary.values.rsi14,
          atrPct: primary.values.atrPct,
          volumeRatio: primary.values.volumeRatio,
          ema1: primary.values.ema1,
          ema2: primary.values.ema2,
          ema3: primary.values.ema3,
          reasons: primary.trend.reasons,
        },
        perTimeframe,
        levels: primary.levels,
      },
      portfolio,
      ticket: {
        readOnly: true,
        direction: ticket.direction,
        qty: ticket.qty,
        risk: ticket.risk,
        limit: ticket.limit,
        tp: ticket.tp,
        sl: ticket.sl,
      },
    };
    return { snapshot, images, failures };
  }

  private emaConfig(): EmaConfig {
    const ribbon = this.handlers.indicatorConfig()?.ema_ribbon;
    if (!ribbon) return DEFAULT_EMA_CONFIG;
    const type = String(ribbon.ma_type ?? "ema").toLowerCase() === "sma" ? "sma" : "ema";
    return {
      length1: Number(ribbon.length1) || DEFAULT_EMA_CONFIG.length1,
      length2: Number(ribbon.length2) || DEFAULT_EMA_CONFIG.length2,
      length3: Number(ribbon.length3) || DEFAULT_EMA_CONFIG.length3,
      maType: type,
    };
  }

  private async buildPortfolio(focus: AiFocus, enabled: boolean): Promise<UnknownRecord> {
    if (!enabled) {
      return { enabled: false, note: "Portfolio context is disabled by the user." };
    }
    const coin = focus.symbol.split("/")[0] || focus.symbol;
    let position: Position | null = null;
    let orders: unknown[] = [];
    let error: string | null = null;
    try {
      position = await account.getPosition(coin);
    } catch (cause) {
      error = (cause as Error).message;
    }
    try {
      orders = await account.getOpenOrders(coin);
    } catch {
      /* orders are optional context */
    }
    return {
      enabled: true,
      coin,
      position,
      openOrders: orders,
      balance: null,
      balanceNote: "Account balance is not exposed by the trading backend.",
      error,
      capturedAtMs: Date.now(),
    };
  }

  private buildAnalysisPrompt(focus: AiFocus, context: BuiltContext): string {
    const ticket = this.handlers.ticket();
    const images = context.images.map((image) => image.timeframe).join(", ");
    const levelText = [ticket.limit && `LIM ${ticket.limit}`, ticket.tp && `TP ${ticket.tp}`, ticket.sl && `SL ${ticket.sl}`]
      .filter(Boolean)
      .join(", ");
    const missing = context.failures.length ? context.failures.join("; ") : "none";
    return [
      "Start analysis.",
      "",
      `Instrument: ${focus.symbol} · ${focus.exchange} · ${focus.market}`,
      `TradePanel chart timeframe: ${focus.timeframe}`,
      `Analysis renders: ${images || "none"}`,
      `Ticket (read-only): ${ticket.direction.toUpperCase()}${ticket.qty ? `, QTY ${ticket.qty}` : ""}${levelText ? `, ${levelText}` : ""}`,
      `Portfolio context: ${this.status.portfolioContext ? "enabled" : "disabled"}`,
      `Snapshot: ${new Date().toISOString()}`,
      `Missing screenshots: ${missing}`,
      "",
      "Read the attached images first. Then call panel_market_context and panel_indicators (and panel_portfolio when enabled).",
      "Use 1d/4h for context, then call panel_submit_trade_plan exactly once with a 5m long or short plan (entry/TP/SL) and an integer probability percentage.",
      "Do not write a verdict or repeat the plan in prose; the trade card is the answer.",
    ].join("\n");
  }

  // ── Transcript rendering ──────────────────────────────────────────────

  private addUserBubble(focus: AiFocus, images: SnapshotImage[]): void {
    const element = document.createElement("div");
    element.className = "ai-msg ai-msg-user";
    const text = document.createElement("div");
    text.className = "ai-msg-text";
    text.textContent = `Start analysis · ${focus.symbol} · ${focus.timeframe}`;
    element.appendChild(text);
    if (images.length) {
      const strip = document.createElement("div");
      strip.className = "ai-thumbs";
      for (const image of images) {
        const thumb = document.createElement("img");
        thumb.className = "ai-thumb";
        thumb.alt = `${image.timeframe} chart snapshot`;
        thumb.title = `${image.timeframe} · ${image.width}×${image.height}`;
        thumb.src = `data:image/png;base64,${image.base64}`;
        strip.appendChild(thumb);
      }
      element.appendChild(strip);
    }
    this.appendMessage(element);
  }

  private addUserBubbleText(text: string): void {
    const element = document.createElement("div");
    element.className = "ai-msg ai-msg-user";
    const body = document.createElement("div");
    body.className = "ai-msg-text";
    body.innerHTML = markdownToHtml(text);
    element.appendChild(body);
    this.appendMessage(element);
  }

  private addAssistantBubble(): void {
    this.finalizeAssistant();
    const element = document.createElement("div");
    element.className = "ai-msg ai-msg-assistant ai-streaming";
    const body = document.createElement("div");
    body.className = "ai-msg-text";
    const caret = document.createElement("span");
    caret.className = "ai-caret";
    caret.setAttribute("aria-hidden", "true");
    body.appendChild(caret);
    element.appendChild(body);
    this.appendMessage(element);
    this.assistant = { element, body, text: "", timer: null };
  }

  private addAssistantText(text: string): void {
    const element = document.createElement("div");
    element.className = "ai-msg ai-msg-assistant";
    const body = document.createElement("div");
    body.className = "ai-msg-text";
    body.innerHTML = markdownToHtml(text);
    element.appendChild(body);
    this.appendMessage(element);
  }

  private appendMessage(element: HTMLElement): void {
    const stick = this.atBottom();
    this.messages.appendChild(element);
    this.trimMessages();
    this.empty.hidden = true;
    if (stick) this.scrollToBottom(true);
  }

  private appendDelta(delta: string): void {
    if (!this.assistant) this.addAssistantBubble();
    if (!this.assistant) return;
    this.assistant.text += delta;
    if (this.assistant.timer !== null) return;
    this.assistant.timer = window.setTimeout(() => {
      if (!this.assistant) return;
      this.assistant.timer = null;
      const stick = this.atBottom();
      this.assistant.body.innerHTML = markdownToHtml(this.assistant.text);
      const caret = document.createElement("span");
      caret.className = "ai-caret";
      caret.setAttribute("aria-hidden", "true");
      this.assistant.body.appendChild(caret);
      if (stick) this.scrollToBottom(true);
    }, 70);
  }

  private finalizeAssistant(errorText?: string): void {
    if (!this.assistant) return;
    const current = this.assistant;
    this.assistant = null;
    if (current.timer !== null) window.clearTimeout(current.timer);
    current.element.classList.remove("ai-streaming");
    const text = current.text.trim();
    if (errorText) {
      current.body.innerHTML = markdownToHtml(text);
      current.element.classList.add("ai-msg-error");
      const error = document.createElement("div");
      error.className = "ai-msg-error-text";
      error.textContent = errorText;
      current.body.appendChild(error);
      return;
    }
    if (!text) {
      current.element.remove();
      this.showEmpty();
      return;
    }
    current.body.innerHTML = markdownToHtml(text);
  }

  private addSystemRow(text: string, spinning: boolean): { setText: (value: string) => void; remove: () => void } {
    const element = document.createElement("div");
    element.className = "ai-system";
    if (spinning) {
      const spinner = document.createElement("span");
      spinner.className = "ai-spinner";
      spinner.setAttribute("aria-hidden", "true");
      element.appendChild(spinner);
    }
    const label = document.createElement("span");
    label.textContent = text;
    element.appendChild(label);
    this.appendMessage(element);
    return {
      setText: (value: string) => {
        label.textContent = value;
      },
      remove: () => {
        element.remove();
        this.showEmpty();
      },
    };
  }

  private showError(message: string): void {
    const row = this.addSystemRow(message, false);
    const element = this.messages.lastElementChild as HTMLElement | null;
    if (element) element.classList.add("ai-system-error");
    row.setText(message);
    toast(message, "error");
  }

  private showFatal(message: string): void {
    this.setDot("error");
    this.emptyTitle.textContent = "AI Analysis unavailable";
    this.emptyText.textContent = message;
    this.empty.hidden = false;
  }

  private toolRow(event: AiEvent, running: boolean): void {
    const id = String(event.toolCallId ?? "");
    const name = String(event.toolName ?? "tool");
    const label = TOOL_LABELS[name] ?? name;
    let row = this.toolRows.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "ai-tool";
      row.dataset.state = "running";
      const icon = iconSpan(TOOL_ICONS[name] ?? "ai-sparkle", 14, "ai-tool-icon");
      const text = document.createElement("span");
      text.className = "ai-tool-label";
      row.append(icon, text);
      this.appendMessage(row);
      this.toolRows.set(id, row);
    }
    const text = row.querySelector(".ai-tool-label");
    if (text) text.textContent = label;
    if (!running) {
      const isError = Boolean(event.isError);
      row.dataset.state = isError ? "error" : "done";
      const duration = Number(event.durationMs);
      if (Number.isFinite(duration) && duration > 0) {
        if (text) text.textContent = `${label} · ${Math.round(duration)}ms`;
      }
      if (isError) row.title = "This tool call failed; the model was told why.";
      this.toolRows.delete(id);
    }
  }

  private showPlan(plan: AiTradePlan, scroll = true): void {
    const element = this.buildPlan(plan);
    if (!element) return;
    const stick = this.atBottom();
    this.messages.appendChild(element);
    this.trimMessages();
    if (scroll && stick) this.scrollToBottom(true);
  }

  /**
   * Instrument the plan belongs to. The captured analysis focus wins so a
   * later chart switch cannot send the overlay to the wrong symbol; history
   * replays without that context and let the workspace resolve by symbol.
   */
  private planInstrument(plan: AiTradePlan): AiFocus | null {
    const symbol = (plan.symbol ?? "").trim().toUpperCase();
    const candidates = [this.planFocus, this.focus, this.handlers.focus()];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (!symbol || candidate.symbol.trim().toUpperCase() === symbol) {
        return { ...candidate };
      }
    }
    return null;
  }

  private buildPlan(plan: AiTradePlan): HTMLElement | null {
    if (!plan || !["long", "short", "no-trade"].includes(plan.action as AiPlanAction)) return null;
    const element = document.createElement("div");
    element.className = "ai-plan";
    element.dataset.action = plan.action;

    const head = document.createElement("div");
    head.className = "ai-plan-head";
    const badge = document.createElement("span");
    badge.className = "ai-plan-badge";
    badge.textContent = plan.action === "no-trade" ? "NO TRADE" : plan.action.toUpperCase();
    const probability =
      typeof plan.probability === "number" && Number.isFinite(plan.probability)
        ? Math.round(plan.probability)
        : null;
    const meta = document.createElement("span");
    meta.className = "ai-plan-meta";
    meta.textContent = [
      plan.symbol,
      plan.basisTimeframe || plan.timeframe,
      probability === null ? plan.confidence : "",
      typeof plan.riskReward === "number" ? `R:R ${plan.riskReward}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    head.append(badge);
    if (probability !== null) {
      const chance = document.createElement("span");
      chance.className = "ai-plan-prob";
      chance.textContent = `${probability}% probability`;
      chance.title =
        "Estimated chance that take-profit is reached before stop-loss. " +
        "This is the model's estimate from the supplied data, not a guarantee.";
      head.appendChild(chance);
    }
    head.appendChild(meta);
    element.appendChild(head);

    if (plan.action !== "no-trade") {
      const grid = document.createElement("div");
      grid.className = "ai-plan-grid";
      const cells: Array<[string, string, string]> = [
        ["Entry", planPrice(plan.entry), ""],
        ["Take profit", planPrice(plan.takeProfit), "ok"],
        ["Stop loss", planPrice(plan.stopLoss), "bad"],
        ["Qty", planQty(plan.qty), ""],
      ];
      for (const [label, value, tone] of cells) {
        const cell = document.createElement("div");
        cell.className = "ai-plan-cell";
        const caption = document.createElement("span");
        caption.textContent = label;
        const strong = document.createElement("strong");
        strong.className = tone ? `ai-${tone}` : "";
        strong.textContent = value;
        cell.append(caption, strong);
        grid.appendChild(cell);
      }
      element.appendChild(grid);
    }

    const rationale = document.createElement("p");
    rationale.className = "ai-plan-rationale";
    rationale.textContent = plan.rationale;
    element.appendChild(rationale);

    if (plan.action !== "no-trade") {
      const actions = document.createElement("div");
      actions.className = "ai-plan-actions";
      // Resolve the instrument now: the plan belongs to the analysis that
      // produced it, not to whichever chart happens to be focused later.
      const instrument = this.planInstrument(plan);
      const fill = document.createElement("button");
      fill.type = "button";
      fill.className = "ghost-btn mini";
      fill.textContent = "Fill ticket";
      fill.title = "Copy the levels into the order form. It does not submit an order.";
      fill.addEventListener("click", () => {
        this.handlers.applyPlan(plan);
        toast("Ticket filled — review the levels and submit manually.", "success");
      });
      const overlay = document.createElement("button");
      overlay.type = "button";
      overlay.className = "ghost-btn mini";
      overlay.textContent = "Show on chart";
      overlay.title =
        `Draw this ${plan.action} as a position box on ${plan.symbol || "its"} chart. ` +
        "It does not fill the ticket or submit an order.";
      overlay.addEventListener("click", () => {
        this.handlers.showPlanOnChart(plan, instrument);
      });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-btn mini";
      copy.textContent = "Copy levels";
      copy.addEventListener("click", () => {
        const text = `${plan.action.toUpperCase()} ${plan.symbol ?? ""} entry=${planPrice(plan.entry)} tp=${planPrice(plan.takeProfit)} sl=${planPrice(plan.stopLoss)} qty=${planQty(plan.qty)}${probability !== null ? ` probability=${probability}%` : ""}`;
        const clipboard = navigator.clipboard;
        if (!clipboard) {
          toast("Clipboard is unavailable.", "error");
          return;
        }
        void clipboard
          .writeText(text)
          .then(() => toast("Levels copied.", "success"))
          .catch(() => toast("Clipboard is unavailable.", "error"));
      });
      actions.append(fill, overlay, copy);
      element.appendChild(actions);
    }

    const warning = document.createElement("p");
    warning.className = "ai-plan-warning";
    warning.textContent = "Read-only analysis. Verify levels and risk before trading.";
    element.appendChild(warning);
    return element;
  }

  // ── Pi events ─────────────────────────────────────────────────────────

  private handleEvent(event: AiEvent): void {
    switch (event.type) {
      case "agent_start":
        this.setStreaming(true);
        break;
      case "message_start": {
        const role = (event.message as { role?: string } | undefined)?.role;
        if (role === "assistant") this.addAssistantBubble();
        break;
      }
      case "message_update": {
        const update = event.assistantMessageEvent as
          | { type?: string; delta?: string; content?: string }
          | undefined;
        if (!update) break;
        if (update.type === "text_delta" && update.delta) this.appendDelta(update.delta);
        else if (update.type === "text_end" && update.content && this.assistant) {
          this.assistant.text = update.content;
          this.appendDelta("");
        }
        break;
      }
      case "message_end": {
        const message = event.message as
          | { role?: string; stopReason?: string; errorMessage?: string }
          | undefined;
        if (message?.role !== "assistant") break;
        if (message.stopReason === "error") {
          this.finalizeAssistant(message.errorMessage || "The provider returned an error.");
        } else if (message.stopReason === "aborted") {
          this.finalizeAssistant();
          this.addSystemRow("Generation stopped.", false);
        } else {
          const text = messageText(message);
          if (this.assistant && text.trim()) this.assistant.text = text;
          this.finalizeAssistant();
        }
        break;
      }
      case "tool_execution_start":
        this.toolRow(event, true);
        break;
      case "tool_execution_end": {
        this.toolRow(event, false);
        if (event.toolName === "panel_submit_trade_plan" && !event.isError) {
          const result = event.result as { details?: { plan?: AiTradePlan } } | undefined;
          const plan = result?.details?.plan;
          if (plan) this.showPlan(plan);
        }
        break;
      }
      case "agent_settled":
        this.setStreaming(false);
        this.finalizeAssistant();
        break;
      case "auto_retry_start":
        this.addSystemRow(`Provider retry ${String(event.attempt ?? "")}/${String(event.maxAttempts ?? "")}…`, true);
        break;
      case "auto_retry_end":
        if (event.success === false) {
          this.addSystemRow(`Retry failed: ${String(event.finalError ?? "unknown error")}`, false);
        }
        break;
      case "compaction_start":
        this.addSystemRow("Compacting conversation context…", true);
        break;
      case "compaction_end":
        this.addSystemRow("Conversation context compacted.", false);
        break;
      case "extension_error":
        this.showError(`Extension error: ${String(event.error ?? "unknown")}`);
        break;
      case "process_exit":
        this.setStreaming(false);
        this.showError("The AI runtime stopped unexpectedly. Your trading session is unaffected; start again when ready.");
        break;
      default:
        break;
    }
  }

  private setStreaming(streaming: boolean): void {
    this.streaming = streaming;
    this.setDot(streaming ? "streaming" : this.dotTone(this.status));
    this.updateControls();
    this.renderComposeHint();
    if (!streaming) this.finalizeAssistant();
  }

  /** Mirror the header indicator onto the AI tab so a background run stays
   *  visible while the trade ticket is on screen. */
  private setDot(tone: string): void {
    this.dot.className = `ai-dot ${tone}`;
    this.sidebarRoot?.setAttribute("data-ai-state", tone);
  }

  // ── Conversations ─────────────────────────────────────────────────────

  private async loadConversation(id: string, scroll = true): Promise<void> {
    try {
      this.conversations = await ai.activateConversation(id);
      const payload = await ai.getHistory();
      this.clearMessages();
      this.planFocus = null;
      let plan: AiTradePlan | null = null;
      let started = false;
      let lastAssistantAt = 0;
      for (const raw of payload.messages as UnknownRecord[]) {
        const role = String(raw.role ?? "");
        if (role === "plan") {
          plan = raw.plan as AiTradePlan;
          continue;
        }
        if (role === "user") {
          const text = messageText(raw);
          if (text.trim()) {
            started = true;
            this.addUserBubbleText(this.compactUserText(text));
            const timestamp = Number(raw.timestamp);
            if (Number.isFinite(timestamp)) lastAssistantAt = Math.max(lastAssistantAt, timestamp);
          }
          continue;
        }
        if (role === "assistant") {
          const text = messageText(raw);
          if (text.trim()) {
            this.addAssistantText(text);
            const timestamp = Number(raw.timestamp);
            if (Number.isFinite(timestamp)) lastAssistantAt = Math.max(lastAssistantAt, timestamp);
          }
        }
      }
      this.analysisStarted = started;
      if (plan) this.showPlan(plan, false);
      if (!this.hasMessages()) this.showEmpty();
      if (lastAssistantAt > 0) this.lastSnapshotAt = lastAssistantAt;
      if (scroll) this.scrollToBottom(true);
      this.renderConversations();
      this.updateControls();
      this.setView("chat");
    } catch (error) {
      this.showError((error as Error).message);
    }
  }

  private compactUserText(text: string): string {
    if (!text.startsWith("Start analysis")) return text;
    const instrument = /Instrument:\s*(.+)/.exec(text)?.[1]?.trim() ?? "chart";
    return `Start analysis · ${instrument}`;
  }

  private renderConversations(): void {
    this.conversationList.replaceChildren();
    if (!this.conversations.items.length) {
      const empty = document.createElement("p");
      empty.className = "ai-muted";
      empty.textContent = "No conversations yet. Start an analysis to create one.";
      this.conversationList.appendChild(empty);
      return;
    }
    for (const conversation of [...this.conversations.items].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs,
    )) {
      this.conversationList.appendChild(this.conversationRow(conversation));
    }
    this.newConversation.disabled = this.streaming;
  }

  private conversationRow(conversation: AiConversation): HTMLElement {
    const row = document.createElement("div");
    row.className = "ai-conv";
    if (conversation.id === this.conversations.active) row.dataset.active = "true";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-conv-main";
    const title = document.createElement("span");
    title.className = "ai-conv-title";
    title.textContent = conversation.title;
    const meta = document.createElement("span");
    meta.className = "ai-conv-meta";
    meta.textContent = [relativeTime(conversation.updatedAtMs), conversation.model]
      .filter(Boolean)
      .join(" · ");
    button.append(title, meta);
    button.disabled = this.streaming && conversation.id !== this.conversations.active;
    button.addEventListener("click", () => {
      if (conversation.id === this.conversations.active) {
        this.setView("chat");
        return;
      }
      void this.loadConversation(conversation.id);
    });

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "icon-btn ai-conv-action";
    rename.title = "Rename conversation";
    rename.setAttribute("aria-label", "Rename conversation");
    setIcon(rename, "menu-manage-layouts-rename", 15);
    rename.addEventListener("click", () => this.beginRename(row, conversation));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn ai-conv-action ai-conv-delete";
    remove.title = "Delete conversation";
    remove.setAttribute("aria-label", "Delete conversation");
    setIcon(remove, "scr-trash", 15);
    remove.addEventListener("click", () => {
      if (remove.dataset.confirm !== "true") {
        remove.dataset.confirm = "true";
        remove.classList.add("is-confirm");
        remove.title = "Click again to delete";
        window.setTimeout(() => {
          remove.dataset.confirm = "";
          remove.classList.remove("is-confirm");
          remove.title = "Delete conversation";
        }, 3000);
        return;
      }
      void this.deleteConversation(conversation.id);
    });

    row.append(button, rename, remove);
    return row;
  }

  private beginRename(row: HTMLElement, conversation: AiConversation): void {
    const main = row.querySelector(".ai-conv-main");
    if (!main) return;
    const input = document.createElement("input");
    input.className = "ai-conv-rename mono";
    input.value = conversation.title;
    input.maxLength = 80;
    main.replaceWith(input);
    input.focus();
    input.select();
    const finish = async (save: boolean): Promise<void> => {
      const value = input.value.trim();
      if (save && value && value !== conversation.title) {
        try {
          this.conversations = await ai.renameConversation(conversation.id, value);
          this.renderConversations();
          return;
        } catch (error) {
          toast((error as Error).message, "error");
        }
      }
      this.renderConversations();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true));
  }

  private async deleteConversation(id: string): Promise<void> {
    const wasActive = this.conversations.active === id;
    try {
      this.conversations = await ai.deleteConversation(id);
      this.renderConversations();
      if (!wasActive) return;
      this.clearMessages();
      this.analysisStarted = false;
      this.lastSnapshotAt = 0;
      this.updateFreshness();
      const next = this.conversations.active;
      if (next) {
        await this.loadConversation(next, false);
      } else {
        this.showEmpty();
        this.updateControls();
      }
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────

  async refreshSettings(): Promise<void> {
    try {
      this.applyStatus(await ai.getStatus());
    } catch {
      /* keep the last known status; diagnostics below reports the error */
    }
    this.thinkingSelect.value = this.status.thinking || "medium";
    this.settingsPortfolio.checked = this.status.portfolioContext;
    this.renderAuthCurrent();
    await this.refreshDiagnostics();
    await this.loadAuth();
  }

  /** Load the provider catalogue and stored credentials from Pi's runtime. */
  private async loadAuth(): Promise<void> {
    try {
      const catalogue = await ai.getAuthProviders();
      this.authReady = catalogue.ready;
      this.authReason = catalogue.reason;
      this.authProviders = catalogue.providers;
      this.authCredentials = catalogue.credentials;
      this.providers = catalogue.providers.map((provider) => ({ id: provider.id, label: provider.name }));
      this.renderProviders();
      this.renderAuthList();
      this.renderAuthCredentials();
      const preferred = this.status.provider
        || this.authCredentials[0]?.providerId
        || this.authProviders.find((provider) => provider.configured)?.id
        || this.authProviders[0]?.id
        || "";
      if (!this.providerSelect.value && preferred) this.providerSelect.value = preferred;
      this.renderAuthCurrent();
      await this.loadAuthModels(false);
    } catch (error) {
      this.authReady = false;
      this.authReason = (error as Error).message;
      this.renderAuthList();
      this.renderAuthCurrent();
    }
  }

  /** Models unlocked by the credentials Pi currently has. */
  private async loadAuthModels(announce: boolean): Promise<void> {
    try {
      this.authModels = await ai.getAuthModels();
      this.renderModelOptions();
      if (announce) {
        const count = this.authModels.filter((model) => model.provider === this.providerSelect.value).length;
        this.authLoginStatus.textContent = count
          ? `${count} model${count === 1 ? "" : "s"} available.`
          : "No models yet — sign in first.";
        this.authLoginStatus.dataset.tone = count ? "ok" : "info";
      }
    } catch (error) {
      this.authModels = [];
      this.renderModelOptions();
      if (announce) {
        this.authLoginStatus.textContent = (error as Error).message;
        this.authLoginStatus.dataset.tone = "error";
      }
    }
  }

  private renderProviders(): void {
    const selected = this.providerSelect.value || this.status.provider || "";
    this.providerSelect.replaceChildren();
    for (const provider of this.providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      this.providerSelect.appendChild(option);
    }
    // Keep a configured provider that Pi reports under a different id (or a
    // runtime that has not loaded the catalogue) visible instead of silently
    // switching the model.
    if (selected && !this.providers.some((provider) => provider.id === selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = this.status.providerLabel || selected;
      this.providerSelect.appendChild(option);
    }
    if (selected) this.providerSelect.value = selected;
  }

  private renderModelOptions(): void {
    const provider = this.providerSelect.value;
    const previous = this.modelSelect.value || (this.status.provider === provider ? this.status.model || "" : "");
    const all = this.authModels
      .filter((model) => !provider || model.provider === provider)
      .sort((a, b) => a.name.localeCompare(b.name));
    // The analysis attaches three screenshots. Prefer models that declare
    // image input; a provider that does not declare it may still accept them,
    // so fall back to its full list rather than showing an empty selector.
    const imageModels = all.filter((model) => model.input.includes("image"));
    const models = imageModels.length ? imageModels : all;
    this.modelSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = models.length
      ? "Choose a model"
      : provider
        ? "Sign in to list models"
        : "Choose a provider first";
    this.modelSelect.appendChild(placeholder);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name === model.id ? model.id : `${model.name} · ${model.id}`;
      option.title = [
        model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k context` : "",
        model.reasoning ? "reasoning" : "",
        model.input.includes("image") ? "images" : "",
      ].filter(Boolean).join(" · ");
      this.modelSelect.appendChild(option);
    }
    if (previous && models.some((model) => model.id === previous)) {
      this.modelSelect.value = previous;
    } else if (previous) {
      // A model configured in Pi's models.json (custom endpoint) is not in the
      // runtime catalogue. Keep it selectable instead of silently replacing it.
      const custom = document.createElement("option");
      custom.value = previous;
      custom.textContent = `${previous} (custom)`;
      this.modelSelect.appendChild(custom);
      this.modelSelect.value = previous;
    } else if (models.length) {
      // Prefer an image-capable model: analysis depends on the three chart
      // screenshots being visible to the model.
      this.modelSelect.value = (models.find((model) => model.input.includes("image")) || models[0]).id;
    }
  }

  private renderAuthCurrent(): void {
    if (!this.authReady) {
      this.authCurrent.dataset.tone = "error";
      this.authCurrent.textContent = this.authReason || "Provider settings are unavailable.";
      return;
    }
    const provider = this.authProviders.find((entry) => entry.id === this.providerSelect.value);
    if (!provider) {
      this.authCurrent.dataset.tone = "idle";
      this.authCurrent.textContent = this.providerSelect.options.length
        ? "Choose a provider to sign in."
        : "Loading providers…";
      return;
    }
    this.authCurrent.dataset.tone = provider.configured ? "ok" : "idle";
    this.authCurrent.textContent = provider.configured
      ? `${provider.name} · ${provider.statusLabel || "signed in"}`
      : `${provider.name} · not signed in`;
  }

  private renderAuthList(): void {
    this.authList.replaceChildren();
    if (!this.authReady) {
      const message = document.createElement("p");
      message.className = "ai-set-note";
      message.textContent = this.authReason || "Provider sign-in is unavailable.";
      this.authList.appendChild(message);
      return;
    }
    if (!this.authProviders.length) {
      const message = document.createElement("p");
      message.className = "ai-set-note";
      message.textContent = "Loading providers…";
      this.authList.appendChild(message);
      return;
    }
    const query = this.authQuery.trim().toLowerCase();
    const providers = this.authProviders
      .filter(
        (provider) =>
          !query ||
          provider.name.toLowerCase().includes(query) ||
          provider.id.toLowerCase().includes(query),
      )
      // Signed-in providers first: the list is long, and the one the user
      // came to manage should not be buried below 30 unconfigured entries.
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
    if (!providers.length) {
      const message = document.createElement("p");
      message.className = "ai-set-note";
      message.textContent = `No providers match “${this.authQuery.trim()}”.`;
      this.authList.appendChild(message);
      return;
    }
    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "ai-auth-prov";
      const main = document.createElement("div");
      main.className = "ai-auth-prov-main";
      const name = document.createElement("span");
      name.className = "ai-auth-prov-name";
      name.textContent = provider.name;
      main.appendChild(name);
      const status = document.createElement("span");
      status.className = "ai-auth-chip";
      status.dataset.tone = provider.configured ? "ok" : "idle";
      status.textContent = provider.configured ? provider.statusLabel || "signed in" : "not configured";
      main.appendChild(status);
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "ai-auth-prov-actions";
      for (const method of provider.methods) {
        if (!method.canLogin) {
          const note = document.createElement("span");
          note.className = "ai-auth-none";
          note.textContent = method.label;
          note.title = `${method.label} — configured outside Pi`;
          actions.appendChild(note);
          continue;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = method.type === "oauth" ? "primary-btn mini" : "ghost-btn mini";
        button.textContent = method.type === "oauth" ? "Sign in" : "API key";
        button.title = method.label;
        button.addEventListener("click", () => void this.startAuth(provider.id, method.type));
        actions.appendChild(button);
      }
      row.appendChild(actions);
      this.authList.appendChild(row);
    }
  }

  private renderAuthCredentials(): void {
    this.credentialsList.replaceChildren();
    if (!this.authCredentials.length) {
      const message = document.createElement("p");
      message.className = "ai-set-note";
      message.textContent = "No provider credentials stored yet.";
      this.credentialsList.appendChild(message);
      return;
    }
    for (const credential of this.authCredentials) {
      const row = document.createElement("div");
      row.className = "ai-auth-cred";
      const name = document.createElement("span");
      name.className = "ai-auth-cred-name";
      name.textContent = credential.name;
      row.appendChild(name);
      const chip = document.createElement("span");
      chip.className = "ai-auth-chip";
      chip.dataset.tone = "ok";
      chip.textContent = credential.type === "oauth" ? "OAuth" : "API key";
      row.appendChild(chip);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-btn mini";
      button.textContent = "Sign out";
      button.addEventListener("click", () => void this.logoutAuth(credential.providerId));
      row.appendChild(button);
      this.credentialsList.appendChild(row);
    }
  }

  private authSignature(session: AiAuthSession | null): string {
    if (!session) return "";
    return `${session.id}|${session.status}|${session.prompt ? session.prompt.id : 0}|${session.prompt ? "-" : session.events.length}`;
  }

  private applyAuthSession(session: AiAuthSession): void {
    const previous = this.authSession;
    const wasRunning = previous?.status === "running";
    this.authSession = session;
    if (session.status !== "running") this.stopAuthPoll();
    const signature = this.authSignature(session);
    if (signature !== this.authSig) {
      this.authSig = signature;
      this.renderAuthLogin();
    }
    if (session.status === "ok" && previous?.status !== "ok") {
      void this.authFinished(session);
    } else if (session.status === "error" && previous?.status !== "error") {
      this.authLoginStatus.textContent = session.error || "Sign-in failed.";
      this.authLoginStatus.dataset.tone = "error";
    } else if (session.status === "cancelled" && wasRunning) {
      this.authLoginStatus.textContent = "Sign-in cancelled.";
      this.authLoginStatus.dataset.tone = "info";
    }
  }

  private renderAuthLogin(): void {
    const session = this.authSession;
    this.authLogin.hidden = !session;
    if (!session) return;
    this.authLoginTitle.textContent = `Sign in to ${session.providerName}`;
    this.authCancel.textContent = session.status === "running" ? "Cancel" : "Close";
    this.authLoginEvents.replaceChildren();
    for (const event of session.events) {
      this.authLoginEvents.appendChild(this.authEventRow(event));
    }
    this.authLoginPrompt.replaceChildren();
    if (session.prompt) this.authLoginPrompt.appendChild(this.authPromptRow(session.prompt));
    if (session.status === "running") {
      this.authLoginStatus.textContent = session.prompt
        ? session.prompt.message
        : "Waiting for the provider…";
      this.authLoginStatus.dataset.tone = "info";
    } else if (session.status === "ok") {
      this.authLoginStatus.textContent = "Signed in. Credentials saved to Pi's auth.json.";
      this.authLoginStatus.dataset.tone = "ok";
    } else if (session.status === "error") {
      this.authLoginStatus.textContent = session.error || "Sign-in failed.";
      this.authLoginStatus.dataset.tone = "error";
    } else {
      this.authLoginStatus.textContent = "Sign-in cancelled.";
      this.authLoginStatus.dataset.tone = "info";
    }
  }

  private authEventRow(event: AiAuthEvent): HTMLElement {
    const row = document.createElement("div");
    row.className = "ai-auth-event";
    if (event.type === "auth_url" && event.url) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "ai-auth-link";
      link.textContent = "Open sign-in page ↗";
      link.addEventListener("click", () => void shell.openExternalUrl(event.url!));
      row.appendChild(link);
      if (event.instructions) {
        const note = document.createElement("div");
        note.className = "ai-auth-event-note";
        note.textContent = event.instructions;
        row.appendChild(note);
      }
      return row;
    }
    if (event.type === "device_code" && event.userCode && event.verificationUri) {
      const text = document.createElement("span");
      text.textContent = "Enter code ";
      const code = document.createElement("code");
      code.textContent = event.userCode;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ghost-btn mini";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(event.userCode!).then(() => {
          copy.textContent = "Copied";
          window.setTimeout(() => (copy.textContent = "Copy"), 1200);
        }).catch(() => toast("Copy the code manually.", "info"));
      });
      const open = document.createElement("button");
      open.type = "button";
      open.className = "ai-auth-link";
      open.textContent = "Open page ↗";
      open.addEventListener("click", () => void shell.openExternalUrl(event.verificationUri!));
      row.append(text, code, copy, open);
      return row;
    }
    if (event.type === "info") {
      const text = document.createElement("span");
      text.textContent = event.message || "";
      row.appendChild(text);
      for (const link of event.links || []) {
        const anchor = document.createElement("button");
        anchor.type = "button";
        anchor.className = "ai-auth-link";
        anchor.textContent = link.label || link.url;
        anchor.addEventListener("click", () => void shell.openExternalUrl(link.url));
        row.appendChild(anchor);
      }
      return row;
    }
    row.classList.add("ai-auth-event-progress");
    row.textContent = event.message || "Working…";
    return row;
  }

  private authPromptRow(prompt: AiAuthPrompt): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ai-auth-prompt";
    const message = document.createElement("div");
    message.className = "ai-auth-prompt-msg";
    message.textContent = prompt.message;
    wrap.appendChild(message);
    if (prompt.type === "select" && prompt.options?.length) {
      const choices = document.createElement("div");
      choices.className = "ai-auth-choices";
      for (const option of prompt.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "primary-btn mini";
        button.textContent = option.label;
        button.title = option.description || option.label;
        button.addEventListener("click", () => void this.answerAuth(option.id));
        choices.appendChild(button);
      }
      wrap.appendChild(choices);
      return wrap;
    }
    const row = document.createElement("div");
    row.className = "ai-auth-input-row";
    const input = document.createElement("input");
    input.type = prompt.type === "secret" ? "password" : "text";
    input.className = "ai-input mono";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = prompt.placeholder || "";
    input.value = this.authDraft;
    input.setAttribute("aria-label", prompt.message);
    input.addEventListener("input", () => {
      this.authDraft = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.answerAuth(input.value);
      }
    });
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "primary-btn mini";
    submit.textContent = "Submit";
    submit.addEventListener("click", () => void this.answerAuth(input.value));
    row.append(input, submit);
    wrap.appendChild(row);
    window.setTimeout(() => input.focus(), 0);
    return wrap;
  }

  private async startAuth(provider: string, authType: "oauth" | "api_key"): Promise<void> {
    this.authDraft = "";
    this.stopAuthPoll();
    this.authSession = null;
    this.authSig = "";
    try {
      const session = await ai.authStart(provider, authType);
      this.applyAuthSession(session);
      this.ensureAuthPoll();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async answerAuth(value: string): Promise<void> {
    const session = this.authSession;
    if (!session?.prompt) return;
    const prompt = session.prompt;
    if (prompt.type !== "select" && !value.trim()) {
      this.authLoginStatus.textContent = "Enter a value before submitting.";
      this.authLoginStatus.dataset.tone = "error";
      return;
    }
    const promptId = prompt.id;
    this.authDraft = "";
    try {
      const next = await ai.authAnswer(session.id, promptId, value);
      this.applyAuthSession(next);
      this.ensureAuthPoll();
    } catch (error) {
      this.authLoginStatus.textContent = (error as Error).message;
      this.authLoginStatus.dataset.tone = "error";
    }
  }

  private async cancelAuth(): Promise<void> {
    const session = this.authSession;
    if (!session) return;
    if (session.status === "running") {
      try {
        const next = await ai.authCancel(session.id);
        this.applyAuthSession(next);
      } catch (error) {
        toast((error as Error).message, "error");
      }
    }
    this.stopAuthPoll();
    this.authSession = null;
    this.authSig = "";
    this.authLogin.hidden = true;
  }

  private async authFinished(session: AiAuthSession): Promise<void> {
    await this.loadAuth();
    this.providerSelect.value = session.providerId;
    this.renderAuthCurrent();
    await this.loadAuthModels(false);
    const model = this.modelSelect.value;
    if (!model) {
      this.authLoginStatus.textContent = `Signed in to ${session.providerName}, but no models were reported. Use Refresh.`;
      this.authLoginStatus.dataset.tone = "info";
      return;
    }
    try {
      const saved = await ai.savePreferences({
        provider: session.providerId,
        model,
        thinking: this.thinkingSelect.value,
        portfolioContext: this.settingsPortfolio.checked,
      });
      this.status.provider = saved.provider;
      this.status.model = saved.model;
      this.status = await ai.getStatus();
      this.applyStatus(this.status);
      this.authLoginStatus.textContent = `Signed in. Using ${model}.`;
      this.authLoginStatus.dataset.tone = "ok";
      toast(`Signed in to ${session.providerName}.`, "success");
    } catch (error) {
      this.authLoginStatus.textContent = (error as Error).message;
      this.authLoginStatus.dataset.tone = "error";
    }
  }

  private async logoutAuth(provider: string): Promise<void> {
    try {
      const catalogue = await ai.authLogout(provider);
      this.authProviders = catalogue.providers;
      this.authCredentials = catalogue.credentials;
      this.renderAuthList();
      this.renderAuthCredentials();
      this.renderAuthCurrent();
      this.status = await ai.getStatus();
      this.applyStatus(this.status);
      await this.loadAuthModels(false);
      toast("Signed out.", "info");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async saveSettings(): Promise<void> {
    const provider = this.providerSelect.value;
    const model = this.modelSelect.value;
    if (!provider) {
      this.authLoginStatus.textContent = "Choose a provider first.";
      this.authLoginStatus.dataset.tone = "error";
      return;
    }
    this.settingsSave.disabled = true;
    try {
      await ai.savePreferences({
        provider,
        model: model || null,
        thinking: this.thinkingSelect.value,
        portfolioContext: this.settingsPortfolio.checked,
      });
      this.status = await ai.getStatus();
      this.applyStatus(this.status);
      this.renderAuthCurrent();
      toast(model ? "AI settings saved." : "Provider saved. Choose a model to analyse.", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      this.settingsSave.disabled = false;
    }
  }

  private ensureAuthPoll(): void {
    if (this.authPoll) return;
    this.authPoll = window.setInterval(() => {
      const session = this.authSession;
      if (!session || session.status !== "running") {
        this.stopAuthPoll();
        return;
      }
      void ai.authSession(session.id).then((next) => this.applyAuthSession(next)).catch(() => {});
    }, 700);
  }

  private stopAuthPoll(): void {
    if (this.authPoll) {
      window.clearInterval(this.authPoll);
      this.authPoll = null;
    }
  }

  private async refreshDiagnostics(): Promise<void> {
    try {
      const diagnostics = await ai.getDiagnostics();
      const lines = [
        `runtime: ${diagnostics.runtimeReady ? "ready" : "unavailable"}${diagnostics.runtimeError ? ` — ${diagnostics.runtimeError}` : ""}`,
        `node: ${diagnostics.nodeVersion ?? "—"}   pi: ${diagnostics.piVersion ?? "—"}   target: ${diagnostics.target ?? "—"}`,
        `provider auth: ${diagnostics.authReady ? "ready" : "unavailable"}${diagnostics.authError ? ` — ${diagnostics.authError}` : ""}`,
        `runtime root: ${diagnostics.runtimeRoot ?? "—"}`,
        `node path: ${diagnostics.nodePath ?? "—"}`,
        `pi cli: ${diagnostics.piCli ?? "—"}`,
        `agent dir: ${diagnostics.agentDir}`,
        `sessions: ${diagnostics.sessionsDir} (${diagnostics.sessionFiles} files)`,
        `context: ${diagnostics.contextFile}`,
        `last error: ${diagnostics.lastError ?? "none"}`,
      ];
      this.diagnostics.textContent = lines.join("\n");
    } catch (error) {
      this.diagnostics.textContent = (error as Error).message;
    }
  }

  // ── Context / freshness ───────────────────────────────────────────────

  private updateFreshness(): void {
    if (!this.lastSnapshotAt) {
      this.freshness.textContent = "no analysis";
      this.freshness.dataset.tone = "idle";
      return;
    }
    if (this.streaming) {
      this.freshness.textContent = "analysing";
      this.freshness.dataset.tone = "live";
      return;
    }
    const age = Date.now() - this.lastSnapshotAt;
    const seconds = Math.round(age / 1000);
    if (age < 60_000) {
      this.freshness.textContent = `fresh · ${seconds}s`;
      this.freshness.dataset.tone = "live";
    } else {
      this.freshness.textContent = `stale · ${Math.round(age / 60_000)}m`;
      this.freshness.dataset.tone = "warn";
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.startButton.addEventListener("click", () => void this.startAnalysis());
    this.stopButton.addEventListener("click", () => void this.stopGeneration());
    this.settingsButton.addEventListener("click", () => this.handlers.openSettings("ai"));
    this.historyButton.addEventListener("click", () =>
      this.setView(this.view === "history" ? "chat" : "history"),
    );
    this.historyBack.addEventListener("click", () => this.setView("chat"));
    this.diagnosticsRefresh.addEventListener("click", () => void this.refreshDiagnostics());
    this.settingsSave.addEventListener("click", () => void this.saveSettings());
    this.settingsRefresh.addEventListener("click", () => void this.refreshSettings());
    this.authCancel.addEventListener("click", () => void this.cancelAuth());
    this.authSearch.addEventListener("input", () => {
      this.authQuery = this.authSearch.value;
      this.renderAuthList();
    });
    this.providerSelect.addEventListener("change", () => {
      this.renderAuthCurrent();
      this.renderModelOptions();
    });
    this.newConversation.addEventListener("click", () => void this.newConversationFlow());
    this.expandButton.addEventListener("click", () => this.toggleExpanded());
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.panel.classList.contains("ai-expanded")) {
        this.setExpanded(false);
      }
    });
    this.compose.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendFollowUp();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendFollowUp();
      }
    });
    this.input.addEventListener("input", () => {
      this.autoGrow();
      this.sendButton.disabled = this.input.value.trim().length === 0 || this.streaming;
    });
    this.portfolioToggle.addEventListener("change", () => void this.togglePortfolio());
  }

  private autoGrow(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
  }

  private async togglePortfolio(): Promise<void> {
    const enabled = this.portfolioToggle.checked;
    try {
      await ai.savePreferences({ portfolioContext: enabled });
      this.settingsPortfolio.checked = enabled;
      this.status = await ai.getStatus();
      this.applyStatus(this.status);
    } catch (error) {
      this.portfolioToggle.checked = !enabled;
      toast((error as Error).message, "error");
    }
  }

  private async stopGeneration(): Promise<void> {
    this.stopButton.disabled = true;
    try {
      await ai.abort();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      this.stopButton.disabled = false;
    }
  }

  private setExpanded(expanded: boolean): void {
    this.panel.classList.toggle("ai-expanded", expanded);
    this.panel.closest(".trade-sidebar")?.classList.toggle("ai-expanded", expanded);
    this.expandButton.setAttribute("aria-pressed", String(expanded));
    this.expandButton.title = expanded ? "Restore panel width" : "Expand analysis panel";
  }

  private toggleExpanded(): void {
    const expanded = !this.panel.classList.contains("ai-expanded");
    this.setExpanded(expanded);
    if (expanded) this.input.focus();
  }

  private async newConversationFlow(): Promise<void> {
    if (this.streaming) {
      toast("Stop the current analysis first.", "info");
      return;
    }
    try {
      this.conversations = await ai.createConversation();
      this.clearMessages();
      this.analysisStarted = false;
      this.lastSnapshotAt = 0;
      this.updateFreshness();
      this.renderConversations();
      this.setView("chat");
      this.updateControls();
      this.input.focus();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
}
