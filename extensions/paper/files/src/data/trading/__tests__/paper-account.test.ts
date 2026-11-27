import { describe, expect, it } from "vitest";
import { DEFAULT_LEVERAGE, DEFAULT_PAPER_SETTINGS, PaperAccount, assetClassOf, type PaperSnapshot } from "../paper-account";
import type { OrderRequest } from "../types";

const SYMBOL = "BINANCE:BTC/USDT";

const account = (startingBalance = 10_000) => {
  const a = new PaperAccount();
  a.setSettings({ startingBalance, currency: "USD" });
  return a;
};

const req = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: SYMBOL,
  side: "buy",
  type: "market",
  qty: 1,
  limitPrice: null,
  stopPrice: null,
  takeProfit: null,
  stopLoss: null,
  ...over,
});

/** An account at 100 with the given last price (a tick gives the engine its first price). */
const atPrice = (price = 100, startingBalance = 10_000) => {
  const a = account(startingBalance);
  a.tick(SYMBOL, price, 1_000);
  a.takeEvents();
  return a;
};

describe("PaperAccount: market orders", () => {
  it("fills at the last price, holds the notional and shows the P&L", () => {
    const a = atPrice();
    const id = a.place(req({ qty: 2 }), 2_000);
    expect(id).toBe("1");
    const p = a.position(SYMBOL)!;
    expect(p).toMatchObject({ side: "buy", qty: 2, avgPrice: 100, pl: 0 });
    expect(a.balance).toBe(10_000);
    expect(a.equity).toBe(10_000);
    expect(a.marginUsed()).toBe(200);
    expect(a.marginFree()).toBe(9_800);
    expect(a.executions(SYMBOL)).toEqual([{ id: expect.any(String), symbol: SYMBOL, side: "buy", qty: 2, price: 100, time: 2 }]);

    a.tick(SYMBOL, 110, 3_000);
    expect(a.position(SYMBOL)!.pl).toBe(20);
    expect(a.equity).toBe(10_020);
    expect(a.realizedPnl).toBe(0);
  });

  it("refuses an order bigger than the free balance", () => {
    const a = atPrice(100, 1_000);
    expect(a.place(req({ qty: 11 }), 2_000)).toBeNull();
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.takeEvents()).toEqual([expect.objectContaining({ kind: "rejected", symbol: SYMBOL, message: "Not enough free balance for this order." })]);
    // The refusal stays in the orders, with its reason.
    expect(a.orderRows()).toMatchObject([{ status: "rejected", qty: 11, message: "Not enough free balance for this order." }]);
  });

  it("refuses a market order before the first price, and a bad quantity", () => {
    const a = account();
    expect(a.place(req(), 1_000)).toBeNull();
    expect(a.place(req({ qty: 0 }), 1_000)).toBeNull();
    expect(a.takeEvents().map((e) => e.message)).toEqual(["No price for this symbol yet.", "Invalid quantity"]);
  });

  it("counts a working order's notional as held", () => {
    const a = atPrice(100, 500);
    expect(a.place(req({ side: "buy", type: "limit", limitPrice: 50, qty: 5 }), 2_000)).toBe("1");
    // 250 held, 250 free: another 600 does not fit.
    expect(a.place(req({ side: "buy", type: "limit", limitPrice: 60, qty: 10 }), 2_100)).toBeNull();
    expect(a.marginUsed()).toBe(250);
    expect(a.marginFree()).toBe(250);
  });
});

