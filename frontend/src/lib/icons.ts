/*
 * Icon helpers for the shell bundle.
 *
 * The icon data is generated from the same SVGs the chart workspace uses, so
 * both surfaces share one visual language. Icons inherit `currentColor` and
 * are sized by the caller (default 18px).
 */
import { ICON_DATA, type IconRecord } from "./icons-data";

export type { IconRecord };

const cache = new Map<string, string>();

function record(name: string): IconRecord | undefined {
  const icon = ICON_DATA[name];
  if (!icon) {
    return undefined;
  }
  return icon;
}

/** Markup for an icon. Returns an empty string when the name is unknown. */
export function iconSvg(name: string, size = 18, className = ""): string {
  const key = `${name}:${size}:${className}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const icon = record(name);
  const markup = icon
    ? `<svg viewBox="${icon.v}" width="${size}" height="${size}"${className ? ` class="${className}"` : ""} fill="currentColor" aria-hidden="true" focusable="false">${icon.b}</svg>`
    : "";
  cache.set(key, markup);
  return markup;
}

/** Replace an element's content with the named icon. */
export function setIcon(element: Element | null, name: string, size = 18): void {
  if (!element) return;
  element.innerHTML = iconSvg(name, size);
  element.setAttribute("data-icon", name);
}

/** Create a standalone icon span (handy for dynamically built rows). */
export function iconSpan(name: string, size = 18, className = "icon"): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = iconSvg(name, size);
  span.setAttribute("aria-hidden", "true");
  return span;
}

/** Fill every `[data-icon]` placeholder under `root`. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
    const name = element.dataset.icon;
    if (!name) return;
    const size = Number(element.dataset.iconSize) || 18;
    element.innerHTML = iconSvg(name, size);
  });
}
