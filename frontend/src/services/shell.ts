import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RpcError } from "./backend";

export async function openTradePage(
  coin: string,
  exchange: string,
  market: string,
): Promise<void> {
  try {
    await invoke("open_trade_page", { coin, exchange, market });
  } catch (error) {
    throw RpcError.from(error);
  }
}

/** HTTPS-only browser open, used by the provider sign-in flow. */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await invoke("open_external_url", { url });
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

/** Toggle the native window (not the iframe) so the shell stays visible. */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    const window = getCurrentWindow();
    const next = !(await window.isFullscreen());
    await window.setFullscreen(next);
    return next;
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