describe("PaperAccount: limit and stop orders", () => {
  it("fills a buy limit at or below its price, at the price or better", () => {
    const a = atPrice(100);
    a.place(req({ type: "limit", limitPrice: 95 }), 2_000);
    a.takeEvents();
    a.tick(SYMBOL, 96, 3_000);
    expect(a.position(SYMBOL)).toBeNull();
    a.tick(SYMBOL, 94, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ side: "buy", qty: 1, avgPrice: 94 });
    expect(a.orderRows()[0]).toMatchObject({ status: "filled", fillPrice: 94 });
    expect(a.takeEvents()).toEqual([expect.objectContaining({ kind: "executed", label: "Limit", price: 94 })]);
  });

  it("fills a sell limit at or above its price", () => {
    const a = atPrice(100);
    // A short needs its notional held; 10 000 covers it.
    a.place(req({ side: "sell", type: "limit", limitPrice: 105 }), 2_000);
    a.tick(SYMBOL, 104, 3_000);
    expect(a.position(SYMBOL)).toBeNull();
    a.tick(SYMBOL, 106, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ side: "sell", qty: 1, avgPrice: 106 });
  });

  it("fills a stop at the tick that reaches it (a gap fills beyond it)", () => {
    const a = atPrice(100);
    a.place(req({ type: "stop", stopPrice: 105 }), 2_000);
    a.tick(SYMBOL, 104, 3_000);
    expect(a.position(SYMBOL)).toBeNull();
    a.tick(SYMBOL, 110, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ side: "buy", avgPrice: 110 });
  });

  it("works a stop-limit as a limit once its stop is reached", () => {
    const a = atPrice(100);
    a.place(req({ type: "stopLimit", stopPrice: 105, limitPrice: 106 }), 2_000);
    // The stop is not reached: nothing works.
    a.tick(SYMBOL, 103, 3_000);
    expect(a.orders(SYMBOL).filter((o) => o.kind === "order")).toMatchObject([{ stopTriggered: false }]);
    // The stop is reached and its limit is at the tick: it fills.
    a.tick(SYMBOL, 105.5, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ side: "buy", avgPrice: 105.5 });
  });

  it("keeps the limit working when the stop is reached above it", () => {
    const a = atPrice(100);
    a.place(req({ type: "stopLimit", stopPrice: 105, limitPrice: 104 }), 2_000);
    a.tick(SYMBOL, 105, 3_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.orders(SYMBOL).filter((o) => o.kind === "order")).toMatchObject([{ type: "stopLimit", stopTriggered: true }]);
    a.tick(SYMBOL, 103.5, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ avgPrice: 103.5 });
  });

  it("cancels a working order, and its bracket legs", () => {
    const a = atPrice(100);
    a.place(req({ type: "limit", limitPrice: 95, takeProfit: 110, stopLoss: 90 }), 2_000);
    a.takeEvents();
    a.cancel("1:tp", SYMBOL, 3_000);
    expect(a.orderRows()[0]).toMatchObject({ takeProfit: null, stopLoss: 90 });
    a.cancel("1", SYMBOL, 4_000);
    expect(a.orderRows()[0].status).toBe("cancelled");
    expect(a.orders(SYMBOL)).toEqual([]);
    expect(a.takeEvents().map((e) => e.kind)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("modifies a working order's price and size", () => {
    const a = atPrice(100);
    a.place(req({ type: "limit", limitPrice: 95 }), 2_000);
    a.modify("1", req({ type: "limit", limitPrice: 98, qty: 2, takeProfit: 105 }), 3_000);
    expect(a.orderRows()[0]).toMatchObject({ qty: 2, limitPrice: 98, takeProfit: 105 });
    a.tick(SYMBOL, 97.5, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ qty: 2, avgPrice: 97.5 });
  });
});

