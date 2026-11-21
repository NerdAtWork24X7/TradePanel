/*
 * Paper trading account: a simulated broker fed with the chart's live prices.
 *
 * Orders fill at the price the market shows: a market order at once on the last price, a limit when the
 * price reaches it, a stop when the price crosses it, a stop-limit when its stop is reached and then its
 * limit. A position's take profit closes it at its price and its stop loss at the tick that reaches it;
 * the take profit / stop loss of an order wait for the order to fill and then protect its position.
 *
 * The account is a cash account at 1:1 unless margin control is on: then each symbol's asset class has its
 * leverage (a position or order holds its value divided by it as margin), so less of the balance is held and an
 * order that would need more margin than the free funds is refused. Commissions — a per-contract one for futures
 * and options, a percent of the trade's value or a flat amount for everything else — come off the balance at every
 * fill. Partial closes, reversing and modifying or cancelling an order work as on the replay broker, so the order
 * ticket, the chart's trading lines and the account view need nothing of their own.
 *
 * Everything here is pure: prices come in through `tick`, the time through the call, and the whole account
 * through `toJSON` / `fromJSON` (the store keeps it in kv; a test builds it directly).
 */
import { ORDER_LABEL, type OrderRequest, type OrderType, type Side, type TradingEvent, type TradingExecution, type TradingOrder, type TradingPosition } from "./types";

/** The asset classes a symbol falls into; each has its own leverage, and futures (with options) its own commission. */
export type AssetClass = "stocks" | "futures" | "forex" | "crypto" | "others";
export const ASSET_CLASSES: readonly AssetClass[] = ["stocks", "futures", "forex", "crypto", "others"];

/** How a commission of the "Others" section is charged: a share of the trade's value, or a flat amount per fill. */
export type CommissionType = "percent" | "absolute";

export type LeverageSettings = Record<AssetClass, number>;
export type CommissionSettings = {
  /** Futures and options: a commission per contract, charged opening and closing. */
  futuresOptions: { enabled: boolean; perContract: number };
  /** Everything else: a percent of the trade's value or a flat amount per fill. */
  others: { enabled: boolean; value: number; type: CommissionType };
};

/** Everything the account settings dialog edits. */
export type PaperSettings = {
  name: string;
  startingBalance: number;
  currency: string;
  /** On: the leverage below applies and an order over the free margin is refused. Off: a plain 1:1 cash account. */
  marginControl: boolean;
  leverage: LeverageSettings;
  commission: CommissionSettings;
};

/** A partial change of the settings (a stored snapshot may hold only some of the fields). */
export type PaperSettingsPatch = Partial<Omit<PaperSettings, "leverage" | "commission">> & {
  leverage?: Partial<LeverageSettings>;
  commission?: {
    futuresOptions?: Partial<CommissionSettings["futuresOptions"]>;
    others?: Partial<CommissionSettings["others"]>;
  };
};

/** The reference defaults a new account opens on. */
export const DEFAULT_LEVERAGE: LeverageSettings = { stocks: 1, futures: 20, forex: 50, crypto: 10, others: 50 };
export const DEFAULT_COMMISSION: CommissionSettings = {
  futuresOptions: { enabled: false, perContract: 0.01 },
  others: { enabled: false, value: 0.002, type: "percent" },
};
export const DEFAULT_PAPER_SETTINGS: PaperSettings = {
  name: "",
  startingBalance: 100_000,
  currency: "USD",
  marginControl: false,
  leverage: { ...DEFAULT_LEVERAGE },
  commission: { futuresOptions: { ...DEFAULT_COMMISSION.futuresOptions }, others: { ...DEFAULT_COMMISSION.others } },
};

/** The exchange codes that place a symbol in an asset class (the venues the app serves); anything unknown is
 *  "others" (indices, bonds and the rest). */
const CRYPTO_EXCHANGES = new Set([
  "BINANCE", "BINANCEUS", "COINBASE", "COINBASE_INTX", "KRAKEN", "BITSTAMP", "BITFINEX", "BITMEX", "OKX", "OKEX",
  "BYBIT", "KUCOIN", "GEMINI", "BITGET", "MEXC", "HTX", "HUOBI", "POLONIEX", "BITTREX", "GATE", "GATEIO", "DERIBIT",
  "HYPERLIQUID", "CRYPTO", "CRYPTOCOM", "UPBIT", "BITSO", "LUNO",
]);
const FOREX_EXCHANGES = new Set([
  "FX", "FX_IDC", "OANDA", "SAXO", "DUKASCOPY", "FOREXCOM", "FXPRO", "PEPPERSTONE", "ICMARKETS", "XM", "CAPITALCOM",
  "IG", "FOREX",
]);
const FUTURES_EXCHANGES = new Set([
  "CME", "CBOT", "COMEX", "NYMEX", "ICEUS", "ICE", "IFEU", "IFLL", "EUREX", "LIFFE", "CFE", "CBOE", "NYBOT", "HKFE",
  "OPRA",
]);
const STOCK_EXCHANGES = new Set([
  "NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "BATY", "BZX", "OTC", "PSX", "IEXG", "EDGX", "EDGA", "XNAS", "XNYS",
  "XASE", "ARCX", "LSE", "XETR", "FWB", "SIX", "TSX", "TSXV", "ASX", "KRX", "TWSE", "SSE", "SZSE", "JPX", "HKEX",
  "NSE", "BSE",
]);
const CURRENCY_CODES = new Set([
  "USD", "EUR", "JPY", "GBP", "AUD", "NZD", "CAD", "CHF", "CNH", "CNY", "SEK", "NOK", "DKK", "PLN", "HUF", "CZK",
  "TRY", "MXN", "ZAR", "SGD", "HKD", "INR", "BRL", "RUB", "KRW", "TWD", "THB",
]);

