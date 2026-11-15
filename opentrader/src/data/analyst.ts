/*
 * The chart analyst's provider settings and one streaming request (Rust: src-tauri/src/analyst.rs).
 * The API key is never here: Rust reads it from the OS credential store and adds the
 * Authorization header. The messages may carry a chart screenshot as a data URL.
 */
import { Channel } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { commands } from "../bindings";
import { applyEvent, newTurn, shownText } from "./assistant/stream";

export type AnalystSettings = { baseUrl: string; model: string; hasKey: boolean };

export type AnalystPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type AnalystMessage = { role: "system" | "user" | "assistant"; content: string | AnalystPart[] };

export type AnalystResult = { status: "ok"; data: AnalystSettings } | { status: "error"; error: string };

const [settings, setSettings] = createSignal<AnalystSettings>({ baseUrl: "", model: "", hasKey: false });
/** What the provider form shows; empty until the first load. */
export const analystSettings = settings;

let sequence = 0;
let current: number | null = null;

/** Read the saved provider (base URL, model, whether a key is stored). */
export async function loadAnalystSettings(): Promise<AnalystSettings | null> {
  try {
    const saved = await commands.analystSettings();
    setSettings(saved);
    return saved;
  } catch (e) {
    console.warn("[analyst] settings", e);
    return null;
  }
}

/** Save the base URL and model; `apiKey` (when given) replaces the stored key. */
export async function saveAnalystSettings(baseUrl: string, model: string, apiKey?: string): Promise<AnalystResult> {
  try {
    const r = await commands.analystSetSettings(baseUrl, model, apiKey?.trim() ? apiKey : null);
    if (r.status === "error") return { status: "error", error: r.error };
    setSettings(r.data);
    return { status: "ok", data: r.data };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function clearAnalystKey(): Promise<AnalystResult> {
  try {
    const r = await commands.analystClearKey();
    if (r.status === "error") return { status: "error", error: r.error };
    setSettings(r.data);
    return { status: "ok", data: r.data };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** One analysis; `onText` receives the answer as it streams. Throws with the provider's message. */
export async function analyzeChart(messages: AnalystMessage[], onText: (text: string) => void): Promise<string> {
  const request = ++sequence;
  current = request;
  let turn = newTurn();
  let failure: string | null = null;
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    try {
      turn = applyEvent(turn, data);
      onText(shownText(turn.content));
    } catch (e) {
      // A provider error arrives inside the stream; keep reading so the command ends cleanly.
      failure ??= e instanceof Error ? e.message : String(e);
    }
  };
  try {
    const r = await commands.analystAnalyze(request, JSON.stringify(messages), channel);
    if (r.status === "error") throw new Error(r.error);
    if (failure) throw new Error(failure);
  } finally {
    if (current === request) current = null;
  }
  return shownText(turn.content);
}

/** Stop the analysis under way; the text received so far stays. */
export function stopAnalysis(): void {
  if (current !== null) void commands.analystCancel(current);
  current = null;
}
