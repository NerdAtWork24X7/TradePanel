import { rpc } from "./backend";
import type { UnknownRecord, WorkspaceStore } from "../types";

export function loadWorkspaceStore(): Promise<WorkspaceStore> {
  return rpc<WorkspaceStore>("workspace.load");
}

export async function saveWorkspaceStore(
  store: UnknownRecord,
): Promise<{ ok: boolean }> {
  return rpc<{ ok: boolean }>("workspace.save", { store });
}

/**
 * Persist only the store-global alert rules. Creating/editing an alert must
 * survive an app restart without force-saving the active session layout.
 */
export async function saveWorkspaceAlerts(
  alerts: unknown[],
): Promise<{ ok: boolean; alerts: unknown[] }> {
  return rpc<{ ok: boolean; alerts: unknown[] }>("workspace.save_alerts", { alerts });
}
