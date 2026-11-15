import { afterEach, describe, expect, it } from "vitest";
import type { DrawingLabel } from "lightweight-charts-drawing/core/labels";
import { drawingLabelFormatter } from "../drawing-labels";
import { setDictionary } from "../translator";
import { translatedPlotConfig, translatedStudyResult } from "../study-text";
import type { IndicatorResult } from "oakscriptjs";
import { libraryMonthRule } from "../format";

const ctx = { kind: "long-position", drawingId: "d1" };
const fmt = (l: { id: DrawingLabel["id"]; text: string; [field: string]: unknown }) => {
  const f = drawingLabelFormatter();
  return f ? f({ ...l, ...ctx } as DrawingLabel) : "(none)";
};

/** The words these labels carry, translated as a fixture (no language ships but English). */
const DICT = {
  "Head": "头部",
  "Add text": "添加文本",
  "{0} bars": "{0} 根K线",
  "{0}d": "{0}天",
  "{0}h": "{0}小时",
  "{0}m": "{0}分",
  "distance: {0} px": "距离：{0} 像素",
  "Vol {0}": "成交量 {0}",
  "Target": "目标",
  "Amount": "金额",
  "Open PnL": "未平仓盈亏",
  "Qty": "数量",
  "Risk/reward ratio": "风险回报比",
  "{0} in {1}": "{0}，用时 {1}",
  "Strong": "强烈",
  "Buy": "买入",
  "Upper Band #1": "上轨 #1",
};

afterEach(() => setDictionary({}));

describe("drawing labels in the interface language (#190)", () => {
  it("no hook in English", () => {
    expect(drawingLabelFormatter()).toBeUndefined();
  });

  it("words, values kept", () => {
    setDictionary(DICT);
    expect(fmt({ id: "caption", text: "Head" })).toBe("头部");
    expect(fmt({ id: "caption", text: "Add text" })).toBe("添加文本");
    expect(fmt({ id: "bars-range", text: "15 bars", bars: 15 })).toBe("15 根K线");
    expect(fmt({ id: "time-span", text: "1d 21h 30m", seconds: 163800 })).toBe("1天 21小时 30分");
    expect(fmt({ id: "time-span", text: "", seconds: 0 })).toBeUndefined();
    expect(fmt({ id: "distance", text: "distance: 25 px", distancePx: 25 })).toBe("距离：25 像素");
    expect(fmt({ id: "volume", text: "Vol 1.5 M", volume: 1.5e6 })).toBe("成交量 1.5 M");
    expect(fmt({ id: "volume", text: "1.5 M", volume: 1.5e6 })).toBeUndefined();
    expect(fmt({ id: "position-target", text: "Target: 30.00 (25.000%) 3,000, Amount: 1500", distance: 30, percent: 25, ticks: 3000, amount: 1500, pnl: 0, digits: 2 }))
      .toBe("目标: 30.00 (25.000%) 3,000, 金额: 1500");
    expect(fmt({ id: "position-middle", text: "Open PnL: +1.00, Qty: 3\nRisk/reward ratio: 2", pnl: 1, closed: false, qty: 3, ratio: 2 }))
      .toBe("未平仓盈亏: +1.00, 数量: 3\n风险回报比: 2");
    expect(fmt({ id: "forecast", text: "1.74 (7.04%) in 1d 21h", change: 1.74, percent: 7.04, seconds: 162000, digits: 2 })).toBe("1.74 (7.04%)，用时 1天 21小时");
    expect(fmt({ id: "price", text: "30.00", price: 30, digits: 2 })).toBeUndefined();
  });
});

describe("study text in the interface language (#190)", () => {
  const result = {
    metadata: { title: "T" },
    plots: {},
    markers: [{ time: 1, position: "aboveBar", shape: "labelDown", color: "#fff", text: "Strong\nBuy" }],
    labels: [{ time: 1, price: 1, text: "HH" }],
    tables: [{ position: "top_right", columns: 1, rows: 1, cells: [{ row: 0, column: 0, text: "Jan" }] }],
  } as unknown as IndicatorResult;

  it("the result as it is in English", () => {
    expect(translatedStudyResult(result)).toBe(result);
  });

  it("labels, shapes and tables; what the dictionary lacks stays", () => {
    setDictionary(DICT, [libraryMonthRule("zh-CN")]);
    const r = translatedStudyResult(result);
    expect(r.markers?.[0].text).toBe("强烈\n买入");
    expect(r.labels?.[0]).toBe(result.labels?.[0]);
    expect(r.tables?.[0].cells[0].text).toBe("1月");
    expect(result.markers?.[0].text).toBe("Strong\nBuy");
    expect(translatedPlotConfig([{ id: "a", title: "Upper Band #1" }])[0].title).toBe("上轨 #1");
  });
});
