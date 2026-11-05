import { rpc } from "./backend";
import type {
  IndicatorComputeResult,
  IndicatorConfig,
  IndicatorConfigResult,
  UnknownRecord,
} from "../types";

export async function getIndicatorConfig(): Promise<IndicatorConfig> {
  const result = await rpc<IndicatorConfigResult>("indicator.get_config");
  return result.config;
}

export async function saveIndicatorConfig(
  config: IndicatorConfig,
): Promise<IndicatorConfig> {
  const result = await rpc<IndicatorConfigResult>("indicator.save_config", {
    config: config as unknown as UnknownRecord,
  });
  return result.config;
}

export function computeIndicators(
  exchange: string,
  market: string,
  symbol: string,
  timeframe: string,
  flags: UnknownRecord,
): Promise<IndicatorComputeResult> {
  return rpc<IndicatorComputeResult>("indicator.compute", {
    exchange,
    market,
    symbol,
    timeframe,
    flags,
  });
}
