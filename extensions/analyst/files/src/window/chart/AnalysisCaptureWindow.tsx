/*
 * The content of Analyze chart's second, hidden Tauri window.
 *
 * It reads the job the main window left in localStorage, renders the selected
 * chart at 1d / 4h / 5m with its studies, and emits one picture per target to
 * the main window. The window is closed as soon as the main window has them
 * (and closes itself if the main window is gone).
 */
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CAPTURE_DONE_EVENT,
  CAPTURE_ERROR_EVENT,
  CAPTURE_IMAGE_EVENT,
  takeCaptureSpec,
} from "../../data/analyst-capture";
import { translate, translateWith } from "../../i18n/translator";
import type { DrawingStore } from "../drawings/drawing-store";
import type { ChartEdits } from "../shell/chart-edits";
import { CAPTURE_HEIGHT, CAPTURE_WIDTH, encodePicture, labelled } from "./capture-picture";
import { ChartView } from "./ChartView";
import { chartSnapshot } from "./layout-snapshot";

/** The capture window has no edits and no drawings; interactions cannot run in it. */
const noop = () => undefined;
const chartEdits = new Proxy({}, { get: () => noop }) as unknown as ChartEdits;
const drawingStore = new Proxy({}, { get: () => noop }) as unknown as DrawingStore;

const RENDER_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(event: string, payload: unknown): Promise<void> {
  return emitTo("main", event, payload).catch(() => undefined);
}

function closeSoon(): void {
  window.setTimeout(() => {
    try {
      void getCurrentWebviewWindow().close().catch(() => undefined);
    } catch {
      /* already gone */
    }
  }, 3_000);
}

export function AnalysisCaptureWindow(props: { id: string }) {
  const spec = takeCaptureSpec(props.id);
  if (!spec) {
    void send(CAPTURE_ERROR_EVENT, { id: props.id, error: translate("The analysis window did not receive its job.") });
    closeSoon();
    return null;
  }

  // ChartView reads the app theme off the html class (and the chart colours
  // off `theme` below); set it before the chart is created.
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(`theme-${spec.theme}`);

  let root: HTMLDivElement | undefined;
  let timer: number | undefined;
  let busy = false;
  let finished = false;
  const [index, setIndex] = createSignal(0);
  const target = () => spec.targets[index()] ?? null;

  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    clearTimer();
    void send(CAPTURE_ERROR_EVENT, { id: props.id, error: message });
    closeSoon();
  };

  const armTimer = (label: string) => {
    clearTimer();
    timer = window.setTimeout(() => fail(translateWith("Rendering the {0} chart timed out.", label)), RENDER_TIMEOUT_MS);
  };

  /** One target has been painted: picture it, then move to the next interval. */
  const ready = async (hasBars: boolean, interval: string | undefined) => {
    const current = target();
    if (finished || busy || !current || interval !== current.interval) return;
    if (!hasBars) {
      fail(translateWith("No {0} bars are available for {1}.", current.label, spec.symbol));
      return;
    }
    busy = true;
    clearTimer();
    try {
      // Let the studies' layers and the legend values paint before the shot.
      await sleep(250);
      if (finished) return;
      const canvas = root ? await chartSnapshot(root) : null;
      if (!canvas) throw new Error(translateWith("The {0} chart could not be pictured.", current.label));
      const image = {
        label: current.label,
        interval: current.interval,
        dataUrl: encodePicture(labelled(canvas, spec.symbol, current.label, spec.theme)),
      };
      await send(CAPTURE_IMAGE_EVENT, { id: props.id, image });
      const next = index() + 1;
      if (next < spec.targets.length) {
        setIndex(next);
        busy = false;
        armTimer(spec.targets[next].label);
        return;
      }
      finished = true;
      await send(CAPTURE_DONE_EVENT, { id: props.id });
      closeSoon();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  };

  onMount(() => armTimer(spec.targets[0].label));
  onCleanup(clearTimer);

  return (
    <Show when={target()}>
      <div
        class="ot-analysis-capture"
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: "0",
          width: `${CAPTURE_WIDTH}px`,
          height: `${CAPTURE_HEIGHT}px`,
          overflow: "hidden",
          background: "var(--color-bg-primary)",
        }}
      >
        <div ref={root} style={{ width: "100%", height: "100%" }}>
          <ChartView
            symbol={spec.symbol}
            interval={target()!.interval}
            session={spec.pane.session}
            chartType={spec.pane.chartType}
            indicators={spec.pane.indicators}
            indicatorsHidden={spec.indicatorsHidden}
            seriesHidden={!!spec.pane.seriesHidden}
            compare={spec.pane.compare}
            indicatorSettings={spec.pane.indicatorSettings}
            paneOrder={spec.pane.paneOrder}
            seriesPane={spec.pane.seriesPane}
            seriesScale={spec.pane.seriesScale}
            sourceOrder={spec.pane.sourceOrder}
            settings={spec.pane.settings}
            theme={spec.theme}
            timeZone={spec.timeZone}
            timeZoneLabel={spec.timeZoneLabel}
            active={false}
            shown
            capture
            onCaptureReady={(hasBars, interval) => void ready(hasBars, interval)}
            tabId={`analysis-capture-${spec.id}`}
            paneIndex={-1}
            chartEdits={chartEdits}
            drawingStore={drawingStore}
            drawingKey={`analysis-capture-${spec.id}`}
            drawings={[]}
          />
        </div>
      </div>
    </Show>
  );
}
