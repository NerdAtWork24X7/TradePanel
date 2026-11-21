import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("../kv", () => ({
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
}));

const { analystPortfolioContext, setAnalystPortfolioContext } = await import("../analyst-settings");

beforeEach(() => store.clear());

describe("analyst portfolio context", () => {
  it("is off until the user enables it, and remembers the choice", () => {
    expect(analystPortfolioContext()).toBe(false);
    setAnalystPortfolioContext(true);
    expect(analystPortfolioContext()).toBe(true);
    setAnalystPortfolioContext(false);
    expect(analystPortfolioContext()).toBe(false);
  });

  it("ignores unrelated or corrupt values", () => {
    store.set("ot:analyst:portfolio-context:v1", "yes");
    expect(analystPortfolioContext()).toBe(false);
  });
});
