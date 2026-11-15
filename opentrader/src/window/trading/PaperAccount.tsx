/*
 * Paper account manager: the built-in simulated account under the charts, a page of the Exchanges tab. It shows
 * the account bar (cash, equity, P&L, the margin the positions hold), the pages (Positions, Orders, Trade history,
 * Account summary) and its tables — the same components, classes and CSV export as the broker plugin's account
 * manager, so the two read the same. Its rows show the symbol on the chart, close a position, cancel or modify an
 * order; "Reset account" starts over with the same starting balance.
 */
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { showConfirm } from "../../components/Dialogs";
import { emitAppEvent } from "../../data/app-events";
import { cachedSymbolSessions } from "../../data/session";
import { Tooltip } from "../../components/Tooltip";
import type { PaperFill, PaperOrder, PaperPositionRow } from "../../data/trading/paper-account";
import { paperBroker } from "../../data/trading/paper-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { translate } from "../../i18n/translator";
import { AccountTable, tableCsv, type Column, type RowMenuItem } from "./AccountTable";
import { DownloadTradingDataDialog } from "./DownloadTradingDataDialog";
import { fmtMoney, fmtPct, fmtPnl, fmtPrice, fmtQty, fmtTime, pnlClass } from "./format";
import { CloseIcon, PencilIcon } from "./icons";

type Page = "positions" | "orders" | "history" | "summary";
type Filter = "all" | "working" | "filled" | "cancelled" | "rejected";

const isActive = (o: PaperOrder) => o.status === "working";

const typeTitle = (t: PaperOrder["type"]) =>
  t === "market" ? translate("Market") : t === "limit" ? translate("Limit") : t === "stop" ? translate("Stop") : translate("Stop Limit");

const statusTitle = (o: PaperOrder) => {
  switch (o.status) {
    case "filled":
      return translate("Filled");
    case "cancelled":
      return translate("Cancelled");
    case "rejected":
      return translate("Rejected");
    default:
      return translate("Working");
  }
};

const matches = (o: PaperOrder, f: Filter) => f === "all" || o.status === f;

/** A price of a symbol on its tick (the chart's sessions know it). */
const price = (symbol: string, v: number | null | undefined) => fmtPrice(v, cachedSymbolSessions(symbol)?.mintick);
const sideText = (side: "buy" | "sell", position?: boolean) =>
  position ? (side === "buy" ? translate("Long") : translate("Short")) : side === "buy" ? translate("Buy") : translate("Sell");

const SymbolPill = (p: { symbol: string }) => (
  <span class="trd-symbol-pill" data-no-translate>
    {p.symbol}
  </span>
);
const SideCell = (p: { side: "buy" | "sell"; position?: boolean }) => (
  <span class={p.side === "buy" ? "trd-buy" : "trd-sell"}>{sideText(p.side, p.position)}</span>
);
const Num = (p: { text: string; cls?: string }) => <span class={`ot-value ${p.cls ?? ""}`}>{p.text}</span>;

/** Ask, then close the position at the last price. */
function closePosition(row: PaperPositionRow) {
  showConfirm({
    title: translate("Close position"),
    text: `${row.side === "buy" ? translate("Long") : translate("Short")} ${fmtQty(row.qty)} ${row.symbol} @ ${price(row.symbol, row.avgPrice)}`,
    mainText: translate("Close position"),
    cancelText: translate("Cancel"),
    intent: "danger",
    onConfirm: () => paperBroker.closePositionAt(row.symbol),
  });
}

function cancelOrder(o: PaperOrder) {
  showConfirm({
    title: translate("Cancel order"),
    text: `${o.side === "buy" ? translate("Buy") : translate("Sell")} ${typeTitle(o.type)} ${fmtQty(o.qty)} ${o.symbol}`,
    mainText: translate("Cancel order"),
    cancelText: translate("Keep order"),
    intent: "danger",
    onConfirm: () => paperBroker.cancelOrder(o.id),
  });
}

