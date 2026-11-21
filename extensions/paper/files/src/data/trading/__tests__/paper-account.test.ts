import { describe, expect, it } from "vitest";
import { PaperAccount, type PaperSnapshot } from "../paper-account";
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
      settings: { startingBalance: 5_000, currency: "USD" },
      orders: [],
      positions: [],
      fills: [],
      last: {},
      realizedPnl: 250,
      seq: 0,
      openedMs: 1,
    };
    const a = PaperAccount.fromJSON(snap);
    expect(a.balance).toBe(5_250);
  });
});
