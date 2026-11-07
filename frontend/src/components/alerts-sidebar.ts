/**
 * Alerts sidebar: the workspace's price-alert rules and per-session fire log.
 *
 * The chart iframe owns evaluation and persistence; this panel is a view plus
 * intent dispatcher. It never evaluates prices itself, so a row can only show
 * what the workspace last reported.
 */
import { iconSpan } from "../lib/icons";
import type {
  WorkspaceAlert,
  WorkspaceAlertLogEntry,
  WorkspaceAlertSnapshot,
} from "../types";

export interface AlertsSidebarHandlers {
  create(): void;
  refresh(): void;
  focus(id: string): void;
  edit(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  rearm(id: string): void;
  remove(id: string): void;
  setSound(on: boolean): void;
  clearLog(): void;
}

type View = "rules" | "log";

const CONDITION_LABELS: Record<string, string> = {
  crossing: "crossing",
  "crossing-up": "crossing up",
  "crossing-down": "crossing down",
  greater: "above",
  less: "below",
};

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing alerts sidebar element #${id}`);
  return node as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function money(value: number, precision: number): string {
  if (!Number.isFinite(value)) return "—";
  const places = Math.max(0, Math.min(8, Math.round(precision)));
  const parts = value.toFixed(places).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}

function clock(ms: number, seconds = false): string {
  if (!ms) return "";
  const iso = new Date(ms).toISOString();
  return iso.slice(11, seconds ? 19 : 16) + " UTC";
}

function isOnce(alert: WorkspaceAlert): boolean {
  return alert.frequency !== "repeating";
}

function stateOf(alert: WorkspaceAlert): { label: string; tone: string } {
  if (!alert.enabled) return { label: "Paused", tone: "paused" };
  if (alert.source === "indicator" && !alert.attached) {
    return { label: "Chart closed", tone: "paused" };
  }
  if (alert.fired && isOnce(alert)) return { label: "Triggered", tone: "fired" };
  return { label: "Active", tone: "live" };
}

function conditionText(alert: WorkspaceAlert): string {
  if (alert.source === "indicator") {
    const name = alert.indicatorName || alert.indicatorId || "Indicator";
    const condition = alert.conditionTitle || alert.conditionId || "alert";
    return `${name} · ${condition}`;
  }
  const label = CONDITION_LABELS[alert.condition] || "crossing";
  return `${label} ${money(alert.price ?? 0, alert.precision)}`;
}

export class AlertsSidebar {
  private readonly list = must<HTMLElement>("alerts-side-list");
  private readonly ruleTab = must<HTMLButtonElement>("alerts-view-rules");
  private readonly logTab = must<HTMLButtonElement>("alerts-view-log");
  private readonly ruleCount = must<HTMLElement>("alerts-side-rules-count");
  private readonly logCount = must<HTMLElement>("alerts-side-log-count");
  private readonly sound = must<HTMLButtonElement>("alerts-side-sound");
  private readonly newButton = must<HTMLButtonElement>("alerts-side-new");
  private readonly refreshButton = must<HTMLButtonElement>("alerts-side-refresh");
  private readonly clearButton = must<HTMLButtonElement>("alerts-side-clear");
  private readonly tabCount = must<HTMLElement>("sidebar-tab-alert-count");
  private readonly tabButton = must<HTMLButtonElement>("sidebar-tab-alerts");
  private snapshot: WorkspaceAlertSnapshot = {
    version: 1,
    alerts: [],
    log: [],
    sound: true,
    activeCount: 0,
    focused: null,
  };
  private view: View = "rules";
  private visible = false;

  constructor(private readonly handlers: AlertsSidebarHandlers) {
    this.ruleTab.addEventListener("click", () => this.setView("rules"));
    this.logTab.addEventListener("click", () => this.setView("log"));
    for (const tab of [this.ruleTab, this.logTab]) {
      tab.addEventListener("keydown", (event) => {
        const next = event.key === "ArrowLeft" || event.key === "Home"
          ? "rules"
          : event.key === "ArrowRight" || event.key === "End" ? "log" : null;
        if (!next) return;
        event.preventDefault();
        this.setView(next);
        (next === "rules" ? this.ruleTab : this.logTab).focus();
      });
    }
    this.newButton.addEventListener("click", () => this.handlers.create());
    this.refreshButton.addEventListener("click", () => this.handlers.refresh());
    this.sound.addEventListener("click", () => this.handlers.setSound(!this.snapshot.sound));
    this.clearButton.addEventListener("click", () => this.handlers.clearLog());
    this.render();
  }

