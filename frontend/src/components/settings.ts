import { toast } from "./toast";
import type {
  ConnectionResult,
  CredentialField,
  ExchangeCatalog,
  ExchangeCatalogEntry,
} from "../types";
import type {
  AiRuntimeUpdateInfo,
  AiRuntimeUpdateProgress,
  UpdateInfo,
} from "../services/updates";
import type { LegacyCredentials } from "../services/credentials";

export interface AiRuntimeSummary {
  ready: boolean;
  nodeVersion: string | null;
  piVersion: string | null;
  managed: boolean;
  error: string | null;
}

export interface SettingsContext {
  loadCredentials(): Promise<CredentialField[]>;
  saveCredentials(values: Record<string, string>, clear: string[]): Promise<CredentialField[]>;
  legacyCredentials(): Promise<LegacyCredentials>;
  importLegacyCredentials(): Promise<CredentialField[]>;
  exchangeCatalog(): Promise<ExchangeCatalog>;
  testConnection(exchange: string, market: string): Promise<ConnectionResult>;
  checkUpdates(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  runtimeInfo(): Promise<AiRuntimeSummary>;
  checkAiRuntimeUpdate(): Promise<AiRuntimeUpdateInfo>;
  installAiRuntimeUpdate(): Promise<AiRuntimeUpdateInfo>;
  onAiRuntimeUpdateProgress(handler: (progress: AiRuntimeUpdateProgress) => void): Promise<() => void>;
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

export interface SettingsContent {
  exchange: HTMLElement;
  updates: HTMLElement;
}

function entriesFromFields(fields: CredentialField[]): ExchangeCatalogEntry[] {
  const byExchange = new Map<string, CredentialField[]>();
  for (const field of fields) {
    const list = byExchange.get(field.exchange) ?? [];
    list.push(field);
    byExchange.set(field.exchange, list);
  }
  return Array.from(byExchange, ([id, list]) => ({
    id,
    name: list[0]?.group ?? id,
    markets: [{ id: "futures", label: "Perpetual", ccxt: id }],
    networks: list.some((field) => field.key.endsWith("_NETWORK")) ? ["testnet", "live"] : ["live"],
    default_network: "testnet",
    passphrase: list.some((field) => field.key.endsWith("_PASSPHRASE")),
    wallet: id === "hyperliquid",
  }));
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return value.toExponential(3);
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toPrecision(4);
}

export async function buildSettingsContent(ctx: SettingsContext): Promise<SettingsContent> {
  const [credentialsResult, legacyResult, runtimeResult, catalogResult] = await Promise.allSettled([
    ctx.loadCredentials(),
    ctx.legacyCredentials(),
    ctx.runtimeInfo(),
    ctx.exchangeCatalog(),
  ]);
  const exchangePage = el("div", "settings-tab-page");
  const updatesPage = el("div", "settings-tab-page");

  let fields = credentialsResult.status === "fulfilled" ? credentialsResult.value : [];
  const catalog: ExchangeCatalog =
    catalogResult.status === "fulfilled"
      ? catalogResult.value
      : {
          exchanges: entriesFromFields(fields),
          default_exchange: "hyperliquid",
          default_market: "futures",
        };

  const exchangeSection = section("Exchange connections");
  exchangeSection.appendChild(
    el(
      "span",
      "field-hint",
      "Connect the API keys for the venue you trade on. Keys live in the OS credential store " +
      "(Windows Credential Manager / Secret Service / Keychain) and are pushed to the trading " +
      "engine in memory only. Secrets are never shown again after saving.",
    ),
  );

  const grid = el("div", "exchange-grid");
  const detail = el("div", "exchange-detail");
  exchangeSection.append(grid, detail);
  exchangePage.appendChild(exchangeSection);

  let selected = catalog.exchanges[0]?.id ?? catalog.default_exchange;
  let connection: ConnectionResult | null = null;

  const fieldsFor = (id: string) => fields.filter((field) => field.exchange === id);

  const renderGrid = () => {
    grid.replaceChildren();
    for (const entry of catalog.exchanges) {
      const entryFields = fieldsFor(entry.id);
      const required = entryFields.filter((field) => field.kind !== "choice");
      const configured = required.length > 0 && required.every((field) => field.set);
      const button = el("button", "exchange-card");
      button.type = "button";
      button.dataset.exchange = entry.id;
      button.classList.toggle("active", entry.id === selected);
      button.setAttribute("aria-pressed", String(entry.id === selected));
      const name = el("span", "exchange-card-name", entry.name);
      const markets = el(
        "span",
        "exchange-card-markets",
        entry.markets.map((market) => market.label).join(" · "),
      );
      const status = el(
        "span",
        `exchange-card-status${configured ? " ready" : ""}`,
        configured ? "Configured" : "Setup",
      );
      const networks = el(
        "span",
        "exchange-card-networks",
        entry.networks.includes("testnet") ? "Testnet + live" : "Live only",
      );
      const body = el("span", "exchange-card-body");
      body.append(name, markets, networks);
      button.append(body, status);
      button.addEventListener("click", () => {
        if (selected === entry.id) return;
        selected = entry.id;
        connection = null;
        renderGrid();
        renderDetail();
      });
      grid.appendChild(button);
    }
  };

  const renderDetail = () => {
    const entry = catalog.exchanges.find((item) => item.id === selected);
    if (!entry) {
      detail.replaceChildren(el("span", "field-hint", "No exchange catalog available."));
      return;
    }
    const entryFields = fieldsFor(entry.id);
    const networkField = entryFields.find((field) => field.kind === "choice");
    const credentialFields = entryFields.filter((field) => field.kind !== "choice");
    const required = credentialFields;
    const configured = required.length > 0 && required.every((field) => field.set);
    const network =
      networkField?.value && entry.networks.includes(networkField.value)
        ? networkField.value
        : entry.networks.includes("testnet")
          ? "testnet"
          : entry.networks[0];

    const card = el("div", "section");
    const head = el("div", "settings-section-head");
    const headText = el("div");
    const title = el("h3", undefined, entry.name);
    const subtitle = el(
      "p",
      undefined,
      `${entry.markets.map((market) => market.label).join(" and ")} trading. ` +
        (entry.wallet
          ? "Use the wallet address that holds the trading account."
          : "Create an API key with trading permission; withdrawal permission is not needed."),
    );
    headText.append(title, subtitle);
    const statusChip = el(
      "span",
      `exchange-status${configured ? " ready" : ""}`,
      configured ? "Keys stored" : "Not connected",
    );
    head.append(headText, statusChip);
    card.appendChild(head);

    // Network selector: only render a choice when the venue offers one.
    if (entry.networks.length > 1) {
      const networkRow = el("div", "network-row");
      const label = el("span", "network-label", "Network");
      const group = el("div", "network-toggle");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", `${entry.name} network`);
      let choice = network;
      for (const value of entry.networks) {
        const button = el("button", "network-btn", value === "live" ? "Live" : "Testnet");
        button.type = "button";
        button.dataset.network = value;
        button.setAttribute("aria-pressed", String(value === choice));
        button.classList.toggle("active", value === choice);
        button.addEventListener("click", () => {
          choice = value;
          group.querySelectorAll<HTMLButtonElement>(".network-btn").forEach((node) => {
            const active = node.dataset.network === choice;
            node.classList.toggle("active", active);
            node.setAttribute("aria-pressed", String(active));
          });
          networkRow.dataset.value = choice;
          const warning = networkRow.querySelector(".network-warning");
          if (choice === "live" && !warning) {
            networkRow.appendChild(el("span", "network-warning", "Live funds at risk"));
          } else if (choice !== "live") {
            warning?.remove();
          }
        });
        group.appendChild(button);
      }
      networkRow.dataset.value = choice;
      networkRow.append(label, group);
      if (network === "live") {
        networkRow.appendChild(el("span", "network-warning", "Live funds at risk"));
      }
      card.appendChild(networkRow);
    } else {
      const only = el("div", "network-row");
      only.append(
        el("span", "network-label", "Network"),
        el("span", "network-static", "Live only"),
      );
      card.appendChild(only);
    }

    const rows = el("div", "section");
    for (const field of credentialFields) {
      const row = el("div", "cred-row");
      const id = `cred-${entry.id}-${field.key.toLowerCase()}`;
      const label = el("label", undefined, field.label);
      label.htmlFor = id;
      let control: HTMLInputElement | HTMLTextAreaElement;
      if (field.multiline) {
        const area = el("textarea", "mono");
        area.rows = 3;
        area.id = id;
        area.autocomplete = "off";
        area.spellcheck = false;
        area.placeholder = field.set ? "configured — paste a new key to replace" : "not configured";
        control = area;
      } else {
        const node = input(field.secret ? "password" : "text", field.secret ? "" : field.value);
        node.id = id;
        node.placeholder = field.set ? "•••••••• configured" : "not configured";
        control = node;
      }
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
      rows.appendChild(row);
    }
    card.appendChild(rows);

    if (!entryFields.length) {
      card.appendChild(el("span", "field-hint", "Credential status unavailable."));
    }

    const actions = el("div", "settings-save-row");
    const status = el("div", "inline-ok");
    status.setAttribute("aria-live", "polite");
    const test = el("button", "ghost-btn", "Test connection");
    test.type = "button";
    test.disabled = !configured;
    const remove = el("button", "ghost-btn", "Remove keys");
    remove.type = "button";
    remove.disabled = !configured;
    const save = el("button", "primary-btn", "Save & test");
    save.type = "button";
    actions.append(status, test, remove, save);
    card.appendChild(actions);

    const balances = el("div", "exchange-balances");
    card.appendChild(balances);

    const setStatus = (text: string, tone: "ok" | "error" | "muted" = "ok") => {
      status.className = tone === "error" ? "inline-error" : "inline-ok";
      status.textContent = text;
    };

    const showConnection = (result: ConnectionResult) => {
      balances.replaceChildren();
      if (!result.balances.length) {
        balances.appendChild(
          el(
            "span",
            "field-hint",
            `Connected to ${result.label} (${result.network}) — no non-zero balances.`,
          ),
        );
        return;
      }
      const line = el(
        "span",
        "field-hint",
        `Connected to ${result.label} (${result.network})`,
      );
      const list = el("div", "balance-list");
      for (const balance of result.balances.slice(0, 8)) {
        const item = el("div", "balance-item");
        item.append(
          el("span", "balance-currency mono", balance.currency),
          el("span", "balance-total mono", formatAmount(balance.total)),
          el("span", "balance-free mono", `free ${formatAmount(balance.free)}`),
        );
        list.appendChild(item);
      }
      balances.append(line, list);
    };

    const runTest = async () => {
      const market = entry.markets.find((item) => item.id === "futures") ?? entry.markets[0];
      if (!market) return;
      test.disabled = true;
      save.disabled = true;
      setStatus("Testing the API key with a balance request...", "muted");
      try {
        connection = await ctx.testConnection(entry.id, market.id);
        setStatus(`Connected to ${connection.label}.`, "ok");
        showConnection(connection);
      } catch (error) {
        balances.replaceChildren();
        setStatus((error as Error).message, "error");
      } finally {
        test.disabled = !configured;
        save.disabled = false;
      }
    };

    save.addEventListener("click", async () => {
      const values: Record<string, string> = {};
      const clear: string[] = [];
      rows.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-key]").forEach((node) => {
        const key = node.dataset.key ?? "";
        if (node.value.trim()) values[key] = node.value;
      });
      if (networkField) {
        const chosen = (card.querySelector(".network-row") as HTMLElement | null)?.dataset.value;
        if (chosen) values[networkField.key] = chosen;
      }
      rows.querySelectorAll<HTMLInputElement>("input[data-clear-key]").forEach((node) => {
        if (node.checked) clear.push(node.dataset.clearKey ?? "");
      });
      if (!Object.keys(values).length && !clear.length) {
        setStatus("Enter a key or choose Remove.", "error");
        return;
      }
      save.disabled = true;
      test.disabled = true;
      setStatus("Saving to the OS credential store...", "muted");
      try {
        fields = await ctx.saveCredentials(values, clear);
        renderGrid();
        renderDetail();
        toast(`${entry.name} credentials saved`, "success");
        const current = fieldsFor(entry.id).filter((field) => field.kind !== "choice");
        if (current.length && current.every((field) => field.set)) {
          const market = entry.markets.find((item) => item.id === "futures") ?? entry.markets[0];
          if (market) {
            try {
              connection = await ctx.testConnection(entry.id, market.id);
              toast(`${entry.name} connected`, "success");
              renderDetail();
            } catch (error) {
              connection = null;
              toast(`${entry.name}: ${(error as Error).message}`, "error");
            }
          }
        }
      } catch (error) {
        setStatus((error as Error).message, "error");
      } finally {
        save.disabled = false;
      }
    });

