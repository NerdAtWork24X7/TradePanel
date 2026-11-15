/* @refresh reload */
import "./styles.css";
import { hydrateKv } from "./data/kv";
import { ANALYSIS_CAPTURE_VIEW } from "./data/analyst-capture";
import { installOverflowTooltip } from "./components/overflow-tooltip";
import { installBrowserMenuBlock } from "./components/browser-menu";

// A tooltip on menu labels only when they are cut.
installOverflowTooltip();
// No web-view menu (Back, Reload, Save as…) on a right-click.
installBrowserMenuBlock();

// Hydrate the persistence layer BEFORE App (and its module graph) loads: many
// modules seed signals/stores from kv synchronously at import time, so the
// in-memory mirror must be populated first. App is dynamically imported so its
// dependency graph isn't evaluated until hydration resolves. hydrateKv always
// resolves (it falls back to localStorage on failure), so .finally is enough.
void hydrateKv().finally(async () => {
  // Restart: main may take over a saved window's tabs (window session).
  const { adoptSavedWindowTabs } = await import("./window/shell/window-bridge");
  await adoptSavedWindowTabs();
  // The interface language, before anything is drawn.
  const { startTranslation } = await import("./i18n/language");
  await startTranslation();
  const params = new URLSearchParams(location.search);
  // Analyze chart's short-lived hidden renderer: a chart only, no shell.
  if (params.get("view") === ANALYSIS_CAPTURE_VIEW) {
    const id = params.get("id") ?? "";
    // The chart studies must exist before the chart is created and pictured.
    const { loadIndicatorLibrary } = await import("./window/chart/indicators/registry");
    // A failed library chunk must not leave the capture window on its splash.
    await loadIndicatorLibrary().catch(() => undefined);
    const { render } = await import("solid-js/web");
    const { AnalysisCaptureWindow } = await import("./window/chart/AnalysisCaptureWindow");
    const root = document.getElementById("root") as HTMLElement;
    render(() => <AnalysisCaptureWindow id={id} />, root);
    hideSplash();
    return;
  }
  // Update state for the title bar, main menu and Settings > About.
  const { initAppUpdate } = await import("./data/app-update");
  initAppUpdate();
  // The run's app zoom (a window opened after a change takes it).
  const { initAppZoom } = await import("./data/app-zoom");
  initAppZoom();
  const { render } = await import("solid-js/web");
  // The screener's own window (placement "Separate window") holds the screener only.
  if (params.get("view") === "screener") {
    const { ScreenerWindow } = await import("./window/screener/ScreenerWindow");
    render(() => <ScreenerWindow />, document.getElementById("root") as HTMLElement);
    hideSplash();
    return;
  }
  const { default: App } = await import("./App");
  render(() => <App />, document.getElementById("root") as HTMLElement);
  hideSplash();
  // The indicator library is not part of the first download: it loads now,
  // after the first render (a chart showing one of its studies asks for it
  // already).
  const { loadIndicatorLibrary } = await import("./window/chart/indicators/registry");
  void loadIndicatorLibrary();
  // Anonymous usage statistics (reads kv, so after hydration).
  const { initAnalytics } = await import("./data/analytics");
  initAnalytics();
});

/** Minimum time the startup splash stays up, from page start, so a fast start
 *  does not flash the loading text for a frame. The App renders underneath. */
const SPLASH_MIN_MS = 300;

/** Fade out the startup splash (index.html) once the App has rendered and the
 *  minimum time has passed. */
function hideSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const fade = () => {
    splash.classList.add("is-hidden");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  };
  window.setTimeout(fade, Math.max(0, SPLASH_MIN_MS - performance.now()));
}
