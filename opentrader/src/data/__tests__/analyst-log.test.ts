import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const saved: string[] = [];
const deleted: string[] = [];

vi.mock("../kv", () => ({
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}));

vi.mock("../../bindings", () => ({
  commands: {
    saveAnalysisImage: vi.fn(async (_data: string, ext: string) => {
      const name = `${String(saved.length + 1).padStart(16, "0")}.${ext}`;
      saved.push(name);
      return { status: "ok", data: name, contentType: "image" };
    }),
    readAnalysisImage: vi.fn(async (name: string) => ({ status: "ok", data: btoa(`bytes-of-${name}`), contentType: "image" })),
    deleteAnalysisImage: vi.fn(async (name: string) => {
      deleted.push(name);
      return { status: "ok", data: null, contentType: "image" };
    }),
  },
}));

const { deleteAnalystLog, listAnalystLogs, MAX_ANALYST_LOGS, readAnalystLogImages, saveAnalystLog } = await import("../analyst-log");

const dataUrl = (label: string) =>
  `data:image/png;base64,${btoa(`chart-${label}`)}`;

beforeEach(() => {
  store.clear();
  saved.length = 0;
  deleted.length = 0;
});

describe("analysis log", () => {
  it("keeps the plan, the answer and the three chart pictures", async () => {
    const entry = await saveAnalystLog({
      symbol: "BINANCE:BTC/USDT",
      interval: "5",
      plan: {
        action: "long",
        entry: 100,
        takeProfit: 105,
        stopLoss: 98,
        probability: 72,
        basisTimeframe: "5m",
        rationale: "5m reclaimed the range high.",
        qty: 50,
        riskReward: 2.5,
        symbol: "BINANCE:BTC/USDT",
        timeframe: "5m",
        lastPrice: 100.5,
        acceptedAtMs: 1,
      },
      text: "Long above 98.",
      images: [
        { label: "1d", interval: "1D", dataUrl: dataUrl("1d") },
        { label: "4h", interval: "240", dataUrl: dataUrl("4h") },
        { label: "5m", interval: "5", dataUrl: dataUrl("5m") },
      ],
      model: "vision-model",
    });

    expect(entry.plan?.probability).toBe(72);
    expect(entry.images.map((i) => i.label)).toEqual(["1d", "4h", "5m"]);
    const [stored] = listAnalystLogs();
    expect(stored.id).toBe(entry.id);
    expect(stored.model).toBe("vision-model");

    const images = await readAnalystLogImages(stored);
    expect(images.map((i) => i.label)).toEqual(["1d", "4h", "5m"]);
    expect(images[0].dataUrl).toBe(`data:image/png;base64,${btoa("bytes-of-0000000000000001.png")}`);

    await deleteAnalystLog(entry.id);
    expect(listAnalystLogs()).toEqual([]);
    expect(deleted).toEqual(entry.images.map((i) => i.name));
  });

  it("drops the oldest entry and its pictures past the cap", async () => {
    for (let i = 0; i < MAX_ANALYST_LOGS + 2; i++) {
      await saveAnalystLog({ symbol: `S${i}`, interval: "5", plan: null, text: `answer ${i}` });
    }
    const logs = listAnalystLogs();
    expect(logs).toHaveLength(MAX_ANALYST_LOGS);
    expect(logs[0].symbol).toBe(`S${MAX_ANALYST_LOGS + 1}`);
  });

  it("ignores a corrupt stored log", () => {
    store.set("ot:analyst:log:v1", "{not json");
    expect(listAnalystLogs()).toEqual([]);
  });
});
