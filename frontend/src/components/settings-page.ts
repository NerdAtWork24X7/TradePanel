/**
 * Full-page settings, shaped like Pi Scope's settings surface: a section rail
 * on the left and one scrollable tab at a time. The AI tab hosts the Pi
 * connection view and the AI analysis indicator selection; the other tabs are
 * built from the credential/update form.
 */
import { toast } from "./toast";
import { buildSettingsContent, type SettingsContext } from "./settings";
import { iconSpan } from "../lib/icons";
import type { AiPanel } from "./ai-panel";

export type SettingsTab = "credentials" | "ai" | "updates";

interface TabDef {
  id: SettingsTab;
  label: string;
  hint: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "ai", label: "AI Analysis", hint: "Pi sign-in and model", icon: "ai-sparkle" },
  { id: "credentials", label: "Credentials", hint: "Hyperliquid API keys", icon: "dt-cm-lock" },
  { id: "updates", label: "Updates", hint: "Signed release channel", icon: "update-app-download" },
];

let panel: HTMLElement | null = null;
let nav: HTMLElement | null = null;
let aiPanelRef: AiPanel | null = null;
let previousFocus: HTMLElement | null = null;
let built = false;
let activeTab: SettingsTab = "ai";
let onKey: ((event: KeyboardEvent) => void) | null = null;

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing settings element #${id}`);
  return node as T;
}

function tabButton(def: TabDef): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-nav-item";
  button.dataset.tab = def.id;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", "false");
  const head = document.createElement("span");
  head.className = "settings-nav-head";
  const label = document.createElement("span");
  label.className = "settings-nav-label";
  label.textContent = def.label;
  head.append(iconSpan(def.icon, 17, "settings-nav-icon"), label);
  const hint = document.createElement("span");
  hint.className = "settings-nav-hint";
  hint.textContent = def.hint;
  button.append(head, hint);
  button.addEventListener("click", () => setTab(def.id));
  return button;
}

function ensureShell(): void {
  if (panel) return;
  panel = must<HTMLElement>("settings-page");
  nav = must<HTMLElement>("settings-nav");
  must<HTMLButtonElement>("settings-page-close").addEventListener("click", closeSettingsPage);
  for (const def of TABS) nav.appendChild(tabButton(def));
  onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !panel?.hidden) {
      event.preventDefault();
      closeSettingsPage();
    }
  };
  document.addEventListener("keydown", onKey, true);
}

function setTab(tab: SettingsTab): void {
  if (!panel) return;
  activeTab = tab;
  panel.querySelectorAll<HTMLButtonElement>(".settings-nav-item").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  panel.querySelectorAll<HTMLElement>(".settings-tab").forEach((node) => {
    node.hidden = node.dataset.tab !== tab;
  });
  if (tab === "ai" && aiPanelRef) aiPanelRef.openSettings();
}

export async function openSettingsPage(
  ctx: SettingsContext,
  aiPanel: AiPanel,
  tab: SettingsTab = "ai",
): Promise<void> {
  ensureShell();
  aiPanelRef = aiPanel;
  if (panel!.hidden) previousFocus = document.activeElement as HTMLElement | null;
  if (!built) {
    try {
      const settings = await buildSettingsContent(ctx);
      must<HTMLElement>("settings-tab-credentials").replaceChildren(settings.credentials);
      must<HTMLElement>("settings-tab-updates").replaceChildren(settings.updates);
      built = true;
    } catch (error) {
      toast((error as Error).message, "error");
      return;
    }
  }
  // The Pi connection markup ships inside the AI tab; it is created with the
  // document, so AiPanel already holds its element references.
  panel!.hidden = false;
  document.body.classList.add("settings-open");
  setTab(tab);
  window.setTimeout(() => must<HTMLButtonElement>("settings-page-close").focus(), 0);
}

export function closeSettingsPage(): void {
  if (!panel) return;
  panel.hidden = true;
  document.body.classList.remove("settings-open");
  built = false; // rebuild credentials and update state next time
  activeTab = "ai";
  previousFocus?.focus?.();
  previousFocus = null;
}

export function settingsPageOpen(): boolean {
  return Boolean(panel && !panel.hidden);
}

export function currentSettingsTab(): SettingsTab {
  return activeTab;
}
