/*
 * The plus button's order rows: the price it points at on the price axis is an order price too,
 * so Buy and Sell open the order ticket at it.
 *
 * They are rows of the menu whether or not the chart trades yet. The ticket they open says what
 * to connect (BrokerPicker: the built-in paper account or a broker plugin), so trading stays one
 * click from the button that asked for it — a row gated on a connected broker left the plus menu
 * with alerts and a line only, and no sign of what was missing.
 */
import type { JSX } from "solid-js";
import type { CtxNode } from "../ChartContextMenu";
import type { Side } from "../../../data/trading/types";
import { translateWith } from "../../../i18n/translator";

export type PlusTradeRow = {
  /** The chart's ticker, in the rows' labels. */
  ticker: string;
  /** The price under the plus button, as the order ticket takes it. */
  price: number;
  /** That price as the pane's scale formats it, in the rows' labels. */
  priceStr: string;
  /** The last close: the ticket reads the side of the market from it (limit in front, stop beyond). */
  last: number | null;
  /** The menu's Buy / Sell glyphs. */
  icons: { buy: JSX.Element; sell: JSX.Element };
  /** Opens the ticket on a side at the price. */
  open: (side: Side, price: number, last: number | null) => void;
};

/** Buy and Sell at the plus button's price. */
export function plusTradeRows(p: PlusTradeRow): CtxNode[] {
  const row = (side: Side, icon: JSX.Element): CtxNode => ({
    kind: "item",
    id: side === "buy" ? "plus-buy" : "plus-sell",
    label: side === "buy" ? translateWith("Buy 1 {0} @ {1} limit", p.ticker, p.priceStr) : translateWith("Sell 1 {0} @ {1} stop", p.ticker, p.priceStr),
    icon,
    onSelect: () => p.open(side, p.price, p.last),
  });
  return [row("buy", p.icons.buy), row("sell", p.icons.sell)];
}
