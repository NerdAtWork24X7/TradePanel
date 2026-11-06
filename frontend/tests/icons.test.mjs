/* Icon registry contract: markup placeholders, the drawing catalog and the
 * generated sprite data must stay in sync with the vendored SVG set. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..", "web");
const INDEX = resolve(HERE, "..", "index.html");

function loadIcons() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(WEB, "icons.js"), "utf8"), context);
  return context.OTIcons;
}

test("every icon record has a viewBox and body", () => {
  const icons = loadIcons();
  assert.ok(icons.names.length > 150);
  for (const name of icons.names) {
    const icon = icons.data[name];
    assert.match(icon.v, /^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/, name);
    assert.ok(icon.b.length > 10, name);
    assert.ok(!/<\/script|<script/i.test(icon.b), `${name} must not contain scripts`);
  }
  assert.equal(icons.svg("missing-icon"), "");
});

test("every drawing tool and family resolves to a real icon", async () => {
  const icons = loadIcons();
  const { default: C } = await import(resolve(WEB, "chart_drawings.js"));
  const drawing = C ?? globalThis.ChartDrawings;
  assert.equal(drawing.TOOLS.length, 86);
  for (const tool of drawing.TOOLS) {
    const name = drawing.iconNameFor(tool.kind);
    assert.ok(icons.has(name), `${tool.kind} → ${name}`);
  }
  for (const family of drawing.FAMILIES) {
    assert.ok(icons.has(drawing.familyIconName(family.id)), family.id);
  }
});

test("static shell/chart icon placeholders exist in the registry", () => {
  const icons = loadIcons();
  const html = readFileSync(INDEX, "utf8");
  const workspace = readFileSync(resolve(WEB, "workspace.html"), "utf8");
  for (const source of [html, workspace]) {
    for (const match of source.matchAll(/data-icon="([^"]+)"/g)) {
      assert.ok(icons.has(match[1]), match[1]);
    }
  }
});
