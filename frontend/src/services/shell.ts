import { invoke } from "@tauri-apps/api/core";
import { RpcError } from "./backend";

export async function openTradePage(coin: string): Promise<void> {
  try {
    await invoke("open_trade_page", { coin });
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function setFullscreen(enabled: boolean): Promise<void> {
  try {
    await invoke("set_fullscreen", { enabled });
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function acknowledgeOrderState(): Promise<void> {
  try {
    await invoke("orders_acknowledge");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export function logFrontend(level: string, message: string): void {
  void invoke("log_frontend", { level, message }).catch(() => undefined);
}
