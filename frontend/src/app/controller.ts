import * as account from "../services/account";
import * as ai from "../services/ai";
import * as backend from "../services/backend";
import * as credentials from "../services/credentials";
import * as marketData from "../services/market-data";
import * as settingsStore from "../services/settings";
import * as shell from "../services/shell";
import * as trading from "../services/trading";
import * as updates from "../services/updates";
import { formatExchangePrice } from "../lib/exchange-price";
import { openModal } from "../components/modal";
import { openSettingsPage, closeSettingsPage } from "../components/settings-page";
import { AiPanel, type AiFocus, type AiTicket } from "../components/ai-panel";
import { SidebarTabs } from "../components/sidebar-tabs";
import { toast } from "../components/toast";
import { WorkspaceHost } from "../workspace-host";
import type {
  AiTradePlan,
  BackendStatus,
  AiChartIndicator,
  Direction,
  ExchangeCatalog,
  MarketMeta,
  OpenOrder,
  Position,
  WindowState,
} from "../types";

const FALLBACK_TIMEFRAMES = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w", "1M",
];

const SIDEBAR_MIN_WIDTH = 248;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_DEFAULT_WIDTH = 296;
const SIDEBAR_WIDTH_KEY = "tp-sidebar-width";

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing shell element #${id}`);
  return node as T;
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function roundTripState(state: WindowState): WindowState {
  return {
    coin: state.coin,
    timeframe: state.timeframe,
    sidebar_collapsed: state.sidebar_collapsed,
    risk: state.risk,
    is_short: state.is_short,
    hyperliquid: state.hyperliquid,
    limit: state.limit,
    tp: state.tp,
    sl: state.sl,
  };
}

class AppController {
  private readonly coin = must<HTMLSelectElement>("coin");
  private readonly tf = must<HTMLSelectElement>("tf");
  private readonly qty = must<HTMLInputElement>("qty");
  private readonly risk = must<HTMLInputElement>("risk");
  private readonly limit = must<HTMLInputElement>("limit");
  private readonly tp = must<HTMLInputElement>("tp");
  private readonly sl = must<HTMLInputElement>("sl");
  private readonly directionBtn = must<HTMLButtonElement>("direction");
  private readonly directionLabel = must<HTMLElement>("direction-label");
  private readonly hyperliquid = must<HTMLInputElement>("hyperliquid");
  private readonly readOrder = must<HTMLButtonElement>("read-order");
  private readonly setOrder = must<HTMLButtonElement>("set-order");
  private readonly updateOrder = must<HTMLButtonElement>("update-order");
  private readonly refreshCoins = must<HTMLButtonElement>("refresh-coins");
  private readonly centerChart = must<HTMLButtonElement>("center-chart");
  private readonly openBrowser = must<HTMLButtonElement>("open-browser");
  private readonly pill = must<HTMLElement>("backend-pill");
  private readonly banner = must<HTMLElement>("backend-banner");
  private readonly bannerTitle = must<HTMLElement>("banner-title");
  private readonly bannerDetail = must<HTMLElement>("banner-detail");
  private readonly bannerRetry = must<HTMLButtonElement>("banner-retry");
  private readonly sidebar = must<HTMLElement>("trade-sidebar");
  private readonly sidebarBody = must<HTMLElement>("sidebar-body");
  private readonly sidebarResizer = must<HTMLElement>("sidebar-resizer");
  private readonly sidebarCollapse = must<HTMLButtonElement>("sidebar-collapse");
  private readonly sidebarExpand = must<HTMLButtonElement>("sidebar-expand");
  private readonly backendDot = must<HTMLElement>("backend-dot");
  private readonly centerRail = must<HTMLButtonElement>("center-chart-rail");
  private readonly refreshRail = must<HTMLButtonElement>("refresh-coins-rail");
  private readonly openBrowserRail = must<HTMLButtonElement>("open-browser-rail");
  private readonly hyperliquidRail = must<HTMLButtonElement>("hyperliquid-rail");
  private readonly venueLabel = must<HTMLElement>("trade-venue");
  private readonly frame = must<HTMLIFrameElement>("workspace-frame");
  private readonly workspaceError = must<HTMLElement>("workspace-error");
  private readonly workspaceErrorMessage = must<HTMLElement>("workspace-error-message");
  private readonly workspaceReload = must<HTMLButtonElement>("workspace-reload");
  private readonly workspaceLoading = must<HTMLElement>("workspace-loading");
  private readonly versionLabel = must<HTMLElement>("app-version");

  private readonly host: WorkspaceHost;
  private readonly aiPanel: AiPanel;
  private readonly sidebarTabs: SidebarTabs;
  private aiFocus: AiFocus | null = null;
  private aiChartIndicators: AiChartIndicator[] = [];
  private status: BackendStatus = {
    state: "starting",
    message: null,
    protocolVersion: null,
    backendVersion: null,
    pid: null,
    attempts: 0,
    updatedAtMs: 0,
  };
  private direction: Direction = "long";
  private focusExchange = trading.DEFAULT_VENUE.exchange;
  private focusMarket = trading.DEFAULT_VENUE.market;
  private focusSymbol = "";
  private exchangeCatalog: ExchangeCatalog | null = null;
  private coinList: string[] = [];
  private meta: MarketMeta | null = null;
  private bootstrapped = false;
  private sidebarCollapsed = false;
  private sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  private bootstrapPromise: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private orderPending = false;
  private lastReadyPid: number | null = null;
  private qtyRequest = 0;
  private readonly pricePrecision = new Map<string, trading.ExchangePricePrecision>();
  private readonly precisionRequests = new Map<
    string,
    Promise<trading.ExchangePricePrecision | null>
  >();