    test.addEventListener("click", () => void runTest());

    remove.addEventListener("click", async () => {
      const clear = credentialFields.filter((field) => field.set).map((field) => field.key);
      if (!clear.length) return;
      if (!window.confirm(`Remove the stored ${entry.name} API keys?`)) return;
      remove.disabled = true;
      setStatus("Removing keys...", "muted");
      try {
        fields = await ctx.saveCredentials({}, clear);
        connection = null;
        renderGrid();
        renderDetail();
        toast(`${entry.name} keys removed`, "success");
      } catch (error) {
        setStatus((error as Error).message, "error");
        remove.disabled = false;
      }
    });

    detail.replaceChildren(card);
    if (connection) showConnection(connection);
  };

  renderGrid();
  renderDetail();

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
        fields = await ctx.importLegacyCredentials();
        renderGrid();
        renderDetail();
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
    exchangeSection.appendChild(legacyBox);
  }

  // ── Updates ─────────────────────────────────────────────────────────────
  const updates = section("TradePanel");
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

  updatesPage.appendChild(
    buildRuntimeSection(
      ctx,
      runtimeResult.status === "fulfilled" ? runtimeResult.value : null,
    ),
  );

  return {
    exchange: exchangePage,
    updates: updatesPage,
  };
}

/** Chips describing the active Pi runtime; refreshed by every check/update. */
function renderRuntimeMeta(
  target: HTMLElement,
  summary: AiRuntimeSummary | null,
  info: AiRuntimeUpdateInfo | null,
): void {
  const chips: HTMLElement[] = [];
  const piVersion = info?.currentVersion ?? summary?.piVersion;
  const nodeVersion = summary?.nodeVersion ?? info?.nodeVersion;
  if (piVersion) chips.push(el("span", "runtime-chip", `Pi ${piVersion}`));
  if (nodeVersion) chips.push(el("span", "runtime-chip", `Node ${nodeVersion}`));
  if (info?.target) chips.push(el("span", "runtime-chip", info.target));
  if (info?.managed) {
    chips.push(el("span", "runtime-chip accent", "Updated from npm"));
  }
  if (!chips.length) chips.push(el("span", "runtime-chip", "Runtime unavailable"));
  target.replaceChildren(...chips);
}

