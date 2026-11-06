/**
 * Registry invariants + builder output tests for frontend/web/drawing_tools.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadClassic(file) {
    const source = fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    const factory = vm.runInThisContext(`(function (module, exports, root) {\n${source}\n})`, { filename: file });
    const mod = { exports: {} };
    factory(mod, mod.exports, globalThis);
    return mod.exports;
}

loadClassic('drawing_geometry.js');
const T = loadClassic('drawing_tools.js');

const TIER_A = [
    'select', 'eraser',
    'long', 'short', 'positionForecast',
    'trend', 'ray', 'extended', 'info', 'hline', 'hray', 'vline', 'crossline',
    'channel', 'flatTopBottom', 'disjointChannel',
    'fib', 'fibExt', 'fibChannel', 'fibTime', 'fibFan', 'fibArcs', 'fibCircles',
    'fibSpiral', 'gannBox', 'gannFan',
    'xabcd', 'abcd', 'headShoulders', 'threeDrives', 'elliottImpulse',
    'rect', 'rotatedRect', 'ellipse', 'circle', 'triangle', 'polyline', 'path',
    'arc', 'curve', 'arrow', 'arrowMarker', 'brush', 'highlighter',
    'text', 'note', 'comment', 'callout', 'priceNote', 'priceLabel', 'pin',
    'measure', 'priceRange', 'dateRange', 'datePriceRange'
];
const NON_PERSISTED = ['select', 'eraser', 'long', 'short', 'measure'];

const T0 = 1_700_000_000;
const BAR = 300;

function env(overrides) {
    const e = {
        px(time) { return 40 + ((time - T0) / BAR) * 6; },
        py(price) { return 300 - (price - 100) * 2; },
        timeAt(x) { return Math.round(T0 + ((x - 40) / 6) * BAR); },
        priceAt(y) { return 100 + (300 - y) / 2; },
        box: { w: 600, h: 400 },
        precision: 2,
        barSeconds: BAR,
        theme: {},
        candles: [],
        visibleRange: null
    };
    return Object.assign(e, overrides || {});
}

function anchorsFor(tool) {
    const count = typeof tool.anchors === 'number' ? tool.anchors : tool.anchors.max;
    const points = [];
    for (let i = 0; i < count; i++) {
        points.push({ time: T0 + i * BAR * 8, price: 100 + i * 4 });
    }
    return points;
}

function shapeFor(tool, points, extra) {
    const shape = T.normalizeRecord({
        id: 'd-test',
        tool: tool.id,
        points: points || anchorsFor(tool),
        text: tool.editor ? 'A note' : '',
        params: Object.assign({}, tool.defaults.params || {}),
        width: tool.defaults.width,
        fill: tool.defaults.fill,
        dash: tool.defaults.dash
    }, tool.id);
    Object.assign(shape, extra || {});
    return shape;
}

test('TOOL_IDS matches the 55 Tier A ids exactly', () => {
    assert.equal(T.TOOL_IDS.length, 55);
    assert.deepEqual([...T.TOOL_IDS].sort(), [...TIER_A].sort());
});

test('PERSISTED_TOOL_IDS is the 50 commons of Tier A', () => {
    assert.equal(T.PERSISTED_TOOL_IDS.length, 50);
    const expected = TIER_A.filter((id) => !NON_PERSISTED.includes(id));
    assert.deepEqual([...T.PERSISTED_TOOL_IDS].sort(), [...expected].sort());
});

test('ids are unique and families are non-empty', () => {
    assert.equal(new Set(T.TOOL_IDS).size, T.TOOL_IDS.length);
    assert.equal(T.FAMILIES.length, 7);
    T.FAMILIES.forEach((family) => {
        assert.ok(T.familyTools(family.id).length > 0, `family ${family.id} is empty`);
    });
    let total = 0;
    T.FAMILIES.forEach((f) => { total += T.familyTools(f.id).length; });
    assert.equal(total, 55);
});

test('descriptors are well-formed', () => {
    T.TOOLS.forEach((tool) => {
        assert.match(tool.id, /^[a-z][a-zA-Z0-9]{1,20}$/);
        assert.ok(tool.label.length > 0);
        assert.ok(['drag', 'click', 'freehand', 'variable', 'cursor'].includes(tool.input));
        assert.ok(typeof tool.anchors === 'number' || (tool.anchors && tool.anchors.min && tool.anchors.max));
        if (typeof tool.anchors === 'number') assert.ok(tool.anchors >= 0);
        if (tool.anchors && tool.anchors.min) assert.ok(tool.anchors.min < tool.anchors.max);
        if (tool.persisted) assert.equal(tool.engine, 'drawing');
        assert.ok(Array.isArray(tool.icon) && tool.icon.length > 0);
        assert.equal(typeof tool.build, 'function');
        assert.equal(typeof tool.describe, 'function');
        // defaults.params must be JSON-serializable primitives only
        const json = JSON.parse(JSON.stringify(tool.defaults.params || {}));
        assert.deepEqual(Object.keys(json), Object.keys(tool.defaults.params || {}));
        Object.values(json).forEach((v) => {
            const ok = v == null || typeof v === 'string' || typeof v === 'boolean' ||
                typeof v === 'number' || Array.isArray(v);
            assert.ok(ok, `${tool.id} params.${v} is not serializable`);
        });
    });
});

test('every drawing tool builds finite primitives for valid anchors', () => {
    const e = env();
    T.TOOLS.filter((t) => t.engine === 'drawing').forEach((tool) => {
        const shape = shapeFor(tool);
        const out = T.build(shape, e);
        assert.ok(Array.isArray(out.prims), `${tool.id} prims`);
        assert.ok(out.prims.length > 0, `${tool.id} produced no primitives`);
        out.prims.forEach((prim) => {
            if (prim.kind === 'path') {
                prim.pts.forEach((p) => {
                    assert.ok(isFinite(p.x) && isFinite(p.y), `${tool.id} non-finite path`);
                    assert.ok(Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5, `${tool.id} runaway coord`);
                });
            } else if (prim.kind === 'text') {
                assert.ok(isFinite(prim.x) && isFinite(prim.y));
            } else if (prim.kind === 'arc') {
                assert.ok(isFinite(prim.rx) && isFinite(prim.ry));
            } else {
                assert.ok(isFinite(prim.x) && isFinite(prim.y));
            }
        });
        if (tool.input === 'freehand') assert.equal(out.handles.length, 2, `${tool.id} handles`);
        else assert.equal(out.handles.length, shape.points.length, `${tool.id} handles`);
    });
});

test('builders never throw or emit NaN for degenerate anchors', () => {
    const e = env();
    T.TOOLS.filter((t) => t.engine === 'drawing').forEach((tool) => {
        const count = typeof tool.anchors === 'number' ? tool.anchors : tool.anchors.max;
        const cases = [
            [],
            [{ time: T0, price: 100 }],
            new Array(count).fill({ time: T0, price: 100 }),
            new Array(count).fill({ time: -9e12, price: 1e15 })
        ];
        cases.forEach((points) => {
            const shape = T.normalizeRecord({ id: 'x', tool: tool.id, points, text: 'x' });
            assert.ok(shape);
            const out = T.build(shape, e);
            assert.ok(out && Array.isArray(out.prims));
        });
        const empty = T.build(null, e);
        assert.deepEqual(empty, { prims: [], handles: [] });
    });
});

test('normalizeRecord fills defaults and clamps hostile input', () => {
    const rec = T.normalizeRecord({
        tool: 'polyline',
        points: [{ time: -5, price: 10 }, { time: 1e12, price: 5 }, { time: 'x', price: 5 }],
        color: 'red',
        width: 99,
        dash: 'wavy',
        fill: 5,
        text: 'a'.repeat(400),
        font: 99,
        z: 9999,
        locked: 'yes',
        hidden: 1,
        params: { levels: [0, 2, 99], extend: 'sideways', bogus: true }
    });
    assert.equal(rec.tool, 'polyline');
    assert.equal(rec.points.length, 2);
    assert.equal(rec.points[0].time, 0);
    assert.equal(rec.points[1].time, 4102444800);
    assert.equal(rec.color, '');
    assert.equal(rec.width, 4);
    assert.equal(rec.dash, 'solid');
    assert.equal(rec.fill, 0.6);
    assert.equal(rec.text.length, 120);
    assert.equal(rec.font, 18);
    assert.equal(rec.z, 1000);
    assert.equal(rec.locked, false);
    assert.equal(rec.hidden, false);
    assert.deepEqual(rec.params.levels, [0, 2]);
    assert.equal(rec.params.extend, 'none');
    assert.equal(rec.params.bogus, undefined);
});

test('normalizeRecord drops unknown tools and keeps point caps per tool', () => {
    assert.equal(T.normalizeRecord({ tool: 'nope', points: [] }), null);
    assert.equal(T.normalizeRecord(null), null);
    const fib = T.normalizeRecord({
        tool: 'fib',
        points: [{ time: 1, price: 1 }, { time: 2, price: 2 }, { time: 3, price: 3 }]
    });
    assert.equal(fib.points.length, 2);
});

test('sanitizeText strips control chars and caps lines/length', () => {
    const out = T.sanitizeText('a\u0000b\u0007c\n1\n2\n3\n4\n5\n6\n7');
    assert.ok(out.indexOf('\u0000') < 0);
    assert.ok(out.split('\n').length <= 6);
    assert.ok(out.length <= 120);
});

test('resolveStyle and describe', () => {
    const style = T.resolveStyle({ color: '#112233', fill: 0.1, width: 2, dash: 'dotted', font: 12 }, { drawingLine: '#888888' }, true);
    assert.equal(style.color, '#112233');
    assert.equal(style.selected, true);
    assert.equal(style.width, 2);
    T.TOOLS.forEach((tool) => {
        const shape = T.normalizeRecord({ tool: tool.id, points: anchorsFor(tool), text: 'x' });
        assert.ok(T.describe(shape).length > 0, tool.id);
    });
});

test('fib levels use the documented defaults', () => {
    assert.deepEqual(T.byId('fib').defaults.params.levels, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    assert.equal(T.byId('fibExt').defaults.params.levels.length, 12);
    assert.equal(T.byId('fibTime').defaults.params.levels.length, 8);
    assert.equal(T.byId('fibFan').defaults.params.levels.length, 7);
    assert.equal(T.byId('gannFan').defaults.params.levels.length, 9);
});

test('line/level tools produce clipped geometry inside the plot box', () => {
    const e = env();
    const trend = T.build(shapeFor(T.byId('trend'), [
        { time: T0 - 100 * BAR, price: 90 }, { time: T0 + 100 * BAR, price: 110 }
    ]), e);
    trend.prims.filter((p) => p.kind === 'path').forEach((p) => {
        p.pts.forEach((pt) => {
            assert.ok(pt.x >= -1 && pt.x <= e.box.w + 1);
            assert.ok(pt.y >= -1 && pt.y <= e.box.h + 1);
        });
    });
    const ray = T.build(shapeFor(T.byId('ray'), [
        { time: T0, price: 100 }, { time: T0 + 4 * BAR, price: 104 }
    ]), e);
    const rayPath = ray.prims.find((p) => p.kind === 'path');
    assert.ok(rayPath.pts.some((p) => Math.abs(p.x - e.box.w) < 0.6));
});

test('freehand simplifies long paths and keeps endpoints', () => {
    const points = [];
    for (let i = 0; i < 400; i++) points.push({ time: T0 + i * BAR, price: 100 + Math.sin(i / 20) });
    const shape = T.normalizeRecord({ tool: 'brush', points });
    const out = T.build(shape, env());
    const drawn = out.prims.find((p) => p.kind === 'path');
    assert.ok(drawn.pts.length < points.length);
    assert.equal(out.handles.length, 2);
});

test('text tools wrap to at most 6 lines and 220px', () => {
    const shape = T.normalizeRecord({ tool: 'text', points: [{ time: T0, price: 100 }], text: 'word '.repeat(60) });
    const out = T.build(shape, env());
    const txt = out.prims.find((p) => p.kind === 'text');
    assert.ok(txt.lines.length <= 6);
    assert.ok(txt.w <= 240);
});
