import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppInfo, BackendStatus, UnknownRecord } from "../types";

/** Stable error shape shared by the Rust command layer and the sidecar. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  static from(value: unknown): RpcError {
    if (value instanceof RpcError) return value;
    if (value && typeof value === "object") {
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.code === "number" &&
        typeof candidate.message === "string"
      ) {
        return new RpcError(candidate.code, candidate.message, candidate.data);
      }
      if (typeof candidate.error === "string") {
        return new RpcError(-32603, candidate.error, candidate);
      }
    }
    if (typeof value === "string") return new RpcError(-32603, value);
    return new RpcError(-32603, "Unexpected backend error");
  }
}

export const RpcCodes = {
  INVALID_PARAMS: -32602,
  UNAVAILABLE: -32001,
  TIMEOUT: -32002,
  EXECUTION_UNKNOWN: -32004,
  SERVER_BUSY: -32005,
  PROTOCOL_MISMATCH: -32010,
  SHUTTING_DOWN: -32011,
  DUPLICATE_REQUEST: -32012,
} as const;

const METHOD_TIMEOUTS: Record<string, number> = {
  "market.get_candles": 40_000,
  "market.get_tick": 25_000,
  "market.search_symbols": 30_000,
  "workspace.save": 20_000,
  "trading.coins": 40_000,
  "account.position": 40_000,
  "account.open_orders": 40_000,
  "trading.place_order": 45_000,
  "trading.update_tp_sl": 45_000,
};

/** True when the failure means "the order may have reached the exchange". */
export function isExecutionUnknown(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    (error.code === RpcCodes.EXECUTION_UNKNOWN || error.code === RpcCodes.TIMEOUT)
  );
}

export async function rpc<T>(
  method: string,
  params: UnknownRecord = {},
  timeoutMs?: number,
): Promise<T> {
  try {
    return await invoke<T>("backend_rpc", {
      method,
      params,
      timeoutMs: timeoutMs ?? METHOD_TIMEOUTS[method] ?? 30_000,
    });
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function fetchBackendStatus(): Promise<BackendStatus> {
  try {
    return await invoke<BackendStatus>("backend_status");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function restartBackend(): Promise<void> {
  try {
    await invoke("backend_restart");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function onBackendStatus(
  handler: (status: BackendStatus) => void,
): Promise<UnlistenFn> {
  return listen<BackendStatus>("backend:status", (event) => handler(event.payload));
}

export interface BackendEvent {
  method: string;
  params: unknown;
}

export async function onBackendEvent(
  handler: (event: BackendEvent) => void,
): Promise<UnlistenFn> {
  return listen<BackendEvent>("backend:event", (event) => handler(event.payload));
}

export interface AppNotice {
  level: "info" | "warn" | "error" | string;
  message: string;
}

export async function onAppNotice(
  handler: (notice: AppNotice) => void,
): Promise<UnlistenFn> {
  return listen<AppNotice>("app:notice", (event) => handler(event.payload));
}

export async function getAppInfo(): Promise<AppInfo> {
  try {
    return await invoke("app_info");
  } catch (error) {
    throw RpcError.from(error);
  }
}