  constructor() {
    this.host = new WorkspaceHost(this.frame, {
      focusedChart: (symbol, exchange, market, timeframe, indicators) =>
        this.onFocusedChart(symbol, exchange, market, timeframe, indicators),
      positionDrawing: (direction, entry, tp, sl) =>
        this.applyLevels(direction, entry, tp, sl),
      tradeOverlay: (ok, message) => {
        if (message) toast(message, ok ? "success" : "error");
      },
      configRequested: () => void this.openSettingsDialog("ai"),
      openSettings: () => void this.openSettingsDialog("ai"),
      toggleTheme: () => this.toggleTheme(),
      toggleTopBar: () => this.toggleSidebar(),
      toggleFullscreen: () => void this.toggleFullscreen(),
      fullscreen: (enabled) => {
        void shell
          .setFullscreen(enabled)
          .then(() => this.host.setFullscreenState(enabled))
          .catch((error) => {
            toast(`Fullscreen failed: ${(error as Error).message}`, "error");
          });
      },
      ready: () => this.onWorkspaceReady(),
      failed: (message) => this.showWorkspaceError(message),
      log: (message) => shell.logFrontend("info", `workspace: ${message}`),
    });
    this.aiPanel = new AiPanel({
      focus: () => this.aiFocus,
      ticket: (): AiTicket => ({
        direction: this.direction,
        qty: this.qty.value,
        risk: this.risk.value,
        limit: this.limit.value,
        tp: this.tp.value,
        sl: this.sl.value,
      }),
      precision: (coin) =>
        this.loadPricePrecision(coin)
          .then((precision) => precision?.sz_decimals ?? null)
          .catch(() => null),
      applyPlan: (plan) => this.applyAiPlan(plan),
      showPlanOnChart: (plan, focus) => this.overlayAiTrade(plan, focus),
      chartIndicators: () =>
        this.aiChartIndicators.map((item) => ({ id: item.id, inputs: item.inputs })),
      openSettings: () => void this.openSettingsDialog("ai"),
      closeSettings: () => closeSettingsPage(),
      log: (message) => shell.logFrontend("info", `ai: ${message}`),
    });
    // Trade and AI analysis are separate views of the same column. Switching
    // away from AI restores the ticket width; switching back re-pins the
    // transcript to the newest message.
    this.sidebarTabs = new SidebarTabs(must<HTMLElement>("sidebar-tabs"), (tab) => {
      if (tab === "ai") this.aiPanel.onShow();
      else this.aiPanel.onHide();
    });
  }

  start(): void {
    shell.logFrontend("info", "shell boot: initialising TradePanel UI");
    this.bindEvents();
    this.updateDirection();
    this.updateTradingEnabled();
    void backend
      .onBackendStatus((status) => this.applyStatus(status))
      .catch((error) => toast(`Status channel unavailable: ${(error as Error).message}`, "error"));
    void backend
      .onBackendEvent((event) => {
        shell.logFrontend("info", `backend event: ${event.method}`);
      })
      .catch(() => undefined);
    void backend
      .onAppNotice((notice) => {
        const level = notice.level === "error" ? "error" : notice.level === "warn" ? "info" : "info";
        toast(notice.message, level);
      })
      .catch(() => undefined);
    void backend
      .fetchBackendStatus()
      .then((status) => this.applyStatus(status))
      .catch((error) => {
        this.applyStatus({
          state: "failed",
          message: (error as Error).message,
          protocolVersion: null,
          backendVersion: null,
          pid: null,
          attempts: 0,
          updatedAtMs: 0,
        });
      });
    void backend
      .getAppInfo()
      .then((info) => {
        this.versionLabel.textContent = `v${info.version} · proto ${info.protocolVersion}`;
        this.versionLabel.title = `Data directory: ${info.dataDir}`;
      })
      .catch(() => undefined);
  }

  // ── Status / bootstrap ────────────────────────────────────────────────

  private applyStatus(status: BackendStatus): void {
    // Status events can race the initial `fetchBackendStatus()` call; the
    // emission timestamp is authoritative so a stale "starting" event can
    // never overwrite a newer "running" state.
    if (status.updatedAtMs && status.updatedAtMs < this.status.updatedAtMs) {
      shell.logFrontend("info", `ignored stale backend status: ${status.state}`);
      return;
    }
    if (status.state !== this.status.state || status.pid !== this.status.pid) {
      shell.logFrontend(
        "info",
        `backend status: ${status.state} pid=${status.pid ?? "-"} ${status.message ?? ""}`.trim(),
      );
    }
    this.status = status;
    const running = status.state === "running";

    this.pill.className = `pill ${
      running ? "ok" : status.state === "starting" || status.state === "restarting" ? "pending" : "error"
    }`;
    this.pill.textContent = running
      ? `Backend ${status.backendVersion ?? ""}`.trim()
      : status.state === "starting"
        ? "Connecting…"
        : status.state === "restarting"
          ? "Reconnecting…"
          : status.state === "incompatible"
            ? "Incompatible backend"
            : status.state === "stopped"
              ? "Backend stopped"
              : "Backend offline";
    this.pill.title = status.message ?? `Protocol ${status.protocolVersion ?? "?"}`;
    this.backendDot.className = `backend-dot ${
      running ? "ok" : status.state === "starting" || status.state === "restarting" ? "pending" : "error"
    }`;
    this.backendDot.title = this.pill.textContent ?? "Backend status";
    this.backendDot.setAttribute("aria-label", `Backend status: ${this.pill.textContent ?? "unknown"}`);

    this.banner.hidden = running;
    this.banner.dataset.tone = status.state === "starting" || status.state === "restarting" ? "warn" : "error";
    if (!running) {
      this.bannerTitle.textContent =
        status.state === "restarting" ? "Backend restarting" :
        status.state === "starting" ? "Starting backend" :
        status.state === "incompatible" ? "Backend version mismatch" :
        "Backend unavailable";
      this.bannerDetail.textContent =
        status.message ??
        "Trading controls are disabled and no order will be sent until the backend is running.";
      this.frame.dataset.dim = "true";
    } else {
      this.frame.dataset.dim = "false";
    }

    this.updateTradingEnabled();
    if (running && status.pid !== this.lastReadyPid) {
      this.lastReadyPid = status.pid;
      void this.onBackendRunning();
    }
  }

