/*
 * Main-window side of Analyze chart's capture: opens the short-lived second
 * Tauri window (hidden), hands it the job, and collects the three pictures it
 * emits. The capture window is a real app webview, not the main
 * chart: the visible chart never changes interval and no browser is bundled.
 */
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CAPTURE_DONE_EVENT,
  CAPTURE_ERROR_EVENT,
  CAPTURE_IMAGE_EVENT,
  clearCaptureSpec,
  saveCaptureSpec,
  type AnalystCaptureDoneMessage,
  type AnalystCaptureErrorMessage,
  type AnalystCaptureImage,
  type AnalystCaptureImageMessage,
  type AnalystCapturePayload,
} from "../../data/analyst-capture";
import { translate, translateWith } from "../../i18n/translator";
import { ANALYSIS_CAPTURE_PREFIX, isTauri, openAnalysisCaptureWindow } from "../shell/window-bridge";

/** A window start + three chart loads; the capture window itself times out each chart. */
const CAPTURE_TIMEOUT_MS = 120_000;

type Pending = {
  id: string;
  label: string;
  expected: number;
  order: string[];
  images: AnalystCaptureImage[];
  timer: number;
  resolve: (images: AnalystCaptureImage[]) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();
let listeners: Promise<void> | null = null;
let seq = 0;

function closeWindow(label: string): void {
  try {
    void WebviewWindow.getByLabel(label)
      .then((win) => win?.close())
      .catch(() => undefined);
  } catch {
    /* no Tauri / already gone */
  }
}

/** Resolve or reject one capture, clean its job and close its window. */
function settle(id: string, error?: string, images?: AnalystCaptureImage[]): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  window.clearTimeout(p.timer);
  clearCaptureSpec(id);
  closeWindow(p.label);
  if (error) p.reject(new Error(error));
  else {
    const list = images ?? p.images;
    p.resolve(list.slice().sort((a, b) => p.order.indexOf(a.label) - p.order.indexOf(b.label)));
  }
}

/** Install the event listeners once; the capture window emits to "main". */
function ensureListeners(): Promise<void> {
  if (!isTauri()) {
    return Promise.reject(new Error(translate("The chart renderer is not ready. Reopen the AI assistant and try again.")));
  }
  if (!listeners) {
    listeners = (async () => {
      await listen<AnalystCaptureImageMessage>(CAPTURE_IMAGE_EVENT, (event) => {
        const p = pending.get(event.payload.id);
        const image = event.payload.image;
        if (!p || !image || typeof image.label !== "string" || typeof image.dataUrl !== "string" || !image.dataUrl.startsWith("data:image/")) return;
        // A repeated event (a reload of the same target) replaces, not duplicates.
        const i = p.images.findIndex((x) => x.label === image.label);
        if (i >= 0) p.images[i] = image;
        else p.images.push(image);
      });
      await listen<AnalystCaptureDoneMessage>(CAPTURE_DONE_EVENT, (event) => {
        const p = pending.get(event.payload.id);
        if (!p) return;
        const labels = new Set(p.images.map((image) => image.label));
        if (p.images.length !== p.expected || p.order.some((label) => !labels.has(label))) {
          settle(
            p.id,
            translateWith("The analysis window returned {0} of {1} pictures.", p.images.length, p.expected),
          );
          return;
        }
        settle(p.id, undefined, p.images);
      });
      await listen<AnalystCaptureErrorMessage>(CAPTURE_ERROR_EVENT, (event) => {
        settle(event.payload.id, event.payload.error || translate("The chart could not be pictured."));
      });
    })().catch((error) => {
      listeners = null;
      throw error;
    });
  }
  return listeners;
}

/**
 * Render the request in a fresh hidden Tauri window. A newer request
 * replaces one still running, like starting a new analysis cancels the old
 * one's pictures.
 */
export async function captureInAnalysisWindow(request: AnalystCapturePayload): Promise<AnalystCaptureImage[]> {
  await ensureListeners();
  const id = `${Date.now().toString(36)}-${(++seq).toString(36)}`;
  for (const active of [...pending.values()]) {
    settle(active.id, translate("A chart capture was replaced by a newer analysis."));
  }

  try {
    saveCaptureSpec({ ...request, id, targets: [...request.targets] });
  } catch {
    throw new Error(translate("The chart renderer could not start."));
  }

  const label = `${ANALYSIS_CAPTURE_PREFIX}${id}`;
  const promise = new Promise<AnalystCaptureImage[]>((resolve, reject) => {
    pending.set(id, {
      id,
      label,
      expected: request.targets.length,
      order: request.targets.map((target) => target.label),
      images: [],
      resolve,
      reject,
      timer: window.setTimeout(
        () => settle(id, translate("The chart pictures did not arrive in time.")),
        CAPTURE_TIMEOUT_MS,
      ),
    });
  });

  const win = openAnalysisCaptureWindow(id);
  if (!win) {
    settle(id, translate("The analysis window could not open."));
    return promise;
  }
  win.once("tauri://error", (error) => {
    settle(id, translateWith("The analysis window could not open: {0}", String(error)));
  });
  return promise;
}
