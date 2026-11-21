/*
 * Paper account settings: the account's name, its leverage per asset class behind "Margin control", and its
 * commissions — a per-contract one for futures and options, a percent of the trade's value or a flat amount for
 * everything else. It uses the chart Settings dialog's layout (the same shell, grid, sections and controls as the
 * indicator settings). "Reset account" is the shared confirmation; Cancel discards, Save stores the settings.
 */
import { For, createSignal, type JSX } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { CheckBox, NumberField, SelectControl } from "../../components/form";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { ASSET_CLASSES, type AssetClass, type CommissionType, type LeverageSettings } from "../../data/trading/paper-account";
import { paperBroker } from "../../data/trading/paper-broker";
import { translate } from "../../i18n/translator";
import { confirmPaperReset } from "./ResetPaperAccount";

/** The leverage multipliers the dialog offers; a custom value the account already holds joins them. */
const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 20, 25, 50, 100, 200];
const CLASS_LABEL: Record<AssetClass, string> = { stocks: "Stocks", futures: "Futures", forex: "Forex", crypto: "Crypto", others: "Others" };
const TYPE_LABEL: Record<CommissionType, string> = { percent: "Percent", absolute: "Absolute" };

/** (i) after a control, with its explanation. */
const InfoIcon = (p: { text: string }) => (
  <Tooltip text={p.text} side="top">
    <span class="cp3-help" aria-label={p.text}>
      <Icon name="st-settings-info" size={18} />
    </span>
  </Tooltip>
);

const Label = (p: { title: string }) => (
  <div class="cp3-cell cp3-label">
    <div class="cp3-label-inner">
      <span class="cp3-title">{p.title}</span>
    </div>
  </div>
);

