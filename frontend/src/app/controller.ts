import * as account from "../services/account";
import * as alerts from "../services/alerts";
import * as backend from "../services/backend";
import * as credentials from "../services/credentials";
import * as indicators from "../services/indicators";
import * as marketData from "../services/market-data";
import * as settingsStore from "../services/settings";
import * as shell from "../services/shell";
import * as trading from "../services/trading";
import * as updates from "../services/updates";
import { openAlertDialog } from "../components/alerts";
import { openModal } from "../components/modal";
import { openSettings } from "../components/settings";
import { toast } from "../components/toast";
import { WorkspaceHost } from "../workspace-host";
import type {
  BackendStatus,
  Direction,
  IndicatorConfig,
  MarketMeta,
  OpenOrder,
  Position,
  UnknownRecord,
  WindowState,
} from "../types";

const FALLBACK_TIMEFRAMES = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w", "1M",
];
const MAX_FAVORITES = 12;

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
    favorites: state.favorites,
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
  private readonly setAlert = must<HTMLButtonElement>("set-alert");
  private readonly addFavorite = must<HTMLButtonElement>("add-favorite");
  private readonly favorites = must<HTMLElement>("favorites");
  private readonly pill = must<HTMLElement>("backend-pill");
  private readonly banner = must<HTMLElement>("backend-banner");
  private readonly bannerTitle = must<HTMLElement>("banner-title");
  private readonly bannerDetail = must<HTMLElement>("banner-detail");
  private readonly bannerRetry = must<HTMLButtonElement>("banner-retry");
  private readonly shellBar = must<HTMLElement>("shell-bar");
  private readonly restoreBar = must<HTMLButtonElement>("restore-bar");
  private readonly settingsBtn = must<HTMLButtonElement>("settings-btn");
  private readonly frame = must<HTMLIFrameElement>("workspace-frame");
  private readonly workspaceError = must<HTMLElement>("workspace-error");
  private readonly workspaceErrorMessage = must<HTMLElement>("workspace-error-message");
  private readonly workspaceReload = must<HTMLButtonElement>("workspace-reload");
  private readonly versionLabel = must<HTMLElement>("app-version");

  private readonly host: WorkspaceHost;
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
  private coinList: string[] = [];
  private favoriteList: string[] = [];
  private meta: MarketMeta | null = null;
  private indicatorConfig: IndicatorConfig | null = null;
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private orderPending = false;
  private lastReadyPid: number | null = null;
  private qtyRequest = 0;

  constructor() {
    this.host = new WorkspaceHost(this.frame, {
      focusedChart: (symbol, _exchange, _market, timeframe) =>
        this.onFocusedChart(symbol, timeframe),
      positionDrawing: (direction, entry, tp, sl) =>
        this.applyLevels(direction, entry, tp, sl),
      configRequested: () => void this.openSettingsDialog(),
      toggleTopBar: () => this.toggleShellBar(),
      fullscreen: (enabled) => {
        void shell.setFullscreen(enabled).catch((error) => {
          toast(`Fullscreen failed: ${(error as Error).message}`, "error");
        });
      },
      ready: () => this.onWorkspaceReady(),
      failed: (message) => this.showWorkspaceError(message),
      log: (message) => shell.logFrontend("info", `workspace: ${message}`),
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
      if (this.coin.value) void this.refreshPosition(false);
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
    const [metaResult, coinsResult, stateResult, configResult] = await Promise.allSettled([
      marketData.getMeta(),
      trading.getCoins(false),
      settingsStore.loadWindowState(),
      indicators.getIndicatorConfig(),
    ]);

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

    if (configResult.status === "fulfilled") {
      this.indicatorConfig = configResult.value;
    }

    shell.logFrontend(
      "info",
      `bootstrap complete: ${this.coinList.length} coins, ${this.favoriteList.length} favourites, ` +
        `tf=${this.tf.value || "?"}`,
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
    this.renderFavorites();
    this.bootstrapped = true;
    this.host.start();
  }

  private async onWorkspaceReady(): Promise<void> {
    shell.logFrontend("info", "workspace ready: chart bridge connected");
    this.workspaceError.hidden = true;
    if (this.indicatorConfig) {
      this.host.setIndicatorConfig(this.indicatorConfig as unknown as UnknownRecord);
    }
    // Chart focus is reported by the workspace itself; no automatic order is
    // ever submitted here.
    if (this.coin.value) this.scheduleSave();
  }

  private showWorkspaceError(message: string): void {
    this.workspaceErrorMessage.textContent = message;
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
    this.favoriteList = Array.isArray(state.favorites)
      ? state.favorites.filter((coin): coin is string => typeof coin === "string")
      : [];
    this.updateDirection();
    this.renderFavorites();
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
      favorites: this.favoriteList,
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

  private renderFavorites(): void {
    this.favorites.replaceChildren();
    for (let index = 0; index < MAX_FAVORITES; index += 1) {
      const coin = this.favoriteList[index];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `fav-btn${coin ? " filled" : ""}`;
      button.textContent = coin ?? `Fav${index + 1}`;
      button.disabled = !coin;
      button.title = coin ? `Switch to ${coin}` : "Empty favourite slot";
      if (coin) {
        button.addEventListener("click", () => {
          this.applyCoins(this.coinList, coin);
          this.host.setFocusedCoin(coin);
          void this.refreshPosition(false);
          this.scheduleSave();
        });
      }
      this.favorites.appendChild(button);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.coin.addEventListener("change", () => {
      const coin = this.coin.value;
      if (!coin) return;
      this.host.setFocusedCoin(coin);
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
    for (const input of [this.risk, this.limit, this.tp, this.sl, this.qty]) {
      input.addEventListener("input", () => this.scheduleSave());
    }
    this.hyperliquid.addEventListener("change", () => this.scheduleSave());

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
    this.setAlert.addEventListener("click", () => void this.openAlerts());
    this.addFavorite.addEventListener("click", () => this.pinCurrentCoin());
    this.settingsBtn.addEventListener("click", () => void this.openSettingsDialog());
    this.bannerRetry.addEventListener("click", () => void this.retryBackend());
    this.workspaceReload.addEventListener("click", () => {
      this.workspaceError.hidden = true;
      this.host.reload();
    });
    this.restoreBar.addEventListener("click", () => this.toggleShellBar(true));

    this.refreshCoins.addEventListener("click", () => void this.refreshCoinList());

    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        event.preventDefault();
        void shell.setFullscreen(true).catch(() => undefined);
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        this.toggleShellBar();
      }
      if (event.ctrlKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        void this.openSettingsDialog();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        void this.openAlerts();
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
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        void shell.setFullscreen(false).catch(() => undefined);
      }
    });
    window.addEventListener("beforeunload", () => {
      void this.saveWindowState();
    });
  }

  private toggleShellBar(force?: boolean): void {
    const hide = force === undefined ? !this.shellBar.hidden : !force;
    this.shellBar.hidden = hide;
    this.restoreBar.hidden = !hide;
  }

  private updateDirection(): void {
    const short = this.direction === "short";
    this.directionBtn.classList.toggle("long", !short);
    this.directionBtn.classList.toggle("short", short);
    this.directionBtn.setAttribute("aria-pressed", String(short));
    this.directionLabel.textContent = short ? "SHORT" : "LONG";
    this.directionBtn.title =
      `Direction: ${short ? "short" : "long"} (does not submit an order)`;
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

  private onFocusedChart(symbol: string, timeframe: string): void {
    const base = (symbol || "").split("/")[0];
    if (base && base !== this.coin.value) {
      this.applyCoins(this.coinList, base);
    }
    if (timeframe && timeframe !== this.tf.value) {
      this.applyTimeframe(timeframe);
    }
    if (base) void this.refreshPosition(false);
    this.scheduleSave();
  }

  private async refreshPosition(report: boolean): Promise<void> {
    const coin = this.coin.value;
    if (!coin || this.status.state !== "running") return;
    try {
      const position = await account.getPosition(coin);
      this.applyPosition(position);
      if (report && !position.has_position) toast(`No open position for ${coin}`, "info");
    } catch (error) {
      const rpcError = error as backend.RpcError;
      if (rpcError.code === backend.RpcCodes.UNAVAILABLE) {
        if (report) toast("No Hyperliquid credentials configured — open Settings → Credentials", "info");
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

  private applyPosition(position: Position): void {
    if (position.coin !== this.coin.value) return;
    if (position.entry) this.limit.value = String(round(position.entry, 6));
    if (position.tp) this.tp.value = String(round(position.tp, 6));
    if (position.sl) this.sl.value = String(round(position.sl, 6));
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
    this.limit.value = String(entry);
    this.tp.value = String(tp);
    this.sl.value = String(sl);
    this.direction = short ? "short" : "long";
    this.updateDirection();
    this.syncInputTitles();
    this.recalculateQty();
    this.scheduleSave();
  }

  private async recalculateQty(): Promise<void> {
    const risk = parseNumber(this.risk.value);
    const entry = parseNumber(this.limit.value);
    const sl = parseNumber(this.sl.value);
    const coin = this.coin.value;
    if (risk === null || entry === null || sl === null || !coin) return;
    if (entry === sl || risk <= 0) return;
    const request = ++this.qtyRequest;
    try {
      const result = await trading.calculateQty(
        risk, entry, sl, this.direction === "short", coin,
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
    const coin = this.coin.value;
    if (!coin) {
      toast("Select a coin first", "error");
      return;
    }
    if (kind === "update" && !this.hyperliquid.checked) {
      toast("Enable Hyperliquid to update orders", "info");
      return;
    }

    const limitPrice = parseNumber(this.limit.value);
    const tpPrice = parseNumber(this.tp.value);
    const slPrice = parseNumber(this.sl.value);
    const qty = parseNumber(this.qty.value);
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
              coin,
              is_buy: !isShort,
              qty: qty as number,
              limit_price: limitPrice as number,
              tp_price: tpPrice as number,
              sl_price: slPrice as number,
            })
          : await trading.updateTpSl({ coin, is_short: isShort, tp: tpPrice as number, sl: slPrice as number });

      this.showOrderResult(kind, coin, result.success, result.message);
      await this.saveWindowState();
    } catch (error) {
      const rpcError = backend.RpcError.from(error);
      if (backend.isExecutionUnknown(rpcError)) {
        this.showExecutionUnknown(coin, rpcError.message);
      } else if (rpcError.code === backend.RpcCodes.DUPLICATE_REQUEST) {
        toast(rpcError.message, "info");
      } else if (rpcError.code === backend.RpcCodes.UNAVAILABLE) {
        toast("Hyperliquid credentials are not configured", "error");
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
    body.style.margin = "0";
    body.style.color = success ? "#a7f3d0" : "#fecaca";
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
      const orders = await account.getOpenOrders(coin);
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

  private pinCurrentCoin(): void {
    const coin = this.coin.value;
    if (!coin) return;
    if (this.favoriteList.includes(coin)) {
      toast(`${coin} is already pinned`, "info");
      return;
    }
    if (this.favoriteList.length >= MAX_FAVORITES) {
      toast("Favourite slots are full", "info");
      return;
    }
    this.favoriteList.push(coin);
    this.renderFavorites();
    this.scheduleSave();
  }

  private async refreshCoinList(): Promise<void> {
    this.refreshCoins.disabled = true;
    try {
      const coins = await trading.getCoins(true);
      this.applyCoins(coins);
      toast(`Coin list refreshed (${coins.length})`, "success");
    } catch (error) {
      toast(`Coin refresh failed: ${(error as Error).message}`, "error");
    } finally {
      this.refreshCoins.disabled = false;
    }
  }

  private async openBrowserPage(): Promise<void> {
    const coin = this.coin.value;
    if (!coin) return;
    try {
      await shell.openTradePage(coin);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async openAlerts(): Promise<void> {
    const coin = this.coin.value;
    if (!coin) {
      toast("Select a coin first", "error");
      return;
    }
    try {
      await openAlertDialog({
        coin,
        load: () => alerts.getAlert(coin),
        save: (high, low) => alerts.setAlert(coin, high, low),
      });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async openSettingsDialog(): Promise<void> {
    if (this.status.state !== "running") {
      toast("Backend unavailable — settings cannot be saved", "error");
      return;
    }
    try {
      await openSettings({
        loadIndicatorConfig: () => indicators.getIndicatorConfig(),
        saveIndicatorConfig: async (config) => {
          const saved = await indicators.saveIndicatorConfig(config);
          this.indicatorConfig = saved;
          this.host.setIndicatorConfig(saved as unknown as UnknownRecord);
        },
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
        checkUpdates: () => updates.checkForUpdates(),
        installUpdate: () => updates.installUpdate(),
      });
    } catch (error) {
      toast((error as Error).message, "error");
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
