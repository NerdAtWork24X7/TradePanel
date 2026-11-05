import { openModal } from "./modal";
import { toast } from "./toast";

export interface AlertDialogContext {
  coin: string;
  load(): Promise<{ high: number | null; low: number | null }>;
  save(high: number, low: number): Promise<void>;
}

export async function openAlertDialog(ctx: AlertDialogContext): Promise<void> {
  const form = document.createElement("div");
  form.className = "grid";

  const high = document.createElement("input");
  const low = document.createElement("input");
  for (const [label, input] of [["FVG high", high], ["FVG low", low]] as const) {
    input.type = "number";
    input.step = "any";
    input.classList.add("mono");
    input.autocomplete = "off";
    const wrap = document.createElement("div");
    wrap.className = "field";
    const id = `alert-${label.replace(/\s+/g, "-").toLowerCase()}`;
    const text = document.createElement("label");
    text.textContent = label;
    text.htmlFor = id;
    input.id = id;
    wrap.append(text, input);
    form.appendChild(wrap);
  }

  const error = document.createElement("div");
  error.className = "inline-error";
  form.appendChild(error);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-btn";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-btn";
  save.textContent = "Save alert";

  const modal = openModal({
    title: `FVG alert · ${ctx.coin}`,
    subtitle: "Levels are stored in alerts.json and restored for this coin.",
    body: form,
    footer: [cancel, save],
    narrow: true,
  });
  cancel.addEventListener("click", modal.close);

  try {
    const current = await ctx.load();
    if (current.high !== null) high.value = String(current.high);
    if (current.low !== null) low.value = String(current.low);
  } catch {
    /* no stored alert for this coin */
  }

  save.addEventListener("click", async () => {
    error.textContent = "";
    if (!high.value.trim() || !low.value.trim()) {
      error.textContent = "Both levels are required.";
      return;
    }
    const highValue = Number(high.value);
    const lowValue = Number(low.value);
    if (!Number.isFinite(highValue) || !Number.isFinite(lowValue)) {
      error.textContent = "Both levels must be numbers.";
      return;
    }
    if (highValue <= lowValue) {
      error.textContent = "High must be greater than low.";
      return;
    }
    save.disabled = true;
    try {
      await ctx.save(highValue, lowValue);
      toast(`Alert saved for ${ctx.coin}`, "success");
      modal.close();
    } catch (cause) {
      error.textContent = (cause as Error).message;
    } finally {
      save.disabled = false;
    }
  });
}
