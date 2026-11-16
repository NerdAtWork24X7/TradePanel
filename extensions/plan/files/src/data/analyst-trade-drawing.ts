/*
 * "Show on chart" of the analyst card: project the plan with the chart's own
 * long / short position drawing tool (the risk/reward box), not a broker
 * order. The shell registers the implementation (it owns the drawing store and
 * the tabs); the analyst panel only supplies the plan.
 */
export type AnalystTradeDrawingPlan = {
  symbol: string;
  action: "long" | "short";
  entry: number;
  takeProfit: number;
  stopLoss: number;
  qty: number | null;
};

type Impl = (plan: AnalystTradeDrawingPlan) => boolean;

let impl: Impl | null = null;

/** Register the shell's drawing projection. Returns the unregister. */
export function installAnalystTradeDrawing(run: Impl): () => void {
  impl = run;
  return () => {
    if (impl === run) impl = null;
  };
}

/** Draw the plan on a shown chart of `plan.symbol`; false when no chart shows it. */
export function showAnalystTradeOnChart(plan: AnalystTradeDrawingPlan): boolean {
  return impl ? impl(plan) : false;
}
