/**
 * Catalog, legacy migration and price-space helpers for the
 * lightweight-charts-drawing integration (frontend/web/chart_drawings.js).
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
    return root.ChartDrawings || mod.exports;
}

const C = loadClassic('chart_drawings.js');

const LIBRARY_KINDS = [
    'trend-line', 'ray', 'info-line', 'extended-line', 'trend-angle',
    'horizontal-line', 'horizontal-ray', 'vertical-line', 'cross-line',
    'parallel-channel', 'regression-trend', 'flat-top-bottom', 'disjoint-channel',
    'pitchfork', 'schiff-pitchfork', 'modified-schiff-pitchfork', 'inside-pitchfork',
    'fib-retracement', 'trend-based-fib-extension', 'fib-channel', 'fib-time-zone',
    'fib-speed-resistance-fan', 'trend-based-fib-time', 'fib-circles', 'fib-spiral',
    'fib-speed-resistance-arcs', 'fib-wedge', 'pitchfan',
    'gann-box', 'gann-square-fixed', 'gann-square', 'gann-fan',
    'xabcd-pattern', 'cypher-pattern', 'head-and-shoulders', 'abcd-pattern',
    'triangle-pattern', 'three-drives-pattern',
    'elliott-impulse', 'elliott-correction', 'elliott-triangle',
    'elliott-double-combo', 'elliott-triple-combo',
    'cyclic-lines', 'time-cycles', 'sine-line',
    'long-position', 'short-position', 'position-forecast', 'bar-pattern',
    'ghost-feed', 'sector', 'anchored-vwap', 'fixed-range-volume-profile',
    'anchored-volume-profile', 'price-range', 'date-range', 'date-and-price-range',
    'brush', 'highlighter', 'arrow-marker', 'arrow', 'arrow-mark-up', 'arrow-mark-down',
    'rectangle', 'rotated-rectangle', 'path', 'circle', 'ellipse', 'polyline',
    'triangle', 'arc', 'curve', 'double-curve',
    'text', 'note', 'price-note', 'pin', 'table', 'callout', 'comment',
    'price-label', 'signpost', 'flag-mark', 'image', 'font-icon'
];

test('catalog mirrors the lightweight-charts-drawing tool set', () => {
    assert.equal(LIBRARY_KINDS.length, 86);
    assert.deepEqual(C.TOOLS.map((t) => t.kind).sort(), LIBRARY_KINDS.slice().sort());
    assert.equal(C.TOOLS.length, 86);
    assert.equal(new Set(C.TOOLS.map((t) => t.kind)).size, 86);
    for (const tool of C.TOOLS) {
        assert.ok(tool.label && tool.label.length > 1, tool.kind);
        assert.ok(C.FAMILIES.some((f) => f.id === tool.family), tool.kind);
        assert.equal(C.TOOL_BY_KIND[tool.kind], tool);
        assert.ok(C.iconFor(tool.kind).length > 0, `icon for ${tool.kind}`);
    }
    assert.equal(C.FAMILIES.length, 16);
    for (const family of C.FAMILIES) {
        assert.ok(family.items.length > 0);
        assert.deepEqual(family.items.map((t) => t.kind), family.tools === undefined ? family.items.map((t) => t.kind) : family.items.map((t) => t.kind));
    }
});

test('primary rail entries exist and favourites are valid', () => {
    const known = new Set(C.TOOLS.map((t) => t.kind));
    for (const entry of C.PRIMARY) {
        const custom = entry.id === 'select' || entry.id === 'measure' || entry.id === 'long' || entry.id === 'short';
        assert.ok(custom || known.has(entry.id), entry.id);
        assert.ok(entry.icon.length > 0);
        assert.ok(entry.label.length > 2);
    }
    assert.ok(C.DEFAULT_FAVORITES.length > 0);
    assert.ok(C.DEFAULT_FAVORITES.length <= C.MAX_FAVORITES);
    for (const kind of C.DEFAULT_FAVORITES) assert.ok(known.has(kind), kind);
    assert.equal(new Set(C.DEFAULT_FAVORITES).size, C.DEFAULT_FAVORITES.length);
});

test('timeframe interval mapping matches the TV interval format', () => {
    const cases = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '12h': '720', '1d': '1D', '1w': '1W', '1M': '1M' };
    for (const [tf, interval] of Object.entries(cases)) assert.equal(C.intervalForTimeframe(tf), interval, tf);
    assert.equal(C.intervalForTimeframe('nope'), undefined);
    assert.equal(C.isIntraday('5m'), true);
    assert.equal(C.isIntraday('1h'), true);
    assert.equal(C.isIntraday('1d'), false);
    assert.equal(C.isIntraday('1M'), false);
});

test('raw and display price spaces round-trip and guard bad references', () => {
    for (const mode of ['independent', 'absolute', 'percentage', 'indexed']) {
        for (const price of [0.5, 1, 76234.5, 1e6]) {
            const display = C.rawToDisplay(price, mode, 76000);
            const back = C.displayToRaw(display, mode, 76000);
            assert.ok(Math.abs(back - price) < 1e-6, `${mode} ${price}`);
        }
    }
    assert.equal(C.rawToDisplay(10, 'independent', null), 10);
    assert.equal(C.rawToDisplay(10, 'percentage', 0), 10);
    assert.equal(C.displayToRaw(10, 'percentage', null), 10);
    assert.equal(C.rawToDisplay(76000, 'indexed', 76000), 100);
    assert.equal(C.rawToDisplay(76000, 'percentage', 76000), 0);
    assert.equal(C.displayToRaw(0, 'percentage', 100), 100);
    assert.equal(C.spaceSignature('independent', 100), 'raw');
    assert.equal(C.spaceSignature('percentage', 100), 'percentage:100');
    assert.equal(C.spaceSignature('indexed', 0), 'indexed:0');
});

test('project maps only prices and never mutates the source', () => {
    const style = { color: '#f23645' };
    const list = [
        { id: 'a', kind: 'trend-line', style, points: [{ time: 1, price: 10 }, { time: 2, price: 20 }] },
        { id: 'b', kind: 'horizontal-line', style, points: [{ time: 3, price: 30 }] }
    ];
    const mapped = C.project(list, (price) => price * 2);
    assert.deepEqual(mapped.map((d) => d.points.map((p) => p.price)), [[20, 40], [60]]);
    assert.deepEqual(mapped.map((d) => d.points.map((p) => p.time)), [[1, 2], [3]]);
    assert.equal(mapped[0].style, style);
    assert.equal(list[0].points[0].price, 10);
    assert.deepEqual(C.project(null, (p) => p), []);
    assert.deepEqual(C.project(list, null), []);
});

test('normalize keeps the new drawing model intact', () => {
    const input = [{
        id: 'dw-1',
        kind: 'image',
        points: [{ time: 1700000000, price: 100 }],
        style: { color: '#2962ff', width: 2, lineStyle: 'dashed', levels: [{ coeff: 0.5, visible: true }] },
        glyph: '★',
        image: { name: 'img-1', cssWidth: 120, cssHeight: 80 },
        pattern: { bars: [[1, 2, 3, 4]] },
        ghost: { seed: 7, amplitude: 2 },
        anchored: { x: 0.5, y: 0.5 },
        table: { rows: [['a', 'b']] },
        visibility: { ranges: [{ from: 1, to: 5 }] },
        fmt: 2,
        locked: true,
        hidden: false,
        text: 'hello',
        name: 'Label',
        group: 'g1',
        owner: 'study-1'
    }];
    const [drawing] = C.normalize(input, { time: 1, price: 1 });
    assert.equal(drawing.id, 'dw-1');
    assert.equal(drawing.kind, 'image');
    assert.deepEqual(drawing.points, [{ time: 1700000000, price: 100 }]);
    assert.equal(drawing.style.color, '#2962ff');
    assert.deepEqual(drawing.style.levels, [{ coeff: 0.5, visible: true }]);
    assert.equal(drawing.glyph, '★');
    assert.deepEqual(drawing.image, { name: 'img-1', cssWidth: 120, cssHeight: 80 });
    assert.deepEqual(drawing.pattern, { bars: [[1, 2, 3, 4]] });
    assert.deepEqual(drawing.ghost, { seed: 7, amplitude: 2 });
    assert.deepEqual(drawing.anchored, { x: 0.5, y: 0.5 });
    assert.deepEqual(drawing.table, { rows: [['a', 'b']] });
    assert.deepEqual(drawing.visibility, { ranges: [{ from: 1, to: 5 }] });
    assert.equal(drawing.fmt, 2);
    assert.equal(drawing.locked, true);
    assert.equal(drawing.hidden, undefined);
    assert.equal(drawing.text, 'hello');
    assert.equal(drawing.name, 'Label');
    assert.equal(drawing.group, 'g1');
    assert.equal(drawing.owner, 'study-1');
    assert.equal(C.needsMigration(input), false);
});

test('normalize migrates the legacy custom shapes', () => {
    const legacy = [
        { id: 'd1', tool: 'hline', points: [{ time: 0, price: 42 }], color: '#a09f95' },
        { id: 'd2', tool: 'vline', points: [{ time: 1700000000, price: 0 }] },
        { id: 'd3', tool: 'trend', points: [{ time: 10, price: 1 }, { time: 20, price: 2 }] },
        { id: 'd4', tool: 'rect', points: [{ time: 10, price: 1 }, { time: 20, price: 2 }] },
        { id: 'd5', tool: 'fib', points: [{ time: 10, price: 1 }] },
        { id: 'd6', tool: 'text', points: [{ time: 10, price: 1 }], text: 'note' },
        { id: 'd7', tool: 'unknown', points: [] }
    ];
    const out = C.normalize(legacy, { time: 1700000000, price: 77 });
    assert.deepEqual(out.map((d) => d.kind),
        ['horizontal-line', 'vertical-line', 'trend-line', 'rectangle', 'fib-retracement', 'text']);
    assert.deepEqual(out[0].points, [{ time: 1700000000, price: 42 }]);
    assert.deepEqual(out[1].points, [{ time: 1700000000, price: 77 }]);
    assert.equal(out[4].points.length, 2);
    assert.deepEqual(out[4].points[1], out[4].points[0]);
    assert.equal(out[5].text, 'note');
    assert.equal(C.needsMigration(legacy), true);
    assert.equal(C.needsMigration([]), false);
});

test('normalize is defensive about junk and caps sizes', () => {
    assert.deepEqual(C.normalize(null, {}), []);
    assert.deepEqual(C.normalize([null, 1, 'x', {}, { kind: 'nope', points: [{ time: 1, price: 1 }] }], {}), []);
    const tooMany = C.normalize([{
        kind: 'path',
        points: Array.from({ length: 40 }, (_, i) => ({ time: i, price: i + 1 }))
    }], {});
    assert.equal(tooMany[0].points.length, 16);
    const badPoints = C.normalize([{
        kind: 'trend-line',
        points: [{ time: 1, price: 'NaN' }, { time: 2, price: 2 }]
    }], {});
    assert.deepEqual(badPoints[0].points, [{ time: 2, price: 2 }]);
    const noPoints = C.normalize([{ kind: 'trend-line', points: [{ time: 1, price: Infinity }] }], {});
    assert.deepEqual(noPoints, []);
    const many = C.normalize(Array.from({ length: 450 }, () => ({ kind: 'text', points: [{ time: 1, price: 1 }] })), {});
    assert.equal(many.length, 400);
});

test('host pickers and labels', () => {
    assert.equal(C.needsPicker('image'), true);
    assert.equal(C.needsPicker('font-icon'), true);
    assert.equal(C.needsPicker('trend-line'), false);
    assert.equal(C.isTextKind('text'), true);
    assert.equal(C.isTextKind('note'), true);
    assert.equal(C.isTextKind('table'), false);
    assert.equal(C.kindLabel('gann-box'), 'Gann box');
    assert.equal(C.kindLabel('missing'), 'missing');
    assert.equal(C.legacyKind('trend'), 'trend-line');
    assert.equal(C.legacyKind('rect'), 'rectangle');
    assert.equal(C.legacyKind('hlc'), null);
});
