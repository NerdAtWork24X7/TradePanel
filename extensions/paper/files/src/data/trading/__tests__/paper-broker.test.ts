/*
 * The paper broker's wiring: its commands reach the account engine, the datafeed's ticks move it, its toasts and its
 * stored state come back, and the ticket reads the account through it. The engine itself is covered by
 * paper-account.test.ts; here the modules around the store are stubbed and the Tauri shell is faked.
 *
 * Its two effects (the symbols it subscribes, and stepping aside for a broker plugin) do not run under vitest: the
 * solid-js build a node test resolves turns `createEffect` into a no-op. They are exercised in the app.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} };
  return {
    kv: new Map<string, string>(),
    ticks: [] as ((t: { symbol: string; price: number }) => void)[],
    activeChart: 7,
    setPlugin: (_id: string | null) => {},
  };
});

vi.mock("../../datafeed", () => ({
  getTickerInfo: async (symbol: string) => ({ name: `Name ${symbol}`, iconUrl: null, symbolType: "crypto" }),
  getTickerSnapshot: async () => ({ last: 100 }),
  isEconomicSymbol: () => false,
}));
vi.mock("../../datafeed-live", () => ({
  onTradeTick: (fn: (t: { symbol: string; price: number }) => void) => {
    h.ticks.push(fn);
    return Promise.resolve(() => {});
  },
}));
vi.mock("../../kv", () => ({
  getItem: (key: string) => h.kv.get(key) ?? null,
  setItem: (key: string, value: string) => void h.kv.set(key, value),
  onExternalChange: () => () => {},
}));
vi.mock("../../local-series", () => ({ isLocalSymbol: vi.fn(() => false) }));
vi.mock("../../session", () => ({ cachedSymbolSessions: () => ({ mintick: 0.01 }) }));
vi.mock("../../strategy-tester-store", () => ({ strategyTester: { activeChartId: () => String(h.activeChart) } }));
vi.mock("../../subscriptions", () => ({ setSubscription: () => {}, clearSubscription: () => {} }));
vi.mock("../plugin-broker", async () => {
  const { createSignal } = await import("solid-js");
  const [active, setActive] = createSignal<string | null>(null);
  h.setPlugin = (id) => setActive(id);
  return {
    pluginBroker: {
      status: () => ({ active: active(), pluginConnected: false, tradingEnabled: false, brokers: [], version: 0 }),
      setActive: async (id: string | null) => setActive(id),
    },
  };
});

const SYMBOL = "BINANCE:BTC/USDT";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The trade-tick handler of the last import: a restart builds a new module instance and leaves the older ones behind. */
const lastTick = () => h.ticks[h.ticks.length - 1]!;

async function freshBroker() {
  h.kv.clear();
  h.ticks = [];
  h.activeChart = 7;
  h.setPlugin(null);
  vi.resetModules();
  const { paperBroker } = await import("../paper-broker");
  return paperBroker;
}

const order = (over: Partial<Parameters<Awaited<ReturnType<typeof freshBroker>>["place"]>[0]> = {}) => ({
  symbol: SYMBOL,
  side: "buy" as const,
  type: "market" as const,
  qty: 1,
  limitPrice: null,
  stopPrice: null,
  takeProfit: null,
  stopLoss: null,
  ...over,
});