/** The asset class of a chart symbol, read from its exchange code and its shape: "BINANCE:BTC/USDT" is crypto,
 *  "FX:EURUSD" forex, "CME:ES1!" futures (with options), "NASDAQ:AAPL" a stock; anything else is "others". */
export function assetClassOf(symbol: string): AssetClass {
  const s = symbol.trim().toUpperCase();
  const colon = s.indexOf(":");
  const exchange = colon > 0 ? s.slice(0, colon) : "";
  const ticker = colon > 0 ? s.slice(colon + 1) : s;
  if (FUTURES_EXCHANGES.has(exchange) || ticker.endsWith("!")) return "futures";
  if (FOREX_EXCHANGES.has(exchange)) return "forex";
  if (CRYPTO_EXCHANGES.has(exchange) || ticker.includes("/")) return "crypto";
  if (STOCK_EXCHANGES.has(exchange)) return "stocks";
  // A bare pair of currency codes ("EURUSD") is forex.
  const pair = ticker.replace(/[^A-Z]/g, "");
  if (pair.length === 6 && CURRENCY_CODES.has(pair.slice(0, 3)) && CURRENCY_CODES.has(pair.slice(3))) return "forex";
  return "others";
}

/** A number at or above zero, else the fallback. */
const nonNegative = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const leverageValue = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : fallback;
};

/** The leverage object completed from `base`: a missing or senseless value falls back. */
export function sanitizeLeverage(src: Partial<LeverageSettings> | undefined, base: LeverageSettings): LeverageSettings {
  return {
    stocks: leverageValue(src?.stocks, base.stocks),
    futures: leverageValue(src?.futures, base.futures),
    forex: leverageValue(src?.forex, base.forex),
    crypto: leverageValue(src?.crypto, base.crypto),
    others: leverageValue(src?.others, base.others),
  };
}

/** The commission object completed from `base`: a missing or senseless value falls back. */
export function sanitizeCommission(src: PaperSettingsPatch["commission"], base: CommissionSettings): CommissionSettings {
  const fo = src?.futuresOptions;
  const ot = src?.others;
  return {
    futuresOptions: {
      enabled: typeof fo?.enabled === "boolean" ? fo.enabled : base.futuresOptions.enabled,
      perContract: nonNegative(fo?.perContract, base.futuresOptions.perContract),
    },
    others: {
      enabled: typeof ot?.enabled === "boolean" ? ot.enabled : base.others.enabled,
      value: nonNegative(ot?.value, base.others.value),
      type: ot?.type === "absolute" ? "absolute" : ot?.type === "percent" ? "percent" : base.others.type,
    },
  };
}

/** A copy of the settings, so a caller cannot reach into the account's own object. */
export function cloneSettings(s: PaperSettings): PaperSettings {
  return {
    ...s,
    leverage: { ...s.leverage },
    commission: { futuresOptions: { ...s.commission.futuresOptions }, others: { ...s.commission.others } },
  };
}

export type PaperOrderStatus = "working" | "filled" | "cancelled" | "rejected";

/** One order of the account, working or kept for its history. */
export type PaperOrder = {
  id: string;
  /** The chart symbol it trades ("BINANCE:BTC/USDT"): paper trading needs no broker ticker. */
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  /** A stop-limit whose stop was reached: its limit works. */
  triggered: boolean;
  status: PaperOrderStatus;
  createdMs: number;
  updatedMs: number;
  /** The price it filled at (null until filled). */
  fillPrice: number | null;
  /** Why it was refused. */
  message?: string;
};

/** A position as the account view lists it. */
export type PaperPositionRow = {
  symbol: string;
  side: Side;
  qty: number;
  avgPrice: number;
  last: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  unrealizedPnl: number;
  openedMs: number;
};

/** One fill: the account's trade history. */
export type PaperFill = {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  timeMs: number;
  /** The profit or loss the fill took (0 when it opened or added to a position). */
  realizedPnl: number;
  /** The commission the fill paid (0 unless a commission section is on). */
  fee: number;
  orderId: string | null;
};

/** The whole account, as the store keeps it. */
export type PaperSnapshot = {
  version: 1;
  settings: PaperSettings;
  orders: PaperOrder[];
  positions: { symbol: string; qty: number; avgPrice: number; takeProfit: number | null; stopLoss: number | null; openedMs: number }[];
  fills: PaperFill[];
  /** The last price seen of each symbol, so a restart shows the account's P&L at once. */
  last: Record<string, number>;
  realizedPnl: number;
  /** The commissions paid over the account's life. */
  fees: number;
  seq: number;
  openedMs: number;
};

type Position = { symbol: string; qty: number; avgPrice: number; takeProfit: number | null; stopLoss: number | null; openedMs: number };

