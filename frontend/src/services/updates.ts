import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

/** Result of asking the npm registry for the latest Pi release. */
export interface AiRuntimeUpdateInfo {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  nodeVersion: string;
  target: string;
  /** True when the active Pi tree already comes from an in-app update. */
  managed: boolean;
  dependencyCount: number | null;
}

export type AiRuntimeUpdatePhase = "prepare" | "install" | "verify" | "done";

export interface AiRuntimeUpdateProgress {
  phase: AiRuntimeUpdatePhase;
  message: string;
}

/** Registry lookup only: nothing is downloaded and Pi keeps running. */
export async function checkAiRuntimeUpdate(): Promise<AiRuntimeUpdateInfo> {
  try {
    return await invoke<AiRuntimeUpdateInfo>("ai_runtime_update_check");
  } catch (error) {
    throw RpcError.from(error);
  }
}

/**
 * Downloads the latest Pi release plus its npm dependencies into the writable
 * runtime overlay and activates it. Stops the AI runtime while it installs.
 */
export async function installAiRuntimeUpdate(): Promise<AiRuntimeUpdateInfo> {
  try {
    return await invoke<AiRuntimeUpdateInfo>("ai_runtime_update_install");
  } catch (error) {
    throw RpcError.from(error);
  }
}

export function onAiRuntimeUpdateProgress(
  handler: (progress: AiRuntimeUpdateProgress) => void,
): Promise<UnlistenFn> {
  return listen<AiRuntimeUpdateProgress>("ai:runtime-update", (event) => handler(event.payload));
}
