/*
 * "Trade with your broker" (#315): every installed broker plugin as a card — the nine crypto venues, or a broker
 * of another market — in the venue catalog's order; a click enables the plugin when it is off and connects the
 * window's trading to it, so a venue is one click away whether its plugin was installed enabled or not.
 */
import { createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { createDialogKeys } from "../../components/Dialog";
import { exchangeLogoSrc } from "../../data/exchange-logos";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { brokerCard, sortBrokerCards } from "../../data/venues";
import { translate } from "../../i18n/translator";
import { isTauri } from "../shell/window-bridge";
import { setAppSettingsTab } from "../shell/app-dialogs";
import { plugins } from "../header/app-settings/io";
import { CloseIcon } from "./icons";

/** Initials of a broker's name, as its mark. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** The venue's bundled mark when there is one (a ccxt venue), else the card shows initials. */
const mark = (code: string | undefined, name: string) => exchangeLogoSrc(code ?? name);

export function BrokerPicker() {
  const close = () => tradingUi.setBrokerPicker(false);
  createDialogKeys({ onEscape: close });
  const active = () => pluginBroker.status()?.active ?? null;
  const brokers = () => sortBrokerCards(pluginBroker.status()?.brokers ?? []);
  const [busy, setBusy] = createSignal<string | null>(null);

  /** What a card says under its name. */
  const note = (b: { id: string; connected: boolean; enabled: boolean }) =>
    busy() === b.id
      ? translate("Connecting...")
      : active() === b.id
        ? b.connected
          ? translate("Connected")
          : translate("Waiting for the plugin to connect")
        : b.enabled
          ? translate("Ready")
          : translate("Enable to trade");

  /** Connect to the broker; a plugin left off is enabled first (its program starts, then the account arrives). */
  const choose = async (id: string, enabled: boolean) => {
    if (busy()) return;
    setBusy(id);
    try {
      // A plugin the app cannot start stays unconnected: its card in the Exchanges tab says why.
      if (!enabled && (await plugins.setEnabled(id, true)).status !== "ok") return;
      await pluginBroker.setActive(id);
    } finally {
      setBusy(null);
    }
    close();
    tradingUi.showAccountManager();
  };

  return (
    <Portal>
      <div class="trd-dialog-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="trd-select-dialog" data-name="select-broker-dialog" role="dialog" aria-label={translate("Trade with your broker")}>
          <button type="button" class="trd-dialog-close" aria-label={translate("Close")} onClick={close}>
            <CloseIcon />
          </button>
          <div class="trd-select-head">
            <h2 class="trd-select-title">Trade with your broker</h2>
          </div>
          <div class="trd-select-grid">
            <For
              each={brokers()}
              fallback={
                <div class="trd-select-empty">
                  {isTauri()
                    ? translate("No broker plugin is installed. Install one in Settings > Plugins: Binance, Bybit, OKX, Gate.io, Bitget, KuCoin, Coinbase, Kraken, or a broker of your own.")
                    : translate("Broker plugins run in the desktop app. Open OpenTrader itself to trade.")}
                </div>
              }
            >
              {(b) => {
                const card = () => brokerCard(b);
                return (
                  <button
                    type="button"
                    class="trd-broker-card"
                    classList={{ "is-active": active() === b.id, "is-off": !b.enabled }}
                    data-broker={b.id}
                    onClick={() => void choose(b.id, b.enabled)}
                  >
                    <Show
                      when={mark(card().code, card().name)}
                      fallback={
                        <span class="trd-broker-mark trd-broker-card-mark" data-no-translate>
                          {initials(card().name)}
                        </span>
                      }
                    >
                      {(src) => (
                        <img class="trd-broker-card-mark is-logo" src={src()} alt="" loading="lazy" />
                      )}
                    </Show>
                    <span class="trd-broker-card-name" data-no-translate>
                      {card().name}
                    </span>
                    <span class="trd-broker-card-note">{note(b)}</span>
                  </button>
                );
              }}
            </For>
          </div>
          <div class="trd-select-foot">
            <span>Brokers are plugins that run on this computer.</span>
            <Show when={isTauri()}>
              <button
                type="button"
                class="trd-select-link"
                data-name="broker-picker-install"
                onClick={() => {
                  close();
                  setAppSettingsTab("plugins");
                }}
              >
                Install a broker plugin...
              </button>
            </Show>
            <button
              type="button"
              class="trd-select-link"
              onClick={() => {
                close();
                tradingUi.showExchanges();
              }}
            >
              Configure exchanges…
            </button>
          </div>
          <Show when={pluginBroker.status()?.active}>
            <div class="trd-select-foot">
              <button
                type="button"
                class="trd-select-link"
                onClick={() => {
                  void pluginBroker.setActive(null);
                  close();
                }}
              >
                Disconnect the broker
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