/** Right click on a position: close it, protect it from its chart, a new order. */
function positionMenu(row: PaperPositionRow): RowMenuItem[] {
  const at = paperBroker.positionPane(row);
  return [
    ...(at ? [{ title: translate("Protect position..."), onClick: () => tradingUi.editPosition(at.position, at.paneId) }] : []),
    { title: translate("Close position"), onClick: () => closePosition(row) },
    { title: translate("Create new order..."), onClick: () => tradingUi.openOrderTicket({ symbol: row.symbol }) },
    "divider",
    { title: translate("Trading settings..."), onClick: () => emitAppEvent("chart-open-settings", { tab: "trading" }) },
  ];
}

/** Right click on a working order: modify it in the ticket (a chart shows its symbol), cancel it. */
function orderMenu(o: PaperOrder): RowMenuItem[] {
  const edit = paperBroker.editable(o);
  return [
    ...(edit ? [{ title: translate("Modify order..."), onClick: () => tradingUi.editOrder(edit.order, edit.paneId) }] : []),
    { title: translate("Cancel order"), onClick: () => cancelOrder(o) },
  ];
}

const POSITION_COLUMNS: Column<PaperPositionRow>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (p) => <SymbolPill symbol={p.symbol} />, value: (p) => p.symbol },
  { id: "side", title: () => translate("Side"), cell: (p) => <SideCell side={p.side} position />, value: (p) => sideText(p.side, true) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (p) => <Num text={fmtQty(p.qty)} />, value: (p) => p.qty },
  { id: "avg", num: true, title: () => translate("Avg price"), cell: (p) => <Num text={price(p.symbol, p.avgPrice)} />, value: (p) => p.avgPrice },
  { id: "last", num: true, title: () => translate("Last price"), cell: (p) => <Num text={price(p.symbol, p.last)} />, value: (p) => p.last },
  { id: "tp", num: true, title: () => translate("Take profit"), cell: (p) => <Num text={price(p.symbol, p.takeProfit)} />, value: (p) => p.takeProfit },
  { id: "sl", num: true, title: () => translate("Stop loss"), cell: (p) => <Num text={price(p.symbol, p.stopLoss)} />, value: (p) => p.stopLoss },
  {
    id: "upl",
    num: true,
    title: () => translate("Unrealized PnL"),
    cell: (p) => <Num text={fmtPnl(p.unrealizedPnl)} cls={pnlClass(p.unrealizedPnl)} />,
    value: (p) => p.unrealizedPnl,
  },
  {
    id: "uplPct",
    num: true,
    title: () => translate("Unrealized PnL %"),
    cell: (p) => {
      const pct = p.avgPrice * p.qty > 0 ? (p.unrealizedPnl / (p.avgPrice * p.qty)) * 100 : null;
      return <Num text={fmtPct(pct)} cls={pnlClass(pct)} />;
    },
    value: (p) => (p.avgPrice * p.qty > 0 ? (p.unrealizedPnl / (p.avgPrice * p.qty)) * 100 : null),
  },
  { id: "opened", hidden: true, title: () => translate("Time"), cell: (p) => <Num text={fmtTime(p.openedMs)} />, value: (p) => p.openedMs },
];

