/*
 * The paper account's reset confirmation. Both the account view and the Exchanges tab use this:
 * a reset clears positions, orders and history, and starts the new account at the equity typed here.
 * With no positions left, that equity is the new starting balance.
 */
import { createSignal, Show } from "solid-js";
import { showConfirm, showNotice } from "../../components/Dialogs";
import { paperBroker } from "../../data/trading/paper-broker";
import { translate } from "../../i18n/translator";
import { parsePositive } from "./format";

export function confirmPaperReset(): void {
  // Prefilled with the balance a plain reset would leave, so an untouched dialog changes nothing.
  const [equity, setEquity] = createSignal(String(paperBroker.account().startingBalance));
  const [invalid, setInvalid] = createSignal(false);

  showConfirm({
    title: translate("Reset paper account"),
    text: translate("Positions, orders and history are cleared. The account starts at this equity:"),
    intent: "danger",
    mainText: translate("Reset account"),
    body: () => (
      <label class="app-settings-field">
        <span class="app-settings-field-label">{translate("Equity")}</span>
        <input
          class="app-settings-input"
          type="text"
          inputmode="decimal"
          value={equity()}
          data-name="paper-reset-equity"
          onInput={(e) => {
            const value = e.currentTarget.value;
            setEquity(value);
            setInvalid(parsePositive(value) === null);
          }}
        />
        <Show when={invalid()}>
          <span class="app-settings-field-error">{translate("Enter an amount greater than zero.")}</span>
        </Show>
      </label>
    ),
    onConfirm: () => {
      const amount = parsePositive(equity());
      if (amount === null) {
        showNotice({
          title: translate("Reset paper account"),
          text: translate("Enter an amount greater than zero."),
        });
        return;
      }
      paperBroker.resetAccount({ startingBalance: amount });
    },
  });
}
