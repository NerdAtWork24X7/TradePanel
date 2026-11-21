/*
 * The plus button offers Buy and Sell at the price it points at, whether or not a broker is
 * connected: with no broker the ticket those rows open names what to connect (its empty state),
 * so a chart that cannot trade yet still answers the button. A row gated on a connected broker
 * left the menu with only alerts and a line — no order action, and nothing saying why.
 */
import { describe, expect, it, vi } from "vitest";
import type { Side } from "../../../data/trading/types";
import { plusTradeRows } from "../view/plus-trade-rows";

vi.mock("../../../data/kv", () => ({ getItem: () => null, setItem: () => {}, onExternalChange: () => () => {} }));

/** What the rows opened the ticket with, in the order they were run. */
type Opened = [Side, number, number | null];

/** Rows for SOL/USDT at 68.63, last close 68.70 unless `last` says otherwise. */
function rows(last: number | null = 68.7) {
  const opened: Opened[] = [];
  const icons = { buy: null, sell: null };
  return {
    opened,
    nodes: plusTradeRows({ ticker: "SOL/USDT", price: 68.63, priceStr: "68.63", last, icons, open: (side, price, at) => opened.push([side, price, at]) }),
  };
}

describe("plusTradeRows", () => {
  it("lists Buy then Sell, with no broker in the picture", () => {
    expect(rows().nodes.map((n) => (n.kind === "item" ? n.id : n.kind))).toEqual(["plus-buy", "plus-sell"]);
  });

  it("labels each row with the symbol and the price under the button", () => {
    expect(rows().nodes.map((n) => (n.kind === "item" ? n.label : ""))).toEqual(["Buy 1 SOL/USDT @ 68.63 limit", "Sell 1 SOL/USDT @ 68.63 stop"]);
  });

  it("opens the ticket on the row's side at that price, with the last close for the order type", () => {
    const { opened, nodes } = rows();
    for (const n of nodes) if (n.kind === "item") n.onSelect?.();
    expect(opened).toEqual([
      ["buy", 68.63, 68.7],
      ["sell", 68.63, 68.7],
    ]);
  });

  it("carries a chart with no bars yet as a price with no last close", () => {
    const { opened, nodes } = rows(null);
    for (const n of nodes) if (n.kind === "item") n.onSelect?.();
    expect(opened).toEqual([
      ["buy", 68.63, null],
      ["sell", 68.63, null],
    ]);
  });
});