function buildRuntimeSection(ctx: SettingsContext, initial: AiRuntimeSummary | null): HTMLElement {
  const runtimeSection = el("div", "section runtime-card");
  const head = el("div", "settings-section-head");
  const headText = el("div");
  headText.append(
    el("h3", undefined, "Pi coding agent"),
    el(
      "p",
      undefined,
      "Checks npm for a newer @earendil-works/pi-coding-agent release and refreshes " +
      "the npm packages it depends on. Updates install into your user data folder; " +
      "the TradePanel installation is never modified.",
    ),
  );
  head.appendChild(headText);
  runtimeSection.appendChild(head);

  const meta = el("div", "runtime-meta");
  runtimeSection.appendChild(meta);

  const status = el(
    "div",
    "field-hint",
    initial?.ready === false
      ? initial.error ?? "The AI runtime is unavailable."
      : "Check the npm registry for a newer Pi release.",
  );
  status.setAttribute("aria-live", "polite");

  const progress = el("div", "runtime-progress");
  progress.setAttribute("role", "log");
  progress.setAttribute("aria-live", "polite");
  progress.setAttribute("aria-label", "AI runtime update progress");

  const actions = el("div", "runtime-actions");
  const check = el("button", "ghost-btn", "Check for AI updates");
  check.type = "button";
  const update = el("button", "ghost-btn", "Update AI runtime");
  update.type = "button";
  update.hidden = true;
  actions.append(check, update);
  runtimeSection.append(actions, progress, status);

  let busy = false;
  let latest: AiRuntimeUpdateInfo | null = null;
  renderRuntimeMeta(meta, initial, null);

  const setBusy = (value: boolean) => {
    busy = value;
    check.disabled = value || initial?.ready === false;
    update.disabled = value;
    runtimeSection.setAttribute("aria-busy", String(value));
  };

  const appendProgress = (message: string) => {
    progress.appendChild(el("div", "runtime-progress-line", message));
    while (progress.childElementCount > 40) progress.firstElementChild?.remove();
    progress.scrollTop = progress.scrollHeight;
  };

  const refreshSummary = async () => {
    try {
      const summary = await ctx.runtimeInfo();
      renderRuntimeMeta(meta, summary, latest);
      return summary;
    } catch {
      return null;
    }
  };

  setBusy(false);

  check.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    check.textContent = "Checking…";
    status.textContent = "Checking the npm registry…";
    progress.replaceChildren();
    try {
      const info = await ctx.checkAiRuntimeUpdate();
      latest = info;
      renderRuntimeMeta(meta, await refreshSummary(), info);
      if (info.available) {
        const dependencies = info.dependencyCount
          ? ` · ${info.dependencyCount} npm dependencies`
          : "";
        status.textContent =
          `Pi ${info.latestVersion} is available (current ${info.currentVersion})` +
          `${dependencies}.`;
        update.textContent = `Update to Pi ${info.latestVersion}`;
        update.hidden = false;
      } else if (info.currentVersion === info.latestVersion) {
        status.textContent = `Pi ${info.currentVersion} is the latest release.`;
        update.hidden = true;
      } else {
        status.textContent =
          `Pi ${info.currentVersion} is newer than the npm latest tag ` +
          `(${info.latestVersion}).`;
        update.hidden = true;
      }
    } catch (error) {
      status.textContent = (error as Error).message;
      update.hidden = true;
    } finally {
      check.textContent = "Check for AI updates";
      setBusy(false);
    }
  });

  update.addEventListener("click", async () => {
    if (busy || !latest?.available) return;
    const confirmed = window.confirm(
      `Download and install Pi ${latest.latestVersion} with its npm dependencies? ` +
      "The AI runtime restarts and a running analysis is stopped. Conversations and " +
      "sign-ins are kept.",
    );
    if (!confirmed) return;
    setBusy(true);
    update.textContent = "Installing…";
    progress.replaceChildren();
    status.textContent = `Installing Pi ${latest.latestVersion}…`;
    appendProgress(`Target: Pi ${latest.latestVersion}`);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await ctx.onAiRuntimeUpdateProgress((event: AiRuntimeUpdateProgress) => {
        appendProgress(event.message);
        if (event.phase !== "done") status.textContent = event.message;
      });
    } catch {
      // Progress events are an enhancement; the command result still reports
      // success or the failing step.
    }
    try {
      const result = await ctx.installAiRuntimeUpdate();
      latest = result;
      update.hidden = true;
      const summary = await refreshSummary();
      renderRuntimeMeta(meta, summary, result);
      status.textContent =
        `Pi ${result.currentVersion} is active. New analyses use the updated runtime.`;
      toast(`AI runtime updated to Pi ${result.currentVersion}`, "success");
    } catch (error) {
      status.textContent = (error as Error).message;
      toast("AI runtime update failed", "error");
      await refreshSummary();
    } finally {
      unlisten?.();
      update.textContent = `Update to Pi ${latest?.latestVersion ?? "newest"}`;
      setBusy(false);
    }
  });

  return runtimeSection;
}
