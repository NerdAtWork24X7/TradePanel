/**
 * Bundle the `lightweight-charts-indicators` engine and dump its registry
 * metadata for the chart workspace and the AI analysis settings.
 *
 * The workspace page is a classic <script> page and the shell must not parse a
 * 10 MB module at startup, so the engine is emitted as a lazy IIFE global
 * (`window.TradePanelIndicators`) and the pickers read `catalog.json`.
 *
 *     npm install -D lightweight-charts-indicators@<v> oakscriptjs@<v>
 *     npm run indicators
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const outDir = resolve(frontend, 'web/indicators');
const ENGINE = resolve(outDir, 'engine.js');
const CATALOG = resolve(outDir, 'catalog.json');
const SHIM = resolve(here, 'lwc-global-shim.js');

// Vite serves `web/` as publicDir; the workspace iframe and the snapshot page
// both reference these paths.
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: [
      "import * as core from 'lightweight-charts-indicators';",
      "import { IndicatorRenderer } from 'lightweight-charts-indicators/render';",
      'globalThis.TradePanelIndicators = { ...core, IndicatorRenderer };',
    ].join('\n'),
    resolveDir: frontend,
    sourcefile: 'tradepanel-indicators-entry.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2022',
  legalComments: 'none',
  // The renderer imports the v5 series classes; the standalone bundle exposes
  // them on `window.LightweightCharts` before either consumer loads.
  alias: { 'lightweight-charts': SHIM },
  outfile: ENGINE,
  logLevel: 'warning',
});

const { indicatorRegistry } = await import('lightweight-charts-indicators');

// Browse metadata only: inputs/plots/styles stay in the engine, which is the
// single source of truth (and keeps this file ~120 kB instead of 4 MB).
const byCategory = new Map();
const catalog = indicatorRegistry.map((entry) => {
  const category = entry.category || 'Other';
  byCategory.set(category, (byCategory.get(category) || 0) + 1);
  return {
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName || entry.name,
    category,
    group: entry.group || '',
    overlay: entry.overlay === true,
  };
});
catalog.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(CATALOG, JSON.stringify(catalog));

const version = JSON.parse(
  readFileSync(resolve(frontend, 'node_modules/lightweight-charts-indicators/package.json'), 'utf8'),
).version;
console.log(
  `indicators ${version}: ${catalog.length} entries ` +
    `(${[...byCategory.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}) -> web/indicators/`,
);
