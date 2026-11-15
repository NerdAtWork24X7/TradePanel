/*
 * "Analyze chart": the analyst sees the charts the user sees.
 *
 * The shown layout is rendered by chartSnapshot/layoutSnapshot (the same render as Take a
 * snapshot), the active chart's symbol, interval, studies and the account's position and
 * order ticket go with it as text, and the answer streams in below the picture. Read-only:
 * the provider gets no tool that can trade.
 */
import { Show, createSignal, onMount } from "solid-js";
import { commands } from "../../bindings";
import { AnswerText } from "./AnswerText";
import { exportableCharts, type ChartExportSource } from "../chart/chart-export";
import { layoutSnapshot, snapshotTheme } from "../chart/layout-snapshot";
import { indicatorLegendFor } from "../../data/chart-state-registry";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { analystSettings, analyzeChart, clearAnalystKey, loadAnalystSettings, saveAnalystSettings, stopAnalysis } from "../../data/analyst";
import { translate } from "../../i18n/translator";
import * as kv from "../../data/kv";

const LAST_KEY = "ot:analyst:last";
const DEFAULT_ASK = "Analyze this chart: the trend, the key levels, and two scenarios with their invalidation.";
const SYSTEM = [
  "You are a market analyst inside a desktop charting terminal.",
  "You receive a rendered screenshot of the user's visible charts and a short data sheet.",
  "Describe only what the image and data show; say when something is not visible.",
  "Structure the answer: trend and structure, key levels, momentum, two scenarios with invalidation. Be concise (under 300 words) unless asked for more.",
  "You cannot place, change or cancel orders and must not claim to. This is not financial advice.",
  "Dates are dd/mm/yyyy. Quote prices with the instrument's precision.",
].join(" ");

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

