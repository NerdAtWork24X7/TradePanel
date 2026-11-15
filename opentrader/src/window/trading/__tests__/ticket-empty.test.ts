import { describe, expect, it } from "vitest";
import type { Tradability } from "../../../data/trading/replay-broker";
import { fixLabel, fixOf } from "../TicketEmpty";

const state = (extra: Partial<Tradability>): Tradability => ({ ok: false, reason: "launch", title: "", text: "", ...extra });

describe("the order ticket's empty state", () => {
  it("offers nothing while it is tradable or still resolving the symbol", () => {
    expect(fixOf(state({ ok: true, reason: "ok" }), true)).toBeNull();
    expect(fixOf(state({ reason: "loading" }), true)).toBeNull();
  });

  it("sends a browser build to the desktop app, where plugins run", () => {
    expect(fixOf(state({ fix: "connect" }), false)).toBe("desktop");
    expect(fixOf(state({ fix: "exchanges" }), false)).toBe("desktop");
  });

  it("keeps the fix the broker named", () => {
    expect(fixOf(state({ fix: "install" }), true)).toBe("install");
    expect(fixOf(state({ fix: "connect" }), true)).toBe("connect");
    expect(fixOf(state({ fix: "exchanges" }), true)).toBe("exchanges");
  });

  it("offers nothing when there is nothing to click (no chart)", () => {
    expect(fixOf(state({ title: "", text: "Select a chart to trade its symbol." }), true)).toBeNull();
  });

  it("labels every fix", () => {
    for (const fix of ["desktop", "install", "connect", "exchanges"] as const) {
      expect(fixLabel(fix).length).toBeGreaterThan(0);
    }
  });
});
