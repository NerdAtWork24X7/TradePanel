import { rpc } from "./backend";
import type { UnknownRecord, WindowState } from "../types";

export async function loadWindowState(): Promise<WindowState> {
  const result = await rpc<{ state: WindowState }>("settings.window_state.get");
  return result.state ?? {};
}

export async function saveWindowState(state: WindowState): Promise<void> {
  await rpc<{ ok: boolean }>("settings.window_state.save", {
    state: state as unknown as UnknownRecord,
  });
}
