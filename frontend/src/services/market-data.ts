import { rpc } from "./backend";
import type { CandleResponse, MarketMeta, SymbolHit } from "../types";

export function getMeta(): Promise<MarketMeta> {
  return rpc<MarketMeta>("market.meta");
}

export function getCandles(
  exchange: string,
  market: string,
  symbol: string,
  timeframe: string,
  limit = 600,
  endTime: number | null = null,
): Promise<CandleResponse> {
  return rpc<CandleResponse>("market.get_candles", {
    exchange,
    market,
    symbol,
    timeframe,
    limit,
    end_time: endTime,
  });
}

export function getTick(
  exchange: string,
  market: string,
  symbol: string,
  timeframe: string,
): Promise<CandleResponse> {
  return rpc<CandleResponse>("market.get_tick", {
    exchange,
    market,
    symbol,
    timeframe,
  });
}

export async function searchSymbols(
  exchange: string,
  market: string,
  query: string,
): Promise<SymbolHit[]> {
  const result = await rpc<{ symbols: SymbolHit[] }>("market.search_symbols", {
    exchange,
    market,
    query,
  });
  return result.symbols ?? [];
}
