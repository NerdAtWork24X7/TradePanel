/*
 * The order ticket's empty state: why it cannot trade, and the one place that fixes it.
 *
 * The way out of "not connected" is the broker picker (the built-in paper account and every
 * broker plugin) or the broker's card in the Exchanges tab under the chart (its settings,
 * Connect, trading switch, symbol map); a broker plugin installed but not usable there leads
 * to Settings > Plugins. The empty state offers that path as a button instead of leaving the
 * user to hunt for a settings card that is not there: a venue plugin (the crypto markets) is
 * configured in the Exchanges tab, never in Settings > Plugins.
 */
import { Show } from "solid-js";
import type { TicketFix, Tradability } from "../../data/trading/replay-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { translate } from "../../i18n/translator";
import { setAppSettingsTab } from "../shell/app-dialogs";
import { isTauri } from "../shell/window-bridge";

/** What the button does, given the fix the broker named: a browser has no plugins at all. */
export function fixOf(state: Tradability, desktop: boolean): TicketFix | null {
  if (!desktop) return "desktop";
  return state.ok || state.reason === "loading" ? null : state.fix ?? null;
}

/** What the fix's button says. */
export function fixLabel(fix: TicketFix): string {
  switch (fix) {
    case "desktop":
      return translate("Open the desktop app");
    case "install":
      return translate("Install a broker plugin");
    case "connect":
      return translate("Connect a broker");
    case "exchanges":
      return translate("Open Exchanges");
  }
}

function runFix(fix: TicketFix): void {
  switch (fix) {
    case "desktop":
    case "install":
      setAppSettingsTab("plugins");
      return;
    case "connect":
      tradingUi.setBrokerPicker(true);
      return;
    case "exchanges":
      tradingUi.showExchanges();
  }
}

export function TicketEmpty(props: { state: Tradability }) {
  const fix = () => fixOf(props.state, isTauri());
  return (
    <div class="trd-tk-empty" data-name="ticket-empty">
      <Show when={props.state.title}>
        <div class="trd-tk-empty-title">{props.state.title}</div>
      </Show>
      <div class="trd-tk-empty-text">{props.state.text}</div>
      <Show when={fix()}>
        {(f) => (
          <button type="button" class="trd-tk-empty-action" data-name="ticket-empty-action" onClick={() => runFix(f())}>
            {fixLabel(f())}
          </button>
        )}
      </Show>
    </div>
  );
}
