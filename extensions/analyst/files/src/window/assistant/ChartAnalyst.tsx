/*
 * "Analyze chart": the bundled Pi coding agent reads the user's charts.
 *
 * A fresh analysis renders the selected chart at 1d, 4h and 5m in a
 * short-lived hidden Tauri window (AnalysisCaptureWindow), with the
 * studies the chart shows, and sends those three pictures plus the versioned
 * numeric snapshot. The agent's only
 * tools are the five read-only `panel_*` tools; its final plan is validated in
 * the extension and shown as a card with BP / SL / qty / TP / probability,
 * "Show on chart" and "Fill values".
 *
 * Every completed analysis is kept in the analysis log (1d/4h/5m pictures,
 * plan and answer) so an earlier run can be loaded again.
 *
 * The first analysis is one press ("Start analysis"): the agent asks its own
 * questions of the tools. Later messages are follow-ups about the same run;
 * each rebuilds the snapshot, so the tools never read stale data, and only a
 * fresh analysis attaches the pictures again.
 */
import { For, Show, createSignal, onMount } from "solid-js";
import { commands, type PiStatus } from "../../bindings";
import { AnswerText } from "./AnswerText";
import { exportableCharts, type ChartExportSource } from "../chart/chart-export";
import { showAnalystTradeOnChart } from "../../data/analyst-trade-drawing";
import { chartBars } from "../../data/chart-state-registry";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import {
  analyze,
  clearAnalystKey,
  loadRuntimeStatus,
  newAnalystSession,
  saveAnalystSettings,
  stopAnalysis,
  updatePiRuntime,
  type AnalystPlan,
  type ToolStep,
} from "../../data/analyst";
import { ANALYSIS_TARGETS, captureAnalystCharts, type AnalystCaptureImage } from "../../data/analyst-capture";
import {
  deleteAnalystLog,
  listAnalystLogs,
  migrateLegacyLastAnalysis,
  readAnalystLogImages,
  saveAnalystLog,
  updateAnalystLog,
  type AnalystLogEntry,
} from "../../data/analyst-log";
import { analystStudies, buildAnalystSnapshot, type AnalystPortfolio, type AnalystSnapshot, type AnalystStudyInput, type AnalystTicket } from "../../data/analyst-context";
import { createChartStudyRunner } from "../../data/analyst-study-run";
import { translate, translateWith } from "../../i18n/translator";

const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A price's own precision: two decimals for thousands, more for a small coin. */
const priceNum = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return num(v, digits);
};

/** A log row's stamp, dd/mm/yyyy hh:mm. */
function logStamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "<symbol>, <interval>" → its parts. */
function titleParts(title: string): { symbol: string; interval: string } {
  const at = title.lastIndexOf(", ");
  return at < 0 ? { symbol: title, interval: "" } : { symbol: title.slice(0, at), interval: title.slice(at + 2) };
}

/** The tool names, as a reader knows them. */
function toolLabel(name: string): string {
  switch (name) {
    case "panel_market_context":
      return translate("Market context");
    case "panel_indicators":
      return translate("Indicators");
    case "panel_portfolio":
      return translate("Portfolio");
    case "panel_order_ticket":
      return translate("Order ticket");
    case "panel_submit_trade_plan":
      return translate("Trade plan");
    default:
      return name;
  }
}

/** "opencode.ai/inference/go/openai/v1" → "opencode.ai": what fits beside the model. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The account context the agent may read (only when the user enabled it). */
function portfolioOf(symbol: string): AnalystPortfolio | null {
  const state = pluginBroker.status()?.state;
  if (!state) return null;
  const base = symbol.split(":")[1]?.split("/")[0] ?? "";
  const account = state.account;
  const positions = (state.positions ?? []).filter((p) => p.ticker === symbol || (p.ticker ? p.ticker.startsWith(`${base}/`) || p.ticker === base : false));
  const orders = (state.orders ?? []).filter((o) => o.ticker === symbol || (o.ticker ? o.ticker.startsWith(`${base}/`) || o.ticker === base : false));
  return {
    enabled: true,
    position: positions.length
      ? {
          side: positions[0].side,
          qty: positions[0].qty,
          avgPrice: positions[0].avgPrice,
          unrealizedPnl: positions[0].unrealizedPnl ?? null,
          takeProfit: positions[0].takeProfit ?? null,
          stopLoss: positions[0].stopLoss ?? null,
        }
      : null,
    openOrders: orders.slice(0, 20).map((o) => ({
      side: o.side,
      type: o.type,
      qty: o.qty,
      limitPrice: o.limitPrice ?? null,
      stopPrice: o.stopPrice ?? null,
      takeProfit: o.takeProfit ?? null,
      stopLoss: o.stopLoss ?? null,
    })),
    balance: account
      ? { currency: account.currency ?? null, balance: account.balance ?? null, equity: account.equity ?? null, unrealizedPnl: account.unrealizedPnl ?? null, isDemo: account.isDemo === true }
      : null,
  };
}

