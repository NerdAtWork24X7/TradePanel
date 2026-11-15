/*
 * A chart picture for Analyze chart: the rendered chart canvas, compressed
 * when a PNG would be too large for the runtime, with the symbol and interval
 * added as a header so the model can tell the three pictures apart.
 */
export const CAPTURE_WIDTH = 1120;
export const CAPTURE_HEIGHT = 700;
/** Per-picture base64 cap: three pictures fit the runtime's 5 MB total. */
const MAX_IMAGE_CHARS = 1_450_000;

/** A data URL of `canvas`, compressed when a PNG would be too large for the runtime. */
export function encodePicture(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL("image/png");
  if (png.length <= MAX_IMAGE_CHARS) return png;
  for (const [width, quality] of [
    [1000, 0.84],
    [820, 0.76],
    [640, 0.62],
  ] as const) {
    const scale = Math.min(1, width / canvas.width);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    out.getContext("2d")?.drawImage(canvas, 0, 0, out.width, out.height);
    const jpeg = out.toDataURL("image/jpeg", quality);
    if (jpeg.length <= MAX_IMAGE_CHARS) return jpeg;
  }
  return png;
}

/** Add "SYMBOL · 1D" above the chart so the model can tell the pictures apart. */
export function labelled(canvas: HTMLCanvasElement, symbol: string, label: string, theme: "dark" | "light"): HTMLCanvasElement {
  const dpr = Math.max(1, Math.round(canvas.width / CAPTURE_WIDTH));
  const header = Math.round(30 * dpr);
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height + header;
  const ctx = out.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = theme === "light" ? "#FFFFFF" : "#1F1F1F";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = theme === "light" ? "#0F0F0F" : "#DBDBDB";
  ctx.font = `600 ${Math.round(13 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.fillText(`${symbol} · ${label.toUpperCase()}`, Math.round(10 * dpr), header / 2);
  ctx.drawImage(canvas, 0, header);
  return out;
}
