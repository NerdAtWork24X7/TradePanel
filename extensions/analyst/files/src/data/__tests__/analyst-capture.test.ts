import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCaptureSpec, saveCaptureSpec, takeCaptureSpec, type AnalystCaptureSpec } from "../analyst-capture";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

const spec = (id: string): AnalystCaptureSpec => ({
  id,
  symbol: "BINANCE:BTC/USDT",
  targets: [
    { interval: "1D", label: "1d" },
    { interval: "240", label: "4h" },
    { interval: "5", label: "5m" },
  ],
  pane: { symbol: "BINANCE:BTC/USDT", interval: "5", indicators: [] } as unknown as AnalystCaptureSpec["pane"],
  indicatorsHidden: false,
  theme: "dark",
  timeZone: "UTC",
  timeZoneLabel: "UTC",
});

describe("analysis capture job", () => {
  it("hands the job to the capture window once", () => {
    saveCaptureSpec(spec("a1"));
    expect(takeCaptureSpec("a1")?.symbol).toBe("BINANCE:BTC/USDT");
    // Taken: a reload of the window cannot render a stale job.
    expect(takeCaptureSpec("a1")).toBeNull();
  });

  it("rejects another id, a malformed job and an unknown theme", () => {
    saveCaptureSpec(spec("a2"));
    expect(takeCaptureSpec("other")).toBeNull();

    localStorage.setItem(
      "ot:analysis-capture:spec:bad",
      JSON.stringify({ ...spec("bad"), targets: [{ interval: 1 }] }),
    );
    expect(takeCaptureSpec("bad")).toBeNull();

    localStorage.setItem("ot:analysis-capture:spec:theme", JSON.stringify({ ...spec("theme"), theme: "blue" }));
    expect(takeCaptureSpec("theme")).toBeNull();
  });

  it("drops a job whose window never opened", () => {
    saveCaptureSpec(spec("a3"));
    clearCaptureSpec("a3");
    expect(takeCaptureSpec("a3")).toBeNull();
  });
});
