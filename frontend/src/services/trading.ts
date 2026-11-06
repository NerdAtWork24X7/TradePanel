import { invoke } from "@tauri-apps/api/core";
import { RpcError, RpcCodes, rpc } from "./backend";
import type { ConnectionResult, ExchangeCatalog, OrderResult } from "../types";

export interface Venue {
  exchange: string;
  market: string;
}

export const DEFAULT_VENUE: Venue = { exchange: "hyperliquid", market: "futures" };

export interface OrderInput extends Venue {
  coin: string;
  is_buy: boolean;
  qty: number;
  limit_price: number;
  tp_price: number;
  sl_price: number;
}

export interface TpSlInput extends Venue {
  coin: string;
  is_short: boolean;
  tp: number;
  sl: number;
}

export interface QtyResult {
  qty: number;
  sz_decimals: number;
}

export interface ExchangePricePrecision {
  coin: string;
  sz_decimals: number;
  price_decimals: number;
  price_sig_figs: number;
}

/** Identical submissions are serialised in the shell; the backend also guards. */
const inFlight = new Set<string>();

async function guard<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    throw new RpcError(
      RpcCodes.DUPLICATE_REQUEST,
      "An identical order is already being submitted. Wait for the result before retrying.",
    );
  }
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

export function placeOrder(input: OrderInput): Promise<OrderResult> {
  const key = `place:${JSON.stringify(input)}`;
  return guard(key, () => rpc<OrderResult>("trading.place_order", { ...input }));
}

export function updateTpSl(input: TpSlInput): Promise<OrderResult> {
  const key = `tpsl:${JSON.stringify(input)}`;
  return guard(key, () => rpc<OrderResult>("trading.update_tp_sl", { ...input }));
}

export function calculateQty(
  risk: number,
  entry: number,
  sl: number,
  isShort: boolean,
  coin: string,
  venue: Venue = DEFAULT_VENUE,
): Promise<QtyResult> {
  return rpc<QtyResult>("trading.calc_qty", {
    risk,
    entry,
    sl,
    is_short: isShort,
    coin,
    ...venue,
  });
}

export function getPricePrecision(
  coin: string,
  venue: Venue = DEFAULT_VENUE,
): Promise<ExchangePricePrecision> {
  return rpc<ExchangePricePrecision>("trading.price_precision", { coin, ...venue });
}

export async function getExchanges(): Promise<ExchangeCatalog> {
  return rpc<ExchangeCatalog>("trading.exchanges");
}

export function testConnection(venue: Venue): Promise<ConnectionResult> {
  return rpc<ConnectionResult>("trading.connection", { ...venue });
}

export async function orderUncertain(): Promise<boolean> {
  try {
    const result = await invoke<{ uncertain: boolean }>("orders_state");
    return Boolean(result.uncertain);
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function getCoins(
  venue: Venue = DEFAULT_VENUE,
  refresh = false,
): Promise<string[]> {
  const result = await rpc<{ coins: string[] }>("trading.coins", { ...venue, refresh });
  return result.coins ?? [];
}