  private async onBackendRunning(): Promise<void> {
    if (this.bootstrapPromise) return;
    if (this.bootstrapped) {
      // Reconnect: never re-run startup side effects (no order submission, no
      // state overwrite). Charts resume polling on their own; positions are
      // refreshed read-only so the ticket reflects the exchange.
      toast("Backend reconnected. Verify the position before trading.", "info");
      if (this.coin.value) {
        void this.refreshPrecisionFor(this.coin.value);
        void this.refreshPosition(false);
      }
      return;
    }
    this.bootstrapPromise = this.bootstrap();
    try {
      await this.bootstrapPromise;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  private async bootstrap(): Promise<void> {
    const [metaResult, coinsResult, stateResult, catalogResult] = await Promise.allSettled([
      marketData.getMeta(),
      trading.getCoins(this.venue(), false),
      settingsStore.loadWindowState(),
      trading.getExchanges(),
    ]);

    if (catalogResult.status === "fulfilled") {
      this.exchangeCatalog = catalogResult.value;
      this.updateVenueBadge();
    }

    if (metaResult.status === "fulfilled") {
      this.meta = metaResult.value;
    } else {
      toast(`Market metadata unavailable: ${(metaResult.reason as Error).message}`, "error");
    }
    this.applyTimeframes(this.meta?.timeframes ?? FALLBACK_TIMEFRAMES);

    if (coinsResult.status === "fulfilled") {
      this.applyCoins(coinsResult.value);
    } else {
      toast(`Coin list unavailable: ${(coinsResult.reason as Error).message}`, "error");
    }

    if (stateResult.status === "fulfilled") {
      this.applyWindowState(stateResult.value);
    } else {
      toast(`Window state unavailable: ${(stateResult.reason as Error).message}`, "error");
    }

    // Never block startup on exchange metadata: format immediately with the
    // fallback, then re-apply the real tick when the backend answers.
    this.normalizeLevels();
    void this.refreshPrecisionFor(this.coin.value);

    shell.logFrontend(
      "info",
      `bootstrap complete: ${this.coinList.length} coins, tf=${this.tf.value || "?"}`,
    );
    void trading
      .orderUncertain()
      .then((uncertain) => {
        if (uncertain) {
          toast(
            "Order submission is blocked: a previous order has an unknown execution status. Open Set Order to verify and re-enable trading.",
            "error",
            10_000,
          );
        }
      })
      .catch(() => undefined);
    this.bootstrapped = true;
    this.host.start();
  }

  private async onWorkspaceReady(): Promise<void> {
    shell.logFrontend("info", "workspace ready: chart bridge connected");
    this.workspaceError.hidden = true;
    this.workspaceLoading.hidden = true;
    // Chart focus is reported by the workspace itself; no automatic order is
    // ever submitted here.
    if (this.coin.value) this.scheduleSave();
  }

  private showWorkspaceError(message: string): void {
    this.workspaceErrorMessage.textContent = message;
    this.workspaceLoading.hidden = true;
    this.workspaceError.hidden = false;
    shell.logFrontend("error", `workspace: ${message}`);
  }

  // ── Window state ──────────────────────────────────────────────────────

  private applyWindowState(state: WindowState): void {
    this.applyCoins(this.coinList, state.coin);
    this.applyTimeframe(state.timeframe ?? "");
    if (typeof state.risk === "string") this.risk.value = state.risk;
    if (typeof state.limit === "string") this.limit.value = state.limit;
    if (typeof state.tp === "string") this.tp.value = state.tp;
    if (typeof state.sl === "string") this.sl.value = state.sl;
    this.direction = state.is_short ? "short" : "long";
    this.hyperliquid.checked = Boolean(state.hyperliquid);
    this.setSidebarCollapsed(state.sidebar_collapsed === true, false);
    this.updateDirection();
    this.updateRailState();
  }

  private scheduleSave(): void {
    if (!this.bootstrapped) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveWindowState();
    }, 700);
  }

  private async saveWindowState(): Promise<void> {
    if (!this.bootstrapped) return;
    const state: WindowState = roundTripState({
      coin: this.coin.value,
      timeframe: this.tf.value,
      sidebar_collapsed: this.sidebarCollapsed,
      risk: this.risk.value,
      is_short: this.direction === "short",
      hyperliquid: this.hyperliquid.checked,
      limit: this.limit.value,
      tp: this.tp.value,
      sl: this.sl.value,
    });
    try {
      await settingsStore.saveWindowState(state);
    } catch {
      /* state persistence must never block trading */
    }
  }

  // ── Coins / timeframes ────────────────────────────────────────────────

  private applyCoins(coins: string[], selected?: string): void {
    const current = selected ?? this.coin.value;
    const unique = Array.from(new Set(coins.filter(Boolean)));
    this.coinList = unique;
    this.coin.replaceChildren();
    for (const coin of unique) {
      const option = document.createElement("option");
      option.value = coin;
      option.textContent = coin;
      this.coin.appendChild(option);
    }
    this.ensureOption(this.coin, current);
    if (current) this.coin.value = current;
    if (!this.coin.value) {
      const first = unique[0] ?? "";
      if (first) this.coin.value = first;
    }
    this.updateRailState();
  }

  private applyTimeframes(timeframes: string[]): void {
    const current = this.tf.value;
    this.tf.replaceChildren();
    for (const timeframe of timeframes) {
      const option = document.createElement("option");
      option.value = timeframe;
      option.textContent = timeframe;
      this.tf.appendChild(option);
    }
    this.ensureOption(this.tf, current || "5m");
    this.tf.value = current || "5m";
  }

  private applyTimeframe(timeframe: string): void {
    if (!timeframe) return;
    this.ensureOption(this.tf, timeframe);
    this.tf.value = timeframe;
  }

