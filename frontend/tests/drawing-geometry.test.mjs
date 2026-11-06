/**
 * Pure-math tests for frontend/web/drawing_geometry.js — no DOM, no charts.
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

const G = loadClassic('drawing_geometry.js');
const BOX = { w: 600, h: 400 };

test('clipSegment keeps fully-inside segments', () => {
    const seg = G.clipSegment({ x: 10, y: 10 }, { x: 100, y: 100 }, BOX);
    assert.deepEqual(seg, [{ x: 10, y: 10 }, { x: 100, y: 100 }]);
});

test('clipSegment returns null when fully outside', () => {
    assert.equal(G.clipSegment({ x: -50, y: -50 }, { x: -10, y: -20 }, BOX), null);
    assert.equal(G.clipSegment({ x: 700, y: 500 }, { x: 800, y: 600 }, BOX), null);
});

test('clipSegment trims to the box edge', () => {
    const seg = G.clipSegment({ x: -100, y: 200 }, { x: 300, y: 200 }, BOX);
    assert.ok(seg);
    assert.equal(seg[0].x, 0);
    assert.equal(seg[1].x, 300);
    assert.equal(seg[0].y, 200);
});

test('clipRay extends past the anchor', () => {
    const seg = G.clipRay({ x: 300, y: 200 }, { x: 400, y: 200 }, BOX);
    assert.ok(seg);
    assert.equal(seg[0].x, 300);
    assert.equal(seg[1].x, 600);
});

test('clipInfinite extends both directions', () => {
    const seg = G.clipInfinite({ x: 300, y: 200 }, { x: 400, y: 200 }, BOX);
    assert.ok(seg);
    assert.equal(seg[0].x, 0);
    assert.equal(seg[1].x, 600);
});

test('clipExtended respects direction modes', () => {
    const right = G.clipExtended({ x: 300, y: 200 }, { x: 400, y: 200 }, BOX, 'right');
    assert.equal(right[1].x, 600);
    const left = G.clipExtended({ x: 300, y: 200 }, { x: 200, y: 200 }, BOX, 'left');
    assert.equal(left[0].x, 0);
    const both = G.clipExtended({ x: 300, y: 200 }, { x: 200, y: 200 }, BOX, 'both');
    assert.equal(both[0].x, 0);
    assert.equal(both[1].x, 600);
});

test('clipHorizontal / clipVertical reject off-screen levels', () => {
    assert.ok(G.clipHorizontal(100, BOX));
    assert.equal(G.clipHorizontal(-1, BOX), null);
    assert.ok(G.clipVertical(100, BOX));
    assert.equal(G.clipVertical(601, BOX), null);
});

test('degenerate clipping never returns NaN', () => {
    assert.equal(G.clipSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, BOX), null);
    const flat = G.clipSegment({ x: -10, y: 0 }, { x: 10, y: 0 }, BOX);
    assert.ok(flat);
    flat.forEach((p) => assert.ok(isFinite(p.x) && isFinite(p.y)));
    assert.equal(G.clipSegment({ x: 0, y: 0 }, { x: NaN, y: 0 }, BOX), null);
});

test('rdpSimplify preserves endpoints and collapses collinear runs', () => {
    const pts = [
        { x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 2, y: 0 }, { x: 3, y: 0 },
        { x: 4, y: 5 }, { x: 5, y: 0 }, { x: 6, y: 0 }
    ];
    const out = G.rdpSimplify(pts, 0.5);
    assert.deepEqual(out[0], pts[0]);
    assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
    assert.ok(out.length < pts.length);
    assert.ok(out.some((p) => p.x === 4));
});

test('rdpSimplify handles < 3 points and empty input', () => {
    assert.deepEqual(G.rdpSimplify([], 1), []);
    assert.deepEqual(G.rdpSimplify([{ x: 1, y: 2 }], 1), [{ x: 1, y: 2 }]);
});

test('sampleArcThrough returns a circle through three points', () => {
    const res = G.sampleArcThrough({ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 10 }, 32);
    assert.equal(res.ok, true);
    assert.ok(res.pts.length > 3);
    // Every sampled point must lie on the same radius (within tolerance).
    const radii = res.pts.map((p) => Math.hypot(p.x - res.cx, p.y - res.cy));
    const max = Math.max(...radii), min = Math.min(...radii);
    assert.ok(max - min < 1e-6);
});

test('sampleArcThrough falls back to a polyline when collinear', () => {
    const res = G.sampleArcThrough({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, 16);
    assert.equal(res.ok, false);
    assert.equal(res.pts.length, 3);
});

test('sampleEllipse and sampleSpiral are finite', () => {
    const ell = G.sampleEllipse(50, 50, 20, 10, 0, Math.PI * 2, 16);
    assert.equal(ell.length, 17);
    ell.forEach((p) => assert.ok(isFinite(p.x) && isFinite(p.y)));
    const spiral = G.sampleSpiral(50, 50, 20, 0, 1.618, 4, 12);
    assert.ok(spiral.length > 10);
    spiral.forEach((p) => assert.ok(isFinite(p.x) && isFinite(p.y)));
});

test('fibPrice interpolates between anchors', () => {
    assert.equal(G.fibPrice(100, 200, 0), 100);
    assert.equal(G.fibPrice(100, 200, 0.5), 150);
    assert.equal(G.fibPrice(100, 200, 1), 200);
    assert.ok(Math.abs(G.fibPrice(100, 200, 1.618) - 261.8) < 1e-9);
});

test('dropCollidingLabels keeps the first of a close pair', () => {
    const kept = G.dropCollidingLabels([{ y: 10 }, { y: 15 }, { y: 30 }], 11);
    assert.deepEqual(kept.map((k) => k.y), [10, 30]);
});

test('hitPrimitives: segment tolerance, polygon interior, text bbox', () => {
    const line = { kind: 'path', pts: [{ x: 10, y: 10 }, { x: 50, y: 10 }], closed: false, width: 1 };
    assert.equal(G.hitPrimitives([line], 30, 14, 6), true);
    assert.equal(G.hitPrimitives([line], 30, 30, 6), false);
    const poly = { kind: 'path', closed: true, fillAlpha: 0.1, pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
    assert.equal(G.hitPrimitives([poly], 50, 50, 4), true);
    assert.equal(G.hitPrimitives([poly], 150, 50, 4), false);
    const txt = { kind: 'text', x: 20, y: 40, text: 'Hello', size: 12 };
    assert.equal(G.hitPrimitives([txt], 30, 36, 0), true);
    assert.equal(G.hitPrimitives([txt], 300, 36, 0), false);
    const arc = { kind: 'arc', cx: 0, cy: 0, rx: 50, ry: 50, a0: 0, a1: Math.PI * 2 };
    assert.equal(G.hitPrimitives([arc], 50, 0, 6), true);
});

test('primitivesBBox unions every primitive', () => {
    const bb = G.primitivesBBox([
        { kind: 'path', pts: [{ x: 10, y: 10 }, { x: 20, y: 20 }] },
        { kind: 'dot', x: 40, y: 5, r: 3 }
    ]);
    assert.equal(bb.x, 10);
    assert.equal(bb.y, 2);
    assert.equal(bb.x + bb.w, 43);
    assert.equal(bb.y + bb.h, 20);
});

test('bboxIntersects / expandBBox', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(G.bboxIntersects(a, { x: 5, y: 5, w: 10, h: 10 }), true);
    assert.equal(G.bboxIntersects(a, { x: 20, y: 20, w: 5, h: 5 }), false);
    const e = G.expandBBox(a, 2);
    assert.deepEqual(e, { x: -2, y: -2, w: 14, h: 14 });
});

function state(ids) {
    return ids.map((id) => ({ id, tool: 'trend', points: [] }));
}

test('DrawingHistory add/remove/update/order/clear inverses', () => {
    const history = new G.DrawingHistory(50);
    let list = [];

    list = history.apply(list, { type: 'add', drawing: { id: 'a', tool: 'trend' } }).list;
    assert.equal(list.length, 1);
    list = history.apply(list, { type: 'add', drawing: { id: 'b', tool: 'trend' } }).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b']);
    list = history.undoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a']);
    list = history.redoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b']);

    list = history.apply(list, { type: 'update', id: 'a', before: { id: 'a', z: 0 }, after: { id: 'a', z: 5 } }).list;
    assert.equal(list[0].z, 5);
    list = history.undoList(list).list;
    assert.equal(list[0].z, 0);

    list = history.apply(list, { type: 'order', id: 'a', beforeZ: 0, afterZ: 9 }).list;
    assert.equal(list[0].z, 9);
    list = history.undoList(list).list;
    assert.equal(list[0].z, 0);

    list = history.apply(list, { type: 'remove', id: 'a', drawing: { id: 'a' }, index: 0 }).list;
    assert.deepEqual(list.map((d) => d.id), ['b']);
    list = history.undoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b']);

    list = history.apply(list, { type: 'clear', ids: ['a', 'b'] }).list;
    assert.equal(list.length, 0);
    list = history.undoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b']);
});

test('DrawingHistory keeps indexes on remove/restore', () => {
    const history = new G.DrawingHistory(50);
    let list = state(['a', 'b', 'c']);
    list = history.apply(list, { type: 'remove', id: 'b', drawing: { id: 'b' }, index: 1 }).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'c']);
    list = history.undoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b', 'c']);
});

test('DrawingHistory caps at the limit and clears redo on a new action', () => {
    const history = new G.DrawingHistory(50);
    let list = [];
    for (let i = 0; i < 60; i++) {
        list = history.apply(list, { type: 'add', drawing: { id: `d${i}`, tool: 'trend' } }).list;
    }
    assert.equal(history.undoStack.length, 50);
    assert.equal(history.redoStack.length, 0);

    history.undoList(list);
    assert.equal(history.redoStack.length, 1);
    history.record({ type: 'add', drawing: { id: 'x', tool: 'trend' } });
    assert.equal(history.redoStack.length, 0);
});

test('clear command only removes listed ids and restores order', () => {
    const history = new G.DrawingHistory(50);
    let list = state(['a', 'b', 'c']);
    const cmd = { type: 'clear', ids: ['a', 'c'], items: [
        { drawing: { id: 'a' }, index: 0 },
        { drawing: { id: 'c' }, index: 2 }
    ] };
    list = history.apply(list, cmd).list;
    assert.deepEqual(list.map((d) => d.id), ['b']);
    list = history.undoList(list).list;
    assert.deepEqual(list.map((d) => d.id), ['a', 'b', 'c']);
});

test('applyCommand never mutates the input array', () => {
    const original = state(['a']);
    const next = G.applyCommand(original, { type: 'add', drawing: { id: 'b' } });
    assert.equal(original.length, 1);
    assert.equal(next.length, 2);
});
