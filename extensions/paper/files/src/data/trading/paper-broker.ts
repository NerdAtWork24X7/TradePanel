/*
 * Paper broker: a simulated account trading every chart symbol at the price the chart shows. It is built into
 * the app (nothing to install) and listed with the broker plugins in the Exchanges tab and Trade > Connect
 * broker..., where one broker is connected at a time: connecting it disconnects the plugin, and a plugin that
 * connects takes the place of the paper account.
 *
 * The engine (paper-account.ts) fills the orders; this module feeds it the datafeed's live prices, keeps the
 * account in kv across restarts, subscribes the positions' and working orders' symbols so their orders fill
 * off screen, and answers the order ticket, the chart's trading lines and the account view the way the broker
 * plugins do (the same reads and commands as plugin-broker.ts). On start (and when the account is connected
 * again) it reads the bars the app was away from: a position whose take profit or stop loss the market reached
 * while the app was closed is closed at that level, as the account would have been if it had stayed open.
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { getBars, getTickerInfo, getTickerSnapshot, isEconomicSymbol } from "../datafeed";
import { onTradeTick } from "../datafeed-live";
import { isLocalSymbol } from "../local-series";
import * as kv from "../kv";
import { persisted } from "../persisted";
import { cachedSymbolSessions } from "../session";
import { strategyTester } from "../strategy-tester-store";
import { clearSubscription, setSubscription } from "../subscriptions";
import { translate } from "../../i18n/translator";
import { ALL_CAPABILITIES, type TradingCapabilities } from "./capabilities";
import { PaperAccount, type PaperBar, type PaperFill, type PaperOrder, type PaperPositionRow, type PaperSettings, type PaperSettingsPatch } from "./paper-account";
import { pluginBroker } from "./plugin-broker";
import type { Tradability } from "./replay-broker";
import type { OrderRequest, TradingEvent, TradingExecution, TradingOrder, TradingPosition, TradingQuote } from "./types";

const ACTIVE_KEY = "ot:paper:broker";
const ACCOUNT_KEY = "ot:paper:account:v1";
/** The subscription contributor of the paper account (subscriptions.ts). */
const SUBS_KEY = "paper";
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const key = (symbol: string) => symbol.trim().toUpperCase();

/** The account view's account line: what the paper account is worth now. */
export type PaperAccountState = {
  name: string;
  currency: string;
  startingBalance: number;
  balance: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  commissions: number;
  marginUsed: number;
  marginFree: number;
};

/** Reads a stored account; a value that does not parse starts a new account (the orders are the truth of it). */
function readAccount(): PaperAccount {
  try {
    return PaperAccount.fromJSON(JSON.parse(kv.getItem(ACCOUNT_KEY) ?? "null"));
  } catch {
    return new PaperAccount();
  }
}