const ORDER_COLUMNS: Column<PaperOrder>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (o) => <SymbolPill symbol={o.symbol} />, value: (o) => o.symbol },
  { id: "side", title: () => translate("Side"), cell: (o) => <SideCell side={o.side} />, value: (o) => sideText(o.side) },
  { id: "type", title: () => translate("Type"), cell: (o) => typeTitle(o.type), value: (o) => typeTitle(o.type) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (o) => <Num text={fmtQty(o.qty)} />, value: (o) => o.qty },
  { id: "fill", num: true, title: () => translate("Avg fill price"), cell: (o) => <Num text={price(o.symbol, o.fillPrice)} />, value: (o) => o.fillPrice },
  { id: "limit", num: true, title: () => translate("Limit price"), cell: (o) => <Num text={price(o.symbol, o.limitPrice)} />, value: (o) => o.limitPrice },
  { id: "stop", num: true, title: () => translate("Stop price"), cell: (o) => <Num text={price(o.symbol, o.stopPrice)} />, value: (o) => o.stopPrice },
  { id: "tp", num: true, title: () => translate("Take profit"), cell: (o) => <Num text={price(o.symbol, o.takeProfit)} />, value: (o) => o.takeProfit },
  { id: "sl", num: true, title: () => translate("Stop loss"), cell: (o) => <Num text={price(o.symbol, o.stopLoss)} />, value: (o) => o.stopLoss },
  {
    id: "status",
    title: () => translate("Status"),
    cell: (o) => (
      <span class={`trd-status trd-status-${o.status}`} title={o.message ?? undefined}>
        {statusTitle(o)}
      </span>
    ),
    value: (o) => statusTitle(o),
  },
  { id: "updated", title: () => translate("Last update time"), cell: (o) => <Num text={fmtTime(o.updatedMs)} />, value: (o) => o.updatedMs },
  { id: "id", num: true, title: () => translate("Order ID"), cell: (o) => <span data-no-translate>{o.id}</span>, value: (o) => o.id },
  {
    id: "message",
    hidden: true,
    title: () => translate("Text"),
    cell: (o) => <span class="trd-notice-text" data-no-translate>{o.message ?? ""}</span>,
    value: (o) => o.message ?? "",
  },
];

const FILL_COLUMNS: Column<PaperFill>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (f) => <SymbolPill symbol={f.symbol} />, value: (f) => f.symbol },
  { id: "side", title: () => translate("Side"), cell: (f) => <SideCell side={f.side} />, value: (f) => sideText(f.side) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (f) => <Num text={fmtQty(f.qty)} />, value: (f) => f.qty },
  { id: "price", num: true, title: () => translate("Fill price"), cell: (f) => <Num text={price(f.symbol, f.price)} />, value: (f) => f.price },
  { id: "time", title: () => translate("Time"), cell: (f) => <Num text={fmtTime(f.timeMs)} />, value: (f) => f.timeMs },
  { id: "rpl", num: true, title: () => translate("Realized PnL"), cell: (f) => <Num text={fmtPnl(f.realizedPnl)} cls={pnlClass(f.realizedPnl)} />, value: (f) => f.realizedPnl },
  { id: "order", num: true, hidden: true, title: () => translate("Order ID"), cell: (f) => <span data-no-translate>{f.orderId ?? ""}</span>, value: (f) => f.orderId ?? "" },
];

type SummaryRow = { label: string; value: string; own: boolean };
const SUMMARY_COLUMNS: Column<SummaryRow>[] = [
  { id: "label", fixed: true, title: () => translate("Account summary"), cell: (r) => (r.own ? r.label : <span data-no-translate>{r.label}</span>), value: (r) => r.label },
  { id: "value", num: true, title: () => translate("Value"), cell: (r) => <span class="ot-value" data-no-translate>{r.value}</span>, value: (r) => r.value },
];

/** The rows of each page. */
const positionRows = () => paperBroker.positions();
const orderRows = (f: Filter) => paperBroker.orderRows().filter((o) => matches(o, f));
const fillRows = () => paperBroker.fills();
const summaryRows = (): SummaryRow[] => {
  const a = paperBroker.account();
  return [
    { label: translate("Starting balance"), value: `${fmtMoney(a.startingBalance)} ${a.currency}`, own: true },
    { label: translate("Balance"), value: fmtMoney(a.balance), own: true },
    { label: translate("Equity"), value: fmtMoney(a.equity), own: true },
    { label: translate("Unrealized PnL"), value: fmtPnl(a.unrealizedPnl), own: true },
    { label: translate("Realized PnL"), value: fmtPnl(a.realizedPnl), own: true },
    { label: translate("Margin"), value: fmtMoney(a.marginUsed), own: true },
    { label: translate("Free margin"), value: fmtMoney(a.marginFree), own: true },
  ];
};

/** The CSV of a page ("Download data"). */
export function paperCsv(page: Page): string {
  switch (page) {
    case "positions":
      return tableCsv("paper-positions", POSITION_COLUMNS, positionRows());
    case "orders":
      return tableCsv("paper-orders", ORDER_COLUMNS, orderRows("all"));
    case "history":
      return tableCsv("paper-history", FILL_COLUMNS, fillRows());
    default:
      return tableCsv("paper-summary", SUMMARY_COLUMNS, summaryRows());
  }
}