/** The order ticket's unsent values for this symbol (read-only). */
function ticketOf(symbol: string): AnalystTicket | null {
  const draft = tradingUi.draft();
  if (!draft || draft.symbol !== symbol) return null;
  const risk = draft.risk != null && draft.risk !== "" ? Number(draft.risk) : null;
  const price = (value: string) => {
    const parsed = Number(value);
    return value && Number.isFinite(parsed) ? parsed : null;
  };
  return {
    side: draft.side,
    qty: price(draft.qty),
    orderType: draft.orderType,
    risk: risk != null && Number.isFinite(risk) ? risk : null,
    limitPrice: price(draft.limitPrice),
    takeProfit: draft.tpOn ? price(draft.takeProfit) : null,
    stopLoss: draft.slOn ? price(draft.stopLoss) : null,
    editing: draft.editing,
  };
}

/** The selected chart's visible studies as the analysis prompt names them ("VWAP, RSI (14 close)"). */
function studyList(studies: readonly AnalystStudyInput[]): string {
  return studies.map((study) => (study.inputs ? `${study.title} (${study.inputs})` : study.title)).join(", ") || "no indicators";
}

/** A one-line data sheet for the caption under the picture. */
function sheetLine(snapshot: AnalystSnapshot): string {
  const parts = [snapshot.instrument.symbol, snapshot.instrument.timeframe];
  const five = snapshot.indicators.perTimeframe["5m"];
  const close = snapshot.instrument.price ?? five?.close ?? null;
  if (close != null) parts.push(priceNum(close));
  const studies = snapshot.indicators.summary.studies;
  if (studies.length) parts.push(studies.join(", "));
  return parts.join(" · ");
}