export const paperBroker = createRoot(() => {
  const [active, setActiveFlag] = persisted<boolean>(ACTIVE_KEY, {
    parse: (raw) => raw === "true",
    format: (v) => String(v),
    default: false,
    sync: true,
  });
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const listeners = new Set<(e: TradingEvent) => void>();
  /** Chart → its symbol (the trading lines of each chart register it). */
  const charts = new Map<number, () => string | undefined>();
  /** Chart symbol → its name, icon and kind, for the ticket. */
  const metas = new Map<string, { description: string; iconUrl: string | null; stock: boolean } | "loading">();
  /** Symbols whose first price is being fetched from the datafeed, and the ones it had none for. */
  const fetching = new Set<string>();
  const noPrice = new Set<string>();
  let account = readAccount();

  const save = () => kv.setItem(ACCOUNT_KEY, JSON.stringify(account.toJSON()));

  // Another window's order, fill or reset: this window's account follows the stored one.
  kv.onExternalChange(ACCOUNT_KEY, () => {
    account = readAccount();
    bump();
  });

  /** The account's notifications (toasts). */
  const drain = () => {
    for (const e of account.takeEvents()) for (const fn of listeners) fn(e);
  };

  /** A command ran: save the account and let the views and the toasts read it. */
  const done = () => {
    save();
    bump();
    drain();
  };

  const activePane = (): number | null => {
    version();
    const id = Number(strategyTester.activeChartId());
    return Number.isFinite(id) && charts.has(id) ? id : null;
  };
  const symbolOf = (paneId: number | null): string | null => (paneId === null ? null : charts.get(paneId)?.() ?? null);
  const activeSymbol = () => symbolOf(activePane());

  const meta = (symbol: string) => {
    const m = metas.get(symbol);
    if (m && m !== "loading") return m;
    if (!m) {
      metas.set(symbol, "loading");
      void getTickerInfo(symbol)
        .then((i) => metas.set(symbol, { description: i.name ?? symbol, iconUrl: i.iconUrl ?? null, stock: i.symbolType === "stock" }))
        .catch(() => metas.set(symbol, { description: symbol, iconUrl: null, stock: false }))
        .finally(bump);
    }
    return null;
  };

  /** Trades this symbol with live data (an imported series or an economic series has none). */
  const tradable = (symbol: string) => !isLocalSymbol(symbol) && !isEconomicSymbol(symbol);

  /** The last price of a symbol: the ticks the account has seen, or the datafeed's snapshot while the first tick
   *  is on its way (a chart opened a second ago). */
  const ensurePrice = (symbol: string) => {
    const s = key(symbol);
    if (!HAS_TAURI || account.price(s) !== null || fetching.has(s) || noPrice.has(s) || !tradable(symbol)) return;
    fetching.add(s);
    void getTickerSnapshot(symbol)
      .then((snap) => {
        if (snap.last !== null && snap.last > 0) {
          if (account.tick(s, snap.last, Date.now())) save();
        } else {
          noPrice.add(s);
        }
      })
      .catch(() => noPrice.add(s))
      .finally(() => {
        fetching.delete(s);
        bump();
      });
  };

  const tradabilityOf = (paneId: number | null): Tradability => {
    version();
    if (!HAS_TAURI)
      return {
        ok: false,
        reason: "launch",
        title: translate("Trading needs the desktop app"),
        text: translate("Paper trading fills orders on the market data the desktop app receives."),
        fix: "desktop",
      };
    if (!active())
      return {
        ok: false,
        reason: "launch",
        title: translate("Connect the paper account"),
        text: translate("Connect Paper trading in the Trade menu to trade with simulated money."),
        fix: "connect",
      };
    const symbol = symbolOf(paneId);
    if (!symbol) return { ok: false, reason: "launch", title: "", text: translate("Select a chart to trade its symbol.") };
    if (!tradable(symbol))
      return { ok: false, reason: "symbol", title: "", text: translate("Paper trading needs a chart with live market data.") };
    ensurePrice(symbol);
    if (account.price(key(symbol)) === null)
      return noPrice.has(key(symbol))
        ? { ok: false, reason: "symbol", title: "", text: translate("Paper trading needs a chart with live market data.") }
        : { ok: false, reason: "loading", title: "", text: "" };
    return { ok: true, reason: "ok", title: "", text: "" };
  };

  const ready = (paneId: number | null): { symbol: string } | null => {
    if (!tradabilityOf(paneId).ok) return null;
    const symbol = symbolOf(paneId);
    return symbol ? { symbol } : null;
  };

  const symbolAt = (paneId?: number | null): string | null => symbolOf(paneId ?? activePane());

  const position = (paneId: number): TradingPosition | null => {
    version();
    const symbol = symbolOf(paneId);
    return symbol ? account.position(symbol) : null;
  };

  /** The chart's working orders (with their brackets and the position's), as the chart draws them. */
  const orders = (paneId: number): TradingOrder[] => {
    version();
    const symbol = symbolOf(paneId);
    return symbol ? account.orders(symbol) : [];
  };

  const executions = (paneId: number): TradingExecution[] => {
    version();
    const symbol = symbolOf(paneId);
    return symbol ? account.executions(symbol) : [];
  };

  /** The account, as the Exchanges tab and the account view show it. */
  const state = (): PaperAccountState => {
    version();
    return {
      name: account.settings.name,
      currency: account.settings.currency,
      startingBalance: account.settings.startingBalance,
      balance: account.balance,
      equity: account.equity,
      unrealizedPnl: account.unrealizedPnl(),
      realizedPnl: account.realizedPnl,
      commissions: account.commissions,
      marginUsed: account.marginUsed(),
      marginFree: account.marginFree(),
    };
  };

  // ── Live prices ─────────────────────────────────────────────────────────
  if (HAS_TAURI) {
    void onTradeTick((t) => {
      if (!active()) return;
      const s = key(t.symbol);
      // Only the symbols the account holds or works (or the ticket shows) move it.
      const chart = symbolOf(activePane());
      if (!(chart !== null && key(chart) === s) && !account.symbols().includes(s)) return;
      const filled = account.tick(s, t.price, Date.now());
      if (filled) save();
      bump();
      if (filled) drain();
    });
  }

  // A chart that comes forward puts its symbol on the account's prices at once (a second chart's price is not
  // polled yet, and a failed snapshot may have been a moment's).
  let lastChart: string | null = null;
  createEffect(() => {
    if (!active()) return;
    const symbol = symbolOf(activePane());
    if (!symbol || symbol === lastChart) return;
    lastChart = symbol;
    noPrice.delete(key(symbol));
    ensurePrice(symbol);
  });

  // The positions' and working orders' symbols stay subscribed, so a limit order fills off screen; the focused
  // chart's symbol joins them for the ticket's quote.
  createEffect(() => {
    version();
    if (!active()) {
      clearSubscription(SUBS_KEY);
      return;
    }
    const symbols = account.symbols();
    const chart = symbolOf(activePane());
    if (chart) symbols.push(chart);
    setSubscription(SUBS_KEY, symbols);
  });

  // A broker plugin that connects takes the window's trading: the paper account steps aside. The plugin the window
  // already had (the one the paper account replaced) is not that: it arrives as the paper account connects.
  if (HAS_TAURI) {
    let seen: string | null = null;
    createEffect(() => {
      const id = pluginBroker.status()?.active ?? null;
      if (id && id !== seen && active()) setActiveFlag(false);
      seen = id;
    });
  }

  // ── Bars missed while the app was away ────────────────────────────────
  /** Bars of the finest resolution whose standard lookback reaches `ageMs` (the interval table in datafeed.ts), so a
   *  position opened minutes or months ago is checked at the tightest granularity that reaches it. Daily bars beyond
   *  a year cover the rest. */
  const DAY_MS = 86_400_000;
  const RESOLUTION_FOR_AGE: readonly (readonly [number, string])[] = [
    [5, "1"], [10, "5"], [30, "15"], [60, "30"], [90, "60"], [180, "120"], [252, "240"],
  ];

  /** The bars a closed account missed for one position: at the resolution its age needs, or daily when that one is
   *  empty (a plugin may serve only daily bars). Null when the datafeed could not give them; an empty list means it
   *  has none, so there is nothing to check. */
  const missedBars = async (symbol: string, sinceMs: number): Promise<PaperBar[] | null> => {
    const ageDays = (Date.now() - sinceMs) / DAY_MS;
    const first = RESOLUTION_FOR_AGE.find(([span]) => ageDays <= span)?.[1] ?? "1D";
    let failed = false;
    for (const resolution of first === "1D" ? ["1D"] : [first, "1D"]) {
      try {
        const { bars } = await getBars(symbol, resolution, "ETH", () => active());
        const rows: PaperBar[] = bars.flatMap((b) =>
          b.time !== null && b.open !== null && b.high !== null && b.low !== null && b.close !== null
            ? [{ timeMs: b.time * 1000, open: b.open, high: b.high, low: b.low, close: b.close }]
            : [],
        );
        if (rows.length) return rows;
      } catch {
        failed = true;
        break;
      }
    }
    return failed ? null : [];
  };

  /** Check each open position's take profit / stop loss against the bars the account missed (when the app starts,
   *  and when the user connects it again): the app may have been closed while the market reached a level, and the
   *  account only knows the prices it was running for. One request per position, at the resolution its absence
   *  needs. A pass just finished for the same positions and bracket times is not repeated (the start and an
   *  immediate connect), but a later connect reads again: the account may have been away since. */
  let sweeping = false;
  let swept: { signature: string; at: number } | null = null;
  const reconcile = async () => {
    if (!HAS_TAURI || !active() || sweeping) return;
    const checks = account.reconcileChecks();
    const signature = checks.map((c) => `${key(c.symbol)}@${c.sinceMs}`).join("|");
    if (!checks.length || (swept?.signature === signature && Date.now() - swept.at < 60_000)) return;
    sweeping = true;
    try {
      const results = await Promise.all(checks.map(async (check) => ({ symbol: check.symbol, bars: await missedBars(check.symbol, check.sinceMs) })));
      // Disconnected mid-flight: this window is no longer the account's broker; its next connect sweeps again.
      if (!active()) return;
      let changed = false;
      let complete = true;
      for (const { symbol, bars } of results) {
        if (bars === null) {
          complete = false;
          continue;
        }
        if (account.reconcileBars(symbol, bars)) changed = true;
      }
      if (complete) swept = { signature, at: Date.now() };
      if (changed) save();
      bump();
      drain();
    } finally {
      sweeping = false;
    }
  };

  const api = {
    version,
    /** The paper account is the window's broker. */
    active,
    connected: active,
    /** Paper trading runs in the desktop app, on its market data. */
    available: HAS_TAURI,

    // ── The account (Exchanges tab, account view) ───────────────────────
    account: state,
    /** The account's settings, as the account settings dialog edits them. */
    settings: (): PaperSettings => {
      version();
      return account.settings;
    },
    positions: (): PaperPositionRow[] => {
      version();
      return account.positions();
    },
    orderRows: (): PaperOrder[] => {
      version();
      return account.orderRows();
    },
    fills: (): PaperFill[] => {
      version();
      return account.fills();
    },
    /** Starts a new account; a reset from the UI can choose the new starting equity. */
    resetAccount(settings?: PaperSettingsPatch) {
      account.reset(settings, Date.now());
      noPrice.clear();
      fetching.clear();
      done();
    },
    setSettings(next: PaperSettingsPatch) {
      account.setSettings(next);
      save();
      bump();
    },

    // ── Connection (Trade menu, broker list) ────────────────────────────
    connect() {
      if (!HAS_TAURI) return;
      // One broker at a time: the plugin's account goes when the paper one comes.
      void pluginBroker.setActive(null).catch(() => {});
      setActiveFlag(true);
      noPrice.clear();
      bump();
      // A position kept while the account was disconnected: the bars since then may have reached its brackets.
      void reconcile();
    },
    disconnect() {
      setActiveFlag(false);
      bump();
    },

    // ── The broker surface the ticket and the chart lines read ──────────
    /** A chart whose symbol the paper account can trade (live data): its lines and Buy / Sell buttons show. */
    trades: (paneId: number): boolean => {
      version();
      const symbol = symbolOf(paneId);
      return active() && !!symbol && tradable(symbol);
    },
    registerChart(paneId: number, symbol: () => string | undefined): () => void {
      charts.set(paneId, symbol);
      bump();
      return () => {
        charts.delete(paneId);
        bump();
      };
    },
    activePane,
    tradability: () => tradabilityOf(activePane()),
    /** Paper trading takes every order type, brackets, partial closes and modifications. */
    capabilities: (): TradingCapabilities => ALL_CAPABILITIES,
    symbol: activeSymbol,
    description(symbol: string): string {
      version();
      return meta(symbol)?.description ?? symbol;
    },
    iconUrl(symbol: string): string | null {
      version();
      return meta(symbol)?.iconUrl ?? null;
    },
    isStock(symbol: string): boolean {
      version();
      return meta(symbol)?.stock ?? false;
    },
    /** No spread: the bid and the ask are the last price. */
    quote: (): TradingQuote | null => {
      version();
      const symbol = activeSymbol();
      if (!symbol) return null;
      const last = account.price(key(symbol));
      if (last === null) return null;
      return { symbol, bid: last, ask: last, last, minTick: cachedSymbolSessions(symbol)?.mintick ?? 0.01 };
    },
    currency: (): string => {
      version();
      return account.settings.currency;
    },
    balance: (): number => {
      version();
      return account.balance;
    },
    position,
    orders,
    executions,

    place(req: OrderRequest): string | null {
      const r = ready(activePane());
      if (!r) return null;
      account.place({ ...req, symbol: r.symbol }, Date.now());
      done();
      return "sent";
    },
    modify(id: string, req: OrderRequest, paneId?: number | null): string | null {
      const symbol = symbolAt(paneId);
      if (!symbol) return null;
      account.modify(id, { ...req, symbol }, Date.now());
      done();
      return "sent";
    },
    cancel(id: string, paneId?: number | null): string | null {
      const symbol = symbolAt(paneId);
      if (!symbol) return null;
      account.cancel(id, symbol, Date.now());
      done();
      return "sent";
    },
    /** Close the chart's position, all of it or `qty` of it. */
    closePosition(qty: number | null = null, paneId?: number | null): string | null {
      const symbol = symbolAt(paneId);
      if (!symbol) return null;
      account.closePosition(symbol, qty, Date.now());
      done();
      return "sent";
    },
    reverse(paneId?: number | null): string | null {
      const symbol = symbolAt(paneId);
      if (!symbol) return null;
      account.reverse(symbol, Date.now());
      done();
      return "sent";
    },
    setPositionBrackets(tp: number | null, sl: number | null, paneId?: number | null): string | null {
      const symbol = symbolAt(paneId);
      if (!symbol) return null;
      account.setPositionBrackets(symbol, tp, sl);
      done();
      return "sent";
    },
    onEvent(fn: (e: TradingEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // ── Account view helpers ────────────────────────────────────────────
    /** A paper position trades the chart symbol itself. */
    chartSymbolFor: (symbol: string): string | null => symbol,
    /** Close a position the account view lists. */
    closePositionAt(symbol: string, qty: number | null = null) {
      account.closePosition(symbol, qty, Date.now());
      done();
    },
    /** Cancel an order the account view lists. */
    cancelOrder(id: string) {
      const order = account.orderRows().find((o) => o.id === id);
      if (!order) return;
      account.cancel(id, order.symbol, Date.now());
      done();
    },
    /** The chart that shows a symbol, for the account view's "show on chart" and the ticket's modify. */
    paneOfSymbol(symbol: string): number | null {
      version();
      const s = key(symbol);
      for (const [paneId, shown] of charts) {
        const at = shown();
        if (at && key(at) === s) return paneId;
      }
      return null;
    },
    /** A working order the ticket can modify: the chart that shows its symbol. */
    editable(order: PaperOrder): { order: TradingOrder; paneId: number } | null {
      const paneId = api.paneOfSymbol(order.symbol);
      if (paneId === null) return null;
      const shown = account.orders(order.symbol).find((o) => o.id === order.id);
      return shown ? { order: shown, paneId } : null;
    },
    /** The chart that trades a position, for its Protect / Reverse menu. */
    positionPane(row: PaperPositionRow): { position: TradingPosition; paneId: number } | null {
      const paneId = api.paneOfSymbol(row.symbol);
      if (paneId === null) return null;
      const position = account.position(row.symbol);
      return position ? { position, paneId } : null;
    },
  };
  // The app may have been closed with a protected position: check the bars it missed as soon as the account is live.
  if (active()) void reconcile();
  return api;
});