describe("PaperAccount: brackets", () => {
  it("closes the position at the take profit's price", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2, takeProfit: 110, stopLoss: 90 }), 2_000);
    expect(a.position(SYMBOL)).toMatchObject({ takeProfit: 110, stopLoss: 90 });
    a.tick(SYMBOL, 112, 3_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.realizedPnl).toBe(20);
    expect(a.balance).toBe(10_020);
    expect(a.fills()[0]).toMatchObject({ side: "sell", qty: 2, price: 110, realizedPnl: 20 });
  });

  it("closes the position at the tick that reaches the stop loss", () => {
    const a = atPrice(100);
    a.place(req({ takeProfit: 110, stopLoss: 90 }), 2_000);
    a.tick(SYMBOL, 88, 3_000);
    expect(a.realizedPnl).toBe(-12);
    expect(a.position(SYMBOL)).toBeNull();
  });

  it("gives an order's brackets to the position it fills", () => {
    const a = atPrice(100);
    a.place(req({ type: "limit", limitPrice: 95, takeProfit: 105, stopLoss: 90 }), 2_000);
    a.tick(SYMBOL, 95, 3_000);
    expect(a.position(SYMBOL)).toMatchObject({ takeProfit: 105, stopLoss: 90 });
    a.tick(SYMBOL, 106, 4_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.realizedPnl).toBe(10);
  });

  it("sets and cancels the position's brackets; the chart lists them", () => {
    const a = atPrice(100);
    a.place(req({ qty: 1 }), 2_000);
    a.setPositionBrackets(SYMBOL, 120, 80);
    expect(a.orders(SYMBOL).filter((o) => o.kind !== "order")).toMatchObject([
      { id: "position:tp", kind: "tp", limitPrice: 120, side: "sell" },
      { id: "position:sl", kind: "sl", stopPrice: 80, side: "sell" },
    ]);
    a.cancel("position:tp", SYMBOL, 3_000);
    expect(a.position(SYMBOL)).toMatchObject({ takeProfit: null, stopLoss: 80 });
  });

  it("refuses brackets on the wrong side of the price", () => {
    const a = atPrice(100);
    a.place(req({ takeProfit: 95 }), 2_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.takeEvents()[0]).toMatchObject({ kind: "rejected", message: "The take profit is on the wrong side of the price." });
    a.place(req({ stopLoss: 120 }), 2_100);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.takeEvents()[0]).toMatchObject({ message: "The stop loss is on the wrong side of the price." });
    // Measured from the order's own price (its limit), not from the market.
    a.place(req({ type: "limit", limitPrice: 95, takeProfit: 94 }), 2_200);
    expect(a.takeEvents()[0]).toMatchObject({ message: "The take profit is on the wrong side of the price." });
  });
});

describe("PaperAccount: positions", () => {
  it("takes the realized profit of a partial close and keeps the rest", () => {
    const a = atPrice(100);
    a.place(req({ qty: 4, takeProfit: 130, stopLoss: 90 }), 2_000);
    a.tick(SYMBOL, 110, 3_000);
    a.closePosition(SYMBOL, 1, 4_000);
    expect(a.realizedPnl).toBe(10);
    expect(a.position(SYMBOL)).toMatchObject({ qty: 3, avgPrice: 100, takeProfit: 130, stopLoss: 90 });
    expect(a.balance).toBe(10_010);
  });

  it("nets one position per symbol and flips through zero", () => {
    const a = atPrice(100);
    a.place(req({ qty: 1 }), 2_000);
    a.tick(SYMBOL, 120, 3_000);
    a.place(req({ side: "sell", qty: 3 }), 4_000);
    expect(a.realizedPnl).toBe(20);
    expect(a.position(SYMBOL)).toMatchObject({ side: "sell", qty: 2, avgPrice: 120 });
    expect(a.balance).toBe(10_020);
  });

  it("reverses the position with one order of twice its size", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2 }), 2_000);
    a.tick(SYMBOL, 105, 3_000);
    a.takeEvents();
    a.reverse(SYMBOL, 4_000);
    expect(a.position(SYMBOL)).toMatchObject({ side: "sell", qty: 2, avgPrice: 105 });
    expect(a.realizedPnl).toBe(10);
    expect(a.takeEvents().map((e) => e.kind)).toEqual(["placed", "executed"]);
  });

  it("refuses to close a position while it has no price, and keeps it", () => {
    const a = atPrice(100);
    a.place(req(), 2_000);
    const snap = a.toJSON();
    snap.last = {};
    const b = PaperAccount.fromJSON(snap);
    b.takeEvents();
    b.closePosition(SYMBOL, null, 5_000);
    expect(b.position(SYMBOL)).toMatchObject({ qty: 1, avgPrice: 100, pl: 0 });
    expect(b.takeEvents()).toEqual([expect.objectContaining({ kind: "rejected", message: "No price for this symbol yet." })]);
  });
});

