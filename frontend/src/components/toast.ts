export type ToastKind = "info" | "success" | "error";

const MAX_TOASTS = 4;

export function toast(message: string, kind: ToastKind = "info", timeoutMs = 4200): void {
  const root = document.getElementById("toasts");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  root.appendChild(node);
  while (root.children.length > MAX_TOASTS) root.firstElementChild?.remove();
  window.setTimeout(() => {
    node.style.opacity = "0";
    window.setTimeout(() => node.remove(), 180);
  }, timeoutMs);
}
