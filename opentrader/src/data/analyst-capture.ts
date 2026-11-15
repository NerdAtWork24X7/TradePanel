/*
 * Chart capture for Analyze chart.
 *
 * The analyst needs three pictures of the SAME instrument — 1d, 4h and 5m —
 * each drawn with the studies the user has on the selected chart. Rendering
 * them in the visible chart would flash through intervals; instead the shell
 * opens a short-lived hidden second Tauri window (the app's existing
 * multi-window path), hands it this job through localStorage, and the window
 * walks the targets and returns the images over Tauri events.
 *
 * The host (App) owns the tab/drawing stores, so it registers the capture
 * implementation here once; the assistant panel only asks for the images.
 */
import type { PaneChart } from "../window/shell/tabs";
import { translate } from "../i18n/translator";

/** The fixed analysis grid: datafeed resolution id and the label shown to the reader/model. */
export const ANALYSIS_TARGETS = [
  { interval: "1D", label: "1d" },
  { interval: "240", label: "4h" },
  { interval: "5", label: "5m" },
] as const;

export type AnalystCaptureTarget = { interval: string; label: string };

export type AnalystCaptureImage = {
  /** "1d", "4h", "5m" — the label drawn on the picture and sent with it. */
  label: string;
  /** Datafeed resolution the picture was rendered at. */
  interval: string;
  /** data:image/(png|jpeg|webp);base64 URL. */
  dataUrl: string;
};

export type AnalystCaptureRequest = {
  symbol: string;
  targets: readonly AnalystCaptureTarget[];
};

/** What the shell asks the capture window to render: the selected pane copied at request time. */
export type AnalystCaptureSpec = {
  id: string;
  symbol: string;
  targets: AnalystCaptureTarget[];
  /** The selected chart's configuration (symbol, studies, settings). */
  pane: PaneChart;
  /** The app-wide Hide indicators flag, so the pictures match the chart. */
  indicatorsHidden: boolean;
  theme: "dark" | "light";
  timeZone: string;
  timeZoneLabel: string;
};

/** The part of a spec the shell chooses; the window names its own id. */
export type AnalystCapturePayload = Omit<AnalystCaptureSpec, "id">;

/** The capture window's route (`index.html?view=analysis-capture&id=...`). */
export const ANALYSIS_CAPTURE_VIEW = "analysis-capture";
const SPEC_PREFIX = "ot:analysis-capture:spec:";
export const CAPTURE_IMAGE_EVENT = "ot:analysis-capture:image";
export const CAPTURE_DONE_EVENT = "ot:analysis-capture:done";
export const CAPTURE_ERROR_EVENT = "ot:analysis-capture:error";

export type AnalystCaptureImageMessage = { id: string; image: AnalystCaptureImage };
export type AnalystCaptureDoneMessage = { id: string };
export type AnalystCaptureErrorMessage = { id: string; error: string };

/** Write the job the capture window reads on boot. Throws when storage is unavailable/full. */
export function saveCaptureSpec(spec: AnalystCaptureSpec): void {
  localStorage.setItem(SPEC_PREFIX + spec.id, JSON.stringify(spec));
}

/** Read and clear a capture job. Null when it is missing or malformed. */
export function takeCaptureSpec(id: string): AnalystCaptureSpec | null {
  const key = SPEC_PREFIX + id;
  try {
    const raw = localStorage.getItem(key);
    localStorage.removeItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AnalystCaptureSpec>;
    if (
      typeof v.id !== "string" ||
      v.id !== id ||
      typeof v.symbol !== "string" ||
      !v.symbol.trim() ||
      !Array.isArray(v.targets) ||
      v.targets.length === 0 ||
      !v.targets.every((t) => t && typeof t.interval === "string" && typeof t.label === "string") ||
      !v.pane ||
      typeof v.pane !== "object" ||
      (v.theme !== "dark" && v.theme !== "light")
    ) {
      return null;
    }
    return v as AnalystCaptureSpec;
  } catch {
    return null;
  }
}

/** Drop a job that never reached its window (or that the window already took). */
export function clearCaptureSpec(id: string): void {
  try {
    localStorage.removeItem(SPEC_PREFIX + id);
  } catch {
    /* noop */
  }
}

type CaptureImpl = (request: AnalystCaptureRequest) => Promise<AnalystCaptureImage[]>;

let impl: CaptureImpl | null = null;

/** Register the shell's renderer (App). Returns the unregister. */
export function installAnalystCapture(run: CaptureImpl): () => void {
  impl = run;
  return () => {
    if (impl === run) impl = null;
  };
}

/** Render the requested timeframes. Rejects when the shell is not mounted or a chart fails. */
export async function captureAnalystCharts(request: AnalystCaptureRequest): Promise<AnalystCaptureImage[]> {
  if (!impl) throw new Error(translate("The chart renderer is not ready. Reopen the AI assistant and try again."));
  return impl(request);
}