describe("PaperAccount: persistence", () => {
  it("restores positions, orders, fills and prices, and settles from the same state", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2, takeProfit: 110 }), 2_000);
    a.place(req({ side: "sell", type: "limit", limitPrice: 120, qty: 1 }), 2_500);
    a.tick(SYMBOL, 104, 3_000);

    const b = PaperAccount.fromJSON(a.toJSON());
    expect(b.position(SYMBOL)).toMatchObject({ qty: 2, avgPrice: 100, takeProfit: 110, pl: 8 });
    expect(b.orders(SYMBOL).filter((o) => o.kind === "order")).toHaveLength(1);
    expect(b.price(SYMBOL)).toBe(104);
    expect(b.balance).toBe(a.balance);

    b.tick(SYMBOL, 111, 4_000);
    expect(b.position(SYMBOL)).toBeNull();
    expect(b.realizedPnl).toBe(20);
    expect(b.toJSON().positions).toEqual([]);
  });

  it("keeps ids unique across a restore", () => {
    const a = atPrice(100);
    a.place(req(), 2_000);
    const b = PaperAccount.fromJSON(a.toJSON());
    expect(b.place(req(), 3_000)).toBe("2");
    expect(b.fills()[0].orderId).toBe("2");
  });

  it("resets every position, order and fill, keeping the settings", () => {
    const a = atPrice(100);
    a.place(req({ takeProfit: 110 }), 2_000);
    a.tick(SYMBOL, 111, 3_000);
    a.reset(undefined, 5_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.orderRows()).toEqual([]);
    expect(a.fills()).toEqual([]);
    expect(a.realizedPnl).toBe(0);
    expect(a.settings.startingBalance).toBe(10_000);
    expect(a.openedAt).toBe(5_000);
  });

  it("starts over at a chosen equity, ignoring invalid amounts", () => {
    const a = atPrice(100);
    a.place(req({ takeProfit: 110 }), 2_000);
    a.tick(SYMBOL, 111, 3_000);
    a.reset({ startingBalance: 25_000, currency: "eur" }, 6_000);
    expect(a.settings).toMatchObject({ startingBalance: 25_000, currency: "EUR" });
    expect(a.balance).toBe(25_000);
    expect(a.equity).toBe(25_000);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.orderRows()).toEqual([]);
    expect(a.fills()).toEqual([]);
    a.reset({ startingBalance: Number.NaN }, 7_000);
    expect(a.settings.startingBalance).toBe(25_000);
    expect(a.balance).toBe(25_000);
  });

  it("counts a restored account's realized profit into its balance", () => {
    const snap: PaperSnapshot = {
      version: 1,
      settings: { ...DEFAULT_PAPER_SETTINGS, startingBalance: 5_000, currency: "USD" },
      orders: [],
      positions: [],
      fills: [],
      last: {},
      realizedPnl: 250,
      fees: 0,
      seq: 0,
      openedMs: 1,
    };
    const a = PaperAccount.fromJSON(snap);
    expect(a.balance).toBe(5_250);
  });
});

describe("PaperAccount: asset classes", () => {
  it("reads the class from the exchange code and the symbol's shape", () => {
    expect(assetClassOf("NASDAQ:AAPL")).toBe("stocks");
    expect(assetClassOf("nse:reliance")).toBe("stocks");
    expect(assetClassOf("BINANCE:BTC/USDT")).toBe("crypto");
    expect(assetClassOf("FX:EURUSD")).toBe("forex");
    expect(assetClassOf("EURUSD")).toBe("forex");
    expect(assetClassOf("CME:ES1!")).toBe("futures");
    expect(assetClassOf("OPRA:AAPL240119C00150000")).toBe("futures");
    expect(assetClassOf("SP:SPX")).toBe("others");
  });
});

