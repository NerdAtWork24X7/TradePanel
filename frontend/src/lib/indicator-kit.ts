/**
 * Lazy access to the `lightweight-charts-indicators` engine.
 *
 * The engine is a ~10 MB IIFE emitted by `npm run indicators`; it is injected
 * on first use so the shell's first paint never parses it. `catalog.json`
 * carries the same registry metadata without the indicator code and feeds the
 * searchable pickers.
 */
import type { Candle } from "../types";

export interface IndicatorInputConfig {
  id: string;
  type?: string;
  title?: string;
  defval?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  group?: string;
  tooltip?: string;
  display?: string;
  active?: unknown;
}

export interface IndicatorPlotConfig {
  id: string;
  title?: string;
  color?: string;
  [key: string]: unknown;
}

/** Browse metadata from `catalog.json` (no inputs/plots — those live in the engine). */
export interface IndicatorCatalogEntry {
  id: string;
  name: string;
  shortName: string;
  category: string;
  group: string;
  overlay: boolean;
}

export interface IndicatorSelection {
  id: string;
  inputs: Record<string, unknown>;
}

export interface IndicatorBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorResult {
  metadata?: { title?: string; shorttitle?: string; overlay?: boolean };
  plots?: Record<string, Array<{ time: number; value: number }>>;
}

export interface RegistryEntry extends IndicatorCatalogEntry {
  description?: string;
  defaultInputs: Record<string, unknown>;
  inputConfig: IndicatorInputConfig[];
  plotConfig: IndicatorPlotConfig[];
  usesVisibleRange?: boolean;
  calculate(
    bars: IndicatorBar[],
    inputs: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): IndicatorResult;
}

export interface IndicatorEngine {
  indicatorRegistry: RegistryEntry[];
}

export interface ComputedIndicator {
  id: string;
  name: string;
  shortName: string;
  overlay: boolean;
  inputs: Record<string, unknown>;
  /** Last finite value per plot id (with readable titles alongside). */
  values: Record<string, number>;
  titles: Record<string, string>;
  error: string | null;
}

export interface IndicatorComputation {
  indicators: ComputedIndicator[];
  unavailable: string[];
}

const ENGINE_SRC = "/indicators/engine.js";
const CATALOG_SRC = "/indicators/catalog.json";
const CHARTS_SRC = "/lightweight-charts.standalone.production.js";

declare global {
  interface Window {
    TradePanelIndicators?: IndicatorEngine;
    LightweightCharts?: unknown;
  }
}

let enginePromise: Promise<IndicatorEngine> | null = null;
let chartsPromise: Promise<void> | null = null;
let catalogPromise: Promise<IndicatorCatalogEntry[]> | null = null;
let lookup: Map<string, RegistryEntry> | null = null;

/** The engine's renderer resolves its series classes from the LWC global. */
function loadChartsRuntime(): Promise<void> {
  if (window.LightweightCharts) return Promise.resolve();
  if (chartsPromise) return chartsPromise;
  chartsPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHARTS_SRC;
    script.async = true;
    script.onload = () => {
      if (window.LightweightCharts) resolve();
      else reject(new Error("Lightweight Charts loaded without a namespace."));
    };
    script.onerror = () => {
      chartsPromise = null;
      script.remove();
      reject(new Error(`Could not load ${CHARTS_SRC}.`));
    };
    document.head.appendChild(script);
  });
  return chartsPromise;
}

export async function loadIndicatorEngine(): Promise<IndicatorEngine> {
  if (window.TradePanelIndicators) return window.TradePanelIndicators;
  await loadChartsRuntime();
  if (window.TradePanelIndicators) return window.TradePanelIndicators;
  if (enginePromise) return enginePromise;
  enginePromise = new Promise<IndicatorEngine>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ENGINE_SRC;
    script.async = true;
    script.dataset.indicatorEngine = "1";
    script.onload = () => {
      if (window.TradePanelIndicators) resolve(window.TradePanelIndicators);
      else reject(new Error("The indicator engine loaded without a registry."));
    };
    script.onerror = () => {
      enginePromise = null;
      script.remove();
      reject(new Error(`Could not load ${ENGINE_SRC}.`));
    };
    document.head.appendChild(script);
  });
  return enginePromise;
}

