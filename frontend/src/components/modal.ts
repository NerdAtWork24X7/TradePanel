export interface ModalOptions {
  title: string;
  subtitle?: string;
  body: HTMLElement;
  footer?: HTMLElement[];
  narrow?: boolean;
  onClose?: () => void;
}

export interface ModalHandle {
  close(): void;
  root: HTMLElement;
}

let active: { close: () => void } | null = null;

export function openModal(options: ModalOptions): ModalHandle {
  const mount = document.getElementById("modal-root");
  if (!mount) throw new Error("Modal root missing");
  active?.close();

  const previousFocus = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const dialog = document.createElement("div");
  dialog.className = `modal${options.narrow ? " narrow" : ""}`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("header");
  const titles = document.createElement("div");
  const heading = document.createElement("h2");
  heading.id = `modal-title-${Date.now()}`;
  heading.textContent = options.title;
  dialog.setAttribute("aria-labelledby", heading.id);
  titles.appendChild(heading);
  if (options.subtitle) {
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = options.subtitle;
    titles.appendChild(sub);
  }
  header.appendChild(titles);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn close";
  closeBtn.setAttribute("aria-label", "Close dialog");
  closeBtn.textContent = "✕";
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "body";
  body.appendChild(options.body);

  const footer = document.createElement("footer");
  (options.footer ?? []).forEach((node) => footer.appendChild(node));

  dialog.append(header, body);
  if (footer.childElementCount > 0) dialog.appendChild(footer);
  backdrop.appendChild(dialog);
  mount.appendChild(backdrop);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    active = null;
    options.onClose?.();
    previousFocus?.focus?.();
  };

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);

  active = { close };
  window.setTimeout(() => {
    // Prefer the first real control in the body; the header close button must
    // not steal focus from the form the user opened the dialog for.
    const focusable =
      body.querySelector<HTMLElement>(
        "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])",
      ) ??
      dialog.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled])",
      );
    focusable?.focus();
  }, 0);

  return { close, root: dialog };
}

export function closeActiveModal(): void {
  active?.close();
}
