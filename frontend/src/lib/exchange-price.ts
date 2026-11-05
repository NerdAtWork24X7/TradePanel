/** Price formatting for Hyperliquid perps: 5 significant figures and at most
 *  `6 - szDecimals` decimal places (the same rule the SDK applies to the wire). */

export interface PricePrecision {
  price_decimals: number;
  price_sig_figs: number;
}

function clampWhole(value: number, min: number, max: number): number {
  const whole = Math.trunc(Number.isFinite(value) ? value : min);
  return Math.min(max, Math.max(min, whole));
}

export function roundToExchangePrice(value: number, precision: PricePrecision): number {
  if (!Number.isFinite(value)) return value;
  const sigFigs = clampWhole(precision.price_sig_figs, 1, 100);
  const decimals = clampWhole(precision.price_decimals, 0, 20);
  const sigFigText = value.toPrecision(sigFigs);
  return Number(Number(sigFigText).toFixed(decimals));
}

/** Round then render with trailing zeros trimmed, never in exponent form. */
export function formatExchangePrice(value: number, precision: PricePrecision): string {
  if (!Number.isFinite(value)) return "";
  const decimals = clampWhole(precision.price_decimals, 0, 20);
  const rounded = roundToExchangePrice(value, precision);
  const text = Math.abs(rounded) < 1e21 ? rounded.toFixed(decimals) : String(rounded);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
