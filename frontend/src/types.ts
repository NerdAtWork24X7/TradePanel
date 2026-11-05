export type UnknownRecord = Record<string, unknown>;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleResponse {
  ok: boolean;
  exchange: string;
  market: string;
  symbol: string;
  native: string;
  base: string;
  quote: string;
  timeframe: string;
  aggregated_from: string | null;
  candles: Candle[];
  has_more: boolean;
}

export interface SymbolHit {
  symbol: string;
  native: string;
  base: string;
  quote: string;
}

export interface MarketMeta {
  exchanges: Array<{
    id: string;
    name: string;
    markets: Array<{ id: string; label: string; timeframes: string[] }>;
  }>;
  timeframes: string[];
  aggregations: UnknownRecord;
  layouts: string[];
}

export interface WorkspaceStore {
  ok: boolean;
  version: number;
  active: string;
  workspaces: unknown[];
}

export interface Position {
  coin: string;
  has_position: boolean;
  entry: number | null;
  tp: number | null;
  sl: number | null;
  size: number;
  pnl: number;
  error?: string;
}

export interface OpenOrder {
  oid: number | string | null;
  side: string | null;
  size: string | null;
  limitPrice: string | null;
  triggerPrice: string | null;
  isTrigger: boolean;
  reduceOnly: boolean;
  timestamp: number | null;
}

export interface OrderResult {
  success: boolean;
  message: string;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  group: string;
  set: boolean;
}

export interface CredentialSaveResult {
  keys: string[];
  fields: CredentialField[];
}

export interface AppInfo {
  version: string;
  protocolVersion: number;
  dataDir: string;
}

export interface WindowState {
  coin?: string;
  timeframe?: string;
  sidebar_collapsed?: boolean;
  risk?: string;
  is_short?: boolean;
  hyperliquid?: boolean;
  limit?: string;
  tp?: string;
  sl?: string;
  fvg_enabled?: boolean;
  [key: string]: unknown;
}

export interface IndicatorConfig {
  fvg: { gap_pct: number; enabled: boolean };
  vwap: { anchor_intraday: string; anchor_daily: string; enabled: boolean };
  sessions: {
    asian_start: string; asian_end: string;
    london_start: string; london_end: string;
    ny_am_start: string; ny_am_end: string;
    ny_pm_start: string; ny_pm_end: string;
    asian_enabled: boolean; london_enabled: boolean;
    ny_am_enabled: boolean; ny_pm_enabled: boolean;
  };
  ema_ribbon: { ma_type: string; length1: number; length2: number; length3: number; enabled: boolean };
  volume_profile: { length: number; rows: number; enabled: boolean };
  session_vp: { enabled: boolean };
  hl_ema: { length: number; enabled: boolean };
  adx: {
    length: number; pane_height: number; levels: number[];
    show_di_lines: boolean; enabled: boolean;
  };
  lines?: { entry_visible: boolean; tp_visible: boolean; sl_visible: boolean };
  [key: string]: unknown;
}

export interface IndicatorConfigResult {
  ok: boolean;
  config: IndicatorConfig;
}

export interface BackendStatus {
  state:
    | "starting"
    | "running"
    | "restarting"
    | "stopped"
    | "failed"
    | "incompatible";
  message: string | null;
  protocolVersion: number | null;
  backendVersion: string | null;
  pid: number | null;
  attempts: number;
  updatedAtMs: number;
}

export type Direction = "long" | "short";

export interface IndicatorComputeResult {
  ok: boolean;
  [key: string]: unknown;
}
