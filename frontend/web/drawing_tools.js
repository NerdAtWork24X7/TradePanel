/* ═══════════════════════════════════════════════════════════════════════════
 * DrawingTools — data-driven registry for the chart drawing layer
 *
 * Every tool is a descriptor: identity, palette family, input gesture, anchor
 * count, defaults, an icon and a pure `build(shape, env)` that turns
 * data-space anchors into pixel-space primitives. Adding a tool is one entry,
 * never a new branch in the renderer.
 *
 * Depends on DrawingGeometry (UMD, loaded first).
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var geom = root && root.DrawingGeometry;
    if (!geom && typeof require === 'function') {
        try { geom = require('./drawing_geometry.js'); } catch (err) { geom = null; }
    }
    var api = factory(geom);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DrawingTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
    'use strict';

    if (!G) throw new Error('DrawingTools requires DrawingGeometry');

    var FAMILIES = [
        { id: 'cursor', label: 'Cursor' },
        { id: 'trend', label: 'Trend' },
        { id: 'fib', label: 'Fib & Gann' },
        { id: 'patterns', label: 'Patterns' },
        { id: 'shapes', label: 'Shapes' },
        { id: 'annotation', label: 'Text & notes' },
        { id: 'position', label: 'Position' }
    ];

    var DASHES = ['solid', 'dashed', 'dotted'];
    var EXTENDS = ['none', 'left', 'right', 'both'];
    var DEFAULT_STYLE = {
        color: '', width: 1, dash: 'solid', fill: 0.08,
        extend: 'none', textSize: 12, params: {}
    };

    /* ── Primitive helpers ──────────────────────────────────────────────── */

    function path(pts, opts) {
        if (!pts || pts.length < 2) return null;
        var o = opts || {};
        return {
            kind: 'path', pts: pts, closed: !!o.closed,
            fillAlpha: o.fillAlpha || 0, tone: o.tone || 'line',
            dash: o.dash || null, width: o.width || null,
            layer: o.fillAlpha ? 0 : 1, cap: o.cap || null
        };
    }

    function textPrim(x, y, str, opts) {
        var o = opts || {};
        var size = o.size || 12;
        var lines = (o.lines && o.lines.length) ? o.lines : String(str == null ? '' : str).split('\n');
        if (!lines.length || (lines.length === 1 && !lines[0])) return null;
        var maxLen = 0;
        lines.forEach(function (line) { if (line.length > maxLen) maxLen = line.length; });
        return {
            kind: 'text', x: x, y: y, text: lines.join('\n'), lines: lines,
            align: o.align || 'left', baseline: o.baseline || 'alphabetic',
            size: size, tone: o.tone || 'soft', badge: !!o.badge,
            mono: o.mono !== false, w: o.w != null ? o.w : maxLen * size * 0.58,
            h: o.h != null ? o.h : lines.length * size * 1.25, layer: 2,
            color: o.color || null
        };
    }

    function dot(x, y, r, tone) {
        return { kind: 'dot', x: x, y: y, r: r || 3, tone: tone || 'accent', layer: 1 };
    }

    function arcPrim(cx, cy, rx, ry, a0, a1, opts) {
        var o = opts || {};
        return {
            kind: 'arc', cx: cx, cy: cy, rx: rx, ry: ry, a0: a0, a1: a1,
            tone: o.tone || 'soft', dash: o.dash || null, width: o.width || null, layer: 1
        };
    }

    function markerPrim(x, y, glyph, size, tone) {
        return { kind: 'marker', x: x, y: y, glyph: glyph, size: size || 12, tone: tone || 'line', layer: 1 };
    }

    function fmtPrice(env, value) {
        if (!isFiniteNum(value)) return '—';
        var p = env && env.precision != null ? env.precision : 2;
        return Number(value).toFixed(p);
    }

    function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

    function boxOf(env) {
        return env && env.box && env.box.w > 0 && env.box.h > 0 ? env.box : null;
    }

    function project(env, point) {
        if (!point || !env) return null;
        var x = env.px(point.time);
        var y = env.py(point.price);
        if (x == null || y == null || !isFiniteNum(x) || !isFiniteNum(y)) return null;
        return { x: x, y: y };
    }

    function projectAll(env, points) {
        var out = [];
        var ok = true;
        (points || []).forEach(function (p) {
            var q = project(env, p);
            if (!q) { ok = false; return; }
            out.push(q);
        });
        return ok ? out : null;
    }

    function handlesOf(pts, axis) {
        return (pts || []).map(function (p, index) {
            return { x: p.x, y: p.y, index: index, axis: axis || 'both' };
        });
    }

    function empty() { return { prims: [], handles: [] }; }

    function finish(prims, handles) {
        return { prims: prims.filter(Boolean), handles: handles || [] };
    }

    function clipped(seg, opts) {
        if (!seg) return null;
        return path([seg[0], seg[1]], opts || {});
    }

    function signedOffset(a, b, through) {
        var u = G.unit(a, b);
        if (!u.len) return 0;
        var n = G.perp(u);
        return (through.x - a.x) * n.x + (through.y - a.y) * n.y;
    }

    /* ── Builders ───────────────────────────────────────────────────────── */

    var B = {};

    /** Straight line tools: trend, ray, extended, info + trendAngle. */
    B.segment = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var p0 = pts[0], p1 = pts[1];
        var mode = o.extend || (shape.params && shape.params.extend) || 'none';
        var seg = mode === 'none' ? G.clipSegment(p0, p1, box) : G.clipExtended(p0, p1, box, mode);
        var prims = [];
        if (seg) prims.push(clipped(seg, { dash: shape.dash, width: shape.width }));
        if (o.arrow && seg) {
            var end = G.clipSegment(p0, p1, box) ? p1 : seg[1];
            var u = G.unit(p0, p1);
            if (u.len) {
                var head = arrowHead(p1, u, 10);
                prims.push(path(head, { closed: true, fillAlpha: 1, tone: 'line' }));
            }
            void end;
        }
        if (o.readout || o.info) {
            var delta = shape.points[1].price - shape.points[0].price;
            var pct = shape.points[0].price ? (delta / shape.points[0].price) * 100 : 0;
            var barSec = env.barSeconds || 1;
            var bars = Math.round((shape.points[1].time - shape.points[0].time) / barSec);
            var str = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%  ' +
                (delta >= 0 ? '+' : '') + fmtPrice(env, delta) + '  ' + bars + ' bars';
            var mid = G.midpoint(p0, p1);
            prims.push(textPrim(Math.min(Math.max(mid.x + 6, 4), box.w - 4), Math.max(12, mid.y - 8), str, {
                size: 10, tone: 'soft', mono: true, align: 'left'
            }));
        }
        if (o.percent) {
            var dp = shape.points[1].price - shape.points[0].price;
            var p2 = shape.points[0].price ? (dp / shape.points[0].price) * 100 : 0;
            prims.push(textPrim(p1.x + 5, p1.y - 5, (p2 >= 0 ? '+' : '') + p2.toFixed(2) + '%', {
                size: 10, tone: 'soft', mono: true
            }));
        }
        return finish(prims, handlesOf([p0, p1]));
    };

    function arrowHead(from, u, size) {
        var back = { x: from.x - u.x * size, y: from.y - u.y * size };
        var n = G.perp(u);
        return [from,
            { x: back.x + n.x * size * 0.5, y: back.y + n.y * size * 0.5 },
            { x: back.x - n.x * size * 0.5, y: back.y - n.y * size * 0.5 }];
    }

    /** Levels: hline, hray, vline, crossline, priceLabel, priceNote. */
    B.level = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        if (!box) return empty();
        var p = shape.points && shape.points[0];
        if (!p) return empty();
        var y = shape.tool === 'vline' ? null : env.py(p.price);
        var x = shape.tool === 'hline' ? null : env.px(p.time);
        var prims = [];
        var handles = [];
        var anchorX = x == null ? box.w - 10 : Math.max(0, Math.min(box.w, x));
        var anchorY = y == null ? 10 : y;
        if (shape.tool === 'hline' || shape.tool === 'priceLabel' || shape.tool === 'priceNote') {
            if (y == null || y < 0 || y > box.h) return empty();
            var seg = G.clipHorizontal(y, box);
            prims.push(clipped(seg, { dash: shape.dash, width: shape.width }));
            prims.push(textPrim(6, y - 4, fmtPrice(env, p.price), { size: 10, tone: 'soft', mono: true }));
            handles.push({ x: box.w - 10, y: y, index: 0, axis: 'price' });
        } else if (shape.tool === 'vline') {
            if (x == null || x < 0 || x > box.w) return empty();
            prims.push(clipped(G.clipVertical(x, box), { dash: shape.dash, width: shape.width }));
            handles.push({ x: x, y: 10, index: 0, axis: 'time' });
        } else if (shape.tool === 'hray') {
            if (y == null || y < 0 || y > box.h) return empty();
            var startX = Math.max(0, Math.min(box.w, x == null ? 0 : x));
            prims.push(path([{ x: startX, y: y }, { x: box.w, y: y }], { dash: shape.dash, width: shape.width }));
            prims.push(textPrim(box.w - 4, y - 4, fmtPrice(env, p.price), { size: 10, tone: 'soft', mono: true, align: 'right' }));
            handles.push({ x: startX, y: y, index: 0, axis: 'price' });
        } else if (shape.tool === 'crossline') {
            if (y != null && y >= 0 && y <= box.h) {
                prims.push(clipped(G.clipHorizontal(y, box), { dash: shape.dash, width: shape.width, tone: 'soft' }));
            }
            if (x != null && x >= 0 && x <= box.w) {
                prims.push(clipped(G.clipVertical(x, box), { dash: shape.dash, width: shape.width, tone: 'soft' }));
            }
            handles.push({ x: anchorX, y: anchorY, index: 0 });
        }
        if (o.chip) {
            prims.push(textPrim(box.w - 4, anchorY, o.chipText || fmtPrice(env, p.price), {
                size: 10, tone: 'soft', mono: true, align: 'right', badge: true
            }));
        }
        return finish(prims, handles);
    };

    /** Two-parallel-line channel with fill. */
    B.channel = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts) return empty();
        var prims = [];
        var lineA, lineB, handles;
        if (o.disjoint) {
            if (pts.length < 4) return empty();
            var s1 = G.clipSegment(pts[0], pts[1], box);
            var s2 = G.clipSegment(pts[2], pts[3], box);
            prims.push(clipped(s1, { dash: shape.dash, width: shape.width }));
            prims.push(clipped(s2, { dash: shape.dash, width: shape.width }));
            if (s1 && s2) prims.push(path([s1[0], s1[1], s2[1], s2[0]], { closed: true, fillAlpha: shape.fill, tone: 'line' }));
            handles = handlesOf(pts);
        } else if (o.flat) {
            if (pts.length < 3) return empty();
            lineA = G.clipSegment(pts[0], pts[1], box);
            var fy = pts[2].y;
            lineB = (fy >= 0 && fy <= box.h) ? [{ x: 0, y: fy }, { x: box.w, y: fy }] : null;
            prims.push(clipped(lineA, { dash: shape.dash, width: shape.width }));
            prims.push(clipped(lineB, { dash: shape.dash, width: shape.width }));
            if (lineA && lineB) {
                prims.push(path([lineA[0], lineA[1], lineB[1], lineB[0]], { closed: true, fillAlpha: shape.fill, tone: 'line' }));
            }
            handles = handlesOf(pts);
        } else {
            if (pts.length < 3) {
                if (pts.length < 2) return empty();
                var only = G.clipSegment(pts[0], pts[1], box);
                prims.push(clipped(only, { dash: shape.dash, width: shape.width }));
                return finish(prims, handlesOf(pts));
            }
            var par = G.parallelThrough(pts[0], pts[1], pts[2]);
            lineA = G.clipSegment(pts[0], pts[1], box);
            lineB = G.clipSegment(par.p0, par.p1, box);
            prims.push(clipped(lineA, { dash: shape.dash, width: shape.width }));
            prims.push(clipped(lineB, { dash: shape.dash, width: shape.width }));
            if (lineA && lineB) {
                prims.push(path([lineA[0], lineA[1], lineB[1], lineB[0]], { closed: true, fillAlpha: shape.fill, tone: 'line' }));
            }
            handles = handlesOf(pts);
        }
        return finish(prims, handles);
    };

    B.fibLevels = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts) return empty();
        var levels = (shape.params && shape.params.levels) || G.FIB_RETRACEMENT;
        var prims = [];
        var labels = [];
        var x0, x1, yOf;
        if (o.extension && pts.length >= 3) {
            var base = pts[2];
            var unit = shape.points[1].price - shape.points[0].price;
            x0 = Math.min(pts[0].x, pts[1].x, pts[2].x);
            x1 = (shape.params && shape.params.extend === 'right') || o.extendRight ? box.w : Math.max(pts[0].x, pts[1].x, pts[2].x);
            yOf = function (ratio) { return env.py(shape.points[2].price + unit * ratio); };
            levels.forEach(function (ratio) {
                var y = yOf(ratio);
                if (y == null || y < 0 || y > box.h) return;
                prims.push(path([{ x: Math.max(0, x0), y: y }, { x: Math.min(box.w, x1), y: y }], {
                    dash: ratio === 0 ? 'solid' : 'dashed', width: shape.width, tone: Math.abs(ratio) >= 1 ? 'soft' : 'line'
                }));
                labels.push({ y: y, ratio: ratio, price: shape.points[2].price + unit * ratio });
            });
        } else if (o.channel && pts.length >= 3) {
            var u = G.unit(pts[0], pts[1]);
            if (!u.len) return empty();
            var dist = signedOffset(pts[0], pts[1], pts[2]);
            levels.forEach(function (ratio) {
                var line = G.offsetLine(pts[0], pts[1], dist * ratio);
                var seg = G.clipInfinite(line.p0, line.p1, box);
                if (!seg) return;
                prims.push(clipped(seg, {
                    dash: ratio === 0 || ratio === 1 ? 'solid' : 'dashed',
                    width: shape.width, tone: ratio === 0 ? 'line' : 'soft'
                }));
                labels.push({ y: seg[0].y, ratio: ratio, price: null, x: Math.min(seg[0].x, seg[1].x) });
            });
            var zero = G.clipInfinite(pts[0], pts[1], box);
            var one = G.clipInfinite(
                { x: pts[0].x + G.perp(u).x * dist, y: pts[0].y + G.perp(u).y * dist },
                { x: pts[1].x + G.perp(u).x * dist, y: pts[1].y + G.perp(u).y * dist }, box);
            if (zero && one && shape.fill > 0) {
                prims.push(path([zero[0], zero[1], one[1], one[0]], { closed: true, fillAlpha: shape.fill, tone: 'line' }));
            }
        } else {
            if (pts.length < 2) return empty();
            x0 = Math.min(pts[0].x, pts[1].x);
            x1 = Math.max(pts[0].x, pts[1].x);
            var ext = (shape.params && shape.params.extend) || 'none';
            if (ext === 'right') x1 = box.w;
            else if (ext === 'left') x0 = 0;
            else if (ext === 'both') { x0 = 0; x1 = box.w; }
            var top = shape.points[0].price, bottom = shape.points[1].price;
            levels.forEach(function (ratio) {
                var y = env.py(top + (bottom - top) * ratio);
                if (y == null || y < 0 || y > box.h) return;
                prims.push(path([{ x: Math.max(0, x0), y: y }, { x: Math.min(box.w, x1), y: y }], {
                    dash: ratio === 0 || ratio === 1 ? 'solid' : 'dashed',
                    width: shape.width, tone: ratio === 0 || ratio === 1 ? 'line' : 'soft'
                }));
                labels.push({ y: y, ratio: ratio, price: top + (bottom - top) * ratio });
            });
            if (shape.fill > 0) {
                var yTop = env.py(top), yBottom = env.py(bottom);
                if (yTop != null && yBottom != null) {
                    prims.push(path([
                        { x: Math.max(0, x0), y: yTop }, { x: Math.min(box.w, x1), y: yTop },
                        { x: Math.min(box.w, x1), y: yBottom }, { x: Math.max(0, x0), y: yBottom }
                    ], { closed: true, fillAlpha: shape.fill * 0.5, tone: 'line' }));
                }
            }
        }
        var kept = G.dropCollidingLabels(labels, 11);
        kept.forEach(function (item) {
            var lx = item.x != null ? item.x + 3 : Math.max(0, x0) + 3;
            var str = trimRatio(item.ratio) + (item.price != null ? ' (' + fmtPrice(env, item.price) + ')' : '');
            prims.push(textPrim(lx, item.y - 3, str, { size: 9.5, tone: 'soft', mono: true }));
        });
        return finish(prims, handlesOf(pts));
    };

    B.fibTime = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var levels = (shape.params && shape.params.levels) || G.FIB_TIME;
        var prims = [];
        levels.forEach(function (ratio) {
            var x = pts[0].x + (pts[1].x - pts[0].x) * ratio;
            if (x < 0 || x > box.w) return;
            prims.push(path([{ x: x, y: 0 }, { x: x, y: box.h }], {
                dash: ratio === 0 || ratio === 1 ? 'solid' : 'dashed', width: shape.width,
                tone: ratio === 0 || ratio === 1 ? 'line' : 'soft'
            }));
            prims.push(textPrim(x + 3, 12, trimRatio(ratio), { size: 9.5, tone: 'soft', mono: true }));
        });
        return finish(prims, handlesOf(pts));
    };

    B.fibRadial = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var a = pts[0], b = pts[1];
        var levels = (shape.params && shape.params.levels) || G.FIB_RADIAL;
        var prims = [];
        var dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist < 1) return empty();
        if (o.mode === 'fan') {
            levels.forEach(function (ratio) {
                var through = G.lerpPoint(a, b, ratio);
                var seg = G.clipRay(a, through, box);
                if (!seg) return;
                prims.push(clipped(seg, { tone: ratio === 1 ? 'line' : 'soft', width: shape.width, dash: ratio === 1 ? 'solid' : 'dashed' }));
                prims.push(textPrim(seg[1].x - 2, seg[1].y - 3, trimRatio(ratio), { size: 9, tone: 'soft', mono: true, align: 'right' }));
            });
        } else if (o.mode === 'arcs') {
            var start = Math.atan2(a.y - b.y, a.x - b.x);
            levels.forEach(function (ratio) {
                var r = dist * ratio;
                if (r < 1) return;
                prims.push(arcPrim(b.x, b.y, r, r, start, start + Math.PI, { tone: ratio === 1 ? 'line' : 'soft', dash: ratio === 1 ? 'solid' : 'dashed' }));
            });
        } else if (o.mode === 'circles') {
            levels.forEach(function (ratio) {
                var r = dist * ratio;
                if (r < 1) return;
                prims.push(arcPrim(b.x, b.y, r, r, 0, Math.PI * 2, { tone: ratio === 1 ? 'line' : 'soft', dash: ratio === 1 ? 'solid' : 'dashed' }));
            });
        } else {
            var pts2 = G.sampleSpiral(b.x, b.y, dist, Math.atan2(a.y - b.y, a.x - b.x), 1.618, 4, 20);
            if (pts2.length) prims.push(path(pts2, { dash: shape.dash, width: shape.width }));
        }
        return finish(prims, handlesOf([a, b]));
    };

    B.gannGrid = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var a = pts[0], b = pts[1];
        var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        var y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        var prims = [];
        prims.push(path([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], {
            closed: true, fillAlpha: opts && opts.fill ? shape.fill : 0, tone: 'line', width: shape.width
        }));
        G.GANN_GRID.forEach(function (ratio) {
            var x = x0 + (x1 - x0) * ratio;
            var y = y0 + (y1 - y0) * ratio;
            prims.push(path([{ x: x, y: y0 }, { x: x, y: y1 }], { tone: 'soft', dash: 'dashed', width: 1 }));
            prims.push(path([{ x: x0, y: y }, { x: x1, y: y }], { tone: 'soft', dash: 'dashed', width: 1 }));
        });
        prims.push(path([{ x: x0, y: y1 }, { x: x1, y: y0 }], { tone: 'soft', width: 1 }));
        prims.push(path([{ x: x0, y: y0 }, { x: x1, y: y1 }], { tone: 'soft', width: 1 }));
        return finish(prims, handlesOf([a, b]));
    };

    B.gannFan = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var a = pts[0], b = pts[1];
        var prims = [];
        var lines = G.gannAnglePoints(a, b, G.GANN_FAN);
        lines.forEach(function (item) {
            var seg = G.clipRay(a, item.point, box);
            if (!seg) return;
            prims.push(clipped(seg, { tone: item.ratio === 1 ? 'line' : 'soft', width: item.ratio === 1 ? shape.width : 1 }));
            prims.push(textPrim(seg[1].x - 2, seg[1].y - 3, gannLabel(item.ratio), { size: 9, tone: 'soft', mono: true, align: 'right' }));
        });
        return finish(prims, handlesOf([a, b]));
    };

    B.pattern = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 2) return empty();
        var prims = [];
        prims.push(path(pts, { width: shape.width, tone: 'line' }));
        (o.labels || []).forEach(function (label, index) {
            var p = pts[index];
            if (!p || !label) return;
            prims.push(textPrim(p.x + 5, p.y - 7, label, { size: 10, tone: 'soft', mono: true, badge: true }));
        });
        if (o.neckline && pts.length >= 4) {
            var n1 = pts[1], n2 = pts[3];
            var seg = G.clipExtended(n1, n2, box, 'both');
            if (seg) prims.push(clipped(seg, { dash: 'dashed', tone: 'soft', width: 1 }));
        }
        if (o.projection && pts.length >= 6) {
            var last = pts[pts.length - 1];
            var prev = pts[pts.length - 2];
            var proj = { x: last.x + (last.x - prev.x) * 0.6, y: last.y };
            prims.push(path([last, proj], { dash: 'dotted', tone: 'soft', width: 1 }));
        }
        if (o.diagonals && pts.length >= 4) {
            prims.push(path([pts[0], pts[2 % pts.length]], { dash: 'dotted', tone: 'soft', width: 1 }));
            prims.push(path([pts[1], pts[3 % pts.length]], { dash: 'dotted', tone: 'soft', width: 1 }));
        }
        return finish(prims, handlesOf(pts));
    };

    B.polyShape = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 2) return empty();
        var prims = [];
        var poly = pts;
        if (o.rotated) {
            if (pts.length < 3) return empty();
            var a = pts[0], b = pts[1];
            var u = G.unit(a, b);
            if (!u.len) {
                poly = rectPoly(a, b);
            } else {
                var n = G.perp(u);
                var w = (pts[2].x - a.x) * n.x + (pts[2].y - a.y) * n.y;
                if (Math.abs(w) < 1) poly = rectPoly(a, b);
                else {
                    poly = [
                        a, b,
                        { x: b.x + n.x * w, y: b.y + n.y * w },
                        { x: a.x + n.x * w, y: a.y + n.y * w }
                    ];
                }
            }
        } else if (o.rect) {
            poly = rectPoly(pts[0], pts[1]);
        }
        var closed = o.closed || shape.tool === 'triangle';
        prims.push(path(poly, {
            closed: closed,
            fillAlpha: closed ? shape.fill : 0,
            width: shape.width, tone: 'line'
        }));
        if (o.perimeter && closed) {
            var total = 0;
            for (var i = 0; i < poly.length; i++) {
                var j = (i + 1) % poly.length;
                total += Math.hypot(poly[j].x - poly[i].x, poly[j].y - poly[i].y);
            }
            prims.push(textPrim(poly[0].x + 6, poly[0].y - 7, Math.round(total) + ' px', {
                size: 10, tone: 'soft', mono: true, badge: true
            }));
        }
        return finish(prims, handlesOf(pts));
    };

    function rectPoly(a, b) {
        return [
            { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
            { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
            { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
            { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) }
        ];
    }

    B.ellipse = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var a = pts[0], b = pts[1];
        var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        var rx, ry;
        if (o.circle) {
            var r = Math.hypot(b.x - a.x, b.y - a.y) / 2;
            rx = r; ry = r;
        } else {
            rx = Math.abs(b.x - a.x) / 2;
            ry = Math.abs(b.y - a.y) / 2;
        }
        if (rx < 0.5 || ry < 0.5) return finish([], handlesOf([a, b]));
        var pts2 = G.sampleEllipse(cx, cy, rx, ry, 0, Math.PI * 2, 72);
        var prims = [path(pts2, { closed: true, fillAlpha: shape.fill, width: shape.width, tone: 'line' })];
        return finish(prims, handlesOf([a, b]));
    };

    B.arc = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 3) return empty();
        var res = G.sampleArcThrough(pts[0], pts[1], pts[2], 64);
        return finish([path(res.pts, { width: shape.width, tone: 'line', closed: false })], handlesOf(pts));
    };

    B.curve = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 3) return empty();
        var pts2 = G.sampleQuadratic(pts[0], pts[1], pts[2], 48);
        var prims = [path(pts2, { width: shape.width, tone: 'line' })];
        if (opts && opts.showControl) {
            prims.push(path([pts[0], pts[1], pts[2]], { dash: 'dotted', tone: 'soft', width: 1 }));
        }
        return finish(prims, handlesOf(pts));
    };

    B.arrow = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 2));
        if (!box || !pts) return empty();
        var a = pts[0], b = pts[1];
        var u = G.unit(a, b);
        if (!u.len) return empty();
        var seg = G.clipSegment(a, b, box);
        var prims = [];
        if (seg) prims.push(clipped(seg, { width: shape.width, tone: 'line' }));
        // Keep the head at the real endpoint when visible, else at the clipped edge.
        var end = (b.x >= 0 && b.x <= box.w && b.y >= 0 && b.y <= box.h) ? b : seg ? seg[1] : null;
        if (end) prims.push(path(arrowHead(end, u, 11), { closed: true, fillAlpha: 1, tone: 'line' }));
        prims.push(textPrim(b.x + 6, b.y - 6,
            trimNum((shape.points[1].price - shape.points[0].price) >= 0 ? '+' : '') + fmtPrice(env, shape.points[1].price - shape.points[0].price),
            { size: 10, tone: 'soft', mono: true }));
        return finish(prims, handlesOf([a, b]));
    };

    B.marker = function (shape, env, opts) {
        var box = boxOf(env);
        var pts = projectAll(env, shape.points && shape.points.slice(0, 1));
        if (!box || !pts) return empty();
        var p = pts[0];
        var prims = [markerPrim(p.x, p.y, (opts && opts.glyph) || 'arrow', (opts && opts.size) || 14, 'line')];
        if (shape.text) {
            prims.push(textPrim(p.x + 10, p.y - 10, shape.text, { size: 11, tone: 'text' }));
        }
        return finish(prims, handlesOf([p]));
    };

    B.freehand = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 2) return empty();
        var simplified = pts.length > 128 ? G.rdpSimplify(pts, 0.75) : pts;
        var width = o.width || shape.width;
        var prims = [path(simplified, {
            width: width, tone: 'line', cap: 'round',
            fillAlpha: 0, dash: 'solid'
        })];
        if (o.opacity) prims[0].opacity = o.opacity;
        var handles = [pts[0], pts[pts.length - 1]].map(function (p, index) {
            return { x: p.x, y: p.y, index: index === 0 ? 0 : shape.points.length - 1, axis: 'both' };
        });
        return finish(prims, handles);
    };

    function wrapText(value, maxChars) {
        var out = [];
        String(value == null ? '' : value).replace(/\r/g, '').split('\n').forEach(function (line) {
            var words = line.split(/\s+/);
            var cur = '';
            words.forEach(function (word) {
                while (word.length > maxChars) {
                    if (cur) { out.push(cur); cur = ''; }
                    out.push(word.slice(0, maxChars));
                    word = word.slice(maxChars);
                }
                if (!cur) cur = word;
                else if (cur.length + 1 + word.length <= maxChars) cur += ' ' + word;
                else { out.push(cur); cur = word; }
            });
            if (cur) out.push(cur);
        });
        out = out.filter(function (line) { return line.length > 0; });
        return out.slice(0, 6).length ? out.slice(0, 6) : [''];
    }

    B.textAnchor = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || !pts.length) return empty();
        var anchor = pts[0];
        var size = shape.font || shape.textSize || 12;
        var lines = wrapText(shape.text || '', Math.max(8, Math.floor(220 / (size * 0.58))));
        var textW = 0;
        lines.forEach(function (line) { if (line.length > textW) textW = line.length; });
        textW = Math.max(60, textW * size * 0.58);
        var textH = lines.length * size * 1.25;
        var prims = [];
        var handles = handlesOf(pts, 'both');
        var mode = o.mode || 'plain';
        var bx, by, align = 'left';
        if (mode === 'callout' && pts.length >= 2) {
            var target = pts[1];
            var bubbleX = clampV(target.x - 6, 8, box.w - 8);
            var bubbleY = clampV(target.y - textH - 22, 8, box.h - 8);
            prims.push(path([anchor, { x: bubbleX + (target.x < anchor.x ? 0 : textW * 0.5), y: bubbleY + textH + 6 }],
                { tone: 'soft', width: 1 }));
            prims.push(bubblePath(bubbleX, bubbleY, textW + 16, textH + 12, shape.fill));
            bx = bubbleX + 8; by = bubbleY + 16;
            handles = handlesOf(pts);
        } else if (mode === 'comment' || mode === 'note') {
            prims.push(dot(anchor.x, anchor.y, mode === 'note' ? 3.5 : 2.5, 'accent'));
            if (mode === 'comment') {
                bx = clampV(anchor.x + 10, 8, box.w - textW - 24);
                by = clampV(anchor.y - textH - 16, 8, box.h - 8);
                prims.push(bubblePath(bx - 6, by - 6, textW + 16, textH + 12, shape.fill, true));
                bx = bx + 2;
            } else {
                bx = anchor.x + 10;
                by = anchor.y + 4;
            }
        } else {
            bx = anchor.x + 4;
            by = anchor.y - 4;
        }
        var tp = textPrim(bx, by + (mode === 'comment' ? size : 0), '', {
            size: size, lines: lines, tone: 'text', w: textW, h: textH, align: align, mono: false
        });
        prims.push(tp);
        return finish(prims, handles);
    };

    function clampV(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function bubblePath(x, y, w, h, fill, tail) {
        // Rounded rectangle approximated with quarter-circle sampling.
        var r = Math.min(7, w / 2, h / 2);
        var pts = [];
        function corner(cx, cy, a0, a1) {
            for (var i = 0; i <= 6; i++) {
                var a = a0 + (a1 - a0) * (i / 6);
                pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
            }
        }
        corner(x + w - r, y + r, -Math.PI / 2, 0);
        corner(x + w - r, y + h - r, 0, Math.PI / 2);
        corner(x + r, y + h - r, Math.PI / 2, Math.PI);
        corner(x + r, y + r, Math.PI, Math.PI * 1.5);
        return path(pts, { closed: true, fillAlpha: Math.max(0.08, fill), tone: 'line' });
    }

    B.rangeBox = function (shape, env, opts) {
        var o = opts || {};
        var box = boxOf(env);
        var pts = projectAll(env, shape.points);
        if (!box || !pts || pts.length < 2) return empty();
        var a = pts[0], b = pts[1];
        var p0 = shape.points[0], p1 = shape.points[1];
        var prims = [];
        var barSec = env.barSeconds || 1;
        var bars = Math.round((p1.time - p0.time) / barSec);
        var dp = p1.price - p0.price;
        var pct = p0.price ? (dp / p0.price) * 100 : 0;
        var up = dp >= 0;
        var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        var y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        if (o.mode === 'forecast') {
            var stop = p0.price - dp;
            var yStop = env.py(stop);
            var yEntry = env.py(p0.price);
            if (yEntry != null && yStop != null) {
                prims.push(path([{ x: x0, y: Math.min(yEntry, y1) }, { x: x1, y: Math.min(yEntry, y1) },
                    { x: x1, y: Math.max(yEntry, y1) }, { x: x0, y: Math.max(yEntry, y1) }],
                    { closed: true, fillAlpha: 0.10, tone: up ? 'up' : 'down' }));
                prims.push(path([{ x: x0, y: Math.min(yEntry, yStop) }, { x: x1, y: Math.min(yEntry, yStop) },
                    { x: x1, y: Math.max(yEntry, yStop) }, { x: x0, y: Math.max(yEntry, yStop) }],
                    { closed: true, fillAlpha: 0.10, tone: up ? 'down' : 'up' }));
                [[yEntry, 'ENTRY', 'accent'], [y1, 'TP', 'up'], [yStop, 'SL', 'down']].forEach(function (row) {
                    if (row[0] == null || row[0] < 0 || row[0] > box.h) return;
                    prims.push(path([{ x: x0, y: row[0] }, { x: x1, y: row[0] }], { tone: row[2], width: 1.2, dash: row[1] === 'ENTRY' ? 'solid' : 'dashed' }));
                    prims.push(textPrim(x1 + 6, row[0] - 3, row[1], { size: 9.5, tone: row[2], mono: true, badge: true }));
                });
                var rr = Math.abs(p1.price - p0.price) / Math.max(1e-9, Math.abs(stop - p0.price));
                prims.push(textPrim(x0 + 6, Math.min(yEntry, y1) - 8, 'R:R ' + rr.toFixed(2), { size: 10, tone: up ? 'up' : 'down', mono: true, badge: true }));
            }
        } else {
            prims.push(path([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], {
                closed: true, fillAlpha: Math.max(0.06, shape.fill), tone: up ? 'up' : 'down', width: 1
            }));
            var label = [];
            if (o.mode !== 'date') {
                label.push((dp >= 0 ? '+' : '') + fmtPrice(env, dp) + '  ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%');
            }
            if (o.mode !== 'price') label.push(bars + ' bars');
            prims.push(textPrim(x0 + 6, Math.min(y0, y1) - 8, label.join('  '), {
                size: 10, tone: up ? 'up' : 'down', mono: true, badge: true
            }));
        }
        return finish(prims, handlesOf([a, b]));
    };

    function trimRatio(ratio) {
        if (ratio === 0 || ratio === 1) return String(ratio);
        return String(Math.round(ratio * 1000) / 1000);
    }

    function trimNum(value) {
        return value >= 0 ? '+' : '';
    }

    function gannLabel(ratio) {
        if (Math.abs(ratio - 1 / 8) < 1e-9) return '1/8';
        if (Math.abs(ratio - 1 / 4) < 1e-9) return '1/4';
        if (Math.abs(ratio - 1 / 3) < 1e-9) return '1/3';
        if (Math.abs(ratio - 1 / 2) < 1e-9) return '1/2';
        return String(ratio);
    }

    function withOpts(fn, opts) {
        return function (shape, env) { return fn(shape, env, opts); };
    }

    /* ── Icons (24×24 stroke paths) ─────────────────────────────────────── */

    var ICONS = {
        select: ['M6 3l12 9-6.2 1.3L9.4 20 6 3z'],
        eraser: ['M4 16l7-7 6 6-5 5H8l-4-4z', 'M12 20h8'],
        long: ['M12 20V5', 'M6.5 10.5L12 5l5.5 5.5'],
        short: ['M12 4v15', 'M6.5 13.5L12 19l5.5-5.5'],
        positionForecast: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M17 4v3', 'M17 11v3'],
        trend: ['M4 19L20 5', 'M4 19h.01', 'M20 5h.01'],
        ray: ['M4 19L19 6', 'M19 6h.01'],
        extended: ['M2 21L22 3'],
        info: ['M4 19L20 5', 'M8 14h8'],
        hline: ['M3 12h18'],
        hray: ['M4 12h16', 'M4 9v6'],
        vline: ['M12 3v18'],
        crossline: ['M12 3v18', 'M3 12h18'],
        channel: ['M3 17l18-7', 'M3 20l18-7'],
        flatTopBottom: ['M3 8h18', 'M3 17l18-6'],
        disjointChannel: ['M3 10l8-5', 'M13 16l8-5'],
        fib: ['M3 6h18', 'M3 10h18', 'M3 14h18', 'M3 18h18'],
        fibExt: ['M3 6h11', 'M3 10h16', 'M3 14h11', 'M3 18h16'],
        fibChannel: ['M3 18l18-8', 'M3 21l18-8', 'M3 15l18-8'],
        fibTime: ['M6 3v18', 'M12 3v18', 'M18 3v18', 'M3 12h18'],
        fibFan: ['M4 20L20 4', 'M4 20l16-9', 'M4 20l16-3'],
        fibArcs: ['M12 12a8 8 0 1 0 8 8', 'M12 12a5 5 0 1 0 5 5'],
        fibCircles: ['M12 12a8 8 0 1 0 0 16', 'M12 12a5 5 0 1 0 0 10'],
        fibSpiral: ['M12 12a3 3 0 1 1 3 3', 'M12 12a6 6 0 1 1 6 6'],
        gannBox: ['M4 4h16v16H4z', 'M4 12h16', 'M12 4v16'],
        gannFan: ['M4 20L20 4', 'M4 20l16-2', 'M4 20l9 0'],
        xabcd: ['M3 18l5-9 5 7 5-11', 'M3 18h.01', 'M18 5h.01'],
        abcd: ['M3 18l6-10 5 8 7-12'],
        headShoulders: ['M3 17l4-5 3 3 4-7 4 7 3-3'],
        threeDrives: ['M3 17l5-6 4 5 5-8 5 6'],
        elliottImpulse: ['M3 18l4-4 3 2 4-8 3 4 4-7'],
        rect: ['M4 5h16v14H4z'],
        rotatedRect: ['M5 8l11-4 4 9-11 4z'],
        ellipse: ['M12 12a8 5 0 1 0 0 .1z', 'M12 7v10'],
        circle: ['M12 12a7 7 0 1 0 0 .1z'],
        triangle: ['M12 4l8 15H4z'],
        polyline: ['M3 17l5-8 5 5 7-10'],
        path: ['M4 16l5-9 6 4 5-7v12H4z'],
        arc: ['M4 18a10 10 0 0 1 16 0'],
        curve: ['M3 18C9 18 9 6 15 6'],
        arrow: ['M4 20L20 4', 'M13 4h7v7'],
        arrowMarker: ['M12 20V5', 'M7 10l5-5 5 5'],
        brush: ['M4 20c4 0 4-4 8-6s6-6 8-6', 'M4 20l1-4 3 3-4 1z'],
        highlighter: ['M6 19h12', 'M9 15l.5-2 8-8 2 2-8 8-2 .5z'],
        text: ['M5 6h14', 'M12 6v13', 'M9 19h6'],
        note: ['M6 4h12v13l-4 4H6z', 'M14 21v-4h4'],
        comment: ['M4 5h16v11H9l-5 4z'],
        callout: ['M4 5h11v8H9l-3 3v-3H4z', 'M18 16h2'],
        priceNote: ['M4 6h10', 'M4 12h16', 'M4 18h10'],
        priceLabel: ['M4 12h11', 'M17 9h3v6h-3z'],
        pin: ['M12 21s6-6.5 6-11a6 6 0 1 0-12 0c0 4.5 6 11 6 11z', 'M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
        measure: ['M4 17L20 7', 'M7 14l2 3', 'M11 12l2 3', 'M15 10l2 3'],
        priceRange: ['M4 7h16', 'M4 17h16', 'M12 7v3', 'M12 14v3'],
        dateRange: ['M7 4v16', 'M17 4v16', 'M7 12h3', 'M14 12h3'],
        datePriceRange: ['M5 5h14v14H5z', 'M5 12h14', 'M12 5v14']
    };

    /* ── Tool descriptors ───────────────────────────────────────────────── */

    var TOOLS = [];
    var byIdMap = {};

    function define(spec) {
        var tool = {
            id: spec.id,
            family: spec.family,
            label: spec.label,
            input: spec.input || 'drag',
            anchors: spec.anchors,
            persisted: spec.persisted !== false,
            engine: spec.engine || 'drawing',
            icon: ICONS[spec.id] || (spec.icon || ['M4 12h16']),
            defaults: Object.assign({}, DEFAULT_STYLE, spec.defaults || {}, {
                params: Object.assign({}, (spec.defaults && spec.defaults.params) || {})
            }),
            build: spec.build ? withOpts(spec.build, spec.opts || {}) : function () { return empty(); },
            describe: spec.describe || function () { return spec.label; },
            editor: !!spec.editor,
            axis: spec.axis || null,
            snap: spec.snap || 'both'
        };
        TOOLS.push(tool);
        byIdMap[tool.id] = tool;
        return tool;
    }

    function maxPoints(tool) {
        if (typeof tool.anchors === 'number') return tool.anchors;
        return tool.anchors && tool.anchors.max ? tool.anchors.max : 2;
    }

    /* Cursor / utility */
    define({ id: 'select', family: 'cursor', label: 'Select', input: 'cursor', anchors: 0, persisted: false, engine: 'cursor',
        describe: function () { return 'Selection'; } });
    define({ id: 'eraser', family: 'cursor', label: 'Eraser', input: 'cursor', anchors: 0, persisted: false, engine: 'cursor',
        describe: function () { return 'Eraser'; } });

    /* Position */
    define({ id: 'long', family: 'position', label: 'Long position', input: 'drag', anchors: 2, persisted: false, engine: 'position' });
    define({ id: 'short', family: 'position', label: 'Short position', input: 'drag', anchors: 2, persisted: false, engine: 'position' });
    define({ id: 'positionForecast', family: 'position', label: 'Position forecast', input: 'drag', anchors: 2,
        build: B.rangeBox, opts: { mode: 'forecast' },
        defaults: { params: { stopRatio: 1 } } });

    /* Trend */
    define({ id: 'trend', family: 'trend', label: 'Trend line', input: 'drag', anchors: 2, build: B.segment, opts: { percent: true } });
    define({ id: 'ray', family: 'trend', label: 'Ray', input: 'drag', anchors: 2, build: B.segment, opts: { extend: 'right' } });
    define({ id: 'extended', family: 'trend', label: 'Extended line', input: 'drag', anchors: 2, build: B.segment, opts: { extend: 'both' } });
    define({ id: 'info', family: 'trend', label: 'Info line', input: 'drag', anchors: 2, build: B.segment, opts: { info: true } });
    define({ id: 'hline', family: 'trend', label: 'Horizontal line', input: 'click', anchors: 1, axis: 'price',
        build: B.level, defaults: { fill: 0 } });
    define({ id: 'hray', family: 'trend', label: 'Horizontal ray', input: 'click', anchors: 1,
        build: B.level });
    define({ id: 'vline', family: 'trend', label: 'Vertical line', input: 'click', anchors: 1, axis: 'time',
        build: B.level, defaults: { fill: 0 } });
    define({ id: 'crossline', family: 'trend', label: 'Cross line', input: 'click', anchors: 1,
        build: B.level });
    define({ id: 'channel', family: 'trend', label: 'Parallel channel', input: 'drag', anchors: 3,
        build: B.channel, defaults: { fill: 0.08 } });
    define({ id: 'flatTopBottom', family: 'trend', label: 'Flat top/bottom', input: 'drag', anchors: 3,
        build: B.channel, opts: { flat: true }, defaults: { fill: 0.08 } });
    define({ id: 'disjointChannel', family: 'trend', label: 'Disjoint channel', input: 'drag', anchors: 4,
        build: B.channel, opts: { disjoint: true }, defaults: { fill: 0.08 } });

    /* Fib & Gann */
    define({ id: 'fib', family: 'fib', label: 'Fib retracement', input: 'drag', anchors: 2,
        build: B.fibLevels, defaults: { params: { levels: G.FIB_RETRACEMENT.slice(), extend: 'none' } } });
    define({ id: 'fibExt', family: 'fib', label: 'Trend-based fib extension', input: 'drag', anchors: 3,
        build: B.fibLevels, opts: { extension: true, extendRight: true },
        defaults: { params: { levels: G.FIB_EXTENSION.slice(), extend: 'right' } } });
    define({ id: 'fibChannel', family: 'fib', label: 'Fib channel', input: 'drag', anchors: 3,
        build: B.fibLevels, opts: { channel: true }, defaults: { params: { levels: G.FIB_RETRACEMENT.slice() } } });
    define({ id: 'fibTime', family: 'fib', label: 'Fib time zone', input: 'drag', anchors: 2,
        build: B.fibTime, defaults: { fill: 0, params: { levels: G.FIB_TIME.slice() } } });
    define({ id: 'fibFan', family: 'fib', label: 'Fib speed resistance fan', input: 'drag', anchors: 2,
        build: B.fibRadial, opts: { mode: 'fan' }, defaults: { fill: 0, params: { levels: G.FIB_RADIAL.slice() } } });
    define({ id: 'fibArcs', family: 'fib', label: 'Fib speed resistance arcs', input: 'drag', anchors: 2,
        build: B.fibRadial, opts: { mode: 'arcs' }, defaults: { fill: 0, params: { levels: G.FIB_RADIAL.slice() } } });
    define({ id: 'fibCircles', family: 'fib', label: 'Fib circles', input: 'drag', anchors: 2,
        build: B.fibRadial, opts: { mode: 'circles' }, defaults: { fill: 0, params: { levels: G.FIB_RADIAL.slice() } } });
    define({ id: 'fibSpiral', family: 'fib', label: 'Fib spiral', input: 'drag', anchors: 2,
        build: B.fibRadial, opts: { mode: 'spiral' }, defaults: { fill: 0 } });
    define({ id: 'gannBox', family: 'fib', label: 'Gann box', input: 'drag', anchors: 2,
        build: B.gannGrid, opts: { fill: true }, defaults: { fill: 0.05, params: { levels: G.GANN_GRID.slice() } } });
    define({ id: 'gannFan', family: 'fib', label: 'Gann fan', input: 'drag', anchors: 2,
        build: B.gannFan, defaults: { fill: 0, params: { levels: G.GANN_FAN.slice() } } });

    /* Patterns */
    define({ id: 'xabcd', family: 'patterns', label: 'XABCD pattern', input: 'click', anchors: 5,
        build: B.pattern, opts: { labels: ['X', 'A', 'B', 'C', 'D'], diagonals: true } });
    define({ id: 'abcd', family: 'patterns', label: 'ABCD pattern', input: 'click', anchors: 4,
        build: B.pattern, opts: { labels: ['A', 'B', 'C', 'D'] } });
    define({ id: 'headShoulders', family: 'patterns', label: 'Head and shoulders', input: 'click', anchors: 6,
        build: B.pattern, opts: { labels: ['LS', 'N1', 'Head', 'N2', 'RS', 'Target'], neckline: true } });
    define({ id: 'threeDrives', family: 'patterns', label: 'Three drives', input: 'click', anchors: 6,
        build: B.pattern, opts: { labels: ['1', '2', '3', '4', '5', '6'] } });
    define({ id: 'elliottImpulse', family: 'patterns', label: 'Elliott impulse wave', input: 'click', anchors: 6,
        build: B.pattern, opts: { labels: ['0', '1', '2', '3', '4', '5'] } });

    /* Shapes */
    define({ id: 'rect', family: 'shapes', label: 'Rectangle', input: 'drag', anchors: 2,
        build: B.polyShape, opts: { rect: true, closed: true }, defaults: { fill: 0.08 } });
    define({ id: 'rotatedRect', family: 'shapes', label: 'Rotated rectangle', input: 'drag', anchors: 3,
        build: B.polyShape, opts: { rotated: true, closed: true }, defaults: { fill: 0.08 } });
    define({ id: 'ellipse', family: 'shapes', label: 'Ellipse', input: 'drag', anchors: 2,
        build: B.ellipse, defaults: { fill: 0.08 } });
    define({ id: 'circle', family: 'shapes', label: 'Circle', input: 'drag', anchors: 2,
        build: B.ellipse, opts: { circle: true }, defaults: { fill: 0.08 } });
    define({ id: 'triangle', family: 'shapes', label: 'Triangle', input: 'click', anchors: 3,
        build: B.polyShape, defaults: { fill: 0.08 } });
    define({ id: 'polyline', family: 'shapes', label: 'Polyline', input: 'variable', anchors: { min: 2, max: 64 },
        build: B.polyShape, defaults: { fill: 0 } });
    define({ id: 'path', family: 'shapes', label: 'Path', input: 'variable', anchors: { min: 3, max: 64 },
        build: B.polyShape, opts: { closed: true }, defaults: { fill: 0.08 } });
    define({ id: 'arc', family: 'shapes', label: 'Arc', input: 'click', anchors: 3, build: B.arc });
    define({ id: 'curve', family: 'shapes', label: 'Curve', input: 'click', anchors: 3,
        build: B.curve, opts: { showControl: true } });
    define({ id: 'arrow', family: 'shapes', label: 'Arrow', input: 'drag', anchors: 2, build: B.arrow, defaults: { fill: 0 } });
    define({ id: 'arrowMarker', family: 'shapes', label: 'Arrow marker', input: 'click', anchors: 1,
        build: B.marker, opts: { glyph: 'arrow' }, defaults: { fill: 0 } });
    define({ id: 'brush', family: 'shapes', label: 'Brush', input: 'freehand', anchors: { min: 2, max: 512 },
        build: B.freehand, opts: { width: 2 }, defaults: { fill: 0, width: 2 } });
    define({ id: 'highlighter', family: 'shapes', label: 'Highlighter', input: 'freehand', anchors: { min: 2, max: 512 },
        build: B.freehand, opts: { width: 12, opacity: 0.25 }, defaults: { fill: 0, width: 12 } });

    /* Annotations */
    define({ id: 'text', family: 'annotation', label: 'Text', input: 'click', anchors: 1, editor: true,
        build: B.textAnchor, opts: { mode: 'plain' }, defaults: { fill: 0 } });
    define({ id: 'note', family: 'annotation', label: 'Note', input: 'click', anchors: 1, editor: true,
        build: B.textAnchor, opts: { mode: 'note' }, defaults: { fill: 0 } });
    define({ id: 'comment', family: 'annotation', label: 'Comment', input: 'click', anchors: 1, editor: true,
        build: B.textAnchor, opts: { mode: 'comment' }, defaults: { fill: 0.1 } });
    define({ id: 'callout', family: 'annotation', label: 'Callout', input: 'drag', anchors: 2, editor: true,
        build: B.textAnchor, opts: { mode: 'callout' }, defaults: { fill: 0.1 } });
    define({ id: 'priceNote', family: 'annotation', label: 'Price note', input: 'click', anchors: 1, editor: true, axis: 'price',
        build: B.level, opts: { chip: true }, defaults: { fill: 0 } });
    define({ id: 'priceLabel', family: 'annotation', label: 'Price label', input: 'click', anchors: 1, axis: 'price',
        build: B.level, opts: { chip: true }, defaults: { fill: 0 } });
    define({ id: 'pin', family: 'annotation', label: 'Pin', input: 'click', anchors: 1,
        build: B.marker, opts: { glyph: 'pin', size: 16 }, defaults: { fill: 0 } });

    /* Measurement / forecast */
    define({ id: 'measure', family: 'position', label: 'Measure', input: 'drag', anchors: 2, persisted: false, engine: 'ephemeral',
        describe: function () { return 'Measure'; } });
    define({ id: 'priceRange', family: 'position', label: 'Price range', input: 'drag', anchors: 2,
        build: B.rangeBox, opts: { mode: 'price' }, defaults: { fill: 0.06 } });
    define({ id: 'dateRange', family: 'position', label: 'Date range', input: 'drag', anchors: 2,
        build: B.rangeBox, opts: { mode: 'date' }, defaults: { fill: 0.06 } });
    define({ id: 'datePriceRange', family: 'position', label: 'Date and price range', input: 'drag', anchors: 2,
        build: B.rangeBox, opts: { mode: 'both' }, defaults: { fill: 0.06 } });

    var TOOL_IDS = TOOLS.map(function (t) { return t.id; });
    var PERSISTED_TOOL_IDS = TOOLS.filter(function (t) { return t.persisted; }).map(function (t) { return t.id; });

    /* ── Validation / normalisation ─────────────────────────────────────── */

    var warned = {};
    var HEX = /^#[0-9a-fA-F]{6}$/;
    var CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

    function byId(id) { return byIdMap[id] || null; }
    function has(id) { return !!byIdMap[id]; }
    function ids() { return TOOL_IDS.slice(); }
    function persistedIds() { return PERSISTED_TOOL_IDS.slice(); }
    function familyTools(family) {
        return TOOLS.filter(function (t) { return t.family === family; });
    }

    function sanitizeText(value) {
        var str = String(value == null ? '' : value).replace(CONTROL, '').replace(/\r/g, '');
        var lines = str.split('\n').slice(0, 6);
        return lines.join('\n').slice(0, 120);
    }

    function clampNum(value, fallback, lo, hi) {
        var n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.max(lo, Math.min(hi, n));
    }

    function normalizePoints(points, maximum) {
        var out = [];
        if (!Array.isArray(points)) return out;
        for (var i = 0; i < points.length && i < maximum; i++) {
            var p = points[i];
            if (!p || typeof p !== 'object') continue;
            var time = Math.round(Number(p.time));
            var price = Number(p.price);
            if (!isFinite(time) || !isFinite(price)) continue;
            out.push({ time: Math.max(0, Math.min(4102444800, time)), price: price });
        }
        return out;
    }

    function normalizeLevels(value) {
        if (!Array.isArray(value)) return null;
        var out = [];
        for (var i = 0; i < value.length && out.length < 24; i++) {
            var n = Number(value[i]);
            if (isFinite(n) && n >= -10 && n <= 10) out.push(n);
        }
        return out.length ? out : null;
    }

    function normalizeParams(tool, raw) {
        var out = {};
        var defaults = tool.defaults.params || {};
        var src = raw && typeof raw === 'object' ? raw : {};
        if (defaults.levels || src.levels) {
            var levels = normalizeLevels(src.levels);
            out.levels = levels || (defaults.levels ? defaults.levels.slice() : null);
            if (!out.levels) delete out.levels;
        }
        if (defaults.extend !== undefined || src.extend !== undefined) {
            var ext = EXTENDS.indexOf(src.extend) >= 0 ? src.extend : (defaults.extend || 'none');
            out.extend = ext;
        }
        if (defaults.stopRatio !== undefined || src.stopRatio !== undefined) {
            out.stopRatio = clampNum(src.stopRatio, defaults.stopRatio != null ? defaults.stopRatio : 1, 0.1, 10);
        }
        if (defaults.multiplier !== undefined || src.multiplier !== undefined) {
            out.multiplier = clampNum(src.multiplier, defaults.multiplier != null ? defaults.multiplier : 1, 0.1, 10);
        }
        if (defaults.period !== undefined || src.period !== undefined) {
            out.period = Math.round(clampNum(src.period, defaults.period != null ? defaults.period : 1, 1, 1000));
        }
        if (defaults.variant !== undefined || src.variant !== undefined) {
            var variants = ['classic', 'schiff', 'modifiedSchiff', 'inside'];
            out.variant = variants.indexOf(src.variant) >= 0 ? src.variant : (defaults.variant || 'classic');
        }
        return out;
    }

    /**
     * Fill defaults and clamp a persisted record. Returns null (and warns once)
     * when the tool is unknown, so a malformed workspace can never crash.
     */
    function normalizeRecord(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var tool = byId(raw.tool);
        if (!tool) {
            if (!warned[raw.tool]) {
                warned[raw.tool] = true;
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[DrawingTools] dropping unknown tool:', raw.tool);
                }
            }
            return null;
        }
        var defaults = tool.defaults;
        var record = {
            id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : nextId(),
            tool: tool.id,
            points: normalizePoints(raw.points, maxPoints(tool)),
            color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color : '',
            width: clampNum(raw.width, defaults.width, 1, 4),
            dash: DASHES.indexOf(raw.dash) >= 0 ? raw.dash : defaults.dash,
            fill: clampNum(raw.fill, defaults.fill, 0, 0.6),
            text: sanitizeText(raw.text),
            font: Math.round(clampNum(raw.font, defaults.textSize || 12, 9, 18)),
            locked: raw.locked === true,
            hidden: raw.hidden === true,
            z: Math.round(clampNum(raw.z, 0, -1000, 1000)),
            params: normalizeParams(tool, raw.params)
        };
        if (record.points.length === 0 && tool.engine === 'drawing') return record;
        return record;
    }

    var idCounter = 0;
    function nextId() {
        idCounter += 1;
        return 'd-' + Date.now().toString(36).slice(-4) + idCounter.toString(36);
    }

    /** Concrete colours for a record; primitives keep semantic tones. */
    function resolveStyle(shape, theme, selected) {
        var t = theme || {};
        var color = shape && shape.color ? shape.color : (t.drawingLine || '#8B93A7');
        return {
            selected: !!selected,
            color: color,
            soft: t.drawingLineSoft || '#6B7280',
            fill: shape ? shape.fill : 0.08,
            width: shape ? shape.width : 1,
            dash: shape ? shape.dash : 'solid',
            font: shape ? shape.font : 12,
            accent: t.accent || '#ffd43b',
            up: t.up || '#83cf9c',
            down: t.down || '#ff9e96',
            text: t.ink || '#f3f1e9',
            muted: t.muted || '#a09f95',
            panel: t.panel || '#1a1a19'
        };
    }

    function describe(shape) {
        var tool = shape && byId(shape.tool);
        if (!tool) return 'Drawing';
        try {
            var label = tool.describe(shape);
            return label || tool.label;
        } catch (err) {
            return tool.label;
        }
    }

    /** Never throws: renders an empty result if a builder trips on bad input. */
    function safeBuild(shape, env) {
        if (!shape) return { prims: [], handles: [] };
        var tool = byId(shape.tool);
        if (!tool) return { prims: [], handles: [] };
        try {
            var result = tool.build(shape, env);
            if (!result || !Array.isArray(result.prims)) return { prims: [], handles: [] };
            // Strip non-finite coordinates before the renderer sees them.
            var prims = result.prims.filter(function (prim) {
                if (!prim) return false;
                if (prim.kind === 'path') {
                    prim.pts = (prim.pts || []).filter(function (p) {
                        return p && isFiniteNum(p.x) && isFiniteNum(p.y);
                    });
                    return prim.pts.length >= 2;
                }
                if (prim.kind === 'text') return isFiniteNum(prim.x) && isFiniteNum(prim.y);
                if (prim.kind === 'arc') return isFiniteNum(prim.cx) && isFiniteNum(prim.cy) && isFiniteNum(prim.rx) && isFiniteNum(prim.ry);
                return isFiniteNum(prim.x) && isFiniteNum(prim.y);
            });
            var handles = (result.handles || []).filter(function (h) {
                return h && isFiniteNum(h.x) && isFiniteNum(h.y);
            });
            return { prims: prims, handles: handles };
        } catch (err) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[DrawingTools] build failed for ' + shape.tool, err);
            }
            return { prims: [], handles: [] };
        }
    }

    return {
        FAMILIES: FAMILIES,
        TOOLS: TOOLS,
        TOOL_IDS: TOOL_IDS,
        PERSISTED_TOOL_IDS: PERSISTED_TOOL_IDS,
        DEFAULT_STYLE: DEFAULT_STYLE,
        DASHES: DASHES,
        byId: byId,
        has: has,
        ids: ids,
        persistedIds: persistedIds,
        familyTools: familyTools,
        normalizeRecord: normalizeRecord,
        normalizeParams: normalizeParams,
        sanitizeText: sanitizeText,
        normalizePoints: normalizePoints,
        resolveStyle: resolveStyle,
        describe: describe,
        build: safeBuild,
        safeBuild: safeBuild,
        wrapText: wrapText,
        nextId: nextId,
        maxPoints: maxPoints
    };
});
