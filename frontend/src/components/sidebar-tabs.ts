/**
 * Sidebar view switcher: the trade ticket, AI analysis and alerts share the
 * right column but never split its height. Implements the WAI-ARIA tabs pattern
 * (roving tabindex, arrow/Home/End keys) and remembers the last view.
 *
 * Panels are looked up through each tab's `aria-controls`, so the markup owns
 * the pairing and this module owns only behaviour.
 */

const TAB_STORAGE_KEY = "tp-sidebar-tab";

export type SidebarTabId = "trade" | "ai" | "alerts";

function isTabId(value: unknown): value is SidebarTabId {
  return value === "trade" || value === "ai" || value === "alerts";
}

function readStoredTab(): SidebarTabId {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    if (isTabId(stored)) return stored;
  } catch {
    /* storage can disappear; fall back to the trade view */
  }
  return "trade";
}

export class SidebarTabs {
  private readonly tabs: HTMLButtonElement[];
  private readonly panels = new Map<SidebarTabId, HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (tab: SidebarTabId) => void,
  ) {
    this.tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    if (!this.tabs.length) throw new Error("Sidebar tab strip has no tabs");
    for (const tab of this.tabs) {
      const id = tab.dataset.tab;
      if (!isTabId(id)) throw new Error(`Sidebar tab "${id}" is not a known view`);
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (!panel) throw new Error(`Sidebar tab "${id}" has no panel`);
      this.panels.set(id, panel);
    }
    this.bind();
    this.setActive(readStoredTab(), false);
  }

  select(tab: SidebarTabId, focus = false): void {
    this.setActive(tab, true);
    if (focus) this.tabFor(tab).focus();
  }

  private tabFor(id: SidebarTabId): HTMLButtonElement {
    const tab = this.tabs.find((candidate) => candidate.dataset.tab === id);
    if (!tab) throw new Error(`Sidebar tab "${id}" is missing`);
    return tab;
  }

  private setActive(tab: SidebarTabId, persist: boolean): void {
    this.root.dataset.active = tab;
    for (const [id, panel] of this.panels) {
      panel.hidden = id !== tab;
    }
    for (const button of this.tabs) {
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (persist) {
      try {
        localStorage.setItem(TAB_STORAGE_KEY, tab);
      } catch {
        /* view still switches for this session */
      }
    }
    this.onChange(tab);
  }

  private bind(): void {
    for (const button of this.tabs) {
      button.addEventListener("click", () => {
        const id = button.dataset.tab;
        if (isTabId(id)) this.setActive(id, true);
      });
      button.addEventListener("keydown", (event) => this.onKeydown(event, button));
    }
  }

  private onKeydown(event: KeyboardEvent, button: HTMLButtonElement): void {
    const index = this.tabs.indexOf(button);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % this.tabs.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + this.tabs.length) % this.tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = this.tabs.length - 1;
        break;
      default:
        return;
    }
    const target = this.tabs[next];
    const id = target?.dataset.tab;
    if (!isTabId(id)) return;
    event.preventDefault();
    this.select(id, true);
  }
}