describe("paperBroker", () => {
  beforeEach(() => {
    h.setPlugin(null);
  });

  it("trades a chart symbol at the datafeed's price and keeps the account", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    expect(paper.active()).toBe(true);

    // A live tick is the price the ticket and the orders use.
    lastTick()({ symbol: SYMBOL, price: 100 });
    expect(paper.tradability().ok).toBe(true);
    expect(paper.quote()).toMatchObject({ symbol: SYMBOL, bid: 100, ask: 100, last: 100 });

    const events: string[] = [];
    const off = paper.onEvent((e) => events.push(`${e.kind}:${e.symbol}`));
    expect(paper.place(order({ qty: 2, takeProfit: 110, stopLoss: 90 }))).toBe("sent");
    off();

    expect(paper.position(7)).toMatchObject({ side: "buy", qty: 2, avgPrice: 100, takeProfit: 110 });
    expect(paper.account()).toMatchObject({ balance: 100_000, equity: 100_000, marginUsed: 200 });
    expect(events).toEqual([`placed:${SYMBOL}`, `executed:${SYMBOL}`]);

    // The take profit fills on a later tick; the account survives a restart.
    lastTick()({ symbol: SYMBOL, price: 112 });
    expect(paper.position(7)).toBeNull();
    expect(paper.account()).toMatchObject({ balance: 100_020, realizedPnl: 20 });
    paper.disconnect();
    vi.resetModules();
    const { paperBroker: again } = await import("../paper-broker");
    expect(again.account()).toMatchObject({ balance: 100_020, realizedPnl: 20 });
    expect(again.fills()[0]).toMatchObject({ side: "sell", price: 110, realizedPnl: 20 });
  });

  it("keeps a working order off screen after a restart and fills it on a tick", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    lastTick()({ symbol: SYMBOL, price: 100 });
    paper.place(order({ type: "limit", limitPrice: 95 }));
    paper.disconnect();

    vi.resetModules();
    const { paperBroker: again } = await import("../paper-broker");
    again.connect();
    expect(again.orderRows()).toMatchObject([{ status: "working", limitPrice: 95 }]);
    lastTick()({ symbol: SYMBOL, price: 94 });
    expect(again.positions()).toMatchObject([{ symbol: SYMBOL, qty: 1, avgPrice: 94 }]);
  });

  it("answers the ticket with its state when it is not connected", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    expect(paper.active()).toBe(false);
    expect(paper.tradability()).toMatchObject({ ok: false, reason: "launch", fix: "connect" });
    expect(paper.place(order())).toBeNull();
  });

  it("shows a chart with no live data as not tradable", async () => {
    const { isLocalSymbol } = await import("../../local-series");
    vi.mocked(isLocalSymbol).mockReturnValue(true);
    const paper = await freshBroker();
    paper.registerChart(7, () => "LOCAL:backtest");
    paper.connect();
    expect(paper.trades(7)).toBe(false);
    expect(paper.tradability()).toMatchObject({ ok: false, reason: "symbol" });
    vi.mocked(isLocalSymbol).mockReturnValue(false);
  });

  it("reports a refused order as a toast and keeps it with its reason", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    paper.setSettings({ startingBalance: 100 });
    lastTick()({ symbol: SYMBOL, price: 100 });
    const events: string[] = [];
    paper.onEvent((e) => events.push(`${e.kind}:${e.message ?? ""}`));
    paper.place(order({ qty: 5 }));
    expect(events).toEqual([`rejected:Not enough free balance for this order.`]);
    expect(paper.orderRows()).toMatchObject([{ status: "rejected", qty: 5, message: "Not enough free balance for this order." }]);
    expect(paper.position(7)).toBeNull();
  });

  it("resets the account and keeps the starting balance", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    lastTick()({ symbol: SYMBOL, price: 100 });
    paper.place(order());
    paper.setSettings({ startingBalance: 5_000 });
    paper.resetAccount();
    expect(paper.account()).toMatchObject({ startingBalance: 5_000, balance: 5_000, equity: 5_000 });
    expect(paper.positions()).toEqual([]);
    expect(paper.orderRows()).toEqual([]);
    expect(paper.fills()).toEqual([]);
  });

  it("starts a reset account at the chosen equity", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    lastTick()({ symbol: SYMBOL, price: 100 });
    paper.place(order());
    paper.resetAccount({ startingBalance: 25_000 });
    expect(paper.account()).toMatchObject({ startingBalance: 25_000, balance: 25_000, equity: 25_000 });
    expect(paper.positions()).toEqual([]);
    expect(paper.orderRows()).toEqual([]);
    expect(paper.fills()).toEqual([]);
  });

  it("closes and reverses from the account view and the chart", async () => {
    const paper = await freshBroker();
    paper.registerChart(7, () => SYMBOL);
    paper.connect();
    lastTick()({ symbol: SYMBOL, price: 100 });
    paper.place(order({ qty: 2 }));
    paper.closePosition(null, 7);
    expect(paper.positions()).toEqual([]);
    paper.place(order({ qty: 1 }));
    lastTick()({ symbol: SYMBOL, price: 110 });
    paper.reverse(7);
    expect(paper.positions()).toMatchObject([{ side: "sell", qty: 1, avgPrice: 110 }]);
    expect(paper.account().realizedPnl).toBe(10);
    await flush();
  });
});