describe("PaperAccount: leverage and margin control", () => {
  it("trades 1:1 with margin control off", () => {
    const a = atPrice(100, 1_000);
    expect(a.place(req({ qty: 5 }), 2_000)).toBe("1");
    expect(a.marginUsed()).toBe(500);
    expect(a.marginFree()).toBe(500);
  });

  it("holds the notional divided by the class's leverage with margin control on", () => {
    const a = account(1_000);
    a.setSettings({ marginControl: true, leverage: { ...DEFAULT_LEVERAGE, crypto: 10 } });
    a.tick(SYMBOL, 100, 1_000);
    a.takeEvents();
    expect(a.place(req({ qty: 50 }), 2_000)).toBe("1");
    expect(a.marginUsed()).toBe(500);
    expect(a.marginFree()).toBe(500);
  });

  it("refuses an order whose margin exceeds the free funds, and takes one that fits", () => {
    const a = account(1_000);
    a.setSettings({ marginControl: true, leverage: { ...DEFAULT_LEVERAGE, crypto: 10 } });
    a.tick(SYMBOL, 100, 1_000);
    a.takeEvents();
    expect(a.place(req({ qty: 101 }), 2_000)).toBeNull();
    expect(a.takeEvents()).toEqual([expect.objectContaining({ kind: "rejected", message: "Not enough free balance for this order." })]);
    expect(a.place(req({ qty: 100 }), 2_500)).not.toBeNull();
    expect(a.marginFree()).toBe(0);
  });
});

describe("PaperAccount: commissions", () => {
  it("charges a percent of the trade's value on every fill", () => {
    const a = atPrice(100);
    a.setSettings({ commission: { others: { enabled: true, value: 0.1, type: "percent" } } });
    a.place(req({ qty: 2 }), 2_000);
    a.tick(SYMBOL, 110, 3_000);
    a.closePosition(SYMBOL, null, 4_000);
    expect(a.commissions).toBeCloseTo(0.42);
    expect(a.balance).toBeCloseTo(10_019.58);
    const fees = a.fills().map((f) => f.fee);
    expect(fees).toHaveLength(2);
    expect(fees[0]).toBeCloseTo(0.22);
    expect(fees[1]).toBeCloseTo(0.2);
  });

  it("charges a flat amount per fill for others", () => {
    const a = atPrice(100);
    a.setSettings({ commission: { others: { enabled: true, value: 1.5, type: "absolute" } } });
    a.place(req({ qty: 2 }), 2_000);
    expect(a.commissions).toBe(1.5);
    expect(a.balance).toBe(9_998.5);
  });

  it("charges a per-contract commission for futures and options", () => {
    const a = account(10_000);
    a.setSettings({ marginControl: true, commission: { futuresOptions: { enabled: true, perContract: 1.25 } } });
    a.tick("CME:ES1!", 4_000, 1_000);
    a.takeEvents();
    expect(a.place(req({ symbol: "CME:ES1!", qty: 3 }), 2_000)).not.toBeNull();
    expect(a.commissions).toBe(3.75);
    expect(a.balance).toBe(9_996.25);
  });

  it("leaves the balance untouched with no commission enabled", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2 }), 2_000);
    expect(a.commissions).toBe(0);
    expect(a.balance).toBe(10_000);
    expect(a.fills()[0].fee).toBe(0);
  });

  it("keeps commissions across a restore and clears them on reset", () => {
    const a = atPrice(100);
    a.setSettings({ commission: { others: { enabled: true, value: 0.5, type: "absolute" } } });
    a.place(req({ qty: 2 }), 2_000);
    const b = PaperAccount.fromJSON(a.toJSON());
    expect(b.commissions).toBe(0.5);
    expect(b.balance).toBe(9_999.5);
    b.reset(undefined, 5_000);
    expect(b.commissions).toBe(0);
    expect(b.balance).toBe(10_000);
  });
});