/** The chart's position id (its take profit / stop loss lines are "<id>:tp" / "<id>:sl"). */
const POSITION_ID = "position";
/** Orders and fills kept for the account view (working orders are never dropped). */
const MAX_ROWS = 200;
/** Float slack of the balance checks and of a position counted as flat. */
const EPS = 1e-9;

/** Symbols compare without case (the tick event's spelling is the subscribed symbol's). */
const key = (symbol: string) => symbol.trim().toUpperCase();
/** A price or quantity that can be used, else null. */
const positive = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) || v <= 0 ? null : v;

const exitSide = (s: Side): Side => (s === "buy" ? "sell" : "buy");

export class PaperAccount {
  private settingsValue: PaperSettings = { ...DEFAULT_PAPER_SETTINGS };
  /** Newest last: the account view lists the history that way. */
  private ordersValue: PaperOrder[] = [];
  private positionsValue = new Map<string, Position>();
  private fillsValue: PaperFill[] = [];
  private lastValue = new Map<string, number>();
  private realizedValue = 0;
  private feesValue = 0;
  private seq = 0;
  private fillSeq = 0;
  private openedMs = Date.now();
  private out: TradingEvent[] = [];

  constructor(snapshot?: PaperSnapshot | null) {
    if (snapshot) this.load(snapshot);
  }

  // ------------------------------------------------------------ settings and state

  get settings(): PaperSettings {
    return cloneSettings(this.settingsValue);
  }

  get openedAt(): number {
    return this.openedMs;
  }

  get realizedPnl(): number {
    return this.realizedValue;
  }

  /** The commissions paid over the account's life. */
  get commissions(): number {
    return this.feesValue;
  }

  /** Cash: the starting balance, what the closed trades made, less the commissions paid. */
  get balance(): number {
    return this.settingsValue.startingBalance + this.realizedValue - this.feesValue;
  }

  get equity(): number {
    return this.balance + this.unrealizedPnl();
  }

  /** The profit or loss of the open positions at the last prices. */
  unrealizedPnl(): number {
    let pnl = 0;
    for (const [symbol, p] of this.positionsValue) {
      const last = this.lastValue.get(symbol);
      if (last !== undefined) pnl += (last - p.avgPrice) * p.qty;
    }
    return pnl;
  }

  /** What the open positions hold (their margin) and the working orders' new exposure. */
  marginUsed(): number {
    let used = 0;
    for (const p of this.positionsValue.values()) used += this.marginOf(p.symbol, p.qty, p.avgPrice);
    for (const o of this.ordersValue) {
      if (o.status !== "working") continue;
      const ref = this.referencePrice(o);
      if (ref !== null) used += this.marginOf(o.symbol, this.newExposure(o.symbol, o.side, o.qty), ref);
    }
    return used;
  }

  /** The margin a position or order holds: its value, divided by its asset class's leverage when margin control is
   *  on (1:1 when it is off). A working order holds only the exposure that adds to a position. */
  private marginOf(symbol: string, qty: number, price: number): number {
    const gross = Math.abs(qty) * price;
    if (!this.settingsValue.marginControl) return gross;
    const lev = this.settingsValue.leverage[assetClassOf(symbol)];
    return Number.isFinite(lev) && lev > 0 ? gross / lev : gross;
  }

  marginFree(): number {
    return this.balance - this.marginUsed();
  }

  /** The symbols the account needs live prices for (its positions and working orders). */
  symbols(): string[] {
    const out = new Set<string>();
    for (const [symbol, p] of this.positionsValue) if (p.qty !== 0) out.add(symbol);
    for (const o of this.ordersValue) if (o.status === "working") out.add(key(o.symbol));
    return [...out];
  }

  /** New settings: the name, the starting balance, margin control with its leverage, and the commissions. A field
   *  the caller leaves out keeps its value; the starting balance counts from the account's realized profit, so the
   *  equity keeps its shape. */
  setSettings(next: PaperSettingsPatch): void {
    const cur = this.settingsValue;
    const balance = positive(next.startingBalance);
    const currency = next.currency?.trim();
    this.settingsValue = {
      name: typeof next.name === "string" ? next.name.trim().slice(0, 40) : cur.name,
      startingBalance: balance ?? cur.startingBalance,
      currency: currency ? currency.toUpperCase() : cur.currency,
      marginControl: typeof next.marginControl === "boolean" ? next.marginControl : cur.marginControl,
      leverage: next.leverage ? sanitizeLeverage(next.leverage, cur.leverage) : cur.leverage,
      commission: next.commission ? sanitizeCommission(next.commission, cur.commission) : cur.commission,
    };
  }

  /** A new account: no positions, no orders, no history; the settings stay. */
  reset(settings?: PaperSettingsPatch, now = Date.now()): void {
    this.setSettings(settings ?? {});
    this.ordersValue = [];
    this.positionsValue.clear();
    this.fillsValue = [];
    this.lastValue.clear();
    this.realizedValue = 0;
    this.feesValue = 0;
    this.seq = 0;
    this.fillSeq = 0;
    this.openedMs = now;
    this.out = [];
  }

  // ------------------------------------------------------------ prices

  /** The last price seen of a symbol. */
  price(symbol: string): number | null {
    return this.lastValue.get(key(symbol)) ?? null;
  }