  /** A fresh snapshot from the workspace (also updates the tab badge). */
  update(snapshot: WorkspaceAlertSnapshot): void {
    this.snapshot = snapshot;
    this.renderBadge();
    if (this.visible) this.render();
  }

  onShow(): void {
    this.visible = true;
    this.render();
    this.handlers.refresh();
  }

  onHide(): void {
    this.visible = false;
  }

  private setView(view: View): void {
    if (this.view === view) return;
    this.view = view;
    this.render();
  }

  private renderBadge(): void {
    const active = this.snapshot.activeCount;
    this.tabCount.textContent = active > 99 ? "99+" : String(active);
    this.tabCount.hidden = active === 0;
    this.tabCount.title = active
      ? `${active} active alert${active === 1 ? "" : "s"}`
      : "No active alerts";
    this.tabButton.setAttribute(
      "aria-label",
      active ? `Alerts, ${active} active` : "Alerts",
    );
  }

  private render(): void {
    const alerts = this.snapshot.alerts;
    const log = this.snapshot.log;
    this.renderBadge();

    this.ruleCount.textContent = String(alerts.length);
    this.logCount.textContent = String(log.length);
    this.ruleTab.setAttribute("aria-selected", String(this.view === "rules"));
    this.logTab.setAttribute("aria-selected", String(this.view === "log"));
    this.ruleTab.tabIndex = this.view === "rules" ? 0 : -1;
    this.logTab.tabIndex = this.view === "log" ? 0 : -1;
    this.clearButton.hidden = this.view !== "log";
    this.clearButton.disabled = log.length === 0;
    this.newButton.hidden = this.view !== "rules";
    this.sound.hidden = this.view !== "rules";
    this.sound.setAttribute("aria-pressed", String(this.snapshot.sound));
    this.sound.title = this.snapshot.sound ? "Alert sound on" : "Alert sound muted";
    this.sound.setAttribute("aria-label", this.sound.title);
    this.sound.replaceChildren(iconSpan("settings-general", 18, "alert-tool-icon"));
    this.refreshButton.replaceChildren(iconSpan("scr-refresh", 16, "alert-tool-icon"));
    this.newButton.replaceChildren(
      iconSpan("dt-add-alert", 16, "alert-tool-icon"),
      element("span", "", "New"),
    );

    const scroll = this.list.scrollTop;
    this.list.replaceChildren();
    if (this.view === "log") {
      this.renderLog(log);
    } else if (alerts.length === 0) {
      this.renderEmptyRules();
    } else {
      const sorted = [...alerts].sort((a, b) => {
        const rank = (alert: WorkspaceAlert) =>
          !alert.enabled ? 2 : alert.fired && isOnce(alert) ? 1 : 0;
        return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol) ||
          (a.price ?? 0) - (b.price ?? 0);
      });
      for (const alert of sorted) this.list.appendChild(this.alertRow(alert));
    }
    this.list.scrollTop = scroll;
  }

  private renderEmptyRules(): void {
    const empty = element("div", "alerts-side-empty");
    empty.appendChild(iconSpan("dt-add-alert", 24));
    empty.appendChild(element("b", "", "No alerts yet"));
    empty.appendChild(element(
      "p", "",
      "Place a price alert with the bell in a chart header, or add an indicator alert from a study's Alerts settings.",
    ));
    this.list.appendChild(empty);
  }