export function ChartAnalyst(props: { ticker: string }) {
  const [runtime, setRuntime] = createSignal<PiStatus | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [base, setBase] = createSignal("");
  const [model, setModel] = createSignal("");
  const [key, setKey] = createSignal("");
  const [hasKey, setHasKey] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [shots, setShots] = createSignal<AnalystCaptureImage[]>([]);
  const [sheet, setSheet] = createSignal("");
  const [question, setQuestion] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [plan, setPlan] = createSignal<AnalystPlan | null>(null);
  const [tools, setTools] = createSignal<ToolStep[]>([]);
  const [history, setHistory] = createSignal<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const [error, setError] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [shownOnChart, setShownOnChart] = createSignal(false);
  const [logs, setLogs] = createSignal<AnalystLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = createSignal(false);
  const [logBusy, setLogBusy] = createSignal(false);
  const [updating, setUpdating] = createSignal(false);
  const [updateStep, setUpdateStep] = createSignal("");
  const [currentLogId, setCurrentLogId] = createSignal<string | null>(null);
  const [loadedFromLog, setLoadedFromLog] = createSignal(false);
  /** One analysis at a time: a stopped or replaced run must not write state. */
  let runSeq = 0;

  const configured = () => runtime()?.configured ?? (!!base().trim() && !!model().trim() && (hasKey() || base().trim().startsWith("http://")));
  const hasResult = () => !!answer().trim() || history().length > 0 || !!plan();
  const provider = () => `${model() || translate("No model")} · ${hostOf(base()) || translate("No endpoint")}`;
  /** The runtime itself could not be found: a staged-runtime problem, not a provider one. */
  const runtimeError = () => {
    const status = runtime();
    return status && !status.runtimeRoot ? (status.error ?? translate("The AI runtime is not staged.")) : null;
  };
  const runtimeLabel = () => {
    const status = runtime();
    if (!status) return translate("AI runtime unavailable");
    return status.piVersion ? translateWith("Pi {0}", status.piVersion) : translate("AI runtime");
  };
  /** The full symbol of the last picture ("BINANCE:BTC/USDT"), for ticker links. */
  const instrument = () => sheet().split(" · ")[0]?.split(", ")[0] || props.ticker;

  const refresh = async () => {
    const status = await loadRuntimeStatus();
    setRuntime(status);
    if (status) {
      setBase(status.baseUrl);
      setModel(status.model);
      setHasKey(status.hasKey);
    }
    setLoaded(true);
    return status;
  };

  /** Install a newer Pi in place; the button stays disabled while npm runs. */
  const updateRuntime = async () => {
    if (updating() || busy()) return;
    setUpdating(true);
    setUpdateStep(translate("Checking for a Pi update…"));
    setError("");
    try {
      const r = await updatePiRuntime(setUpdateStep);
      if (r.status === "error") {
        setUpdateStep("");
        setError(r.error);
        return;
      }
      setRuntime(r.data);
      setBase(r.data.baseUrl);
      setModel(r.data.model);
      setHasKey(r.data.hasKey);
    } finally {
      setUpdating(false);
    }
  };

  /** Put a stored analysis back on screen (pictures, card, answer). */
  async function loadLog(entry: AnalystLogEntry): Promise<void> {
    if (busy() || logBusy()) return;
    runSeq += 1;
    setLogBusy(true);
    setError("");
    try {
      const images = await readAnalystLogImages(entry);
      setShots(images);
      setSheet(entry.symbol ? `${entry.symbol}${entry.interval ? ` · ${entry.interval}` : ""}` : "");
      setPlan(entry.plan);
      setAnswer(entry.text);
      setHistory(entry.text ? [{ q: translate("Analyze chart"), a: entry.text }] : []);
      setTools([]);
      setQuestion("");
      setCurrentLogId(entry.id);
      setLoadedFromLog(true);
      setShownOnChart(false);
      // The old conversation is not the running Pi session: a later analysis starts fresh.
      newAnalystSession();
    } finally {
      setLogBusy(false);
    }
  }

  onMount(() => {
    void refresh();
    const entries = migrateLegacyLastAnalysis();
    setLogs(entries);
    if (entries[0]) void loadLog(entries[0]);
  });

  const save = async () => {
    setSaving(true);
    setError("");
    const r = await saveAnalystSettings(base(), model(), key() || undefined);
    setSaving(false);
    if (r.status === "error") return setError(r.error);
    setRuntime(r.data);
    setBase(r.data.baseUrl);
    setModel(r.data.model);
    setHasKey(r.data.hasKey);
    setKey("");
    setSetupOpen(false);
  };

  const forgetKey = async () => {
    const r = await clearAnalystKey();
    if (r.status === "error") setError(r.error);
    else {
      setRuntime(r.data);
      setHasKey(r.data.hasKey);
      setSetupOpen(true);
    }
  };

  /**
   * `fresh` runs the standard analysis: the 1d / 4h / 5m pictures are attached
   * and the agent decides what to ask. Otherwise the message is a follow-up
   * about the same conversation; the snapshot is rebuilt without the pictures.
   */
  const run = async (fresh: boolean) => {
    if (busy()) return;
    const runId = ++runSeq;
    if (!configured()) {
      setSetupOpen(true);
      setError(translate("Set the analyst's provider first."));
      return;
    }
    const followUp = question().trim();
    if (!fresh && !followUp) return;
    setError("");
    setAnswer("");
    if (fresh) setPlan(null);
    setTools([]);
    setCopied(false);
    setStopped(false);
    setShownOnChart(false);
    setLoadedFromLog(false);
    setBusy(true);
    let captured: AnalystCaptureImage[] = [];
    try {
      const source = activeSource();
      const { symbol, interval } = titleParts(source.title());
      const exchange = symbol.includes(":") ? symbol.split(":")[0] : undefined;
      // The studies the selected chart shows drive everything: the message names them, the
      // snapshot recomputes them for 1d/4h/5m.
      const studies = analystStudies(source.studies());
      if (fresh) {
        // Headless render: the selected chart's studies at 1d, 4h and 5m.
        setShots([]);
        captured = await captureAnalystCharts({ symbol, targets: ANALYSIS_TARGETS });
        if (runId !== runSeq || stopped()) return;
        if (!captured.length) throw new Error(translate("The charts could not be pictured."));
        setShots(captured);
      }
      const chart = chartBars(symbol, interval);
      const snapshot = await buildAnalystSnapshot({
        symbol,
        ...(exchange ? { exchange } : {}),
        timeframe: interval,
        session: source.session(),
        price: snapshotPrice(source),
        studies,
        runStudy: createChartStudyRunner(symbol),
        portfolio: portfolioOf(symbol),
        ticket: ticketOf(symbol),
        ...(chart && chart.length ? { chartBars: { interval, bars: chart } } : {}),
      });
      if (runId !== runSeq || stopped()) return;
      setSheet(sheetLine(snapshot));
      const prompt = fresh
        ? `Analyze ${symbol} on its ${interval} chart. The selected chart shows: ${studyList(studies)}. The three attached images are the same instrument's 1d, 4h and 5m charts, each with those indicators.`
        : followUp;
      const outcome = await analyze(snapshot, fresh ? captured.map((image) => image.dataUrl) : [], prompt, {
        onText: (text) => { if (runId === runSeq) setAnswer(text); },
        onTool: (steps) => { if (runId === runSeq) setTools(steps); },
        onPlan: (next) => { if (runId === runSeq) setPlan(next); },
      });
      if (runId !== runSeq || stopped()) return;
      if (outcome.error && !outcome.aborted) setError(outcome.error);
      if (!outcome.text.trim() && !plan() && !outcome.error && !outcome.aborted) {
        setError(translate("The agent did not return a plan. Try again."));
      }
      if (outcome.text.trim()) {
        setHistory([...history(), { q: prompt, a: outcome.text }]);
      } else if (fresh) {
        setHistory([...history(), { q: prompt, a: "" }]);
      }
      const finalPlan = plan() ?? outcome.plan;
      if (!outcome.aborted && (outcome.text.trim() || finalPlan)) {
        // Keep the run: a fresh analysis opens a new log, a follow-up rewrites
        // the current one (its plan can be revised).
        if (fresh || !currentLogId() || loadedFromLog()) {
          const entry = await saveAnalystLog({ symbol, interval, plan: finalPlan, text: outcome.text, images: fresh ? captured : undefined, model: model() });
          if (runId !== runSeq) return;
          setCurrentLogId(entry.id);
          setLoadedFromLog(false);
        } else {
          await updateAnalystLog(currentLogId()!, { text: outcome.text, plan: finalPlan, model: model() });
          if (runId !== runSeq) return;
        }
        setLogs(listAnalystLogs());
      }
      setQuestion("");
      void refresh();
    } catch (e) {
      if (runId === runSeq) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (runId === runSeq) setBusy(false);
    }
  };

  /** The focused chart: its symbol, interval and visible studies drive the run. */
  function activeSource(): ChartExportSource {
    const charts = exportableCharts();
    const source = (charts.find((c) => c.source.active()) ?? charts[0])?.source;
    if (!source) throw new Error(translate("No chart is shown."));
    return source;
  }

  /** The last close of the chart as sent: the extension validates levels against it. */
  function snapshotPrice(source: ChartExportSource): number | null {
    try {
      const { times, columns } = source.data();
      const close = columns.find((c) => c.title.toLowerCase() === "close") ?? columns[0];
      const value = times.length && close ? close.values.get(times[times.length - 1]) : undefined;
      return value != null && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  const stop = () => {
    runSeq += 1;
    setStopped(true);
    stopAnalysis();
    setBusy(false);
  };

  /** The plan's levels into the order ticket (never submits). */
  const fillTicket = () => {
    const p = plan();
    if (!p) return;
    const symbol = p.symbol ?? instrument();
    tradingUi.openOrderTicket({ symbol, side: p.action === "long" ? "buy" : "sell" });
    tradingUi.patchDraft({
      limitPrice: String(p.entry),
      orderType: "limit",
      tpOn: true,
      takeProfit: String(p.takeProfit),
      slOn: true,
      stopLoss: String(p.stopLoss),
      ...(p.qty != null && p.qty > 0 ? { qty: String(p.qty) } : {}),
    });
  };

  /** Project the plan with the chart's long / short position drawing tool (no order, no ticket fill). */
  const showOnChart = () => {
    const p = plan();
    if (!p) return;
    const symbol = p.symbol ?? instrument();
    let shown = false;
    try {
      shown = showAnalystTradeOnChart({
        symbol,
        action: p.action,
        entry: p.entry,
        takeProfit: p.takeProfit,
        stopLoss: p.stopLoss,
        qty: p.qty,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!shown) {
      setError(translateWith("Open {0} on the chart to show this trade.", symbol));
      return;
    }
    setShownOnChart(true);
    window.setTimeout(() => setShownOnChart(false), 2000);
  };

  const copyLevels = () => {
    const p = plan();
    if (!p) return;
    const symbol = p.symbol ?? instrument();
    const line = `${p.action.toUpperCase()} ${symbol} entry=${p.entry} tp=${p.takeProfit} sl=${p.stopLoss} probability=${p.probability}%`;
    void navigator.clipboard.writeText(line).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  /** Empty the panel without touching the stored log. */
  const clearViews = () => {
    runSeq += 1;
    setAnswer("");
    setHistory([]);
    setShots([]);
    setSheet("");
    setPlan(null);
    setTools([]);
    setQuestion("");
    setError("");
    setCurrentLogId(null);
    setLoadedFromLog(false);
    setShownOnChart(false);
  };

  const clear = () => {
    stopAnalysis();
    setBusy(false);
    clearViews();
    newAnalystSession();
  };

  /** Delete one stored analysis (its pictures go with it). */
  const removeLog = async (entry: AnalystLogEntry) => {
    if (logBusy()) return;
    setLogBusy(true);
    try {
      const next = await deleteAnalystLog(entry.id);
      setLogs(next);
      if (currentLogId() === entry.id) {
        clearViews();
        newAnalystSession();
      }
    } finally {
      setLogBusy(false);
    }
  };

  return (
    <div class="asst-analyst" aria-busy={busy()}>
      <div class="asst-analyst-head">
        <div class="asst-analyst-heading">
          <div class="asst-analyst-title">{translate("Chart analyst")}</div>
          <div class="asst-analyst-meta">
            <span class="asst-runtime" classList={{ "is-busy": busy(), "is-error": !!runtimeError() }}>
              <span class="asst-runtime-dot" aria-hidden="true" />
              <span data-no-translate>{runtimeLabel()}</span>
            </span>
            <span class="asst-analyst-sep" aria-hidden="true">·</span>
            <span data-no-translate>{provider()}</span>
          </div>
        </div>
        <div class="asst-analyst-actions">
          <button
            type="button"
            class="asst-link"
            disabled={updating() || busy()}
            onClick={() => void updateRuntime()}
            title={translate("Install the latest Pi coding agent")}
          >
            {updating() ? translate("Updating Pi…") : translate("Update Pi")}
          </button>
          <button type="button" class="asst-link" onClick={() => setLogsOpen(!logsOpen())}>
            {logsOpen() ? translate("Hide log") : translateWith("Log ({0})", logs().length)}
          </button>
          <button type="button" class="asst-link" onClick={() => setSetupOpen(!setupOpen())}>
            {setupOpen() ? translate("Close") : translate("Settings")}
          </button>
        </div>
      </div>

      <Show when={updateStep()}>
        <div class="asst-update" role="status" aria-live="polite">
          <span class="asst-runtime-dot" classList={{ "is-busy": updating() }} aria-hidden="true" />
          <span data-no-translate>{updateStep()}</span>
        </div>
      </Show>

      <Show when={logsOpen()}>
        <section class="asst-log" aria-label={translate("Analysis log")}>
          <header class="asst-log-head">
            <span>{translate("Analysis log")}</span>
            <span class="asst-log-count">{translateWith("{0} saved", logs().length)}</span>
          </header>
          <Show when={!logs().length}>
            <p class="asst-analyst-note">{translate("No saved analyses yet.")}</p>
          </Show>
          <ul class="asst-log-list">
            <For each={logs()}>
              {(entry) => (
                <li class="asst-log-row" classList={{ "is-current": currentLogId() === entry.id }}>
                  <button
                    type="button"
                    class="asst-log-open"
                    disabled={busy() || logBusy()}
                    onClick={() => void loadLog(entry)}
                    title={translate("Load this analysis")}
                  >
                    <span class="asst-log-side" classList={{ "is-short": entry.plan?.action === "short" }}>
                      {entry.plan?.action === "short" ? translate("Short") : entry.plan ? translate("Long") : translate("Analysis")}
                    </span>
                    <span class="asst-log-symbol" data-no-translate>
                      {entry.symbol}
                      {entry.interval ? `, ${entry.interval}` : ""}
                    </span>
                    <span class="asst-log-stamp" data-no-translate>{logStamp(entry.at)}</span>
                    <Show when={entry.plan}>
                      <span class="asst-log-prob" data-no-translate>{entry.plan?.probability}%</span>
                    </Show>
                  </button>
                  <button
                    type="button"
                    class="asst-log-del"
                    aria-label={translate("Delete this analysis")}
                    title={translate("Delete this analysis")}
                    disabled={logBusy()}
                    onClick={() => void removeLog(entry)}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <Show when={runtimeError()}>
        {(message) => (
          <div class="asst-callout is-error" role="alert">
            <p>{message()}</p>
            <div class="asst-analyst-actions">
              <button type="button" class="asst-link" onClick={() => void refresh()}>
                {translate("Check again")}
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={setupOpen()}>
        <div class="asst-analyst-form">
          <div class="asst-form-head">
            <span>{translate("Provider")}</span>
            <span class="asst-runtime-note">
              {runtime()?.piVersion ? translateWith("Pi {0}", runtime()!.piVersion ?? "") : translate("AI runtime")}
              <Show when={runtime()?.target}>
                {(target) => <span data-no-translate> · {target()}</span>}
              </Show>
            </span>
          </div>
          <label class="asst-analyst-field">
            <span>{translate("API base URL")}</span>
            <input
              class="asst-analyst-input"
              classList={{ "is-invalid": !!base() && !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\]))/.test(base().trim()) }}
              placeholder="https://api.openai.com/v1"
              value={base()}
              spellcheck={false}
              onInput={(e) => setBase(e.currentTarget.value)}
            />
          </label>
          <label class="asst-analyst-field">
            <span>{translate("Model")}</span>
            <input class="asst-analyst-input" data-no-translate placeholder="gpt-4o-mini" value={model()} spellcheck={false} onInput={(e) => setModel(e.currentTarget.value)} />
          </label>
          <label class="asst-analyst-field">
            <span>{translate("API key")}</span>
            <input
              class="asst-analyst-input"
              type="password"
              autocomplete="off"
              placeholder={hasKey() ? translate("Stored — type to replace") : ""}
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
          </label>
          <p class="asst-analyst-note">
            {translate("The Pi agent appends /chat/completions to this base URL. The key is kept in your operating system's credential store and never reaches the window. HTTPS is required, or HTTP on 127.0.0.1 for a local model.")}
          </p>
          <div class="asst-analyst-actions">
            <button type="button" class="asst-primary" disabled={saving()} onClick={() => void save()}>
              {saving() ? translate("Saving...") : translate("Save")}
            </button>
            <Show when={hasKey()}>
              <button type="button" class="asst-link" onClick={() => void forgetKey()}>
                {translate("Forget the key")}
              </button>
            </Show>
            <button type="button" class="asst-link" onClick={() => setSetupOpen(false)}>
              {translate("Close")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={loaded() && !configured() && !setupOpen()}>
        <div class="asst-callout">
          <p>{translate("Add a vision provider to analyze your charts.")}</p>
          <button type="button" class="asst-link" onClick={() => setSetupOpen(true)}>
            {translate("Set up")}
          </button>
        </div>
      </Show>

      <Show when={shots().length}>
        <figure class="asst-analyst-figure">
          <div class="asst-shot-grid">
            <For each={shots()}>
              {(image) => (
                <button
                  type="button"
                  class="asst-shot"
                  title={translate("Open image")}
                  onClick={() => {
                    const b64 = image.dataUrl.split(",")[1];
                    if (b64) void commands.openSnapshot(b64);
                  }}
                >
                  <img class="asst-analyst-image" src={image.dataUrl} alt={`${sheet()} ${image.label}`} />
                  <span class="asst-shot-label" data-no-translate>{image.label.toUpperCase()}</span>
                </button>
              )}
            </For>
          </div>
          <figcaption class="asst-analyst-note">
            <span data-no-translate>{sheet()}</span>
          </figcaption>
        </figure>
      </Show>

      <Show when={!hasResult()}>
        <p class="asst-analyst-note">
          {translate("The agent reads 1d, 4h and 5m pictures of this chart, each with the indicators it shows, then returns a 5m trade plan. It cannot trade.")}
        </p>
      </Show>

      <div class="asst-analyst-actions asst-analyst-start">
        <button type="button" class="asst-primary" disabled={busy() || updating() || !configured() || !!runtimeError()} onClick={() => void run(true)}>
          {busy()
            ? translate("Analyzing...")
            : hasResult()
              ? translate("Analyze again")
              : translate("Start analysis")}
        </button>
        <Show when={busy()}>
          <button type="button" class="asst-link" onClick={stop}>
            {translate("Stop")}
          </button>
        </Show>
        <Show when={hasResult() && !busy()}>
          <button type="button" class="asst-link" onClick={clear}>
            {translate("New analysis")}
          </button>
        </Show>
      </div>

      <Show when={hasResult() && loadedFromLog()}>
        <p class="asst-analyst-note">
          {translate("Loaded from the analysis log. Run a new analysis to ask follow-up questions.")}
        </p>
      </Show>

      <Show when={error()}>
        <p class="asst-error" role="alert">{error()}</p>
      </Show>

      <Show when={busy() && !answer()}>
        <div class="asst-thinking" aria-hidden="true"><span /><span /><span /></div>
      </Show>

      <Show when={tools().length}>
        <ul class="asst-steps" aria-label={translate("Reading the charts")}>
          <For each={tools()}>
            {(step) => (
              <li class="asst-step" classList={{ "is-failed": step.state === "failed" }}>
                <span class="asst-step-dot" aria-hidden="true" />
                {toolLabel(step.name)}
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={plan()}>
        {(p) => (
          <section class="asst-plan" classList={{ "is-short": p().action === "short" }} aria-label={translate("Trade plan")} aria-live="polite">
            <header class="asst-plan-head">
              <span class="asst-plan-side">{p().action === "long" ? translate("Long") : translate("Short")}</span>
              <span class="asst-plan-prob" title={translate("Probability")}>
                <b>{p().probability}%</b>
                <span>{translate("Probability")}</span>
              </span>
            </header>
            <dl class="asst-plan-rows">
              <div>
                <dt>{translate("Entry (BP)")}</dt>
                <dd data-no-translate>{priceNum(p().entry)}</dd>
              </div>
              <div>
                <dt>{translate("Stop loss (SL)")}</dt>
                <dd class="is-risk" data-no-translate>{priceNum(p().stopLoss)}</dd>
              </div>
              <div>
                <dt>{translate("Quantity")}</dt>
                <dd data-no-translate>{p().qty != null ? num(p().qty, 6) : "—"}</dd>
              </div>
              <div>
                <dt>{translate("Take profit (TP)")}</dt>
                <dd class="is-target" data-no-translate>{priceNum(p().takeProfit)}</dd>
              </div>
              <div>
                <dt>{translate("Risk/reward")}</dt>
                <dd data-no-translate>{num(p().riskReward, 2)}</dd>
              </div>
            </dl>
            <Show when={p().rationale}>
              <p class="asst-plan-note">{p().rationale}</p>
            </Show>
            <div class="asst-plan-actions">
              <button type="button" class="asst-primary" onClick={fillTicket}>
                {translate("Fill values")}
              </button>
              <button type="button" class="asst-link" onClick={showOnChart}>
                {shownOnChart() ? translate("Shown on chart") : translate("Show on chart")}
              </button>
              <button type="button" class="asst-link" onClick={copyLevels}>
                {copied() ? translate("Copied") : translate("Copy levels")}
              </button>
              <span class="asst-plan-basis" data-no-translate>{p().basisTimeframe}</span>
            </div>
          </section>
        )}
      </Show>

      <Show when={answer()}>
        <div class="asst-answer" aria-live="polite">
          <AnswerText text={answer()} known={new Map([[props.ticker.toUpperCase(), instrument()]])} />
        </div>
      </Show>

      <Show when={hasResult() && !loadedFromLog()}>
        <div class="asst-analyst-ask">
          <textarea
            class="asst-input"
            rows={2}
            value={question()}
            placeholder={translate("Ask about this analysis…")}
            onInput={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run(false);
              }
            }}
          />
          <div class="asst-analyst-actions">
            <button type="button" class="asst-primary" disabled={busy() || updating() || !question().trim() || !!runtimeError()} onClick={() => void run(false)}>
              {translate("Send")}
            </button>
            <Show when={busy()}>
              <button type="button" class="asst-link" onClick={stop}>
                {translate("Stop")}
              </button>
            </Show>
            <button type="button" class="asst-link" onClick={clear}>
              {translate("New analysis")}
            </button>
          </div>
        </div>
      </Show>

      <p class="asst-note">
        {translate("Read-only analysis. The analyst cannot trade, and this is not financial advice.")}
      </p>
    </div>
  );
}
