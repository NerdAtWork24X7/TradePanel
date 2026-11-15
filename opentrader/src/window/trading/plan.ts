/*
 * Trade-plan projections: what the ticket's entry, stop, target and quantity mean in
 * account terms. Pure math (point value 1, like the ticket), so every figure is unit
 * tested: risk and reward at the levels, their share of the balance, R:R, and the balance
 * after either level. A level on the wrong side of the entry is reported, not silently
 * turned into a profit.
 */

export type PlanInput = {
  side: "buy" | "sell";
  entry: number | null;
  stop: number | null;
  target: number | null;
  qty: number | null;
  /** The account's cash; null / 0 hides the percentages and the balances after each level. */
  balance: number | null;
};

export type TradePlan = {
  side: "buy" | "sell";
  entry: number;
  qty: number;
  stop: number | null;
  target: number | null;
  /** Money at the stop (positive). */
  risk: number | null;
  /** Money at the target (positive). */
  reward: number | null;
  riskPct: number | null;
  rewardPct: number | null;
  /** Reward / risk; null without both levels or with no distance to the stop. */
  rr: number | null;
  balanceAtStop: number | null;
  balanceAtTarget: number | null;
  /** The stop or the target sits on the side that makes it a profit / a loss. */
  wrongSide: "stop" | "target" | null;
};

/** The plan, or null until the ticket has an entry and a quantity. */
export function tradePlan(input: PlanInput): TradePlan | null {
  const { side, entry, stop, target, qty, balance } = input;
  if (entry == null || !(entry > 0) || qty == null || !(qty > 0)) return null;
  const up = side === "buy" ? 1 : -1;
  const usable = (level: number | null) => level != null && level > 0 ? level : null;
  const stopLevel = usable(stop);
  const targetLevel = usable(target);
  // A stop above the entry of a long (or below a short) and a target on the other side
  // are reported: treating them as a risk / reward would show a plan the order can't take.
  const wrongStop = stopLevel != null && (stopLevel - entry) * up >= 0;
  const wrongTarget = targetLevel != null && (targetLevel - entry) * up <= 0;
  const risk = stopLevel != null && !wrongStop ? Math.abs(stopLevel - entry) * qty : null;
  const reward = targetLevel != null && !wrongTarget ? Math.abs(targetLevel - entry) * qty : null;
  const cash = balance != null && balance > 0 ? balance : null;
  return {
    side,
    entry,
    qty,
    stop: stopLevel,
    target: targetLevel,
    risk,
    reward,
    riskPct: cash != null && risk != null ? (risk / cash) * 100 : null,
    rewardPct: cash != null && reward != null ? (reward / cash) * 100 : null,
    rr: risk != null && risk > 0 && reward != null ? reward / risk : null,
    balanceAtStop: cash != null && risk != null ? cash - risk : null,
    balanceAtTarget: cash != null && reward != null ? cash + reward : null,
    wrongSide: wrongStop ? "stop" : wrongTarget ? "target" : null,
  };
}