  private alertRow(alert: WorkspaceAlert): HTMLElement {
    const state = stateOf(alert);
    const card = element("article", `alert-item ${state.tone}${alert.enabled ? "" : " off"}`);
    card.dataset.alertId = alert.id;

    const top = element("div", "alert-item-top");
    const jump = element("button", "alert-jump");
    jump.type = "button";
    jump.title = "Show this alert on its chart";
    jump.appendChild(element("span", "alert-symbol", alert.symbol));
    const venue = [alert.exchange.toUpperCase(), alert.timeframe].filter(Boolean).join(" · ");
    jump.appendChild(element("span", "alert-venue", venue || alert.market.toUpperCase()));
    jump.addEventListener("click", () => this.handlers.focus(alert.id));
    top.appendChild(jump);
    top.appendChild(element("span", `alert-state ${state.tone}`, state.label));
    card.appendChild(top);

    const condition = element("div", "alert-cond");
    condition.appendChild(document.createTextNode(conditionText(alert)));
    if (alert.frequency === "repeating") {
      condition.appendChild(element("span", "alert-repeat", "every time"));
    }
    card.appendChild(condition);

    if (alert.note) card.appendChild(element("p", "alert-note", alert.note));

    const meta = element("div", "alert-meta");
    if (alert.current != null) {
      meta.appendChild(element("span", "", "now "));
      meta.appendChild(element("b", "mono", money(alert.current, alert.precision)));
    } else {
      meta.appendChild(element(
        "span",
        "alert-muted",
        alert.source === "indicator" ? "waiting for signal" : "waiting for price",
      ));
    }
    if (alert.distance != null) {
      const distance = alert.distance;
      meta.appendChild(element(
        "span",
        `alert-distance ${distance >= 0 ? "up" : "down"}`,
        `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%`,
      ));
    }
    if (alert.count > 0) {
      meta.appendChild(element("span", "alert-hit-count", `${alert.count}×`));
    }
    if (alert.lastAt) {
      meta.appendChild(element("span", "alert-last", clock(alert.lastAt)));
    }
    card.appendChild(meta);

    const actions = element("div", "alert-actions");
    const enabled = alert.enabled;
    const rearm = enabled && alert.fired && isOnce(alert);
    const toggle = element("button", "alert-act", enabled ? (rearm ? "Re-arm" : "Pause") : "Resume");
    toggle.type = "button";
    toggle.title = enabled ? (rearm ? "Re-arm this alert" : "Pause this alert") : "Resume this alert";
    toggle.addEventListener("click", () => {
      if (rearm) this.handlers.rearm(alert.id);
      else this.handlers.setEnabled(alert.id, !enabled);
    });
    actions.appendChild(toggle);

    const edit = element("button", "icon-btn alert-act-icon");
    edit.type = "button";
    edit.title = "Edit alert";
    edit.setAttribute("aria-label", "Edit alert");
    edit.appendChild(iconSpan("menu-manage-layouts-rename", 16, "alert-tool-icon"));
    edit.addEventListener("click", () => this.handlers.edit(alert.id));
    actions.appendChild(edit);

    const remove = element("button", "icon-btn alert-act-icon danger");
    remove.type = "button";
    remove.title = "Delete alert";
    remove.setAttribute("aria-label", "Delete alert");
    remove.appendChild(iconSpan("scr-trash", 16, "alert-tool-icon"));
    remove.addEventListener("click", () => this.handlers.remove(alert.id));
    actions.appendChild(remove);

    card.appendChild(actions);
    return card;
  }

  private renderLog(log: WorkspaceAlertLogEntry[]): void {
    const head = element("div", "alerts-log-lead");
    head.appendChild(element("span", "", "Triggered this session"));
    head.appendChild(element("span", "alert-muted", "newest first"));
    this.list.appendChild(head);
    if (log.length === 0) {
      const empty = element("div", "alerts-side-empty");
      empty.appendChild(iconSpan("settings-alerts", 24));
      empty.appendChild(element("b", "", "No triggers yet"));
      empty.appendChild(element(
        "p", "",
        "Alerts evaluate while TradePanel is running. A fire appears here and as a shell notification.",
      ));
      this.list.appendChild(empty);
      return;
    }
    for (const fire of log) {
      const row = element("div", "alert-log-item");
      row.appendChild(element("span", "alert-log-time", clock(fire.time, true)));
      const body = element("div", "alert-log-body");
      body.appendChild(element("p", "alert-log-message", fire.message));
      const meta = element("div", "alert-log-meta");
      if (fire.price != null) {
        meta.appendChild(element("b", "mono", money(fire.price, fire.precision)));
      }
      meta.appendChild(element("span", "alert-muted", fire.source === "replay" ? "replay" : "live"));
      body.appendChild(meta);
      row.appendChild(body);
      this.list.appendChild(row);
    }
  }
}