  /** A new price: the working orders and the position's brackets are checked against it. Returns whether the
   *  account changed (a fill, a cancellation), so the store saves only then; the price itself is kept either way. */
  tick(symbol: string, price: number, now = Date.now()): boolean {
    const at = positive(price);
    if (at === null) return false;
    const s = key(symbol);
    this.lastValue.set(s, at);
    let changed = false;
    // Oldest order first, as the market would have met them.
    for (const o of [...this.ordersValue].reverse()) {
      if (o.status !== "working" || key(o.symbol) !== s) continue;
      const fill = this.fillPriceOf(o, at);
      if (fill === null) continue;
      this.fillOrder(o, fill, now);
      changed = true;
    }
    // A position opened by an order above may have its brackets reached by the same tick.
    if (this.closeOnBracket(s, at, now)) changed = true;
    return changed;
  }

  /** The price an order fills at with this tick, or null while it is not met (a stop-limit is triggered on the way). */
  private fillPriceOf(o: PaperOrder, price: number): number | null {
    const buy = o.side === "buy";
    if (o.type === "limit") return this.limitHit(o, price);
    if (o.type === "stop") return o.stopPrice !== null && this.reached(o.stopPrice, buy, price) ? price : null;
    // A stop-limit: its stop makes it a limit order, which may fill in the same tick.
    if (!o.triggered && o.stopPrice !== null && this.reached(o.stopPrice, buy, price)) o.triggered = true;
    return o.triggered ? this.limitHit(o, price) : null;
  }

  /** A limit price the tick reaches: the order fills at the price or better. */
  private limitHit(o: PaperOrder, price: number): number | null {
    if (o.limitPrice === null) return null;
    if (o.side === "buy") return price <= o.limitPrice ? Math.min(price, o.limitPrice) : null;
    return price >= o.limitPrice ? Math.max(price, o.limitPrice) : null;
  }

  private reached(stop: number, buy: boolean, price: number): boolean {
    return buy ? price >= stop : price <= stop;
  }

  /** A position's take profit (a limit, at its price) or stop loss (a stop, at the tick that reaches it). */
  private closeOnBracket(symbol: string, price: number, now: number): boolean {
    const p = this.positionsValue.get(symbol);
    if (!p) return false;
    const long = p.qty > 0;
    const hitTp = p.takeProfit !== null && (long ? price >= p.takeProfit : price <= p.takeProfit);
    const hitSl = p.stopLoss !== null && (long ? price <= p.stopLoss : price >= p.stopLoss);
    if (!hitTp && !hitSl) return false;
    const at = hitTp ? p.takeProfit! : price;
    const side = exitSide(long ? "buy" : "sell");
    const qty = Math.abs(p.qty);
    const label = hitTp ? "Take Profit" : "Stop Loss";
    const realized = this.applyFill(p.symbol, side, qty, at, now);
    this.record({ symbol: p.symbol, side, qty, price: at, timeMs: now, realizedPnl: realized, orderId: null });
    this.emit(p.symbol, { kind: "executed", label, side, qty, price: at });
    return true;
  }

  // ------------------------------------------------------------ reads

  position(symbol: string): TradingPosition | null {
    const p = this.positionsValue.get(key(symbol));
    if (!p || p.qty === 0) return null;
    const last = this.lastValue.get(key(symbol)) ?? p.avgPrice;
    const long = p.qty > 0;
    return {
      id: key(symbol),
      symbol: p.symbol,
      side: long ? "buy" : "sell",
      qty: Math.abs(p.qty),
      avgPrice: p.avgPrice,
      pl: (last - p.avgPrice) * p.qty,
      takeProfit: p.takeProfit,
      stopLoss: p.stopLoss,
    };
  }

  /** The positions, as the account view lists them. */
  positions(): PaperPositionRow[] {
    const out: PaperPositionRow[] = [];
    for (const p of this.positionsValue.values()) {
      const last = this.lastValue.get(key(p.symbol)) ?? null;
      out.push({
        symbol: p.symbol,
        side: p.qty > 0 ? "buy" : "sell",
        qty: Math.abs(p.qty),
        avgPrice: p.avgPrice,
        last,
        takeProfit: p.takeProfit,
        stopLoss: p.stopLoss,
        unrealizedPnl: last === null ? 0 : (last - p.avgPrice) * p.qty,
        openedMs: p.openedMs,
      });
    }
    return out;
  }

  /** The working orders of a symbol, with their brackets and the position's brackets, as the chart draws them. */
  orders(symbol: string): TradingOrder[] {
    const s = key(symbol);
    const out: TradingOrder[] = [];
    for (const o of [...this.ordersValue].reverse()) {
      if (o.status !== "working" || key(o.symbol) !== s) continue;
      out.push({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        qty: o.qty,
        limitPrice: o.limitPrice,
        stopPrice: o.stopPrice,
        kind: "order",
        parentId: null,
        takeProfit: o.takeProfit,
        stopLoss: o.stopLoss,
        stopTriggered: o.type === "stopLimit" ? o.triggered : undefined,
      });
      if (o.takeProfit !== null) out.push(this.bracket(o.symbol, `${o.id}:tp`, exitSide(o.side), o.qty, "tp", o.takeProfit, o.id));
      if (o.stopLoss !== null) out.push(this.bracket(o.symbol, `${o.id}:sl`, exitSide(o.side), o.qty, "sl", o.stopLoss, o.id));
    }
    const p = this.position(s);
    if (p) {
      if (p.takeProfit !== null) out.push(this.bracket(p.symbol, `${POSITION_ID}:tp`, exitSide(p.side), p.qty, "tp", p.takeProfit, POSITION_ID));
      if (p.stopLoss !== null) out.push(this.bracket(p.symbol, `${POSITION_ID}:sl`, exitSide(p.side), p.qty, "sl", p.stopLoss, POSITION_ID));
    }
    return out;
  }