  private ensureOption(select: HTMLSelectElement, value: string): void {
    if (!value) return;
    if (!Array.from(select.options).some((option) => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.coin.addEventListener("change", () => {
      const coin = this.coin.value;
      if (!coin) return;
      // A manual selection is a base symbol; drop the chart's exact quote.
      this.focusSymbol = "";
      this.host.setFocusedCoin(coin);
      void this.refreshPrecisionFor(coin);
      void this.refreshPosition(false);
      this.scheduleSave();
    });

    this.tf.addEventListener("change", () => {
      if (this.tf.value) this.host.setFocusedTimeframe(this.tf.value);
      this.scheduleSave();
    });

    this.risk.addEventListener("change", () => this.recalculateQty());
    this.limit.addEventListener("change", () => this.recalculateQty());
    this.sl.addEventListener("change", () => this.recalculateQty());
    this.tp.addEventListener("change", () => this.normalizePriceInput(this.tp));
    for (const input of [this.risk, this.limit, this.tp, this.sl, this.qty]) {
      input.addEventListener("input", () => this.scheduleSave());
    }
    this.hyperliquid.addEventListener("change", () => {
      this.updateRailState();
      this.scheduleSave();
    });

    this.directionBtn.addEventListener("click", () => {
      this.direction = this.direction === "long" ? "short" : "long";
      this.updateDirection();
      this.recalculateQty();
      this.scheduleSave();
    });

    this.readOrder.addEventListener("click", () => void this.refreshPosition(true));
    this.setOrder.addEventListener("click", () => void this.submitOrder("set"));
    this.updateOrder.addEventListener("click", () => void this.submitOrder("update"));
    this.centerChart.addEventListener("click", () => this.host.centerFocused());
    this.openBrowser.addEventListener("click", () => void this.openBrowserPage());
    this.sidebarCollapse.addEventListener("click", () => this.toggleSidebar(false));
    this.sidebarExpand.addEventListener("click", () => this.toggleSidebar(true));
    this.bannerRetry.addEventListener("click", () => void this.retryBackend());
    this.workspaceReload.addEventListener("click", () => {
      this.workspaceError.hidden = true;
      this.workspaceLoading.hidden = false;
      this.host.reload();
    });
    this.refreshCoins.addEventListener("click", () => void this.refreshCoinList());
    this.centerRail.addEventListener("click", () => this.host.centerFocused());
    this.refreshRail.addEventListener("click", () => void this.refreshCoinList());
    this.openBrowserRail.addEventListener("click", () => void this.openBrowserPage());
    this.hyperliquidRail.addEventListener("click", () => {
      this.hyperliquid.checked = !this.hyperliquid.checked;
      this.hyperliquid.dispatchEvent(new Event("change"));
    });

    this.bindSidebarResize();

    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        event.preventDefault();
        void this.toggleFullscreen();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        this.toggleSidebar();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        if (this.sidebarCollapsed) this.setSidebarCollapsed(false);
        this.sidebarTabs.select("ai", true);
      }
      if (event.ctrlKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        void this.openSettingsDialog();
      }
    });

