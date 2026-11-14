/**
 * The per-tool drawing settings schema must stay in lockstep with the drawing
 * catalog: every tool gets a dialog tailored to its family, with no duplicate
 * or empty controls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadClassic(file) {
    const source = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    const factory = vm.runInThisContext(`(function (module, exports, root) {\n${source}\n})`, { filename: file });
    const mod = { exports: {} };
    const root = {};
    factory(mod, mod.exports, root);
    return root.ChartDrawings || root.DrawingSettings || mod.exports;
}

const C = loadClassic('chart_drawings.js');
const D = loadClassic('drawing_settings.js');

const FIELD_TYPES = new Set(['color', 'number', 'toggle', 'select', 'text', 'textarea', 'levels']);

function allFields(kind) {
    return D.sections(kind).reduce((fields, section) => fields.concat(section.fields), []);
}

test('every drawing tool has a tailored settings schema', () => {
    for (const tool of C.TOOLS) {
        assert.ok(D.has(tool.kind), `missing schema for ${tool.kind}`);
        const sections = D.sections(tool.kind);
        assert.ok(sections.length > 0, tool.kind);
        const ids = new Set();
        const keys = new Set();
        for (const section of sections) {
            assert.ok(section.id && section.label, `${tool.kind} section`);
            assert.ok(!ids.has(section.id), `${tool.kind} duplicate section ${section.id}`);
            ids.add(section.id);
            assert.ok(section.fields.length > 0, `${tool.kind}/${section.id} has no fields`);
            for (const field of section.fields) {
                assert.ok(field.key && field.label, `${tool.kind} field`);
                assert.ok(FIELD_TYPES.has(field.type), `${tool.kind} ${field.key}: ${field.type}`);
                assert.ok(!keys.has(field.key), `${tool.kind} duplicate field ${field.key}`);
                keys.add(field.key);
                if (field.type === 'select') {
                    assert.ok(Array.isArray(field.options) && field.options.length > 1, `${tool.kind} ${field.key}`);
                }
                if (field.type === 'number') {
                    assert.equal(typeof field.step, 'number');
                }
            }
        }
    }
});

test('tool families expose their own controls instead of one generic dialog', () => {
    const has = (kind, key) => allFields(kind).some((field) => field.key === key);

    assert.ok(has('fib-retracement', 'levels'), 'Fib levels');
    assert.ok(has('fib-retracement', 'fibLevelsAsPercents'));
    assert.ok(has('trend-based-fib-extension', 'levels'));

    assert.ok(has('trend-line', 'extendRight'));
    assert.ok(has('horizontal-line', 'showPriceLabels'));
    assert.ok(has('vertical-line', 'extendLine'));

    assert.ok(has('text', '@text'), 'text tools edit drawing.text');
    assert.ok(has('text', 'wordWrap'));
    assert.ok(has('text', 'fontSize'));
    assert.ok(has('font-icon', '@glyph'));
    assert.ok(has('signpost', 'signpostPosition'));

    assert.ok(has('long-position', 'stopLevel'));
    assert.ok(has('long-position', 'riskPercent'));
    assert.ok(has('position-forecast', 'successBackground'));

    assert.ok(has('rectangle', 'fillBackground'));
    assert.ok(has('rectangle', 'rectMiddleLine.visible'));

    assert.ok(has('anchored-volume-profile', 'vp.rowsLayout'));
    assert.ok(has('fixed-range-volume-profile', 'vp.vaVolume'));
    assert.ok(has('regression-trend', 'upperDeviation'));
    assert.ok(has('elliott-impulse', 'elliottDegree'));

    assert.ok(!has('fib-retracement', 'wordWrap'), 'no text-box fields on Fib');
    assert.ok(!has('text', 'stopLevel'), 'no position sizing on Text');
    assert.ok(!has('long-position', 'levels'), 'no Fib levels on Position');
});

test('dotted paths read and write nested style keys without mutating the input', () => {
    const input = { color: '#fff', vp: { rows: 24, poc: { visible: true } } };
    const output = D.set(input, 'vp.poc.visible', false);
    assert.equal(output.vp.poc.visible, false);
    assert.equal(input.vp.poc.visible, true, 'input is never mutated');
    assert.equal(D.get(output, 'vp.poc.visible'), false);
    assert.equal(D.get(output, 'vp.missing.deeper'), undefined);
    assert.equal(D.get(output, 'color'), '#fff');
});

test('the schema keeps the library field names (selection and fill)', () => {
    const keys = (kind) => new Set(allFields(kind).map((field) => field.key));
    for (const key of ['extendLeft', 'extendRight', 'leftEnd', 'rightEnd', 'showMiddlePoint',
        'showStats', 'statsPosition', 'showPriceRange', 'showPercentPriceRange', 'showBarsRange',
        'showDateTimeRange', 'showDistance', 'showAngle', 'textColor', 'horzLabelsAlign',
        'vertLabelsAlign']) {
        assert.ok(keys('trend-line').has(key), `trend-line ${key}`);
    }
    for (const key of ['fillBackground', 'backgroundColor', 'transparency']) {
        assert.ok(keys('rectangle').has(key), `rectangle ${key}`);
    }
    for (const key of ['reverse', 'fibLevelsAsPercents', 'showText', 'horzTextAlign', 'vertTextAlign']) {
        assert.ok(keys('fib-retracement').has(key), `fib-retracement ${key}`);
    }
});