  private bracket(symbol: string, id: string, side: Side, qty: number, kind: "tp" | "sl", price: number, parentId: string): TradingOrder {
    return {
      id,
      symbol,
      side,
      type: kind === "tp" ? "limit" : "stop",
      qty,
      limitPrice: kind === "tp" ? price : null,
      stopPrice: kind === "sl" ? price : null,
      kind,
      parentId,
      takeProfit: null,
      stopLoss: null,
    };
  }

  /** Every order the account view lists: working ones and the history, newest first. */
  orderRows(): PaperOrder[] {
    return [...this.ordersValue].reverse();
  }

  /** The fills of a symbol, oldest first (the chart's execution marks). */
  executions(symbol: string): TradingExecution[] {
    const s = key(symbol);
    return this.fillsValue
      .filter((f) => key(f.symbol) === s)
      .slice()
      .reverse()
      .map((f) => ({ id: f.id, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, time: Math.floor(f.timeMs / 1000) }));
  }

  /** The trade history, newest first. */
  fills(): PaperFill[] {
    return this.fillsValue;
  }

  /** The account's notifications since the last call (order toasts). */
  takeEvents(): TradingEvent[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  // ------------------------------------------------------------ commands

  /** Place an order. The id of the order, or null when it was refused (the rejection is an event). */
  place(req: OrderRequest, now = Date.now()): string | null {
    const symbol = key(req.symbol);
    const label = ORDER_LABEL[req.type];
    const qty = Number(req.qty);
    const reject = (message: string) => this.rejectOrder(symbol, req, qty, now, message);
    if (!(qty > 0) || !Number.isFinite(qty)) return reject("Invalid quantity");

    const limit = req.type === "limit" || req.type === "stopLimit" ? positive(req.limitPrice) : null;
    const stop = req.type === "stop" || req.type === "stopLimit" ? positive(req.stopPrice) : null;
    if ((req.type === "limit" || req.type === "stopLimit") && limit === null) return reject("A limit price is needed.");
    if ((req.type === "stop" || req.type === "stopLimit") && stop === null) return reject("A stop price is needed.");

    const last = this.price(symbol);
    const ref = req.type === "market" ? last : req.type === "stop" ? stop : limit;
    if (ref === null) return reject("No price for this symbol yet.");

    const takeProfit = positive(req.takeProfit);
    const stopLoss = positive(req.stopLoss);
    const bracketError = this.bracketError(req.side, ref, takeProfit, stopLoss);
    if (bracketError) return reject(bracketError);
    if (this.marginOf(symbol, this.newExposure(symbol, req.side, qty), ref) > this.marginFree() + EPS) return reject("Not enough free balance for this order.");

    const order: PaperOrder = {
      id: String(++this.seq),
      symbol,
      side: req.side,
      type: req.type,
      qty,
      limitPrice: limit,
      stopPrice: stop,
      takeProfit,
      stopLoss,
      triggered: false,
      status: "working",
      createdMs: now,
      updatedMs: now,
      fillPrice: null,
    };
    this.ordersValue.push(order);
    this.trim();
    this.emit(symbol, { kind: "placed", label, side: req.side, qty, price: req.type === "market" ? null : ref });

    if (req.type === "market" && last !== null) {
      this.fillOrder(order, last, now);
      return order.id;
    }
    // An entry whose price the market is already at fills on the next tick (a limit at market, a stop reached).
    if (order.type === "stopLimit" && stop !== null && last !== null && this.reached(stop, order.side === "buy", last)) order.triggered = true;
    this.emitBrackets(order, "placed");
    return order.id;
  }

  /** Change a working order; the ticket sends its whole shape (`req`). */
  modify(id: string, req: OrderRequest, now = Date.now()): void {
    const order = this.working(id);
    if (!order) return;
    const label = ORDER_LABEL[order.type];
    const qty = Number(req.qty);
    const price = req.limitPrice ?? req.stopPrice;
    const reject = (message: string) => void this.refuse(order.symbol, label, order.side, qty, price, message);
    if (!(qty > 0) || !Number.isFinite(qty)) return reject("Invalid quantity");
    const limit = order.type === "limit" || order.type === "stopLimit" ? positive(req.limitPrice ?? order.limitPrice) : null;
    const stop = order.type === "stop" || order.type === "stopLimit" ? positive(req.stopPrice ?? order.stopPrice) : null;
    if ((order.type === "limit" || order.type === "stopLimit") && limit === null) return reject("A limit price is needed.");
    if ((order.type === "stop" || order.type === "stopLimit") && stop === null) return reject("A stop price is needed.");
    const ref = order.type === "stop" ? stop : limit ?? this.price(order.symbol);
    if (ref === null) return reject("No price for this symbol yet.");
    const takeProfit = positive(req.takeProfit);
    const stopLoss = positive(req.stopLoss);
    const bracketError = this.bracketError(order.side, ref, takeProfit, stopLoss);
    if (bracketError) return reject(bracketError);
    // The order's own hold comes off the balance before its new size is measured.
    const held = this.referencePrice(order);
    const other = held === null ? 0 : this.marginOf(order.symbol, this.newExposure(order.symbol, order.side, order.qty), held);
    if (this.marginOf(order.symbol, this.newExposure(order.symbol, order.side, qty), ref) > this.marginFree() + other + EPS)
      return reject("Not enough free balance for this order.");

    order.qty = qty;
    order.limitPrice = limit;
    order.stopPrice = stop;
    order.takeProfit = takeProfit;
    order.stopLoss = stopLoss;
    order.updatedMs = now;
    this.emit(order.symbol, { kind: "modified", label, side: order.side, qty, price: order.type === "stop" ? stop : limit });
  }

  /** Cancel an order, or an order's or the position's take profit / stop loss (`"<id>:tp"`, `"position:sl"`). */
  cancel(id: string, symbol: string, now = Date.now()): void {
    const [base, leg] = id.split(":");
    if (leg === "tp" || leg === "sl") {
      if (base === POSITION_ID) {
        const p = this.positionsValue.get(key(symbol));
        if (!p) return;
        const price = leg === "tp" ? p.takeProfit : p.stopLoss;
        if (leg === "tp") p.takeProfit = null;
        else p.stopLoss = null;
        if (price !== null) this.emit(p.symbol, { kind: "cancelled", label: leg === "tp" ? "Take Profit" : "Stop Loss", side: exitSide(p.qty > 0 ? "buy" : "sell"), qty: Math.abs(p.qty), price });
        return;
      }
      const order = this.working(base);
      if (!order) return;
      const price = leg === "tp" ? order.takeProfit : order.stopLoss;
      if (leg === "tp") order.takeProfit = null;
      else order.stopLoss = null;
      order.updatedMs = now;
      if (price !== null) this.emit(order.symbol, { kind: "cancelled", label: leg === "tp" ? "Take Profit" : "Stop Loss", side: exitSide(order.side), qty: order.qty, price });
      return;
    }
    const order = this.working(id);
    if (!order) return;
    order.status = "cancelled";
    order.updatedMs = now;
    this.emit(order.symbol, { kind: "cancelled", label: ORDER_LABEL[order.type], side: order.side, qty: order.qty, price: this.referencePrice(order) });
    this.emitBrackets(order, "cancelled");
  }

  /** Close a position, all of it (`qty` null) or part of it, at the last price. */
  closePosition(symbol: string, qty: number | null = null, now = Date.now()): void {
    const p = this.positionsValue.get(key(symbol));
    if (!p) return;
    const all = Math.abs(p.qty);
    const closing = qty === null ? all : Math.min(Number(qty), all);
    if (!(closing > 0) || !Number.isFinite(closing)) return;
    const price = this.price(symbol);
    const side = p.qty > 0 ? "sell" : "buy";
    if (price === null) return void this.refuse(p.symbol, ORDER_LABEL.market, side, closing, null, "No price for this symbol yet.");
    this.emit(p.symbol, { kind: "placed", label: ORDER_LABEL.market, side, qty: closing, price: null });
    const realized = this.applyFill(p.symbol, side, closing, price, now);
    this.record({ symbol: p.symbol, side, qty: closing, price, timeMs: now, realizedPnl: realized, orderId: null });
    this.emit(p.symbol, { kind: "executed", label: ORDER_LABEL.market, side, qty: closing, price: null });
  }

  /** Close the position and open the other way: a market order of twice its quantity. */
  reverse(symbol: string, now = Date.now()): void {
    const p = this.positionsValue.get(key(symbol));
    if (!p) return;
    const qty = Math.abs(p.qty) * 2;
    const price = this.price(symbol);
    const side = p.qty > 0 ? "sell" : "buy";
    if (price === null) return void this.refuse(p.symbol, ORDER_LABEL.market, side, qty, null, "No price for this symbol yet.");
    if (this.marginOf(p.symbol, this.newExposure(p.symbol, side, qty), price) > this.marginFree() + EPS)
      return void this.refuse(p.symbol, ORDER_LABEL.market, side, qty, null, "Not enough free balance for this order.");
    this.emit(p.symbol, { kind: "placed", label: ORDER_LABEL.market, side, qty, price: null });
    const realized = this.applyFill(p.symbol, side, qty, price, now);
    this.record({ symbol: p.symbol, side, qty, price, timeMs: now, realizedPnl: realized, orderId: null });
    this.emit(p.symbol, { kind: "executed", label: ORDER_LABEL.market, side, qty, price: null });
  }

  /** Set (or remove, with null) the position's take profit / stop loss. */
  setPositionBrackets(symbol: string, takeProfit: number | null, stopLoss: number | null): void {
    const p = this.positionsValue.get(key(symbol));
    if (!p) return;
    const ref = this.price(symbol) ?? p.avgPrice;
    const side: Side = p.qty > 0 ? "buy" : "sell";
    const error = this.bracketError(side, ref, takeProfit, stopLoss);
    if (error) return void this.refuse(p.symbol, error.startsWith("The take profit") ? "Take Profit" : "Stop Loss", side, Math.abs(p.qty), null, error);
    const legs: ["tp" | "sl", number | null, number | null][] = [
      ["tp", p.takeProfit, takeProfit],
      ["sl", p.stopLoss, stopLoss],
    ];
    p.takeProfit = takeProfit;
    p.stopLoss = stopLoss;
    for (const [leg, before, after] of legs) {
      const label = leg === "tp" ? "Take Profit" : "Stop Loss";
      if (before === null && after !== null) this.emit(p.symbol, { kind: "placed", label, side: exitSide(side), qty: Math.abs(p.qty), price: after });
      else if (before !== null && after === null) this.emit(p.symbol, { kind: "cancelled", label, side: exitSide(side), qty: Math.abs(p.qty), price: before });
      else if (before !== null && after !== null && before !== after) this.emit(p.symbol, { kind: "modified", label, side: exitSide(side), qty: Math.abs(p.qty), price: after });
    }
  }

  // ------------------------------------------------------------ fills

  /** Fill an order at `price`: the position and the realized profit move, the fill is kept, the toast goes out. */
  private fillOrder(o: PaperOrder, price: number, now: number): void {
    o.status = "filled";
    o.fillPrice = price;
    o.updatedMs = now;
    const realized = this.applyFill(o.symbol, o.side, o.qty, price, now);
    this.record({ symbol: o.symbol, side: o.side, qty: o.qty, price, timeMs: now, realizedPnl: realized, orderId: o.id });
    this.emit(o.symbol, { kind: "executed", label: ORDER_LABEL[o.type], side: o.side, qty: o.qty, price: o.type === "market" ? null : price });
    // Its take profit / stop loss protect the position it opened.
    const p = this.positionsValue.get(key(o.symbol));
    if (p && Math.sign(p.qty) === (o.side === "buy" ? 1 : -1) && (o.takeProfit !== null || o.stopLoss !== null)) {
      p.takeProfit = o.takeProfit;
      p.stopLoss = o.stopLoss;
    }
  }

  /** Move a position by a fill, netting (one position per symbol), and return the profit it took. */
  private applyFill(symbol: string, side: Side, qty: number, price: number, now: number): number {
    const s = key(symbol);
    const signed = side === "buy" ? qty : -qty;
    const p = this.positionsValue.get(s);
    let realized = 0;
    if (!p) {
      this.positionsValue.set(s, { symbol, qty: signed, avgPrice: price, takeProfit: null, stopLoss: null, openedMs: now });
    } else if (Math.sign(p.qty) === Math.sign(signed)) {
      const total = Math.abs(p.qty) + qty;
      p.avgPrice = (Math.abs(p.qty) * p.avgPrice + qty * price) / total;
      p.qty += signed;
    } else {
      const closing = Math.min(qty, Math.abs(p.qty));
      realized = (price - p.avgPrice) * closing * Math.sign(p.qty);
      const left = Math.abs(p.qty) - closing;
      const flip = qty - closing;
      if (left > EPS) {
        p.qty = Math.sign(p.qty) * left;
      } else if (flip > EPS) {
        // Through the position: the rest opens the other way, without the old brackets.
        this.positionsValue.set(s, { symbol, qty: Math.sign(signed) * flip, avgPrice: price, takeProfit: null, stopLoss: null, openedMs: now });
      } else {
        this.positionsValue.delete(s);
      }
    }
    this.realizedValue += realized;
    return realized;
  }

  private record(fill: Omit<PaperFill, "id" | "fee">): void {
    const fee = this.feeOf(fill.symbol, fill.qty, fill.price);
    this.feesValue += fee;
    this.fillsValue.unshift({ id: `F${++this.fillSeq}`, fee, ...fill });
    this.trim();
  }

  /** The commission a fill pays: per contract for futures and options, a percent of the trade's value or a flat
   *  amount for the rest; zero unless that section is on. */
  private feeOf(symbol: string, qty: number, price: number): number {
    const c = this.settingsValue.commission;
    if (assetClassOf(symbol) === "futures") return c.futuresOptions.enabled ? qty * c.futuresOptions.perContract : 0;
    if (!c.others.enabled) return 0;
    return c.others.type === "percent" ? (qty * price * c.others.value) / 100 : c.others.value;
  }

  /** Keep the history to its last rows: the oldest filled, cancelled or rejected orders go, working orders stay. */
  private trim(): void {
    if (this.fillsValue.length > MAX_ROWS) this.fillsValue.length = MAX_ROWS;
    let excess = this.ordersValue.length - MAX_ROWS;
    if (excess <= 0) return;
    const done = new Set<string>();
    for (const o of this.ordersValue) {
      if (excess <= 0) break;
      if (o.status === "working") continue;
      done.add(o.id);
      excess--;
    }
    this.ordersValue = this.ordersValue.filter((o) => !done.has(o.id));
  }

  // ------------------------------------------------------------ balance

  /** The quantity of an order that adds exposure: the part beyond the opposite position it would close. */
  private newExposure(symbol: string, side: Side, qty: number): number {
    const p = this.positionsValue.get(key(symbol));
    if (!p) return qty;
    const reduces = (side === "buy" && p.qty < 0) || (side === "sell" && p.qty > 0);
    return reduces ? Math.max(0, qty - Math.abs(p.qty)) : qty;
  }

  /** The price an order holds its balance at: its trigger, its limit, or the market. */
  private referencePrice(o: PaperOrder): number | null {
    if (o.type === "market") return this.price(o.symbol);
    return o.type === "stop" ? o.stopPrice : o.limitPrice;
  }

  /** The take profit above the entry (below it on a sell) and the stop loss below it: the order of the two follows. */
  private bracketError(side: Side, ref: number, takeProfit: number | null, stopLoss: number | null): string | null {
    const buy = side === "buy";
    if (takeProfit !== null && (buy ? takeProfit <= ref : takeProfit >= ref)) return "The take profit is on the wrong side of the price.";
    if (stopLoss !== null && (buy ? stopLoss >= ref : stopLoss <= ref)) return "The stop loss is on the wrong side of the price.";
    return null;
  }

  // ------------------------------------------------------------ events

  private refuse(symbol: string, label: string, side: Side, qty: number, price: number | null, message: string): null {
    this.emit(symbol, { kind: "rejected", label, side, qty, price, message });
    return null;
  }

  /** Refuse an order the account view keeps, with its reason: a rejected order shows there like at a broker. */
  private rejectOrder(symbol: string, req: OrderRequest, qty: number, now: number, message: string): null {
    this.ordersValue.push({
      id: String(++this.seq),
      symbol,
      side: req.side,
      type: req.type,
      qty: Number.isFinite(qty) ? qty : 0,
      limitPrice: positive(req.limitPrice),
      stopPrice: positive(req.stopPrice),
      takeProfit: positive(req.takeProfit),
      stopLoss: positive(req.stopLoss),
      triggered: false,
      status: "rejected",
      createdMs: now,
      updatedMs: now,
      fillPrice: null,
      message,
    });
    this.trim();
    this.refuse(symbol, ORDER_LABEL[req.type], req.side, qty, req.limitPrice ?? req.stopPrice, message);
    return null;
  }

  private emitBrackets(o: PaperOrder, kind: "placed" | "cancelled"): void {
    const side = exitSide(o.side);
    if (o.takeProfit !== null) this.emit(o.symbol, { kind, label: "Take Profit", side, qty: o.qty, price: o.takeProfit });
    if (o.stopLoss !== null) this.emit(o.symbol, { kind, label: "Stop Loss", side, qty: o.qty, price: o.stopLoss });
  }

  private emit(symbol: string, e: Omit<TradingEvent, "symbol">): void {
    this.out.push({ ...e, symbol });
  }

  private working(id: string): PaperOrder | undefined {
    return this.ordersValue.find((o) => o.id === id && o.status === "working");
  }

  // ------------------------------------------------------------ persistence

  /** The account as the store keeps it. */
  toJSON(): PaperSnapshot {
    return {
      version: 1,
      settings: this.settingsValue,
      orders: this.ordersValue,
      positions: [...this.positionsValue.values()],
      fills: this.fillsValue,
      last: Object.fromEntries(this.lastValue),
      realizedPnl: this.realizedValue,
      fees: this.feesValue,
      seq: this.seq,
      openedMs: this.openedMs,
    };
  }

  /** Read a stored account back; a value that does not make sense falls back to a new account. */
  private load(snap: PaperSnapshot): void {
    const s = (snap.settings ?? {}) as PaperSettingsPatch;
    this.settingsValue = {
      name: typeof s.name === "string" ? s.name : DEFAULT_PAPER_SETTINGS.name,
      startingBalance: positive(s.startingBalance) ?? DEFAULT_PAPER_SETTINGS.startingBalance,
      currency: s.currency?.trim().toUpperCase() || DEFAULT_PAPER_SETTINGS.currency,
      marginControl: s.marginControl === true,
      leverage: sanitizeLeverage(s.leverage, DEFAULT_PAPER_SETTINGS.leverage),
      commission: sanitizeCommission(s.commission, DEFAULT_PAPER_SETTINGS.commission),
    };
    this.ordersValue = Array.isArray(snap.orders) ? snap.orders.filter((o) => o && typeof o.id === "string" && typeof o.symbol === "string") : [];
    for (const p of Array.isArray(snap.positions) ? snap.positions : []) {
      const qty = Number(p.qty);
      const avg = positive(p.avgPrice);
      if (!Number.isFinite(qty) || qty === 0 || avg === null) continue;
      this.positionsValue.set(key(p.symbol), {
        symbol: p.symbol,
        qty,
        avgPrice: avg,
        takeProfit: positive(p.takeProfit),
        stopLoss: positive(p.stopLoss),
        openedMs: Number(p.openedMs) || Date.now(),
      });
    }
    this.fillsValue = Array.isArray(snap.fills) ? snap.fills.filter((f) => f && typeof f.id === "string") : [];
    this.lastValue = new Map(
      Object.entries(snap.last ?? {}).filter(([s, v]) => s && typeof v === "number" && Number.isFinite(v) && v > 0) as [string, number][],
    );
    this.realizedValue = Number.isFinite(snap.realizedPnl) ? Number(snap.realizedPnl) : 0;
    this.feesValue = Number.isFinite(snap.fees) ? Number(snap.fees) : 0;
    this.seq = Math.max(0, ...this.ordersValue.map((o) => Number(o.id) || 0), Number(snap.seq) || 0);
    this.fillSeq = this.fillsValue.reduce((max, f) => Math.max(max, Number(f.id.slice(1)) || 0), 0);
    this.openedMs = Number(snap.openedMs) || Date.now();
  }

  /** An account from its stored state. */
  static fromJSON(snap: PaperSnapshot | null | undefined): PaperAccount {
    return new PaperAccount(snap ?? null);
  }
}
