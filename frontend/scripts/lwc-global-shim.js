/**
 * `lightweight-charts-indicators/render` imports the v5 series classes as a
 * regular dependency. The workspace and snapshot pages load the standalone
 * LWC bundle, which publishes the same classes on `window.LightweightCharts`,
 * so the esbuild alias points here instead of bundling a second chart engine.
 *
 * Keep this list in sync with the package: a renamed import fails the build.
 */
const LWC = globalThis.LightweightCharts;

export const createSeriesMarkers = LWC.createSeriesMarkers;
export const LineSeries = LWC.LineSeries;
export const HistogramSeries = LWC.HistogramSeries;
export const BaselineSeries = LWC.BaselineSeries;
export const CandlestickSeries = LWC.CandlestickSeries;
export const BarSeries = LWC.BarSeries;
export const LineStyle = LWC.LineStyle;
export const LineType = LWC.LineType;
export const customSeriesDefaultOptions = LWC.customSeriesDefaultOptions;
