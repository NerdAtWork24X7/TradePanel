/*
 * The analysis's study runner: one of the user's chart studies on one analysis
 * timeframe's bars, through the engine the alerts use (`alert-studies.runStudy`
 * — the study's own `calculate` with the chart context of the symbol, interval
 * and session). No indicator is hardcoded: whatever the chart shows is run.
 *
 * `ChartAnalyst` injects this into `buildAnalystSnapshot`; a test injects its
 * own, so the snapshot is built without the indicator library.
 */
import { getIndicatorEntry, loadIndicatorLibrary } from "../window/chart/indicators/registry";
import { runStudy } from "./alert-studies";
import type { AnalystBar, AnalystStudyRun, StudyValue } from "./analyst-context";
import type { SessionId } from "./session";

/** Latest finite value of one plot series of a study result. */
function lastPlotValue(result: unknown, plotId: string): number | null {
  const series = (result as { plots?: Record<string, Array<{ value: number | null }>> } | null)?.plots?.[plotId];
  if (!series) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i]?.value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** The runner the analyst injects: the chart symbol's studies, run on each timeframe's bars. */
export function createChartStudyRunner(symbol: string): AnalystStudyRun {
  return async (study, bars: readonly AnalystBar[], resolution: string, session: SessionId): Promise<StudyValue> => {
    await loadIndicatorLibrary();
    const entry = getIndicatorEntry(study.id);
    if (!entry) return { plots: [], error: "its definition is not available" };
    try {
      const { result } = runStudy(entry, bars as unknown[], study.inputValues ?? {}, symbol, resolution, session);
      const plots = entry.plotConfig.flatMap((plot, index) => {
        const value = lastPlotValue(result, plot.id);
        return value == null ? [] : [{ plot: index, title: plot.title ?? plot.id, value }];
      });
      return { plots };
    } catch (error) {
      return { plots: [], error: error instanceof Error ? error.message : String(error) };
    }
  };
}