    // Long prices exceed the field width; expose the exact value on hover.
    for (const input of [this.limit, this.tp, this.sl, this.qty]) {
      const sync = () => {
        input.title = input.value;
      };
      input.addEventListener("input", sync);
      input.addEventListener("change", sync);
      sync();
    }
    window.addEventListener("beforeunload", () => {
      this.aiPanel.dispose();
      void this.saveWindowState();
    });
  }

  private toggleSidebar(force?: boolean): void {
    this.setSidebarCollapsed(force === undefined ? !this.sidebarCollapsed : !force);
  }

  // ── Sidebar resize ────────────────────────────────────────────────────

  private sidebarMaxWidth(): number {
    return Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 360),
    );
  }

  private applySidebarWidth(width: number, persist: boolean): void {
    const clamped = Math.round(
      Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), this.sidebarMaxWidth()),
    );
    this.sidebarWidth = clamped;
    document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
    this.sidebarResizer.setAttribute("aria-valuenow", String(clamped));
    this.sidebarResizer.setAttribute("aria-valuemax", String(this.sidebarMaxWidth()));
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
      } catch {
        /* storage can be unavailable; width still applies for this session */
      }
    }
  }

  private bindSidebarResize(): void {
    // Restore the persisted width before any interaction. The inline script in
    // index.html already prevents a first-paint jump; this normalises it
    // against the current viewport.
    let stored = NaN;
    try {
      stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    } catch {
      /* storage unavailable */
    }
    const initial = Number.isFinite(stored) && stored > 0
      ? stored
      : this.sidebar.getBoundingClientRect().width || SIDEBAR_DEFAULT_WIDTH;
    this.applySidebarWidth(initial, false);

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const stop = (): void => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      this.applySidebarWidth(this.sidebarWidth, true);
    };
    // The sidebar is docked on the right: dragging its inner edge left grows it.
    const move = (event: PointerEvent): void => {
      if (!dragging) return;
      this.applySidebarWidth(startWidth + (startX - event.clientX), false);
    };

    this.sidebarResizer.addEventListener("pointerdown", (event) => {
      if (this.sidebarCollapsed || event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = this.sidebar.getBoundingClientRect().width;
      document.body.classList.add("is-resizing");
      try {
        this.sidebarResizer.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers */
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("blur", stop);
    });

    this.sidebarResizer.addEventListener("keydown", (event) => {
      if (this.sidebarCollapsed) return;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = this.sidebarWidth + 16;
      else if (event.key === "ArrowRight") next = this.sidebarWidth - 16;
      else if (event.key === "Home") next = SIDEBAR_DEFAULT_WIDTH;
      else if (event.key === "End") next = this.sidebarMaxWidth();
      if (next === null) return;
      event.preventDefault();
      this.applySidebarWidth(next, true);
    });

    this.sidebarResizer.addEventListener("dblclick", () => {
      this.applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
    });

    // Keep the docked sidebar within reach after the window shrinks.
    window.addEventListener("resize", () => {
      if (this.sidebarWidth > this.sidebarMaxWidth()) {
        this.applySidebarWidth(this.sidebarMaxWidth(), false);
      }
    });
  }

  /** Native window fullscreen keeps the shell (and this sidebar) in the layout. */
  private async toggleFullscreen(): Promise<void> {
    try {
      const enabled = await shell.toggleFullscreen();
      this.host.setFullscreenState(enabled);
    } catch (error) {
      toast(`Fullscreen failed: ${(error as Error).message}`, "error");
    }
  }

  private setSidebarCollapsed(collapsed: boolean, persist = true): void {
    const active = document.activeElement as HTMLElement | null;
    // Focus in a real control (not the collapse button) means the user is
    // keyboard-driving the panel, so hand focus to the mirrored rail control.
    const keyboardInside =
      !!active && active !== this.sidebarCollapse && this.sidebarBody.contains(active);
    const focusWasOnExpand = active === this.sidebarExpand;
    this.sidebarCollapsed = collapsed;
    this.sidebar.classList.toggle("collapsed", collapsed);
    this.sidebarBody.hidden = collapsed;
    this.sidebarCollapse.setAttribute("aria-expanded", String(!collapsed));
    this.sidebarExpand.setAttribute("aria-expanded", String(!collapsed));
    if (collapsed) {
      if (keyboardInside) this.sidebarExpand.focus();
      // Pointer collapse: drop focus so the rail parks instead of hanging open.
      else if (active === this.sidebarCollapse) this.sidebarCollapse.blur();
    } else if (focusWasOnExpand) {
      this.sidebarCollapse.focus();
    }
    if (persist) this.scheduleSave();
  }

  private updateDirection(): void {
    const short = this.direction === "short";
    this.directionBtn.classList.toggle("long", !short);
    this.directionBtn.classList.toggle("short", short);
    this.directionBtn.setAttribute("aria-pressed", String(short));
    this.directionBtn.setAttribute(
      "aria-label",
      `Direction: ${short ? "short" : "long"} (click to toggle)`,
    );
    this.directionLabel.textContent = short ? "SHORT" : "LONG";
    this.directionBtn.title =
      `Direction: ${short ? "short" : "long"} (does not submit an order)`;
  }

  private venue(): trading.Venue {
    return { exchange: this.focusExchange, market: this.focusMarket };
  }

  /** Base coin from the select, upgraded to the chart's exact quote symbol. */
  private ticketCoin(): string {
    const coin = this.coin.value;
    if (!coin) return "";
    const base = this.focusSymbol.split("/")[0];
    return this.focusSymbol && base.toUpperCase() === coin.toUpperCase()
      ? this.focusSymbol
      : coin;
  }

  private venueName(): string {
    return (
      this.exchangeCatalog?.exchanges.find((entry) => entry.id === this.focusExchange)?.name ??
      this.focusExchange.replace(/^./, (letter) => letter.toUpperCase())
    );
  }

  private updateVenueBadge(): void {
    const entry = this.exchangeCatalog?.exchanges.find((item) => item.id === this.focusExchange);
    const market = entry?.markets.find((item) => item.id === this.focusMarket);
    this.venueLabel.textContent = `${entry?.name ?? this.venueName()} · ${
      market?.label ?? (this.focusMarket === "spot" ? "Spot" : "Perpetual")
    }`;
    this.venueLabel.title = "The ticket follows the focused chart's exchange and market";
  }

  /** Mirror instrument state onto the collapsed rail so it never drifts. */
  private updateRailState(): void {
    const live = this.hyperliquid.checked;
    this.hyperliquidRail.setAttribute("aria-pressed", String(live));
    this.hyperliquidRail.title = live ? "Live trading: on" : "Live trading: off";
    this.hyperliquidRail.setAttribute("aria-label", live ? "Disable live trading" : "Enable live trading");
    this.centerRail.disabled = !this.coin.value;
  }

  private updateTradingEnabled(): void {
    const enabled = this.status.state === "running" && !this.orderPending;
    for (const button of [this.setOrder, this.updateOrder, this.readOrder]) {
      button.disabled = !enabled;
    }
    this.setOrder.title = enabled
      ? "Place the limit order with TP/SL"
      : "Backend unavailable — no order will be sent";
  }

  // ── Position / levels ─────────────────────────────────────────────────

  private onFocusedChart(
    symbol: string,
    exchange: string,
    market: string,
    timeframe: string,
    indicators: AiChartIndicator[],
  ): void {
    this.aiChartIndicators = indicators;
    if (symbol) {
      this.aiFocus = { symbol, exchange, market, timeframe };
      this.aiPanel.setFocus(this.aiFocus);
    }
    const venueChanged =
      Boolean(exchange) &&
      (exchange !== this.focusExchange || (market || "futures") !== this.focusMarket);
    if (exchange) {
      this.focusExchange = exchange;
      this.focusMarket = market || "futures";
    }
    if (symbol) this.focusSymbol = symbol;
    if (venueChanged) {
      this.pricePrecision.clear();
      this.precisionRequests.clear();
      this.qtyRequest += 1;
      this.updateVenueBadge();
      this.updateRailState();
      void this.reloadCoinsForVenue();
    }
    const base = (symbol || "").split("/")[0];
    if (base && (base !== this.coin.value || venueChanged)) {
      this.applyCoins(this.coinList, base);
    }
    if (timeframe && timeframe !== this.tf.value) {
      this.applyTimeframe(timeframe);
    }
    if (base) void this.refreshPrecisionFor(base);
    if (base) void this.refreshPosition(false);
    this.scheduleSave();
  }

  /** Reload the symbol catalog when the focused chart changes venue. */
  private async reloadCoinsForVenue(): Promise<void> {
    const exchange = this.focusExchange;
    const market = this.focusMarket;
    try {
      const coins = await trading.getCoins({ exchange, market }, false);
      // Ignore a slow response if the user focused another venue meanwhile.
      if (this.focusExchange !== exchange || this.focusMarket !== market) return;
      if (coins.length) this.applyCoins(coins, this.coin.value);
    } catch (error) {
      shell.logFrontend(
        "warn",
        `coin list for ${this.focusExchange}/${this.focusMarket} unavailable: ${(error as Error).message}`,
      );
    }
  }

  private async refreshPosition(report: boolean): Promise<void> {
    const coin = this.ticketCoin();
    if (!coin || this.status.state !== "running") return;
    try {
      // Kick the tick metadata off in parallel but never make positions wait
      // on a slow exchange meta request.
      void this.loadPricePrecision(coin);
      const venue = this.venue();
      const position = await account.getPosition(coin, venue);
      if (this.venue().exchange !== venue.exchange || this.venue().market !== venue.market) {
        return;
      }
      this.applyPosition(position);
      if (report && !position.has_position) {
        toast(position.note ?? `No open position for ${coin}`, "info");
      }
    } catch (error) {
      const rpcError = error as backend.RpcError;
      if (rpcError.code === backend.RpcCodes.UNAVAILABLE) {
        if (report) {
          toast(
            `No ${this.venueName()} credentials configured — open Settings → Exchange`,
            "info",
          );
        }
        return;
      }
      if (report) toast(rpcError.message, "error");
    }
  }

  private syncInputTitles(): void {
    for (const input of [this.limit, this.tp, this.sl, this.qty]) {
      input.title = input.value;
    }
  }

  /** Fetch (once per coin) the exchange price tick used to format LIM/TP/SL. */
  private async loadPricePrecision(
    coin: string,
  ): Promise<trading.ExchangePricePrecision | null> {
    if (!coin) return null;
    const cacheKey = `${this.focusExchange}|${this.focusMarket}|${coin}`;
    const cached = this.pricePrecision.get(cacheKey);
    if (cached) return cached;
    const pending = this.precisionRequests.get(cacheKey);
    if (pending) return pending;
    const request = trading
      .getPricePrecision(coin, this.venue())
      .then((precision) => {
        this.pricePrecision.set(cacheKey, precision);
        return precision;
      })
      .catch(() => null)
      .finally(() => {
        this.precisionRequests.delete(cacheKey);
      });
    this.precisionRequests.set(cacheKey, request);
    return request;
  }

  /** Re-format the ticket once the coin's tick is known (or changed). */
  private async refreshPrecisionFor(coin: string): Promise<void> {
    const precision = await this.loadPricePrecision(this.ticketCoin());
    if (!precision || this.coin.value !== coin) return;
    // Never rewrite a field the user is currently editing.
    const active = document.activeElement;
    if (active === this.limit || active === this.tp || active === this.sl) return;
    this.normalizeLevels();
    if (this.limit.value || this.sl.value) void this.recalculateQty();
  }

  /** Format a price with the selected coin's tick; falls back to 6 dp while
   *  metadata is still loading so raw float tails never reach the ticket. */
  private formatPrice(value: number): string {
    const precision = this.pricePrecision.get(
      `${this.focusExchange}|${this.focusMarket}|${this.ticketCoin()}`,
    );
    if (precision) return formatExchangePrice(value, precision);
    return String(round(value, 6));
  }

  private normalizePriceInput(input: HTMLInputElement): number | null {
    const value = parseNumber(input.value);
    if (value === null) return null;
    const text = this.formatPrice(value);
    input.value = text;
    input.title = text;
    return parseNumber(text);
  }

  private normalizeLevels(): void {
    for (const input of [this.limit, this.tp, this.sl]) {
      this.normalizePriceInput(input);
    }
  }

  /** User-initiated: copy AI plan levels into the ticket (never submits). */
  private applyAiPlan(plan: AiTradePlan): void {
    if (plan.action !== "long" && plan.action !== "short") return;
    this.direction = plan.action;
    if (plan.entry) this.limit.value = this.formatPrice(plan.entry);
    if (plan.takeProfit) this.tp.value = this.formatPrice(plan.takeProfit);
    if (plan.stopLoss) this.sl.value = this.formatPrice(plan.stopLoss);
    this.updateDirection();
    this.syncInputTitles();
    void this.recalculateQty();
    this.scheduleSave();
  }

  /** User-initiated: draw the plan as a position box on the matching chart.
   *  It never fills the ticket and never submits an order. */
  private overlayAiTrade(plan: AiTradePlan, focus: AiFocus | null): void {
    if (plan.action !== "long" && plan.action !== "short") return;
    const { entry, takeProfit, stopLoss } = plan;
    if (!entry || !takeProfit || !stopLoss) {
      toast("The plan has no usable levels to draw.", "error");
      return;
    }
    const symbol = (plan.symbol ?? focus?.symbol ?? "").trim();
    if (!symbol) {
      toast("The plan does not name an instrument.", "error");
      return;
    }
    this.host.overlayTrade({
      direction: plan.action,
      symbol,
      exchange: focus?.exchange ?? "",
      market: focus?.market ?? "",
      timeframe: plan.basisTimeframe || focus?.timeframe || "",
      entry,
      takeProfit,
      stopLoss,
    });
  }

  private applyPosition(position: Position): void {
    if (position.coin !== this.coin.value) return;
    if (position.entry) this.limit.value = this.formatPrice(position.entry);
    if (position.tp) this.tp.value = this.formatPrice(position.tp);
    if (position.sl) this.sl.value = this.formatPrice(position.sl);
    this.direction = position.size < 0 ? "short" : "long";
    this.updateDirection();
    this.syncInputTitles();
    this.recalculateQty();
    this.scheduleSave();
  }

  private applyLevels(direction: string, entry: number, tp: number, sl: number): void {
    const short = direction === "short";
    if (![entry, tp, sl].every((value) => Number.isFinite(value) && value > 0)) return;
    if (entry === sl) return;
    if (short && !(tp < entry && entry < sl)) return;
    if (!short && !(sl < entry && entry < tp)) return;
    const limitText = this.formatPrice(entry);
    const tpText = this.formatPrice(tp);
    const slText = this.formatPrice(sl);
    const rounded = [limitText, tpText, slText].map(parseNumber);
    if (rounded.some((value) => value === null || value <= 0)) {
      toast(`Levels are below ${this.coin.value}'s price tick`, "error");
      return;
    }
    const [limit, takeProfit, stop] = rounded as [number, number, number];
    if (short ? !(takeProfit < limit && limit < stop) : !(stop < limit && limit < takeProfit)) {
      toast(
        `Levels are tighter than ${this.coin.value}'s price tick — widen the position box`,
        "error",
      );
      return;
    }
    this.limit.value = limitText;
    this.tp.value = tpText;
    this.sl.value = slText;
    this.direction = short ? "short" : "long";
    this.updateDirection();
    this.syncInputTitles();
    this.recalculateQty();
    this.scheduleSave();
  }

  private async recalculateQty(): Promise<void> {
    const risk = parseNumber(this.risk.value);
    const entry = this.normalizePriceInput(this.limit);
    const sl = this.normalizePriceInput(this.sl);
    const coin = this.ticketCoin();
    if (risk === null || entry === null || sl === null || !coin) return;
    if (entry === sl || risk <= 0) return;
    const request = ++this.qtyRequest;
    try {
      const result = await trading.calculateQty(
        risk, entry, sl, this.direction === "short", coin, this.venue(),
      );
      // Ignore stale responses when the user kept typing.
      if (request !== this.qtyRequest) return;
      this.qty.value = String(result.qty);
      this.syncInputTitles();
      this.scheduleSave();
    } catch {
      /* invalid combination: leave QTY untouched (matches the Qt panel) */
    }
  }

  // ── Orders ────────────────────────────────────────────────────────────

  private async submitOrder(kind: "set" | "update"): Promise<void> {
    if (this.status.state !== "running") {
      toast("Backend unavailable — no order was sent", "error");
      return;
    }
    const coin = this.ticketCoin();
    if (!coin) {
      toast("Select a coin first", "error");
      return;
    }
    if (!this.hyperliquid.checked) {
      toast("Enable Live trade to submit orders", "info");
      return;
    }

    const limitPrice = this.normalizePriceInput(this.limit);
    const tpPrice = this.normalizePriceInput(this.tp);
    const slPrice = this.normalizePriceInput(this.sl);
    const qty = parseNumber(this.qty.value);
    this.syncInputTitles();
    const isShort = this.direction === "short";

    if (kind === "set") {
      if (limitPrice === null || tpPrice === null || slPrice === null || qty === null) {
        toast("LIM, TP, SL and QTY must all be numeric", "error");
        return;
      }
      if (qty <= 0 || limitPrice <= 0 || tpPrice <= 0 || slPrice <= 0) {
        toast("LIM, TP, SL and QTY must be positive", "error");
        return;
      }
      if (limitPrice === slPrice) {
        toast("LIM and SL must differ", "error");
        return;
      }
    } else if (tpPrice === null || slPrice === null || tpPrice <= 0 || slPrice <= 0) {
      toast("TP and SL must be positive numbers", "error");
      return;
    }

    this.orderPending = true;
    this.updateTradingEnabled();
    try {
      const result =
        kind === "set"
          ? await trading.placeOrder({
              ...this.venue(),
              coin,
              is_buy: !isShort,
              qty: qty as number,
              limit_price: limitPrice as number,
              tp_price: tpPrice as number,
              sl_price: slPrice as number,
            })
          : await trading.updateTpSl({
              ...this.venue(),
              coin,
              is_short: isShort,
              tp: tpPrice as number,
              sl: slPrice as number,
            });

      this.showOrderResult(kind, coin, result.success, result.message);
      await this.saveWindowState();
    } catch (error) {
      const rpcError = backend.RpcError.from(error);
      if (backend.isExecutionUnknown(rpcError)) {
        this.showExecutionUnknown(coin, rpcError.message);
      } else if (rpcError.code === backend.RpcCodes.DUPLICATE_REQUEST) {
        toast(rpcError.message, "info");
      } else if (rpcError.code === backend.RpcCodes.UNAVAILABLE) {
        toast(`${this.venueName()} credentials are not configured`, "error");
      } else {
        this.showOrderResult(kind, coin, false, rpcError.message);
      }
    } finally {
      this.orderPending = false;
      this.updateTradingEnabled();
    }
  }

  private showOrderResult(
    kind: "set" | "update",
    coin: string,
    success: boolean,
    message: string,
  ): void {
    const body = document.createElement("p");
    body.className = success ? "inline-ok" : "inline-error";
    body.style.margin = "0";
    body.textContent = success
      ? kind === "set"
        ? `Order request accepted for ${coin}.`
        : `TP/SL updated for ${coin}.`
      : message;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost-btn";
    close.textContent = "Close";
    const check = document.createElement("button");
    check.type = "button";
    check.className = "primary-btn";
    check.textContent = "Check open orders";
    const modal = openModal({
      title: success ? "Order updated" : "Order not placed",
      subtitle: message,
      body,
      footer: [close, check],
      narrow: true,
    });
    close.addEventListener("click", modal.close);
    check.addEventListener("click", () => {
      modal.close();
      void this.showOpenOrders(coin);
    });
  }

  private showExecutionUnknown(coin: string, detail: string): void {
    const body = document.createElement("p");
    body.style.margin = "0";
    body.textContent =
      `${detail}\n\nNo automatic retry was attempted. Verify the exchange state before submitting again — ` +
      "a second submission can duplicate or replace a live order.";
    body.style.whiteSpace = "pre-wrap";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost-btn";
    close.textContent = "Close";
    const check = document.createElement("button");
    check.type = "button";
    check.className = "primary-btn";
    check.textContent = "Check open orders";
    const acknowledge = document.createElement("button");
    acknowledge.type = "button";
    acknowledge.className = "ghost-btn";
    acknowledge.textContent = "I verified — re-enable trading";
    acknowledge.addEventListener("click", async () => {
      try {
        await shell.acknowledgeOrderState();
        toast("Trading re-enabled. Verify the exchange state before the next order.", "info");
        modal.close();
      } catch (error) {
        toast((error as Error).message, "error");
      }
    });
    const modal = openModal({
      title: "Execution status unknown",
      subtitle: `${coin} · order may or may not have reached the exchange`,
      body,
      footer: [acknowledge, close, check],
      narrow: true,
    });
    close.addEventListener("click", modal.close);
    check.addEventListener("click", () => {
      modal.close();
      void this.showOpenOrders(coin);
    });
  }

  private async showOpenOrders(coin: string): Promise<void> {
    const body = document.createElement("div");
    const status = document.createElement("p");
    status.style.margin = "0";
    status.textContent = "Loading open orders…";
    body.appendChild(status);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ghost-btn";
    close.textContent = "Close";
    const modal = openModal({
      title: `Open orders · ${coin}`,
      subtitle: "Read-only view of the exchange state",
      body,
      footer: [close],
    });
    close.addEventListener("click", modal.close);

    try {
      const orders = await account.getOpenOrders(coin, this.venue());
      body.replaceChildren(this.renderOrders(orders));
    } catch (error) {
      status.textContent = (error as Error).message;
    }
  }

  private renderOrders(orders: OpenOrder[]): HTMLElement {
    if (!orders.length) {
      const empty = document.createElement("p");
      empty.style.margin = "0";
      empty.textContent = "No open orders for this coin.";
      return empty;
    }
    const table = document.createElement("table");
    table.className = "order-list";
    const head = document.createElement("tr");
    for (const label of ["Side", "Size", "Limit", "Trigger", "Type", "OID"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const order of orders) {
      const row = document.createElement("tr");
      const cells = [
        order.side === "B" ? "Buy" : order.side === "A" ? "Sell" : (order.side ?? "—"),
        order.size ?? "—",
        order.limitPrice ?? "—",
        order.triggerPrice ?? "—",
        order.isTrigger ? (order.reduceOnly ? "TP/SL" : "Trigger") : "Limit",
        String(order.oid ?? "—"),
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        row.appendChild(td);
      }
      table.appendChild(row);
    }
    return table;
  }

  // ── Other actions ─────────────────────────────────────────────────────

  private async refreshCoinList(): Promise<void> {
    this.setRefreshBusy(true);
    try {
      const coins = await trading.getCoins(this.venue(), true);
      this.applyCoins(coins);
      toast(`Coin list refreshed (${coins.length})`, "success");
    } catch (error) {
      toast(`Coin refresh failed: ${(error as Error).message}`, "error");
    } finally {
      this.setRefreshBusy(false);
    }
  }

  private setRefreshBusy(busy: boolean): void {
    for (const button of [this.refreshCoins, this.refreshRail]) {
      button.disabled = busy;
      button.classList.toggle("is-busy", busy);
      button.setAttribute("aria-busy", String(busy));
    }
  }

  private async openBrowserPage(): Promise<void> {
    const coin = this.coin.value;
    if (!coin) return;
    try {
      await shell.openTradePage(coin, this.focusExchange, this.focusMarket);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async openSettingsDialog(
    tab: "ai" | "exchange" | "updates" = "exchange",
  ): Promise<void> {
    if (this.status.state !== "running") {
      toast("Backend unavailable — settings cannot be saved", "error");
      return;
    }
    try {
      await openSettingsPage(
        {
          loadCredentials: () => credentials.credentialStatus(),
          saveCredentials: async (values, clear) => {
            const saved = await credentials.saveCredentials(values, clear);
            return saved.fields;
          },
          legacyCredentials: () => credentials.legacyCredentialsStatus(),
          importLegacyCredentials: async () => {
            const imported = await credentials.importLegacyCredentials();
            return imported.fields;
          },
          exchangeCatalog: () => trading.getExchanges(),
          testConnection: (exchange, market) =>
            trading.testConnection({ exchange, market }),
          checkUpdates: () => updates.checkForUpdates(),
          installUpdate: () => updates.installUpdate(),
          runtimeInfo: async () => {
            const report = await ai.getRuntimeReport();
            return {
              ready: report.runtimeReady,
              nodeVersion: report.nodeVersion,
              piVersion: report.piVersion,
              managed: report.managed,
              error: report.runtimeError,
            };
          },
          checkAiRuntimeUpdate: () => updates.checkAiRuntimeUpdate(),
          installAiRuntimeUpdate: () => updates.installAiRuntimeUpdate(),
          onAiRuntimeUpdateProgress: (handler) =>
            updates.onAiRuntimeUpdateProgress(handler),
        },
        this.aiPanel,
        tab,
      );
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private toggleTheme(): void {
    const light = document.body.getAttribute("data-theme") === "light";
    if (light) {
      document.body.removeAttribute("data-theme");
      try { localStorage.setItem("tp-theme", "dark"); } catch { /* storage unavailable */ }
    } else {
      document.body.setAttribute("data-theme", "light");
      try { localStorage.setItem("tp-theme", "light"); } catch { /* storage unavailable */ }
    }
  }

  private async retryBackend(): Promise<void> {
    this.bannerRetry.disabled = true;
    try {
      await backend.restartBackend();
      toast("Restarting backend…", "info");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      this.bannerRetry.disabled = false;
    }
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function bootstrapApp(): void {
  const controller = new AppController();
  controller.start();
}
