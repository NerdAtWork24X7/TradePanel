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
