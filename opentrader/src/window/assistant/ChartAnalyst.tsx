/*
 * "Analyze chart": the bundled Pi coding agent reads the user's charts.
 *
 * The run is the reference `ai/runtime` design: the shown layout is rendered
 * by layoutSnapshot (the same render as Take a snapshot), the focused chart's
 * symbol, interval, studies, position and ticket travel as a versioned
 * snapshot, and the answer streams in below the picture. The agent's only
 * tools are the five read-only `panel_*` tools; its final plan is validated in
 * the extension and rendered as a card the user can copy into the ticket.
 *
 * The first analysis is one press ("Start analysis"): the agent asks its own
 * questions of the tools. Later messages are follow-ups about the same run;
 * each rebuilds the snapshot, so the tools never read stale data, and only a
 * fresh analysis attaches the picture again.
 */
import { For, Show, createSignal, onMount } from "solid-js";
import { commands, type PiStatus } from "../../bindings";
import { AnswerText } from "./AnswerText";
import { exportableCharts, type ChartExportSource } from "../chart/chart-export";
import { layoutSnapshot, snapshotTheme } from "../chart/layout-snapshot";
import { chartBars, indicatorLegendFor } from "../../data/chart-state-registry";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import {
  analyze,
  clearAnalystKey,
  loadRuntimeStatus,
  newAnalystSession,
  saveAnalystSettings,
  stopAnalysis,
  type AnalystPlan,
  type ToolStep,
} from "../../data/analyst";
import { buildAnalystSnapshot, type AnalystPortfolio, type AnalystSnapshot, type AnalystStudy, type AnalystTicket } from "../../data/analyst-context";
import { translate, translateWith } from "../../i18n/translator";
import * as kv from "../../data/kv";

const LAST_KEY = "ot:analyst:last";

type Last = { symbol: string; interval: string; text: string; at: number };

const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A price's own precision: two decimals for thousands, more for a small coin. */
const priceNum = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 8;
  return num(v, digits);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** The active chart, its grid, and the picture of the layout. */
async function capture(): Promise<{ image: string; source: ChartExportSource }> {
  const charts = exportableCharts();
  const source = (charts.find((c) => c.source.active()) ?? charts[0])?.source;
  if (!source) throw new Error(translate("No chart is shown."));
  const grid = source.host()?.closest<HTMLElement>(".chart-grid");
  if (!grid) throw new Error(translate("The chart is not laid out yet."));
  // Studies just added or changed compute on the next frames.
  await sleep(250);
  const theme = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
  const canvas = await layoutSnapshot(grid, snapshotTheme(theme), source.timeZone());
  if (!canvas) throw new Error(translate("The chart could not be pictured."));
  return { image: analystImage(canvas), source };
}

/** A PNG when it is small enough, else a scaled JPEG: a vision request pays for pixels. */
function analystImage(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL("image/png");
  if (png.length <= 3_500_000) return png;
  const scale = Math.min(1, 1600 / canvas.width);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  out.getContext("2d")?.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.86);
}

