import { toast } from "./toast";
import type {
  CredentialField,
  IndicatorConfig,
  UnknownRecord,
} from "../types";
import type { UpdateInfo } from "../services/updates";
import type { LegacyCredentials } from "../services/credentials";

export interface SettingsContext {
  loadIndicatorConfig(): Promise<IndicatorConfig>;
  saveIndicatorConfig(config: IndicatorConfig): Promise<void>;
  loadCredentials(): Promise<CredentialField[]>;
  saveCredentials(values: Record<string, string>, clear: string[]): Promise<CredentialField[]>;
  legacyCredentials(): Promise<LegacyCredentials>;
  importLegacyCredentials(): Promise<CredentialField[]>;
  checkUpdates(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
}

interface InputBinding {
  path: [string, string];
  element: HTMLInputElement | HTMLSelectElement;
  kind: "number" | "text" | "select" | "checkbox" | "levels" | "time";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelled(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el("div", "field");
  const label = el("label", undefined, labelText);
  const id = `cfg-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  label.htmlFor = id;
  wrap.append(label, control);
  if (hint) wrap.appendChild(el("span", "field-hint", hint));
  return wrap;
}

function section(title: string): HTMLElement {
  const node = el("div", "section");
  node.appendChild(el("h3", undefined, title));
  return node;
}

function input(type: string, value: string, width?: string): HTMLInputElement {
  const node = el("input");
  node.type = type;
  node.value = value;
  node.autocomplete = "off";
  node.spellcheck = false;
  if (width) node.style.width = width;
  return node;
}

function numeric(step = "any"): HTMLInputElement {
  const node = input("number", "", "100%");
  node.step = step;
  node.classList.add("mono");
  return node;
}

function asNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number`);
  return number;
}

function asInt(value: string, label: string, min: number, max: number): number {
  const number = asNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface SettingsContent {
  indicators: HTMLElement;
  credentials: HTMLElement;
  updates: HTMLElement;
  saveIndicators: HTMLButtonElement;
  indicatorError: HTMLElement;
}

export async function buildSettingsContent(ctx: SettingsContext): Promise<SettingsContent> {
  const [configResult, credentialsResult, legacyResult] = await Promise.allSettled([
    ctx.loadIndicatorConfig(),
    ctx.loadCredentials(),
    ctx.legacyCredentials(),
  ]);
  if (configResult.status === "rejected") {
    throw new Error(`Could not load indicator config: ${String(configResult.reason)}`);
  }
  const config = structuredClone(configResult.value) as IndicatorConfig;
  const bindings: InputBinding[] = [];

  const indicatorsPage = el("div", "settings-tab-page");
  const credentialsPage = el("div", "settings-tab-page");
  const updatesPage = el("div", "settings-tab-page");

  // ── Indicators ──────────────────────────────────────────────────────────
  const indicators = section("Indicators");
  const grid = el("div", "grid");

  const fvg = numeric("0.1");
  fvg.value = String(config.fvg?.gap_pct ?? 0.5);
  bindings.push({ path: ["fvg", "gap_pct"], element: fvg, kind: "number" });
  grid.appendChild(labelled("FVG gap %", fvg, "Minimum gap as % of price (0.5 = 0.5%)"));

  const vwapIntraday = input("text", String(config.vwap?.anchor_intraday ?? "D"));
  bindings.push({ path: ["vwap", "anchor_intraday"], element: vwapIntraday, kind: "text" });
  grid.appendChild(labelled("VWAP anchor (intraday)", vwapIntraday, "D = day, W = week"));

  const vwapDaily = input("text", String(config.vwap?.anchor_daily ?? "W"));
  bindings.push({ path: ["vwap", "anchor_daily"], element: vwapDaily, kind: "text" });
  grid.appendChild(labelled("VWAP anchor (daily)", vwapDaily, "D = day, W = week"));

  const ribbonType = el("select");
  for (const option of ["EMA", "SMA"]) {
    const node = el("option", undefined, option);
    node.value = option;
    ribbonType.appendChild(node);
  }
  ribbonType.value = String(config.ema_ribbon?.ma_type ?? "EMA");
  bindings.push({ path: ["ema_ribbon", "ma_type"], element: ribbonType, kind: "select" });
  grid.appendChild(labelled("Ribbon MA type", ribbonType));

  const ribbon1 = numeric("1");
  ribbon1.value = String(config.ema_ribbon?.length1 ?? 20);
  bindings.push({ path: ["ema_ribbon", "length1"], element: ribbon1, kind: "number" });
  grid.appendChild(labelled("Ribbon length 1", ribbon1));

  const ribbon2 = numeric("1");
  ribbon2.value = String(config.ema_ribbon?.length2 ?? 40);
  bindings.push({ path: ["ema_ribbon", "length2"], element: ribbon2, kind: "number" });
  grid.appendChild(labelled("Ribbon length 2", ribbon2));

  const ribbon3 = numeric("1");
  ribbon3.value = String(config.ema_ribbon?.length3 ?? 60);
  bindings.push({ path: ["ema_ribbon", "length3"], element: ribbon3, kind: "number" });
  grid.appendChild(labelled("Ribbon length 3", ribbon3));

  const vpLength = numeric("1");
  vpLength.value = String(config.volume_profile?.length ?? 100);
  bindings.push({ path: ["volume_profile", "length"], element: vpLength, kind: "number" });
  grid.appendChild(labelled("Volume profile candles", vpLength));

  const vpRows = numeric("1");
  vpRows.value = String(config.volume_profile?.rows ?? 24);
  bindings.push({ path: ["volume_profile", "rows"], element: vpRows, kind: "number" });
  grid.appendChild(labelled("Volume profile rows", vpRows));

  const hlEma = numeric("1");
  hlEma.value = String(config.hl_ema?.length ?? 20);
  bindings.push({ path: ["hl_ema", "length"], element: hlEma, kind: "number" });
  grid.appendChild(labelled("High/Low EMA length", hlEma));

  const adxLength = numeric("1");
  adxLength.value = String(config.adx?.length ?? 14);
  bindings.push({ path: ["adx", "length"], element: adxLength, kind: "number" });
  grid.appendChild(labelled("ADX length", adxLength));

  const adxPane = numeric("1");
  adxPane.value = String(config.adx?.pane_height ?? 160);
  bindings.push({ path: ["adx", "pane_height"], element: adxPane, kind: "number" });
  grid.appendChild(labelled("ADX pane height (px)", adxPane, "60 – 400"));

  const adxLevels = input("text", (config.adx?.levels ?? [25]).join(", "));
  adxLevels.classList.add("mono");
  bindings.push({ path: ["adx", "levels"], element: adxLevels, kind: "levels" });
  grid.appendChild(labelled("ADX reference levels", adxLevels, "Comma separated, 1 – 100"));

  const adxDi = input("checkbox", "");
  adxDi.checked = Boolean(config.adx?.show_di_lines);
  bindings.push({ path: ["adx", "show_di_lines"], element: adxDi, kind: "checkbox" });
  const diWrap = el("div", "toggle-row");
  diWrap.append(adxDi, el("span", undefined, "Show +DI / −DI lines"));
  grid.appendChild(labelled("ADX lines", diWrap));

  indicators.appendChild(grid);

  const sessions = section("Session windows (UTC)");
  const sessionGrid = el("div", "grid");
  const sessionLabels: Array<[string, string, string]> = [
    ["asian_start", "asian_end", "Asian"],
    ["london_start", "london_end", "London"],
    ["ny_am_start", "ny_am_end", "NY AM"],
    ["ny_pm_start", "ny_pm_end", "NY PM"],
  ];
  for (const [startKey, endKey, label] of sessionLabels) {
    const sessions = config.sessions as unknown as Record<string, string>;
    const start = input("text", String(sessions?.[startKey] ?? "00:00"));
    const end = input("text", String(sessions?.[endKey] ?? "00:00"));
    start.classList.add("mono");
    end.classList.add("mono");
    bindings.push({ path: ["sessions", startKey], element: start, kind: "time" });
    bindings.push({ path: ["sessions", endKey], element: end, kind: "time" });
    const row = el("div", "grid");
    row.style.gridTemplateColumns = "1fr 1fr";
    row.append(
      labelled(`${label} start`, start),
      labelled(`${label} end`, end),
    );
    const wrap = el("div", "section");
    wrap.style.gap = "4px";
    wrap.appendChild(row);
    sessionGrid.appendChild(wrap);
  }
  sessions.appendChild(sessionGrid);
  sessions.appendChild(
    el("span", "field-hint", "The box extends to the next session start; all times UTC."),
  );

  indicatorsPage.append(indicators, sessions);

  // ── Credentials ─────────────────────────────────────────────────────────
  const credentialsSection = section("Credentials");
  const credentialRows = el("div", "section");
  credentialsSection.appendChild(
    el(
      "span",
      "field-hint",
      "Stored in the OS credential store (Windows Credential Manager / Secret Service). " +
      "Secrets are never sent to the chart workspace or written to plaintext files.",
    ),
  );
  const credError = el("div", "inline-error");
  const credOk = el("div", "inline-ok");
  const credSave = el("button", "ghost-btn", "Save credentials");
  credSave.type = "button";
  credentialsSection.append(credentialRows, credError, credOk, credSave);
  credentialsPage.appendChild(credentialsSection);

  const renderCredentials = (fields: CredentialField[]) => {
    credentialRows.replaceChildren();
    if (!fields.length) {
      credentialRows.appendChild(el("span", "field-hint", "Credential status unavailable."));
      return;
    }
    for (const field of fields) {
      const row = el("div", "cred-row");
      const label = el("label", undefined, field.label);
      const id = `cred-${field.key.toLowerCase()}`;
      label.htmlFor = id;
      const control = input(field.secret ? "password" : "text", "");
      control.id = id;
      control.placeholder = field.set ? "•••••••• configured" : "not configured";
      control.autocomplete = "off";
      control.dataset.key = field.key;
      control.dataset.secret = String(field.secret);
      const state = el(
        "span",
        `cred-state${field.set ? " set" : ""}`,
        field.set ? "set" : "missing",
      );
      const meta = el("div");
      meta.style.display = "flex";
      meta.style.gap = "8px";
      meta.style.alignItems = "center";
      if (field.set) {
        const clearLabel = el("label", "check-inline");
        const clear = input("checkbox", "");
        clear.dataset.clearKey = field.key;
        clearLabel.append(clear, el("span", undefined, "Remove"));
        meta.append(state, clearLabel);
      } else {
        meta.append(state);
      }
      row.append(label, control, meta);
      credentialRows.appendChild(row);
    }
  };

  renderCredentials(
    credentialsResult.status === "fulfilled" ? credentialsResult.value : [],
  );

  const legacy = legacyResult.status === "fulfilled" ? legacyResult.value : null;
  if (legacy?.found) {
    const legacyBox = el("div", "section");
    legacyBox.style.borderTop = "1px solid var(--hairline)";
    legacyBox.style.paddingTop = "10px";
    legacyBox.appendChild(
      el(
        "span",
        "field-hint",
        `Plaintext credentials were found in ${legacy.path ?? "keys/.env"}. ` +
        "Import them into the OS credential store and delete the file afterwards.",
      ),
    );
    const importButton = el("button", "ghost-btn", "Import legacy keys");
    importButton.type = "button";
    const importStatus = el("div", "inline-ok");
    importButton.addEventListener("click", async () => {
      importButton.disabled = true;
      importStatus.textContent = "";
      try {
        const fields = await ctx.importLegacyCredentials();
        renderCredentials(fields);
        importStatus.textContent =
          "Imported. The original plaintext file was not modified; delete it manually.";
        toast("Legacy credentials imported into the OS keyring", "success");
      } catch (error) {
        importStatus.className = "inline-error";
        importStatus.textContent = (error as Error).message;
      } finally {
        importButton.disabled = false;
      }
    });
    const row = el("div");
    row.style.display = "flex";
    row.style.gap = "10px";
    row.style.alignItems = "center";
    row.append(importButton, importStatus);
    legacyBox.appendChild(row);
    credentialsSection.appendChild(legacyBox);
  }

  credSave.addEventListener("click", async () => {
    credError.textContent = "";
    credOk.textContent = "";
    const values: Record<string, string> = {};
    const clear: string[] = [];
    credentialRows.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((node) => {
      const key = node.dataset.key ?? "";
      if (node.value.trim()) values[key] = node.value;
    });
    credentialRows.querySelectorAll<HTMLInputElement>("input[data-clear-key]").forEach((node) => {
      if (node.checked) clear.push(node.dataset.clearKey ?? "");
    });
    if (!Object.keys(values).length && !clear.length) {
      credError.textContent = "Enter a value or choose Remove.";
      return;
    }
    credSave.disabled = true;
    try {
      const fields = await ctx.saveCredentials(values, clear);
      renderCredentials(fields);
      credOk.textContent = "Saved to the OS credential store.";
      toast("Credentials updated", "success");
    } catch (error) {
      credError.textContent = (error as Error).message;
    } finally {
      credSave.disabled = false;
    }
  });

  // ── Updates ─────────────────────────────────────────────────────────────
  const updates = section("Updates");
  const updateStatus = el("span", "field-hint", "Checks the signed release channel.");
  const install = el("button", "ghost-btn", "Install update");
  install.type = "button";
  install.hidden = true;
  const check = el("button", "ghost-btn", "Check for updates");
  check.type = "button";
  const updateRow = el("div");
  updateRow.style.display = "flex";
  updateRow.style.gap = "8px";
  updateRow.style.alignItems = "center";
  updateRow.append(check, install, updateStatus);
  updates.appendChild(updateRow);
  updatesPage.appendChild(updates);

  check.addEventListener("click", async () => {
    check.disabled = true;
    updateStatus.textContent = "Checking…";
    install.hidden = true;
    try {
      const info = await ctx.checkUpdates();
      updateStatus.textContent = info.available
        ? `Version ${info.version} is available (current ${info.currentVersion ?? "?"}).`
        : "You are running the latest version.";
      install.hidden = !info.available;
    } catch (error) {
      updateStatus.textContent = (error as Error).message;
    } finally {
      check.disabled = false;
    }
  });

  install.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Install the downloaded update now? The application will restart.",
    );
    if (!confirmed) return;
    install.disabled = true;
    try {
      await ctx.installUpdate();
    } catch (error) {
      updateStatus.textContent = (error as Error).message;
      install.disabled = false;
    }
  });

  // ── Save ────────────────────────────────────────────────────────────────
  const errorLine = el("div", "inline-error");
  const save = el("button", "primary-btn", "Save indicators");
  save.type = "button";
  const saveRow = el("div", "settings-save-row");
  saveRow.append(errorLine, save);
  indicatorsPage.appendChild(saveRow);

  save.addEventListener("click", async () => {
    errorLine.textContent = "";
    try {
      for (const binding of bindings) {
        const [group, key] = binding.path;
        const target = config[group] as unknown as UnknownRecord;
        if (!target) continue;
        switch (binding.kind) {
          case "number": {
            const label = `${group}.${key}`;
            const raw = binding.element.value.trim();
            const number = asNumber(raw, label);
            if (key === "pane_height") {
              target[key] = asInt(raw, label, 60, 400);
            } else if (
              key === "length" || key === "length1" || key === "length2" ||
              key === "length3" || key === "rows"
            ) {
              target[key] = asInt(raw, label, 1, 5000);
            } else {
              target[key] = number;
            }
            break;
          }
          case "levels": {
            const parts = binding.element.value.split(",").map((part) => part.trim()).filter(Boolean);
            if (!parts.length) throw new Error("ADX levels must not be empty");
            target[key] = parts.map((part) => asInt(part, "ADX level", 1, 100));
            break;
          }
          case "time": {
            const value = binding.element.value.trim();
            if (!TIME_RE.test(value)) throw new Error(`Invalid time for ${group}.${key} (HH:MM)`);
            target[key] = value;
            break;
          }
          case "checkbox":
            target[key] = (binding.element as HTMLInputElement).checked;
            break;
          case "select":
          case "text":
            target[key] = binding.element.value.trim();
            break;
        }
      }
      if (config.fvg && (config.fvg.gap_pct < 0 || config.fvg.gap_pct > 100)) {
        throw new Error("FVG gap % must be between 0 and 100");
      }
      await ctx.saveIndicatorConfig(config);
      toast("Indicator settings saved", "success");
    } catch (error) {
      errorLine.textContent = (error as Error).message;
    }
  });

  return {
    indicators: indicatorsPage,
    credentials: credentialsPage,
    updates: updatesPage,
    saveIndicators: save,
    indicatorError: errorLine,
  };
}