/** "Reset account" with its confirmation: the account starts over with the same starting balance. */
function ResetButton() {
  const [armed, setArmed] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <button
      type="button"
      class="trd-pill"
      classList={{ "is-selected": armed() }}
      data-name="paper-reset"
      onClick={() => {
        if (!armed()) {
          setArmed(true);
          timer = window.setTimeout(() => setArmed(false), 4000);
          return;
        }
        window.clearTimeout(timer);
        setArmed(false);
        paperBroker.resetAccount();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed() ? translate("Reset the account") : translate("Reset account")}
    </button>
  );
}

/** The account bar: the paper account (name, cash, PAPER) and the values it is made of. */
function AccountBar() {
  const a = () => paperBroker.account();
  const fields = (): { title: string; value: string; cls?: string; hint?: string }[] => [
    { title: translate("Unrealized PnL"), value: fmtPnl(a().unrealizedPnl), cls: pnlClass(a().unrealizedPnl) },
    { title: translate("Realized PnL"), value: fmtPnl(a().realizedPnl), cls: pnlClass(a().realizedPnl) },
    { title: translate("Equity"), value: fmtMoney(a().equity) },
    { title: translate("Account margin"), value: fmtMoney(a().marginUsed), hint: "The margin your open positions hold" },
    { title: translate("Available funds"), value: fmtMoney(a().marginFree), hint: "What is left for new orders" },
  ];
  return (
    <div class="trd-am-header is-expanded" data-name="paper-account-bar">
      <button type="button" class="trd-account-btn is-static">
        <span class="trd-account-name">{translate("Paper trading")}</span>
        <span class="trd-account-balance ot-value">{fmtMoney(a().balance)}</span>
        <span class="trd-account-ccy" data-no-translate>
          {a().currency}
        </span>
        <span class="trd-account-kind">PAPER</span>
      </button>
      <div class="trd-am-summary">
        <div class="trd-am-fields">
          <For each={fields()}>
            {(f) => (
              <div class="trd-am-field">
                <Show when={f.hint} fallback={<span class="trd-am-field-title">{f.title}</span>}>
                  <Tooltip text={f.hint!} side="top">
                    <span class="trd-am-field-title is-hint" tabIndex={0}>
                      {f.title}
                    </span>
                  </Tooltip>
                </Show>
                <span class={`trd-am-field-value ot-value ${f.cls ?? ""}`}>{f.value}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

const DownloadIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M10 8.91V2H9v6.91L6.33 6.62l-.66.76 3.5 3 .33.28.33-.28 3.5-3-.66-.76L10 8.92zM4 14v-3H3v3a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3h-1v3H4z" />
  </svg>
);

/** The paper account's page of the Exchanges tab. `fill`: the parent sizes it (a flex child) instead of `height`. */
export function PaperAccount(props: { onSymbol: (symbol: string) => void; height: number; fill?: boolean }) {
  const [page, setPage] = createSignal<Page>("positions");
  const [filter, setFilter] = createSignal<Filter>("all");
  const [exporting, setExporting] = createSignal(false);
  const show = (symbol: string) => props.onSymbol(symbol);
  const counts = createMemo(() => ({
    positions: paperBroker.positions().length,
    orders: paperBroker.orderRows().filter(isActive).length,
  }));
  const pages: [Page, () => string][] = [
    ["positions", () => translate("Positions")],
    ["orders", () => translate("Orders")],
    ["history", () => translate("Trade history")],
    ["summary", () => translate("Account summary")],
  ];
  const filters: [Filter, () => string][] = [
    ["all", () => translate("All")],
    ["working", () => translate("Working")],
    ["filled", () => translate("Filled")],
    ["cancelled", () => translate("Cancelled")],
    ["rejected", () => translate("Rejected")],
  ];

  return (
    <div
      class="trd-am"
      style={props.fill ? undefined : { height: Number.isFinite(props.height) ? `${props.height}px` : "100%" }}
      data-name="paper-account"
    >
      <AccountBar />
      <div class="trd-am-tabs" role="tablist">
        <For each={pages}>
          {([id, title]) => {
            const count = () => (id === "positions" ? counts().positions : id === "orders" ? counts().orders : 0);
            return (
              <button type="button" role="tab" class="trd-pill" classList={{ "is-selected": page() === id }} aria-selected={page() === id} onClick={() => setPage(id)}>
                {title()}
                <Show when={count() > 0}>
                  <span class="trd-pill-count ot-value"> {count()}</span>
                </Show>
              </button>
            );
          }}
        </For>
        <ResetButton />
        <Tooltip text="Download data" side="top">
          <button
            type="button"
            class="trd-row-btn trd-am-download"
            aria-label={translate("Download data")}
            data-name="download-data"
            onClick={() => setExporting(true)}
          >
            <DownloadIcon />
          </button>
        </Tooltip>
      </div>
      <Show when={exporting()}>
        <DownloadTradingDataDialog
          broker={translate("Paper trading")}
          tabs={pages.map(([id, title]) => ({ id, title, csv: () => paperCsv(id) }))}
          onClose={() => setExporting(false)}
        />
      </Show>
      <Show when={page() === "orders"}>
        <div class="trd-am-filters" role="tablist">
          <For each={filters}>
            {([id, title]) => {
              const n = () => paperBroker.orderRows().filter((o) => matches(o, id)).length;
              return (
                <button type="button" role="tab" class="trd-filter" classList={{ "is-selected": filter() === id }} aria-selected={filter() === id} onClick={() => setFilter(id)}>
                  {title()}
                  <Show when={n() > 0}>
                    <span class="trd-pill-count ot-value"> {n()}</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <div class="trd-am-content">
        <Show when={page() === "positions"}>
          <AccountTable<PaperPositionRow>
            id="paper-positions"
            columns={POSITION_COLUMNS}
            rows={positionRows()}
            rowKey={(p) => p.symbol}
            empty={translate("There are no open positions in your trading account yet")}
            onRow={(p) => show(p.symbol)}
            menu={positionMenu}
            actions={(p) => (
              <Tooltip text="Close" side="top">
                <button type="button" class="trd-row-btn" aria-label={translate("Close position")} onClick={() => closePosition(p)}>
                  <CloseIcon size={16} />
                </button>
              </Tooltip>
            )}
          />
        </Show>
        <Show when={page() === "orders"}>
          <AccountTable<PaperOrder>
            id="paper-orders"
            columns={ORDER_COLUMNS}
            rows={orderRows(filter())}
            rowKey={(o) => o.id}
            empty={translate("There is no trading data here yet")}
            onRow={(o) => show(o.symbol)}
            muted={(o) => filter() === "all" && !isActive(o)}
            menu={orderMenu}
            actions={(o) => (
              <Show when={isActive(o)}>
                <Show when={paperBroker.editable(o)}>
                  {(edit) => (
                    <Tooltip text="Modify order..." side="top">
                      <button
                        type="button"
                        class="trd-row-btn"
                        aria-label={translate("Modify order")}
                        onClick={() => tradingUi.editOrder(edit().order, edit().paneId)}
                      >
                        <PencilIcon />
                      </button>
                    </Tooltip>
                  )}
                </Show>
                <Tooltip text="Cancel" side="top">
                  <button type="button" class="trd-row-btn" aria-label={translate("Cancel order")} onClick={() => cancelOrder(o)}>
                    <CloseIcon size={16} />
                  </button>
                </Tooltip>
              </Show>
            )}
          />
        </Show>
        <Show when={page() === "history"}>
          <AccountTable<PaperFill>
            id="paper-history"
            columns={FILL_COLUMNS}
            rows={fillRows()}
            rowKey={(f) => f.id}
            empty={translate("There is no trading data here yet")}
            onRow={(f) => show(f.symbol)}
          />
        </Show>
        <Show when={page() === "summary"}>
          <AccountTable
            id="paper-summary"
            columns={SUMMARY_COLUMNS}
            rows={summaryRows()}
            rowKey={(r) => r.label}
            empty={translate("There is no trading data here yet")}
          />
        </Show>
      </div>
    </div>
  );
}