/** The focused chart's visible studies, as the extension reports them. */
function studiesOf(symbol: string): AnalystStudy[] {
  return indicatorLegendFor(symbol)
    .filter((row) => !row.hidden && !row.offInterval && !row.compare)
    .slice(0, 24)
    .map((row) => ({
      title: row.title,
      ...(row.inputs ? { inputs: row.inputs } : {}),
      plots: row.plots
        .filter((plot) => plot.value != null && Number.isFinite(plot.value))
        .map((plot) => ({ plot: plot.index, value: Number(plot.value) })),
    }));
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

/** A one-line data sheet for the caption under the picture. */
function sheetLine(snapshot: AnalystSnapshot): string {
  const parts = [snapshot.instrument.symbol, snapshot.instrument.timeframe];
  const five = snapshot.indicators.perTimeframe["5m"];
  const close = snapshot.instrument.price ?? five?.close ?? null;
  if (close != null) parts.push(priceNum(close));
  const rsi = five?.rsi14;
  if (rsi != null) parts.push(`RSI ${num(rsi, 1)}`);
  parts.push(snapshot.indicators.summary.alignment);
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
  const [shot, setShot] = createSignal<string | null>(null);
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

  const configured = () => runtime()?.configured ?? (!!base().trim() && !!model().trim() && (hasKey() || base().trim().startsWith("http://")));
  const hasResult = () => !!answer().trim() || history().length > 0;
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
  const instrument = () => sheet().split(" · ")[0] || props.ticker;

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

  onMount(() => {
    void refresh();
    const saved = kv.getItem(LAST_KEY);
    if (!saved) return;
    try {
      const last = JSON.parse(saved) as Last;
      if (last.symbol && last.text) {
        setAnswer(last.text);
        setHistory([{ q: translate("Analyze chart"), a: last.text }]);
      }
    } catch {
      /* an old or broken entry: start clean */
    }
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
   * `fresh` runs the standard analysis: the picture is attached and the agent
   * decides what to ask. Otherwise the message is a follow-up about the same
   * conversation; the snapshot is rebuilt without the picture.
   */
  const run = async (fresh: boolean) => {
    if (busy()) return;
    if (!configured()) {
      setSetupOpen(true);
      setError(translate("Set the analyst's provider first."));
      return;
    }
    const followUp = question().trim();
    if (!fresh && !followUp) return;
    setError("");
    setAnswer("");
    setPlan(null);
    setTools([]);
    setCopied(false);
    setStopped(false);
    setBusy(true);
    let source: ChartExportSource | null = null;
    try {
      const picture = await capture();
      source = picture.source;
      const { symbol, interval } = titleParts(source.title());
      const exchange = symbol.includes(":") ? symbol.split(":")[0] : undefined;
      const chart = chartBars(symbol, interval);
      const snapshot = await buildAnalystSnapshot({
        symbol,
        ...(exchange ? { exchange } : {}),
        timeframe: interval,
        price: snapshotPrice(source),
        studies: studiesOf(symbol),
        portfolio: portfolioOf(symbol),
        ticket: ticketOf(symbol),
        ...(chart && chart.length ? { chartBars: { interval, bars: chart } } : {}),
      });
      setShot(picture.image);
      setSheet(sheetLine(snapshot));
      const prompt = fresh ? `Analyze ${symbol} on the ${interval} chart.` : followUp;
      const outcome = await analyze(snapshot, fresh ? [picture.image] : [], prompt, {
        onText: setAnswer,
        onTool: setTools,
        onPlan: setPlan,
      });
      if (stopped()) return;
      if (outcome.error && !outcome.aborted) setError(outcome.error);
      if (!outcome.text.trim() && !plan() && !outcome.error && !outcome.aborted) {
        setError(translate("The agent did not return a plan. Try again."));
      }
      if (outcome.text.trim()) {
        setHistory([...history(), { q: prompt, a: outcome.text }]);
        if (fresh) {
          const parts = titleParts(source.title());
          kv.setItem(LAST_KEY, JSON.stringify({ symbol: parts.symbol, interval: parts.interval, text: outcome.text, at: Date.now() } satisfies Last));
        }
      } else if (fresh) {
        setHistory([...history(), { q: prompt, a: "" }]);
      }
      setQuestion("");
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  const clear = () => {
    setAnswer("");
    setHistory([]);
    setShot(null);
    setSheet("");
    setPlan(null);
    setTools([]);
    setQuestion("");
    setError("");
    kv.removeItem(LAST_KEY);
    newAnalystSession();
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
        <button type="button" class="asst-link" onClick={() => setSetupOpen(!setupOpen())}>
          {setupOpen() ? translate("Close") : translate("Settings")}
        </button>
      </div>

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

      <Show when={shot()}>
        {(src) => (
          <figure class="asst-analyst-figure">
            <img class="asst-analyst-image" src={src()} alt={translate("The charts sent to the analyst")} />
            <figcaption class="asst-analyst-note">
              <span data-no-translate>{sheet()}</span>
              <button
                type="button"
                class="asst-link"
                onClick={() => {
                  const b64 = src().split(",")[1];
                  if (b64) void commands.openSnapshot(b64);
                }}
              >
                {translate("Open image")}
              </button>
            </figcaption>
          </figure>
        )}
      </Show>

      <Show when={!hasResult()}>
        <p class="asst-analyst-note">
          {translate("The agent reads this chart and a 1d, 4h and 5m indicator snapshot, then returns a 5m trade plan. It cannot trade.")}
        </p>
      </Show>

      <div class="asst-analyst-actions asst-analyst-start">
        <button type="button" class="asst-primary" disabled={busy() || !configured() || !!runtimeError()} onClick={() => void run(true)}>
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

      <Show when={hasResult()}>
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
            <button type="button" class="asst-primary" disabled={busy() || !question().trim() || !!runtimeError()} onClick={() => void run(false)}>
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
                <dt>{translate("Entry")}</dt>
                <dd data-no-translate>{priceNum(p().entry)}</dd>
              </div>
              <div>
                <dt>{translate("Take profit")}</dt>
                <dd class="is-target" data-no-translate>{priceNum(p().takeProfit)}</dd>
              </div>
              <div>
                <dt>{translate("Stop loss")}</dt>
                <dd class="is-risk" data-no-translate>{priceNum(p().stopLoss)}</dd>
              </div>
              <div>
                <dt>{translate("Risk/reward")}</dt>
                <dd data-no-translate>{num(p().riskReward, 2)}</dd>
              </div>
              <Show when={p().qty != null}>
                <div>
                  <dt>{translate("Quantity")}</dt>
                  <dd data-no-translate>{num(p().qty, 6)}</dd>
                </div>
              </Show>
            </dl>
            <Show when={p().rationale}>
              <p class="asst-plan-note">{p().rationale}</p>
            </Show>
            <div class="asst-plan-actions">
              <button type="button" class="asst-primary" onClick={fillTicket}>
                {translate("Fill ticket")}
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

      <p class="asst-note">
        {translate("Read-only analysis. The analyst cannot trade, and this is not financial advice.")}
      </p>
    </div>
  );
}