/** A non-negative number typed in a field, else null. */
const typedAmount = (s: string): number | null => {
  const n = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

export function PaperAccountSettings(props: { onClose: () => void }): JSX.Element {
  const cur = paperBroker.settings();
  const [name, setName] = createSignal(cur.name);
  const [marginControl, setMarginControl] = createSignal(cur.marginControl);
  const [leverage, setLeverage] = createSignal<LeverageSettings>({ ...cur.leverage });
  const [foOn, setFoOn] = createSignal(cur.commission.futuresOptions.enabled);
  const [foPer, setFoPer] = createSignal(String(cur.commission.futuresOptions.perContract));
  const [otOn, setOtOn] = createSignal(cur.commission.others.enabled);
  const [otValue, setOtValue] = createSignal(String(cur.commission.others.value));
  const [otType, setOtType] = createSignal<CommissionType>(cur.commission.others.type);

  const perContract = () => typedAmount(foPer());
  const othersValue = () => typedAmount(otValue());
  const valid = () => perContract() !== null && othersValue() !== null;

  const save = () => {
    if (!valid()) return;
    paperBroker.setSettings({
      name: name(),
      marginControl: marginControl(),
      leverage: leverage(),
      commission: {
        futuresOptions: { enabled: foOn(), perContract: perContract()! },
        others: { enabled: otOn(), value: othersValue()!, type: otType() },
      },
    });
    props.onClose();
  };

  const optionsFor = (v: number) => (LEVERAGE_OPTIONS.includes(v) ? LEVERAGE_OPTIONS : [...LEVERAGE_OPTIONS, v].sort((a, b) => a - b)).map((n) => `${n}x`);

  return (
    <Dialog
      look="settings"
      layerClass="settings-backdrop"
      backdrop="close"
      class="settings-dialog trd-acct-dlg"
      label={translate("Account settings")}
      title={translate("Account settings")}
      onClose={() => props.onClose()}
      // Escape / Enter in the bubble phase: a select's menu takes its own Escape first, Enter in a field is the field's.
      keys={{ capture: false }}
      onEnter={(e) => (e.target instanceof HTMLInputElement ? false : save())}
    >
      <div class="cp3-content">
        <div class="cp3-grid ind3-grid">
          <Label title={translate("Account name")} />
          <div class="cp3-cell cp3-controls">
            <span class="cp3-number trd-acct-name">
              <input
                type="text"
                maxLength={40}
                spellcheck={false}
                autocomplete="off"
                value={name()}
                data-name="paper-account-name"
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </span>
          </div>

          <div class="cp3-section ind3-section is-first">{translate("Leverage")}</div>
          <div class="cp3-cell cp3-label is-full ind3-check-row">
            <div class="cp3-label-inner">
              <CheckBox checked={marginControl()} onToggle={() => setMarginControl(!marginControl())} />
              <span class="cp3-title" onClick={() => setMarginControl(!marginControl())}>
                {translate("Margin control")}
              </span>
            </div>
          </div>
          <For each={ASSET_CLASSES}>
            {(cls) => (
              <>
                <Label title={translate(CLASS_LABEL[cls])} />
                <div class="cp3-cell cp3-controls">
                  <SelectControl
                    value={`${leverage()[cls]}x`}
                    options={optionsFor(leverage()[cls])}
                    width={100}
                    onPick={(v) => setLeverage({ ...leverage(), [cls]: Number(v.replace("x", "")) })}
                  />
                  {cls === "others" ? (
                    <InfoIcon text={translate("The margin a position holds is its value divided by its asset class's leverage. With margin control off the account trades 1:1.")} />
                  ) : null}
                </div>
              </>
            )}
          </For>
          <div class="cp3-cell cp3-label is-full">
            <div class="cp3-label-inner">
              <span class="cp3-desc">
                {translate("On, the leverage above applies and an order that needs more margin than the free funds is refused; off, the account trades 1:1, like cash.")}
              </span>
            </div>
          </div>

          <div class="cp3-section ind3-section ind3-after-plots">{translate("Commission")}</div>
          <div class="cp3-cell cp3-label is-full ind3-check-row">
            <div class="cp3-label-inner">
              <CheckBox checked={foOn()} onToggle={() => setFoOn(!foOn())} />
              <span class="cp3-title" onClick={() => setFoOn(!foOn())}>
                {translate("Futures and options")}
              </span>
              <InfoIcon text={translate("A commission per contract, charged when the position opens and when it closes.")} />
            </div>
          </div>
          <Label title={translate("Commission per contract")} />
          <div class="cp3-cell cp3-controls">
            <NumberField value={foPer()} disabled={!foOn()} num={{ min: 0, max: 1e9, step: 0.01 }} onChange={setFoPer} />
          </div>
          <div class="cp3-cell cp3-label is-full ind3-check-row">
            <div class="cp3-label-inner">
              <CheckBox checked={otOn()} onToggle={() => setOtOn(!otOn())} />
              <span class="cp3-title" onClick={() => setOtOn(!otOn())}>
                {translate("Others")}
              </span>
              <InfoIcon text={translate("A commission on every other symbol: a share of the trade's value (Percent) or a flat amount per fill (Absolute).")} />
            </div>
          </div>
          <Label title={translate("Commission")} />
          <div class="cp3-cell cp3-controls">
            <NumberField value={otValue()} disabled={!otOn()} num={{ min: 0, max: 1e9, step: 0.0001 }} onChange={setOtValue} />
          </div>
          <Label title={translate("Commission type")} />
          <div class="cp3-cell cp3-controls">
            <SelectControl
              value={otType()}
              options={["percent", "absolute"]}
              labelOf={(o) => translate(TYPE_LABEL[o as CommissionType])}
              width={100}
              disabled={!otOn()}
              onPick={(o) => setOtType(o as CommissionType)}
            />
          </div>
        </div>
      </div>
      <footer class="cp3-footer">
        <button type="button" class="cp3-btn" onClick={() => confirmPaperReset()}>
          {translate("Reset account")}
        </button>
        <div class="cp3-footer-actions">
          <button type="button" class="cp3-btn" onClick={() => props.onClose()}>
            {translate("Cancel")}
          </button>
          <button type="button" class="cp3-btn is-primary" data-name="submit-button" disabled={!valid()} onClick={save}>
            {translate("Save")}
          </button>
        </div>
      </footer>
    </Dialog>
  );
}
