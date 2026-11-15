/*
 * Analyze chart logs: every completed analysis kept on this computer, with
 * its trade plan and the 1d / 4h / 5m pictures that produced it.
 *
 * The entries live in the kv store (metadata only); pictures are files under
 * <app data>/analysis-images, so the store and the cross-window sync never
 * carry base64. A log is capped so old runs cannot grow it without bound; the
 * pictures of evicted entries are removed with them.
 */
import { commands } from "../bindings";
import * as kv from "./kv";
import { asAnalystPlan, type AnalystPlan } from "./analyst";
import type { AnalystCaptureImage } from "./analyst-capture";

const KEY = "ot:analyst:log:v1";
/** Kept analyses (newest first). */
export const MAX_ANALYST_LOGS = 40;
/** Old single-entry key: imported once when the log is empty. */
const LEGACY_LAST_KEY = "ot:analyst:last";

export type AnalystLogImage = {
  label: string;
  interval: string;
  /** File name in analysis-images. */
  name: string;
  mime: string;
};

export type AnalystLogEntry = {
  id: string;
  /** Epoch ms of the run. */
  at: number;
  symbol: string;
  interval: string;
  plan: AnalystPlan | null;
  text: string;
  images: AnalystLogImage[];
  /** Provider model that produced it, when known. */
  model?: string;
};

export type AnalystLogInput = {
  symbol: string;
  interval: string;
  plan: AnalystPlan | null;
  text: string;
  images?: AnalystCaptureImage[];
  model?: string;
};

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function asImage(value: unknown): AnalystLogImage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = asText(v.name);
  if (!name) return null;
  return {
    label: asText(v.label),
    interval: asText(v.interval),
    name,
    mime: asText(v.mime) || "image/png",
  };
}

function asEntry(value: unknown): AnalystLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : 0;
  const text = asText(v.text);
  const plan = asAnalystPlan(v.plan);
  if (!at || (!text && !plan)) return null;
  return {
    id: asText(v.id) || `${at.toString(36)}`,
    at,
    symbol: asText(v.symbol),
    interval: asText(v.interval),
    plan,
    text,
    images: Array.isArray(v.images) ? v.images.map(asImage).filter((i): i is AnalystLogImage => i !== null) : [],
    ...(typeof v.model === "string" && v.model ? { model: v.model } : {}),
  };
}

/** The stored analyses, newest first. Corrupt entries are dropped. */
export function listAnalystLogs(): AnalystLogEntry[] {
  const raw = kv.getItem(KEY);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(asEntry).filter((e): e is AnalystLogEntry => e !== null) : [];
  } catch {
    return [];
  }
}

function persist(entries: AnalystLogEntry[]): void {
  kv.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ANALYST_LOGS)));
}

/** Import the old "last analysis" key (text only) once, when no log exists yet. */
export function migrateLegacyLastAnalysis(): AnalystLogEntry[] {
  const logs = listAnalystLogs();
  if (logs.length) return logs;
  const raw = kv.getItem(LEGACY_LAST_KEY);
  if (!raw) return logs;
  try {
    const last = JSON.parse(raw) as { symbol?: unknown; interval?: unknown; text?: unknown; at?: unknown };
    const text = asText(last.text);
    const at = typeof last.at === "number" && Number.isFinite(last.at) ? last.at : Date.now();
    if (!text) return logs;
    const entry: AnalystLogEntry = {
      id: `legacy-${at.toString(36)}`,
      at,
      symbol: asText(last.symbol),
      interval: asText(last.interval),
      plan: null,
      text,
      images: [],
    };
    persist([entry]);
    kv.removeItem(LEGACY_LAST_KEY);
    return [entry];
  } catch {
    return logs;
  }
}

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** "data:image/png;base64,..." → its bytes and extension. */
function splitDataUrl(url: string): { data: string; ext: string; mime: string } | null {
  const match = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url.trim());
  if (!match) return null;
  return { mime: match[1], ext: match[2].toLowerCase(), data: match[3] };
}

async function saveImages(images: AnalystCaptureImage[] | undefined): Promise<AnalystLogImage[]> {
  if (!images?.length) return [];
  const saved = await Promise.all(
    images.map(async (image): Promise<AnalystLogImage | null> => {
      const file = splitDataUrl(image.dataUrl);
      if (!file) return null;
      try {
        const result = await commands.saveAnalysisImage(file.data, file.ext);
        if (result.status === "error") return null;
        return { label: image.label, interval: image.interval, name: result.data, mime: file.mime };
      } catch (e) {
        console.warn("[analyst] saving a chart image failed", e);
        return null;
      }
    }),
  );
  return saved.filter((i): i is AnalystLogImage => i !== null);
}

/** Keep an analysis; returns the stored entry (saved pictures included). */
export async function saveAnalystLog(input: AnalystLogInput): Promise<AnalystLogEntry> {
  const entry: AnalystLogEntry = {
    id: newId(),
    at: Date.now(),
    symbol: input.symbol,
    interval: input.interval,
    plan: input.plan,
    text: input.text,
    images: await saveImages(input.images),
    ...(input.model ? { model: input.model } : {}),
  };
  const existing = listAnalystLogs();
  const kept = [entry, ...existing].slice(0, MAX_ANALYST_LOGS);
  const evicted = [entry, ...existing].slice(MAX_ANALYST_LOGS);
  persist(kept);
  // Pictures are content-addressed: a file can belong to another kept entry.
  const referenced = new Set(kept.flatMap((e) => e.images.map((i) => i.name)));
  void deleteImages(evicted.flatMap((e) => e.images), referenced);
  return entry;
}

/** Update the current analysis (its follow-ups change the answer or the plan). */
export async function updateAnalystLog(id: string, patch: { text?: string; plan?: AnalystPlan | null; model?: string }): Promise<void> {
  const logs = listAnalystLogs();
  const index = logs.findIndex((e) => e.id === id);
  if (index < 0) return;
  const current = logs[index];
  const next: AnalystLogEntry = {
    ...current,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
    ...(patch.model ? { model: patch.model } : {}),
  };
  logs[index] = next;
  persist(logs);
}

async function deleteImages(images: AnalystLogImage[], keep: Set<string> = new Set()): Promise<void> {
  await Promise.all(
    images.map(async (image) => {
      if (keep.has(image.name)) return;
      try {
        await commands.deleteAnalysisImage(image.name);
      } catch {
        /* already gone */
      }
    }),
  );
}

export async function deleteAnalystLog(id: string): Promise<AnalystLogEntry[]> {
  const logs = listAnalystLogs();
  const entry = logs.find((e) => e.id === id);
  const next = logs.filter((e) => e.id !== id);
  persist(next);
  if (entry) {
    const referenced = new Set(next.flatMap((e) => e.images.map((i) => i.name)));
    await deleteImages(entry.images, referenced);
  }
  return next;
}

/** The entry's pictures as data URLs, in the 1d / 4h / 5m order they were captured. */
export async function readAnalystLogImages(entry: AnalystLogEntry): Promise<AnalystCaptureImage[]> {
  const out = await Promise.all(
    entry.images.map(async (image): Promise<AnalystCaptureImage | null> => {
      try {
        const result = await commands.readAnalysisImage(image.name);
        if (result.status === "error") return null;
        return { label: image.label || image.interval, interval: image.interval, dataUrl: `data:${image.mime};base64,${result.data}` };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((i): i is AnalystCaptureImage => i !== null);
}
