import { invoke } from "@tauri-apps/api/core";
import { RpcError } from "./backend";

export interface UpdateInfo {
  available: boolean;
  version?: string;
  notes?: string;
  currentVersion?: string;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    return await invoke<UpdateInfo>("update_check");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export async function installUpdate(): Promise<void> {
  try {
    await invoke("update_install");
  } catch (error) {
    throw RpcError.from(error);
  }
}