export function loadIndicatorCatalog(): Promise<IndicatorCatalogEntry[]> {
  if (catalogPromise) return catalogPromise;
  catalogPromise = fetch(CATALOG_SRC, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`Indicator catalog unavailable (HTTP ${response.status}).`);
      return response.json() as Promise<IndicatorCatalogEntry[]>;
    })
    .catch((error: unknown) => {
      catalogPromise = null;
      throw error;
    });
  return catalogPromise;
}

export function findRegistryEntry(id: string): RegistryEntry | null {
  const engine = window.TradePanelIndicators;
  if (!engine) return null;
  if (!lookup) {
    lookup = new Map();
    for (const entry of engine.indicatorRegistry) lookup.set(entry.id, entry);
  }
  return lookup.get(id) ?? null;
}

/** Registry entry, loading the engine first when it is not resident yet. */
export async function loadRegistryEntry(id: string): Promise<RegistryEntry | null> {
  await loadIndicatorEngine();
  return findRegistryEntry(id);
}

/** Inputs the settings UI edits (drops internal script constants). */
export function editableInputs(entry: { inputConfig?: IndicatorInputConfig[] } | null): IndicatorInputConfig[] {
  return (entry?.inputConfig ?? []).filter((input) => input.display !== "none");
}

export function indicatorBars(candles: Candle[]): IndicatorBar[] {
  return candles.map((candle) => ({
    time: Math.floor(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}

/** Defaults + the user's saved values, restricted to real inputs. */
export function mergeIndicatorInputs(
  entry: { defaultInputs?: Record<string, unknown>; inputConfig?: IndicatorInputConfig[] } | null,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(entry?.defaultInputs ?? {}) };
  const known = new Set(Object.keys(merged));
  for (const input of entry?.inputConfig ?? []) known.add(input.id);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!known.has(key)) continue;
    if (typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      merged[key] = value;
    }
  }
  return merged;
}

function lastFinite(values: Array<{ time: number; value: number }> | undefined): number | null {
  if (!values || !values.length) return null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]?.value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function roundValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return Math.round(value * 100) / 100;
  if (magnitude >= 1) return Math.round(value * 10000) / 10000;
  return Number(value.toPrecision(6));
}

/**
 * Compute the selected indicators over one candle series. Every indicator is
 * isolated: a throw (missing symbol context, unsupported script, …) is
 * reported in `unavailable` and never rejects the whole analysis.
 */
export async function computeIndicatorSelection(
  selection: IndicatorSelection[],
  candles: Candle[],
): Promise<IndicatorComputation> {
  const result: IndicatorComputation = { indicators: [], unavailable: [] };
  if (!selection.length || candles.length < 2) return result;
  try {
    await loadIndicatorEngine();
  } catch (error) {
    result.unavailable.push(`engine: ${(error as Error).message || String(error)}`);
    return result;
  }
  const bars = indicatorBars(candles);
  for (const item of selection) {
    const entry = findRegistryEntry(item.id);
    if (!entry) {
      result.unavailable.push(`${item.id}: unknown indicator`);
      continue;
    }
    const inputs = mergeIndicatorInputs(entry, item.inputs);
    try {
      const computed = entry.calculate(bars, inputs);
      const values: Record<string, number> = {};
      const titles: Record<string, string> = {};
      for (const plot of entry.plotConfig ?? []) {
        if (plot.display === "none" || plot.visible === false) continue;
        if (typeof plot.visible === "string" && inputs[plot.visible] === false) continue;
        const value = lastFinite(computed.plots?.[plot.id]);
        if (value === null) continue;
        values[plot.id] = roundValue(value);
        titles[plot.id] = plot.title || plot.id;
      }
      result.indicators.push({
        id: entry.id,
        name: entry.name,
        shortName: entry.shortName || entry.name,
        overlay: entry.overlay === true,
        inputs,
        values,
        titles,
        error: null,
      });
      if (!Object.keys(values).length) {
        result.unavailable.push(`${item.id}: no finite value on the latest bar`);
      }
    } catch (error) {
      result.unavailable.push(`${item.id}: ${(error as Error).message || String(error)}`);
    }
  }
  return result;
}
