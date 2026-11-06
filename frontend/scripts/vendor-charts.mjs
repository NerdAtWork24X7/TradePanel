/**
 * Copy the Lightweight Charts runtime and the drawing-tools bundle from
 * node_modules into frontend/web (Vite's publicDir).
 *
 * The workspace page is a classic <script> page, so the vendored files are
 * committed assets — run this only when upgrading either package:
 *
 *     npm install -D lightweight-charts@<v> lightweight-charts-drawing@<v>
 *     npm run vendor:charts
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../web');

// Package `exports` hides the dist directory, so anchor on the resolved entry.
const CHARTS_DIST = dirname(fileURLToPath(import.meta.resolve('lightweight-charts')));
const DRAWING_DIST = dirname(fileURLToPath(import.meta.resolve('lightweight-charts-drawing')));

const FILES = [
  [join(CHARTS_DIST, 'lightweight-charts.standalone.production.js'), 'lightweight-charts.standalone.production.js'],
  [join(DRAWING_DIST, 'lightweight-charts-drawing.umd.cjs'), 'lightweight-charts-drawing.js'],
];

mkdirSync(web, { recursive: true });
for (const [source, to] of FILES) {
  copyFileSync(source, resolve(web, to));
  console.log(`vendored ${source} -> web/${to}`);
}
