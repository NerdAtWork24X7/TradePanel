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
  note?: string;
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
  exchange: string;
  kind: "text" | "secret" | "choice";
  multiline: boolean;
  set: boolean;
  value: string;
}

export interface ExchangeMarket {
  id: string;
  label: string;
  ccxt: string;
}

export interface ExchangeCatalogEntry {
  id: string;
  name: string;
  markets: ExchangeMarket[];
  networks: string[];
  default_network: string;
  passphrase: boolean;
  wallet: boolean;
}

export interface ExchangeCatalog {
  exchanges: ExchangeCatalogEntry[];
  default_exchange: string;
  default_market: string;
}

export interface BalanceEntry {
  currency: string;
  total: number;
  free: number;
}

export interface ConnectionResult {
  ok: boolean;
  exchange: string;
  market: string;
  network: string;
  label: string;
  balances: BalanceEntry[];
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

/** A study enabled on a chart panel, mirrored to the shell for AI analysis. */
export interface AiChartIndicator {
  id: string;
  inputs: Record<string, unknown>;
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

// ── AI Analysis ────────────────────────────────────────────────────────────

export type AiState =
  | "stopped"
  | "starting"
  | "idle"
  | "streaming"
  | "error"
  | "unavailable";

export interface AiStatus {
  state: AiState;
  message: string | null;
  pid: number | null;
  runtimeReady: boolean;
  runtimeError: string | null;
  nodeVersion: string | null;
  piVersion: string | null;
  configured: boolean;
  hasKey: boolean;
  provider: string | null;
  providerLabel: string | null;
  model: string | null;
  thinking: string;
  portfolioContext: boolean;
  sessionId: string | null;
  streaming: boolean;
  attempt: number;
  models: number;
  updatedAtMs: number;
}

export interface AiProvider {
  id: string;
  label: string;
}

export interface AiModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: string[];
}

export interface AiAuthMethod {
  type: "oauth" | "api_key";
  label: string;
  canLogin: boolean;
}

export interface AiAuthProvider {
  id: string;
  name: string;
  methods: AiAuthMethod[];
  configured: boolean;
  usingOAuth: boolean;
  statusLabel: string;
}

export interface AiAuthCredential {
  providerId: string;
  name: string;
  type: "oauth" | "api_key";
}

export interface AiAuthProviders {
  ready: boolean;
  reason: string | null;
  providers: AiAuthProvider[];
  credentials: AiAuthCredential[];
}

export interface AiAuthPromptOption {
  id: string;
  label: string;
  description?: string;
}

export interface AiAuthPrompt {
  id: number;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: AiAuthPromptOption[];
}

export interface AiAuthEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  links?: { url: string; label?: string }[];
}

export interface AiAuthSession {
  id: string;
  providerId: string;
  providerName: string;
  type: "oauth" | "api_key";
  status: "running" | "ok" | "error" | "cancelled";
  prompt: AiAuthPrompt | null;
  events: AiAuthEvent[];
  error?: string | null;
  startedAt: number;
}

export interface AiAuthModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  input: string[];
  thinkingLevels: string[] | null;
  cost: UnknownRecord | null;
}

export interface AiConversation {
  id: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  model: string;
}

export interface AiConversationStore {
  version: number;
  active: string;
  items: AiConversation[];
}

export interface AiSettings {
  provider: string;
  model: string;
  thinking: string;
  portfolioContext: boolean;
}

export interface AiDiagnostics {
  runtimeReady: boolean;
  runtimeError: string | null;
  runtimeRoot: string | null;
  nodeVersion: string | null;
  piVersion: string | null;
  target: string | null;
  nodePath: string | null;
  piCli: string | null;
  extension: string | null;
  systemPrompt: string | null;
  agentDir: string;
  sessionsDir: string;
  workspaceDir: string;
  contextFile: string;
  sessionFiles: number;
  lastError: string | null;
  authReady: boolean;
  authError: string | null;
}

export type AiPlanAction = "long" | "short" | "no-trade";

export interface AiTradePlan {
  /** `no-trade` only appears in plans stored before analysis required a trade. */
  action: AiPlanAction;
  /** Estimated chance (integer percentage) that TP is hit before SL. */
  probability?: number | null;
  /** Legacy plans used a qualitative confidence instead of `probability`. */
  confidence?: "low" | "medium" | "high";
  basisTimeframe: string;
  rationale: string;
  entry: number | null;
  takeProfit: number | null;
  stopLoss: number | null;
  qty?: number | null;
  riskReward: number | null;
  symbol: string | null;
  timeframe: string | null;
  lastPrice?: number | null;
  acceptedAtMs: number;
}

export interface AiConnectResult {
  models: AiModel[];
  model: string;
  reply: string;
}

export interface AiEvent {
  type: string;
  [key: string]: unknown;
}
