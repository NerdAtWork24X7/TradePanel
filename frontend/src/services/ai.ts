import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RpcError } from "./backend";
import type {
  AiConnectResult,
  AiConversationStore,
  AiAuthModel,
  AiAuthProviders,
  AiAuthSession,
  AiDiagnostics,
  AiEvent,
  AiModel,
  AiProvider,
  AiSettings,
  AiStatus,
  UnknownRecord,
} from "../types";

async function call<T>(command: string, args?: UnknownRecord): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw RpcError.from(error);
  }
}

export function getStatus(): Promise<AiStatus> {
  return call("ai_status");
}

export function getProviders(): Promise<AiProvider[]> {
  return call("ai_providers");
}

export function getDiagnostics(): Promise<AiDiagnostics> {
  return call("ai_diagnostics");
}

export function getRuntimeReport(): Promise<{
  runtimeReady: boolean;
  runtimeError: string | null;
  nodeVersion: string | null;
  piVersion: string | null;
  managed: boolean;
}> {
  return call("ai_runtime_report");
}

export function getAuthProviders(): Promise<AiAuthProviders> {
  return call("ai_auth_providers");
}

export function getAuthModels(): Promise<AiAuthModel[]> {
  return call("ai_auth_models");
}

export function authStart(provider: string, authType: "oauth" | "api_key"): Promise<AiAuthSession> {
  return call("ai_auth_start", { provider, authType });
}

export function authAnswer(sessionId: string, promptId: number, value: string): Promise<AiAuthSession> {
  return call("ai_auth_answer", { sessionId, promptId, value });
}

export function authCancel(sessionId: string): Promise<AiAuthSession> {
  return call("ai_auth_cancel", { sessionId });
}

export function authSession(sessionId: string): Promise<AiAuthSession> {
  return call("ai_auth_session", { sessionId });
}

export function authLogout(provider: string): Promise<AiAuthProviders> {
  return call("ai_auth_logout", { provider });
}

export function onAuth(handler: (session: AiAuthSession) => void): Promise<UnlistenFn> {
  return listen<{ session: AiAuthSession }>("ai:auth", (event) => handler(event.payload.session));
}

export function connect(input: {
  provider: string;
  apiKey: string;
  model?: string | null;
  thinking?: string | null;
  portfolioContext?: boolean;
}): Promise<AiConnectResult> {
  return call("ai_connect", {
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
    portfolioContext: input.portfolioContext ?? null,
  });
}

export function disconnect(): Promise<void> {
  return call("ai_disconnect");
}

export function getModels(): Promise<AiModel[]> {
  return call("ai_models");
}

export function savePreferences(input: {
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
  portfolioContext?: boolean | null;
}): Promise<AiSettings> {
  return call("ai_save_preferences", {
    provider: input.provider ?? null,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
    portfolioContext: input.portfolioContext ?? null,
  });
}

export function send(
  message: string,
  snapshot: UnknownRecord,
  images: string[] = [],
): Promise<{ conversationId: string; disposition: string; images: number }> {
  return call("ai_send", { message, snapshot, images });
}

export function abort(): Promise<void> {
  return call("ai_abort");
}

export function stop(): Promise<void> {
  return call("ai_stop");
}

export function getHistory(): Promise<{ conversationId: string; messages: UnknownRecord[] }> {
  return call("ai_history");
}

export function getConversations(): Promise<AiConversationStore> {
  return call("ai_conversations");
}

export function createConversation(): Promise<AiConversationStore> {
  return call("ai_conversation_create");
}

export function activateConversation(id: string): Promise<AiConversationStore> {
  return call("ai_conversation_activate", { id });
}

export function renameConversation(id: string, title: string): Promise<AiConversationStore> {
  return call("ai_conversation_rename", { id, title });
}

export function deleteConversation(id: string): Promise<AiConversationStore> {
  return call("ai_conversation_delete", { id });
}

export function onEvent(handler: (event: AiEvent) => void): Promise<UnlistenFn> {
  return listen<AiEvent>("ai:event", (event) => handler(event.payload));
}

export function onStatus(handler: (status: AiStatus) => void): Promise<UnlistenFn> {
  return listen<AiStatus>("ai:status", (event) => handler(event.payload));
}
