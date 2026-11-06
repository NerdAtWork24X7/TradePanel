import { toast } from "./toast";
import type { CredentialField } from "../types";
import type { UpdateInfo } from "../services/updates";
import type { LegacyCredentials } from "../services/credentials";

export interface SettingsContext {
  loadCredentials(): Promise<CredentialField[]>;
  saveCredentials(values: Record<string, string>, clear: string[]): Promise<CredentialField[]>;
  legacyCredentials(): Promise<LegacyCredentials>;
  importLegacyCredentials(): Promise<CredentialField[]>;
  checkUpdates(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
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
  credentials: HTMLElement;
  updates: HTMLElement;
}

export async function buildSettingsContent(ctx: SettingsContext): Promise<SettingsContent> {
  const [credentialsResult, legacyResult] = await Promise.allSettled([
    ctx.loadCredentials(),
    ctx.legacyCredentials(),
  ]);
  const credentialsPage = el("div", "settings-tab-page");
  const updatesPage = el("div", "settings-tab-page");

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

  return {
    credentials: credentialsPage,
    updates: updatesPage,
  };
}