/** The data sheet sent with the picture: what the image cannot say (exact numbers, account). */
function dataSheet(source: ChartExportSource): string {
  const { symbol, interval } = titleParts(source.title());
  const lines = [`Instrument: ${symbol}${interval ? ` · ${interval}` : ""}`];
  try {
    const { times, columns } = source.data();
    const close = columns.find((c) => c.title.toLowerCase() === "close") ?? columns[0];
    const last = times.length ? close?.values.get(times[times.length - 1]) : undefined;
    if (last != null) lines.push(`Last close: ${priceNum(last)}`);
    if (times.length > 1) {
      const from = Math.max(0, times.length - 100);
      const window = times.slice(from).map((t) => close?.values.get(t)).filter((v): v is number => v != null && Number.isFinite(v));
      if (window.length > 1 && window[0] !== 0) {
        const change = ((window[window.length - 1] - window[0]) / window[0]) * 100;
        lines.push(`Last ${window.length} bars: ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`);
      }
    }
    if (times.length) lines.push(`Bars loaded: ${times.length}`);
  } catch {
    /* a chart still loading has no columns yet */
  }
  const studies = indicatorLegendFor(symbol)
    .filter((r) => !r.hidden && !r.offInterval)
    .slice(0, 24)
    .map((r) => {
      const values = r.plots
        .filter((p) => p.value != null && Number.isFinite(p.value))
        .map((p) => num(p.value, 4));
      return `- ${r.title}${r.inputs ? ` (${r.inputs})` : ""}${values.length ? `: ${values.join(", ")}` : ""}`;
    });
  if (studies.length) lines.push("Indicators:", ...studies);

  const state = pluginBroker.status()?.state;
  if (state?.account) {
    const a = state.account;
    lines.push(
      `Account: ${a.isDemo ? "demo/testnet" : "LIVE"} · balance ${num(a.balance)} ${a.currency} · equity ${num(a.equity)}` +
        (a.unrealizedPnl != null ? ` · open P/L ${num(a.unrealizedPnl)}` : ""),
    );
  }
  const positions = (state?.positions ?? []).filter((p) => p.ticker === symbol || p.ticker.startsWith(`${symbol.split(":")[0]}:`));
  for (const p of positions) {
    lines.push(`Position: ${p.side} ${num(p.qty, 8)} ${symbol.split(":")[1]?.split("/")[0] ?? ""} @ ${priceNum(p.avgPrice)} · P/L ${num(p.unrealizedPnl)}`);
  }
  const draft = tradingUi.draft();
  if (draft && draft.symbol === symbol) {
    const parts = [`Ticket: ${draft.side} ${draft.qty || "?"} ${draft.orderType}`];
    if (draft.limitPrice) parts.push(`limit ${draft.limitPrice}`);
    if (draft.takeProfit) parts.push(`TP ${draft.takeProfit}`);
    if (draft.stopLoss) parts.push(`SL ${draft.stopLoss}`);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

export function ChartAnalyst(props: { ticker: string }) {
  const [base, setBase] = createSignal("");
  const [model, setModel] = createSignal("");
  const [key, setKey] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [shot, setShot] = createSignal<string | null>(null);
  const [sheet, setSheet] = createSignal("");
  const [question, setQuestion] = createSignal(DEFAULT_ASK);
  const [answer, setAnswer] = createSignal("");
  const [history, setHistory] = createSignal<{ q: string; a: string }[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const [error, setError] = createSignal("");

  const configured = () => {
    const s = analystSettings();
    // A local model server (plain HTTP on this computer) may take no key.
    return !!s.baseUrl && !!s.model && (s.hasKey || s.baseUrl.trim().startsWith("http://"));
  };
  const provider = () => `${analystSettings().model || translate("No model")} · ${analystSettings().baseUrl || translate("No endpoint")}`;
  /** The full symbol of the last picture ("BINANCE:BTC/USDT"), for the answer's ticker links. */
  const instrument = () => sheet().match(/^Instrument: (\S+)/)?.[1] ?? props.ticker;

  onMount(() => {
    void loadAnalystSettings().then((s) => {
      if (!s) return;
      setBase(s.baseUrl);
      setModel(s.model);
      // A local HTTP model server may take no key.
      setSetupOpen(!s.baseUrl || !s.model || (!s.hasKey && !s.baseUrl.trim().startsWith("http://")));
    });
    const saved = kv.getItem(LAST_KEY);
    if (!saved) return;
    try {
      const last = JSON.parse(saved) as Last;
      if (last.symbol && last.text) {
        setAnswer(last.text);
        setHistory([{ q: "", a: last.text }]);
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
    setKey("");
    setSetupOpen(false);
  };

  const forgetKey = async () => {
    const r = await clearAnalystKey();
    if (r.status === "error") setError(r.error);
    else setSetupOpen(true);
  };

  /** What "Analyze again" asks when the box is empty after a first answer. */
  const askNow = () => question().trim() || (history().length ? DEFAULT_ASK : "");
  const run = async (ask = askNow()) => {
    if (busy()) return;
    const text = ask.trim();
    if (!text) return;
    setError("");
    setAnswer("");
    setStopped(false);
    setBusy(true);
    let source: ChartExportSource | null = null;
    try {
      const picture = await capture();
      source = picture.source;
      const sheetText = dataSheet(source);
      setShot(picture.image);
      setSheet(sheetText);
      // The picture is fresh each time; the earlier questions and answers keep the thread.
      // An answer restored from the last session has no question of its own: it is shown,
      // not replayed into the model.
      const turns = history().filter((t) => t.q.trim());
      const first = turns[0]?.q || text;
      const messages: Parameters<typeof analyzeChart>[0] = [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: picture.image } },
            { type: "text", text: `${sheetText}\n\n${first}` },
          ],
        },
      ];
      for (let i = 0; i < turns.length; i++) {
        messages.push({ role: "assistant", content: turns[i].a });
        messages.push({ role: "user", content: i + 1 < turns.length ? turns[i + 1].q : text });
      }
      const result = await analyzeChart(messages, setAnswer);
      if (stopped()) return;
      if (result.trim()) {
        const next = [...history(), { q: text, a: result }];
        setHistory(next);
        const parts = titleParts(source.title());
        kv.setItem(LAST_KEY, JSON.stringify({ symbol: parts.symbol, interval: parts.interval, text: result, at: Date.now() } satisfies Last));
        setQuestion("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    setStopped(true);
    stopAnalysis();
    setBusy(false);
  };

  return (
    <div class="asst-analyst" aria-busy={busy()}>
      <div class="asst-analyst-head">
        <div>
          <div class="asst-analyst-title">{translate("The analyst sees these charts")}</div>
          <div class="asst-analyst-meta" data-no-translate>{provider()}</div>
        </div>
        <button type="button" class="asst-link" onClick={() => setSetupOpen(!setupOpen())}>
          {configured() ? translate("Provider…") : translate("Set up")}
        </button>
      </div>

      <Show when={setupOpen()}>
        <div class="asst-analyst-form">
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
              placeholder={analystSettings().hasKey ? translate("Stored — type to replace") : ""}
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
          </label>
          <p class="asst-analyst-note">
            {translate("The key is kept in your operating system's credential store and never reaches the window. HTTPS is required, or HTTP on 127.0.0.1 for a local model.")}
          </p>
          <div class="asst-analyst-actions">
            <button type="button" class="asst-primary" disabled={saving()} onClick={() => void save()}>
              {saving() ? translate("Saving…") : translate("Save")}
            </button>
            <Show when={analystSettings().hasKey}>
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

      <Show when={!configured() && !setupOpen()}>
        <p class="asst-analyst-note">{translate("Add a vision provider to analyze your charts.")}</p>
      </Show>

      <Show when={shot()}>
        {(src) => (
          <figure class="asst-analyst-figure">
            <img class="asst-analyst-image" src={src()} alt={translate("The charts sent to the analyst")} />
            <figcaption class="asst-analyst-note">
              {sheet()}
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

      <div class="asst-analyst-ask">
        <textarea
          class="asst-input"
          rows={2}
          value={question()}
          placeholder={translate("What should the analyst look at?")}
          onInput={(e) => setQuestion(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <div class="asst-analyst-actions">
          <button type="button" class="asst-primary" disabled={busy() || !configured() || !askNow()} onClick={() => void run()}>
            {busy() ? translate("Analyzing…") : history().length && !question().trim() ? translate("Analyze again") : translate("Analyze chart")}
          </button>
          <Show when={busy()}>
            <button type="button" class="asst-link" onClick={stop}>
              {translate("Stop")}
            </button>
          </Show>
          <Show when={answer() || history().length}>
            <button
              type="button"
              class="asst-link"
              onClick={() => {
                setAnswer("");
                setHistory([]);
                setShot(null);
                setSheet("");
                kv.removeItem(LAST_KEY);
              }}
            >
              {translate("Clear")}
            </button>
          </Show>
        </div>
      </div>

      <Show when={error()}>
        <p class="asst-error" role="alert">{error()}</p>
      </Show>

      <Show when={busy() && !answer()}>
        <div class="asst-thinking" aria-hidden="true"><span /><span /><span /></div>
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
