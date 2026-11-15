import { describe, expect, it } from "vitest";
import { tradePlan } from "../plan";

const base = { entry: 100, qty: 2, balance: 1_000 } as const;

describe("tradePlan", () => {
  it("measures a long's risk and reward at both levels", () => {
    const p = tradePlan({ ...base, side: "buy", stop: 90, target: 120 })!;
    expect(p.risk).toBe(20);
    expect(p.reward).toBe(40);
    expect(p.rr).toBe(2);
    expect(p.riskPct).toBe(2);
    expect(p.rewardPct).toBe(4);
    expect(p.balanceAtStop).toBe(980);
    expect(p.balanceAtTarget).toBe(1_040);
    expect(p.wrongSide).toBeNull();
  });

  it("measures a short the other way", () => {
    const p = tradePlan({ ...base, side: "sell", stop: 110, target: 80 })!;
    expect(p.risk).toBe(20);
    expect(p.reward).toBe(40);
    expect(p.rr).toBe(2);
  });

  it("reports a target on the wrong side instead of a profit", () => {
    const p = tradePlan({ ...base, side: "buy", stop: 90, target: 80 })!;
    expect(p.wrongSide).toBe("target");
    expect(p.reward).toBeNull();
    expect(p.rr).toBeNull();
    expect(p.balanceAtTarget).toBeNull();
  });

  it("reports a stop on the wrong side", () => {
    const p = tradePlan({ ...base, side: "sell", stop: 90, target: 80 })!;
    expect(p.wrongSide).toBe("stop");
    expect(p.risk).toBeNull();
    expect(p.balanceAtStop).toBeNull();
  });

  it("shows one level alone", () => {
    const p = tradePlan({ ...base, side: "buy", stop: 95, target: null })!;
    expect(p.risk).toBe(10);
    expect(p.reward).toBeNull();
    expect(p.rr).toBeNull();
    expect(p.balanceAtStop).toBe(990);
  });

  it("hides balance figures without a balance", () => {
    const p = tradePlan({ ...base, balance: 0, side: "buy", stop: 90, target: 110 })!;
    expect(p.riskPct).toBeNull();
    expect(p.balanceAtStop).toBeNull();
    expect(p.rr).toBe(1);
  });

  it("is null until the entry and quantity are there", () => {
    expect(tradePlan({ ...base, entry: null, side: "buy", stop: 90, target: 110 })).toBeNull();
    expect(tradePlan({ ...base, qty: 0, side: "buy", stop: 90, target: 110 })).toBeNull();
  });

  it("avoids dividing by an entry at the stop", () => {
    const p = tradePlan({ ...base, side: "buy", stop: 100, target: 110 })!;
    expect(p.wrongSide).toBe("stop");
    expect(p.rr).toBeNull();
  });
});
