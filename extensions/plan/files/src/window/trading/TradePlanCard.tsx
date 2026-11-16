/*
 * The ticket's trade plan: entry, stop and target in account terms. It answers the
 * question the price fields leave open — what the order risks, what it aims at, how that
 * compares to the balance — before the order is sent. Pure numbers from plan.ts, read
 * through the ticket model (so they follow the field types, offsets and risk sizing).
 */
import { createMemo, Show } from "solid-js";
import { tradePlan, type TradePlan } from "./plan";
import { translate } from "../../i18n/translator";
import type { TicketModel } from "./ticket-model";

const amount = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => `${v.toFixed(2)}%`;

export function TradePlanCard(props: { m: TicketModel; ccy: string }) {
  const plan = createMemo<TradePlan | null>(() =>
    tradePlan({
      side: props.m.d().side,
      entry: props.m.entry(),
      stop: props.m.exitOn("sl") ? props.m.exitPx("sl") : null,
      target: props.m.exitOn("tp") ? props.m.exitPx("tp") : null,
      qty: props.m.qtyNum(),
      balance: props.m.ctx().balance,
    }),
  );
  const price = (v: number) => v.toFixed(props.m.dec());
  // The bar's two halves, in proportion to what is at stake on each side.
  const share = (p: TradePlan) => {
    if (p.risk == null || p.reward == null || p.risk + p.reward <= 0) return null;
    return Math.min(100, Math.max(0, (p.risk / (p.risk + p.reward)) * 100));
  };
  return (
    <Show when={plan()}>
      {(p) => (
        <section class="trd-plan" data-name="trade-plan" aria-label="Trade plan">
          <div class="trd-plan-head">
            <span>Trade plan</span>
            <span class="trd-plan-rr" classList={{ "is-idle": p().rr == null }}>
              R:R {p().rr == null ? "—" : Number(p().rr!.toFixed(2))}
            </span>
          </div>
          <div class="trd-plan-levels">
            <div class="trd-plan-level">
              <span>Entry</span>
              <strong>{price(p().entry)}</strong>
            </div>
            <div class="trd-plan-level is-loss">
              <span>Stop</span>
              <strong>{p().stop == null ? "—" : price(p().stop!)}</strong>
            </div>
            <div class="trd-plan-level is-profit">
              <span>Target</span>
              <strong>{p().target == null ? "—" : price(p().target!)}</strong>
            </div>
          </div>
          <Show when={share(p())}>{(left) => (
            <div class="trd-plan-bar" role="img" aria-label="Risk and reward at the levels">
              <span class="is-risk" style={{ width: `${left()}%` }} />
              <span class="is-reward" style={{ width: `${100 - left()}%` }} />
            </div>
          )}</Show>
          <div class="trd-plan-rows">
            <Show when={p().risk != null}>
              <div class="trd-tk-row">
                <span>Risk</span>
                <span class="trd-tk-row-value trd-plan-risk">
                  {amount(p().risk!)}
                  <small> {props.ccy}</small>
                  <Show when={p().riskPct != null}><small class="trd-plan-pct">{pct(p().riskPct!)}</small></Show>
                </span>
              </div>
            </Show>
            <Show when={p().reward != null}>
              <div class="trd-tk-row">
                <span>Reward</span>
                <span class="trd-tk-row-value trd-plan-reward">
                  {amount(p().reward!)}
                  <small> {props.ccy}</small>
                  <Show when={p().rewardPct != null}><small class="trd-plan-pct">{pct(p().rewardPct!)}</small></Show>
                </span>
              </div>
            </Show>
            <Show when={p().balanceAtTarget != null || p().balanceAtStop != null}>
              <div class="trd-plan-balance">
                <Show when={p().balanceAtTarget != null}>
                  <span>At target <strong>{amount(p().balanceAtTarget!)}</strong></span>
                </Show>
                <Show when={p().balanceAtStop != null}>
                  <span>At stop <strong>{amount(p().balanceAtStop!)}</strong></span>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={p().wrongSide}>
            {(side) => (
              <p class="trd-plan-warning" role="alert">
                {side() === "stop" ? translate("The stop is on the wrong side of the entry.") : translate("The target is on the wrong side of the entry.")}
              </p>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}
