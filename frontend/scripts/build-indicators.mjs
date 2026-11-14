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
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '..');
const outDir = resolve(frontend, 'web/indicators');
const ENGINE = resolve(outDir, 'engine.js');
const CATALOG = resolve(outDir, 'catalog.json');
const MANIFEST = resolve(outDir, 'manifest.json');
const SHIM = resolve(here, 'lwc-global-shim.js');

// The workspace also ships one local study (ported from `custom_pine/`). It is
// part of the same bundle so a chart has no extra script to lazy-load.
const { MyIndicator } = await import('../src/indicators/my_indicator.mjs');

// Vite serves `web/` as publicDir; the workspace iframe and the snapshot page
// both reference these paths.
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: [
      "import * as core from 'lightweight-charts-indicators';",
      "import { IndicatorRenderer } from 'lightweight-charts-indicators/render';",
      "import { MyIndicator } from './src/indicators/my_indicator.mjs';",
      'globalThis.TradePanelIndicators = { ...core, IndicatorRenderer,',
      '  indicatorRegistry: [...core.indicatorRegistry, MyIndicator] };',
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
const registry = [...indicatorRegistry, MyIndicator];

// Browse metadata only: inputs/plots/styles stay in the engine, which is the
// single source of truth (and keeps this file ~120 kB instead of 4 MB).
const byCategory = new Map();
const catalog = registry.map((entry) => {
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

// The workspace appends ?v=<hash> to the engine URL. The WebView cache is
// persistent, so a rebuild with an unchanged URL would keep serving the old
// registry (and any new study would silently vanish from the chart).
const engineVersion = createHash('sha256').update(readFileSync(ENGINE)).digest('hex').slice(0, 12);
writeFileSync(MANIFEST, JSON.stringify({ version: engineVersion }));

const version = JSON.parse(
  readFileSync(resolve(frontend, 'node_modules/lightweight-charts-indicators/package.json'), 'utf8'),
).version;
console.log(
  `indicators ${version}: ${catalog.length} entries ` +
    `(${[...byCategory.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}) -> web/indicators/`,
);
