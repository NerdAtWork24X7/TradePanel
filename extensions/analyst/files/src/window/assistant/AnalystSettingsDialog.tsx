/*
 * All Analyze chart settings in one place: the vision provider, its key, the
 * system prompt sent with every analysis, the optional portfolio context and
 * the in-app Pi updater. It is a portal dialog so the panel behind it keeps
 * its run state while the user edits; only Save (or Update Pi) changes the
 * runtime, and a saved prompt takes effect on the next analysis.
 */
import { Show, createSignal, onMount } from "solid-js";
import type { PiStatus } from "../../bindings";
import { Dialog } from "../../components/Dialog";
import { clearAnalystKey, saveAnalystSettings, updatePiRuntime } from "../../data/analyst";
import { analystPortfolioContext, setAnalystPortfolioContext } from "../../data/analyst-settings";
import { translate, translateWith } from "../../i18n/translator";

export function AnalystSettingsDialog(props: {
  status: PiStatus | null;
  onStatus: (status: PiStatus) => void;
  onClose: () => void;
}) {
  const [base, setBase] = createSignal(props.status?.baseUrl ?? "");
  const [model, setModel] = createSignal(props.status?.model ?? "");
  const [key, setKey] = createSignal("");
  const [hasKey, setHasKey] = createSignal(props.status?.hasKey ?? false);
  const [prompt, setPrompt] = createSignal(props.status?.systemPrompt ?? "");
  const [builtIn, setBuiltIn] = createSignal(!(props.status?.hasCustomPrompt ?? false));
  const [portfolio, setPortfolio] = createSignal(analystPortfolioContext());
  const [saving, setSaving] = createSignal(false);
  const [updating, setUpdating] = createSignal(false);
  const [updateStep, setUpdateStep] = createSignal("");
  const [error, setError] = createSignal("");
  let baseInput: HTMLInputElement | undefined;

  onMount(() => baseInput?.focus());

  const runtimeNote = () => {
    const status = props.status;
    const version = status?.piVersion ? translateWith("Pi {0}", status.piVersion) : translate("AI runtime");
    return status?.target ? `${version} · ${status.target}` : version;
  };

  const save = async () => {
    if (saving()) return;
    setSaving(true);
    setError("");
    const r = await saveAnalystSettings(base(), model(), key() || null, builtIn() ? null : prompt());
    setSaving(false);
    if (r.status === "error") return setError(r.error);
    setHasKey(r.data.hasKey);
    setKey("");
    setUpdateStep("");
    props.onStatus(r.data);
    props.onClose();
  };

  const forgetKey = async () => {
    const r = await clearAnalystKey();
    if (r.status === "error") setError(r.error);
    else {
      setHasKey(r.data.hasKey);
      props.onStatus(r.data);
    }
  };

  const useBuiltIn = () => {
    setPrompt(props.status?.defaultPrompt ?? "");
    setBuiltIn(true);
  };

  /** Install a newer Pi in place; the button stays disabled while npm runs. */
  const updateRuntime = async () => {
    if (updating() || saving()) return;
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
      props.onStatus(r.data);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Dialog
      look="prompt"
      layerClass="asst-settings-layer"
      backdrop="close-self"
      draggable={false}
      class="ot-dlg asst-settings-dlg"
      title={translate("Analysis settings")}
      label={translate("Analysis settings")}
      onClose={props.onClose}
    >
      <div class="asst-settings-body">
        <section class="asst-settings-section">
          <div class="asst-form-head">
            <span>{translate("Provider")}</span>
            <span class="asst-runtime-note" data-no-translate>{runtimeNote()}</span>
          </div>
          <label class="asst-analyst-field">
            <span>{translate("API base URL")}</span>
            <input
              ref={baseInput}
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
        </section>

        <section class="asst-settings-section">
          <div class="asst-form-head">
            <span>{translate("System prompt")}</span>
            <Show when={builtIn()}>
              <span class="asst-runtime-note">{translate("Built-in")}</span>
            </Show>
          </div>
          <label class="asst-analyst-field">
            <span>{translate("Instructions sent to the analyst before each analysis")}</span>
            <textarea
              class="asst-analyst-input asst-prompt-input"
              rows={10}
              value={prompt()}
              spellcheck={false}
              onInput={(e) => {
                setPrompt(e.currentTarget.value);
                setBuiltIn(false);
              }}
            />
          </label>
          <p class="asst-analyst-note">
            {translate("Keep the built-in prompt to receive improvements with Pi updates, or edit it to change how the analyst reads your charts. Only the text is saved; it never becomes a file path or a command.")}
          </p>
          <div class="asst-analyst-actions">
            <button type="button" class="asst-link" disabled={!props.status?.defaultPrompt} onClick={useBuiltIn}>
              {translate("Use built-in prompt")}
            </button>
          </div>
        </section>

        <section class="asst-settings-section">
          <label class="asst-analyst-field asst-settings-check">
            <input
              type="checkbox"
              checked={portfolio()}
              onChange={(e) => {
                setPortfolio(e.currentTarget.checked);
                setAnalystPortfolioContext(e.currentTarget.checked);
              }}
            />
            <span>{translate("Let the analyst read my portfolio context")}</span>
          </label>
          <p class="asst-analyst-note">
            {translate("When off, positions, open orders and balance are left out of the analysis snapshot.")}
          </p>
        </section>

        <section class="asst-settings-section">
          <div class="asst-form-head">
            <span>{translate("Runtime")}</span>
          </div>
          <div class="asst-analyst-actions">
            <button type="button" class="asst-link" disabled={updating() || saving()} onClick={() => void updateRuntime()}>
              {updating() ? translate("Updating Pi…") : translate("Update Pi")}
            </button>
          </div>
          <Show when={updateStep()}>
            <div class="asst-update" role="status" aria-live="polite">
              <span class="asst-runtime-dot" classList={{ "is-busy": updating() }} aria-hidden="true" />
              <span data-no-translate>{updateStep()}</span>
            </div>
          </Show>
        </section>

        <Show when={error()}>
          <p class="asst-error" role="alert">{error()}</p>
        </Show>
      </div>

      <div class="asst-settings-footer">
        <button type="button" class="asst-primary" disabled={saving() || updating()} onClick={() => void save()}>
          {saving() ? translate("Saving...") : translate("Save")}
        </button>
        <Show when={hasKey()}>
          <button type="button" class="asst-link" onClick={() => void forgetKey()}>
            {translate("Forget the key")}
          </button>
        </Show>
        <button type="button" class="asst-link" onClick={props.onClose}>
          {translate("Close")}
        </button>
      </div>
    </Dialog>
  );
}
