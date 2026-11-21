/*
 * The UI-side switch for the account context an analysis may read.
 *
 * The snapshot and the analysis prompt both treat portfolio access as a user
 * choice, so the panel asks before sending positions or orders to the model.
 * It stays in kv (not the provider settings file): it is a window preference,
 * not a provider credential, and kv syncs it across windows.
 */
import * as kv from "./kv";

const PORTFOLIO_KEY = "ot:analyst:portfolio-context:v1";

export function analystPortfolioContext(): boolean {
  return kv.getItem(PORTFOLIO_KEY) === "1";
}

export function setAnalystPortfolioContext(enabled: boolean): void {
  kv.setItem(PORTFOLIO_KEY, enabled ? "1" : "0");
}