describe("PaperAccount: account settings", () => {
  it("stores the name, the margin control and the commissions, and restores them", () => {
    const a = account();
    a.setSettings({
      name: "  My account  ",
      marginControl: true,
      leverage: { ...DEFAULT_LEVERAGE, crypto: 25 },
      commission: { others: { enabled: true, value: 0.05, type: "absolute" } },
    });
    const s = a.settings;
    expect(s.name).toBe("My account");
    expect(s.marginControl).toBe(true);
    expect(s.leverage.crypto).toBe(25);
    expect(s.commission.others).toEqual({ enabled: true, value: 0.05, type: "absolute" });
    expect(PaperAccount.fromJSON(a.toJSON()).settings).toEqual(s);
  });

  it("falls back on senseless values, keeping the rest", () => {
    const a = account();
    a.setSettings({ leverage: { stocks: 0, futures: Number.NaN }, commission: { others: { value: -5 } } });
    expect(a.settings.leverage.stocks).toBe(DEFAULT_LEVERAGE.stocks);
    expect(a.settings.leverage.futures).toBe(DEFAULT_LEVERAGE.futures);
    expect(a.settings.commission.others.value).toBe(DEFAULT_PAPER_SETTINGS.commission.others.value);
    expect(a.settings.name).toBe("");
  });

  it("reads an old snapshot's settings as defaults, name and all", () => {
    const a = PaperAccount.fromJSON({ version: 1, settings: { startingBalance: 3_000, currency: "USD" } } as PaperSnapshot);
    expect(a.settings).toMatchObject({
      name: "",
      startingBalance: 3_000,
      currency: "USD",
      marginControl: false,
      leverage: DEFAULT_LEVERAGE,
      commission: DEFAULT_PAPER_SETTINGS.commission,
    });
  });
});

describe("PaperAccount: bars missed while the app was away", () => {
  /** A bar at `timeMs` with the given open/high/low/close. */
  const bar = (timeMs: number, open: number, high: number, low: number, close: number) => ({ timeMs, open, high, low, close });

  it("closes at the take profit when a missed bar reached it", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2, takeProfit: 110, stopLoss: 90 }), 2_000);
    expect(a.reconcileChecks()).toEqual([{ symbol: SYMBOL, sinceMs: 2_000 }]);
    expect(a.reconcileBars(SYMBOL, [bar(60_000, 100, 112, 98, 105)])).toBe(true);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.realizedPnl).toBe(20);
    expect(a.balance).toBe(10_020);
    // The fill is at the take profit, timed at the bar, not the tick's price.
    expect(a.fills()[0]).toMatchObject({ side: "sell", qty: 2, price: 110, timeMs: 60_000, realizedPnl: 20 });
    expect(a.price(SYMBOL)).toBe(105);
  });

  it("closes at the stop loss's price, not the bar's low", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2, takeProfit: 110, stopLoss: 90 }), 2_000);
    a.reconcileBars(SYMBOL, [bar(60_000, 100, 101, 85, 88)]);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.realizedPnl).toBe(-20);
    expect(a.fills()[0]).toMatchObject({ side: "sell", qty: 2, price: 90, timeMs: 60_000 });
  });

  it("fills a bar that gapped through the stop at its open", () => {
    const a = atPrice(100);
    a.place(req({ qty: 2, takeProfit: 110, stopLoss: 90 }), 2_000);
    a.reconcileBars(SYMBOL, [bar(60_000, 85, 90, 84, 88)]);
    expect(a.realizedPnl).toBe(-30);
    expect(a.fills()[0]).toMatchObject({ price: 85 });
  });

  it("takes the level the bar met first when both are inside it", () => {
    // The open is nearer the low: the stop loss is reached first.
    const down = atPrice(100);
    down.place(req({ qty: 1, takeProfit: 110, stopLoss: 90 }), 2_000);
    down.reconcileBars(SYMBOL, [bar(60_000, 95, 112, 88, 100)]);
    expect(down.realizedPnl).toBe(-10);
    expect(down.fills()[0]).toMatchObject({ price: 90 });

    // The open is nearer the high: the take profit is reached first.
    const up = atPrice(100);
    up.place(req({ qty: 1, takeProfit: 110, stopLoss: 90 }), 2_000);
    up.reconcileBars(SYMBOL, [bar(60_000, 105, 112, 88, 100)]);
    expect(up.realizedPnl).toBe(10);
    expect(up.fills()[0]).toMatchObject({ price: 110 });
  });

  it("checks a short's brackets the same way", () => {
    const tp = atPrice(100);
    tp.place(req({ side: "sell", qty: 1, takeProfit: 90, stopLoss: 110 }), 2_000);
    tp.reconcileBars(SYMBOL, [bar(60_000, 100, 101, 88, 95)]);
    expect(tp.realizedPnl).toBe(10);
    expect(tp.fills()[0]).toMatchObject({ side: "buy", price: 90 });

    const sl = atPrice(100);
    sl.place(req({ side: "sell", qty: 1, takeProfit: 90, stopLoss: 110 }), 2_000);
    sl.reconcileBars(SYMBOL, [bar(60_000, 100, 112, 99, 105)]);
    expect(sl.realizedPnl).toBe(-10);
    expect(sl.fills()[0]).toMatchObject({ side: "buy", price: 110 });
  });

  it("does not use bars from before the bracket was set", () => {
    const a = atPrice(100);
    a.place(req({ qty: 1 }), 2_000);
    a.setPositionBrackets(SYMBOL, 110, 90, 10_000);
    expect(a.reconcileChecks()).toEqual([{ symbol: SYMBOL, sinceMs: 10_000 }]);
    // An earlier bar that would have reached both: the account had not set the levels then.
    a.reconcileBars(SYMBOL, [bar(5_000, 100, 120, 80, 100)]);
    expect(a.position(SYMBOL)).toMatchObject({ takeProfit: 110, stopLoss: 90 });
    a.reconcileBars(SYMBOL, [bar(12_000, 100, 111, 99, 105)]);
    expect(a.position(SYMBOL)).toBeNull();
    expect(a.fills()[0]).toMatchObject({ price: 110 });
  });

  it("keeps the bracket times across a restore and reads an old snapshot from the position's open", () => {
    const a = atPrice(100);
    a.place(req({ qty: 1, takeProfit: 110, stopLoss: 90 }), 2_000);
    expect(a.toJSON().positions[0]).toMatchObject({ tpSince: 2_000, slSince: 2_000 });
    const b = PaperAccount.fromJSON(a.toJSON());
    expect(b.reconcileChecks()).toEqual([{ symbol: SYMBOL, sinceMs: 2_000 }]);

    // A snapshot from before the times: the position's open is the start of what it could have missed.
    const snap = atPrice(100).toJSON();
    snap.positions = [{ symbol: SYMBOL, qty: 1, avgPrice: 100, takeProfit: 110, stopLoss: 90, openedMs: 1_000 }];
    const c = PaperAccount.fromJSON(snap);
    expect(c.reconcileChecks()).toEqual([{ symbol: SYMBOL, sinceMs: 1_000 }]);
    c.reconcileBars(SYMBOL, [bar(900, 100, 120, 80, 100)]);
    expect(c.position(SYMBOL)).not.toBeNull();
    c.reconcileBars(SYMBOL, [bar(1_500, 100, 111, 99, 105)]);
    expect(c.position(SYMBOL)).toBeNull();
  });

  it("has nothing to check without a bracketed position", () => {
    const a = atPrice(100);
    a.place(req({ qty: 1 }), 2_000);
    expect(a.reconcileChecks()).toEqual([]);
    // Only the last price moves: nothing closes without a bracket.
    expect(a.reconcileBars(SYMBOL, [bar(60_000, 100, 120, 80, 101)])).toBe(true);
    expect(a.position(SYMBOL)).not.toBeNull();
    expect(a.price(SYMBOL)).toBe(101);
    expect(a.reconcileBars(SYMBOL, [bar(61_000, 101, 102, 100, 101)])).toBe(false);
  });
});
