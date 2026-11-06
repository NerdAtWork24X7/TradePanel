/* ═══════════════════════════════════════════════════════════════════════════
 * DrawingGeometry — pure math for the chart drawing layer
 *
 * No DOM, no canvas, no Lightweight Charts. Everything is expressed in pixel
 * space (the integration layer projects data-space anchors first), which keeps
 * hit-testing and rendering generic across all 55 tools.
 *
 * Exported helpers are intentionally small and composable; the tool registry
 * (drawing_tools.js) builds primitives from them.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DrawingGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var EPS = 1e-9;
    var FIB_RETRACEMENT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    var FIB_EXTENSION = [-0.618, -0.382, 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];
    var FIB_TIME = [0, 0.382, 0.5, 0.618, 1, 1.618, 2.618, 4.236];
    var FIB_RADIAL = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    var GANN_FAN = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];
    var GANN_GRID = [0, 0.25, 0.5, 0.75, 1];

    function isNum(value) { return typeof value === 'number' && isFinite(value); }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function normAngle(a) {
        var twoPi = Math.PI * 2;
        a = a % twoPi;
        return a < 0 ? a + twoPi : a;
    }

    /* ── Distances / hit math ───────────────────────────────────────────── */

    function distToSegment(px, py, x1, y1, x2, y2) {
        var dx = x2 - x1, dy = y2 - y1;
        if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return Math.hypot(px - x1, py - y1);
        var t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
        t = clamp(t, 0, 1);
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function distToPolyline(pts, x, y, closed) {
        if (!pts || pts.length === 0) return Infinity;
        if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
        var best = Infinity;
        for (var i = 0; i < pts.length - 1; i++) {
            var d = distToSegment(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
            if (d < best) best = d;
        }
        if (closed) {
            var last = pts[pts.length - 1];
            var first = pts[0];
            var d2 = distToSegment(x, y, last.x, last.y, first.x, first.y);
            if (d2 < best) best = d2;
        }
        return best;
    }

    function pointInPolygon(pts, x, y) {
        if (!pts || pts.length < 3) return false;
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || EPS) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function polygonArea(pts) {
        if (!pts || pts.length < 3) return 0;
        var sum = 0;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            sum += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        }
        return Math.abs(sum) / 2;
    }

    function bboxOfPoints(pts) {
        if (!pts || !pts.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (!p || !isNum(p.x) || !isNum(p.y)) continue;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX)) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    function expandBBox(bb, pad) {
        if (!bb) return null;
        return { x: bb.x - pad, y: bb.y - pad, w: bb.w + pad * 2, h: bb.h + pad * 2 };
    }

    function bboxIntersects(a, b) {
        if (!a || !b) return false;
        return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
    }

    /* ── Line clipping (Liang–Barsky) ───────────────────────────────────── */

    /**
     * Clip the parametric line p0 + t·(p1−p0) to the rectangle [0,box.w]×[0,box.h]
     * intersected with t ∈ [tMin, tMax]. Returns [{x,y},{x,y}] or null.
     * segment: t ∈ [0,1]; ray: [0,∞); extended line: (−∞,∞).
     */
    function clipLine(p0, p1, box, tMin, tMax) {
        if (!p0 || !p1 || !box) return null;
        var w = box.w, h = box.h;
        if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) return null;
        var x0 = p0.x, y0 = p0.y, dx = p1.x - x0, dy = p1.y - y0;
        if (!isNum(x0) || !isNum(y0) || !isNum(dx) || !isNum(dy)) return null;
        var lo = isNum(tMin) ? tMin : -Infinity;
        var hi = isNum(tMax) ? tMax : Infinity;
        // Degenerate direction: no drawable geometry.
        if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return null;
        var p = [-dx, dx, -dy, dy];
        var q = [x0, w - x0, y0, h - y0];
        for (var i = 0; i < 4; i++) {
            if (Math.abs(p[i]) < EPS) {
                if (q[i] < 0) return null;            // parallel and outside
            } else {
                var t = q[i] / p[i];
                if (p[i] < 0) { if (t > lo) lo = t; }
                else { if (t < hi) hi = t; }
            }
        }
        if (!isFinite(lo) || !isFinite(hi) || lo > hi) return null;
        // Large but finite segments would produce huge coordinates; clamp to a
        // generous multiple of the box before building the result.
        var cap = w + h;
        var t0 = clamp(lo, -cap, cap), t1 = clamp(hi, -cap, cap);
        if (t0 > t1) return null;
        return [
            { x: x0 + dx * t0, y: y0 + dy * t0 },
            { x: x0 + dx * t1, y: y0 + dy * t1 }
        ];
    }

    function clipSegment(p0, p1, box) { return clipLine(p0, p1, box, 0, 1); }
    function clipRay(p0, p1, box) { return clipLine(p0, p1, box, 0, Infinity); }
    function clipInfinite(p0, p1, box) { return clipLine(p0, p1, box, -Infinity, Infinity); }

    /** Clip a horizontal level (y) to the full box width. */
    function clipHorizontal(y, box) {
        if (!isNum(y) || y < 0 || y > box.h) return null;
        return [{ x: 0, y: y }, { x: box.w, y: y }];
    }

    /** Clip a vertical level (x) to the full box height. */
    function clipVertical(x, box) {
        if (!isNum(x) || x < 0 || x > box.w) return null;
        return [{ x: x, y: 0 }, { x: x, y: box.h }];
    }

    /** Extend a segment to ±infinity depending on mode, then clip. */
    function clipExtended(p0, p1, box, mode) {
        if (mode === 'both') {
            var line = clipInfinite(p0, p1, box);
            if (line && (line[0].x > line[1].x || (line[0].x === line[1].x && line[0].y > line[1].y))) {
                return [line[1], line[0]];
            }
            return line;
        }
        if (mode === 'right' || mode === 'left') {
            var dx = p1.x - p0.x, dy = p1.y - p0.y;
            var along = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
            if (Math.abs(along) < EPS) return clipSegment(p0, p1, box);
            var s0 = Math.abs(dx) >= Math.abs(dy) ? p0.x : p0.y;
            var s1 = Math.abs(dx) >= Math.abs(dy) ? p1.x : p1.y;
            var seg = mode === 'right'
                ? (s1 >= s0 ? clipLine(p0, p1, box, 0, Infinity) : clipLine(p0, p1, box, -Infinity, 1))
                : (s1 >= s0 ? clipLine(p0, p1, box, -Infinity, 0) : clipLine(p0, p1, box, 1, Infinity));
            if (seg && mode === 'left') return [seg[1], seg[0]];
            return seg;
        }
        return clipSegment(p0, p1, box);
    }

    /* ── Polyline simplification (RDP) ──────────────────────────────────── */

    function rdpSimplify(points, tolerance) {
        var pts = Array.isArray(points) ? points : [];
        if (pts.length < 3) return pts.map(function (p) { return { x: p.x, y: p.y }; });
        var tol = isNum(tolerance) && tolerance > 0 ? tolerance : 0.75;
        var n = pts.length;
        var keep = new Uint8Array(n);
        keep[0] = 1; keep[n - 1] = 1;
        var stack = [[0, n - 1]];
        while (stack.length) {
            var seg = stack.pop();
            var first = seg[0], last = seg[1];
            if (last <= first + 1) continue;
            var ax = pts[first].x, ay = pts[first].y;
            var bx = pts[last].x, by = pts[last].y;
            var maxD = -1, maxI = -1;
            for (var i = first + 1; i < last; i++) {
                var d = distToSegment(pts[i].x, pts[i].y, ax, ay, bx, by);
                if (d > maxD) { maxD = d; maxI = i; }
            }
            if (maxD > tol) {
                keep[maxI] = 1;
                stack.push([first, maxI], [maxI, last]);
            }
        }
        var out = [];
        for (var k = 0; k < n; k++) {
            if (keep[k]) out.push({ x: pts[k].x, y: pts[k].y });
        }
        return out;
    }

    /* ── Sampling helpers ───────────────────────────────────────────────── */

    function sampleEllipse(cx, cy, rx, ry, a0, a1, steps) {
        if (!isNum(cx) || !isNum(cy) || !isNum(rx) || !isNum(ry)) return [];
        var count = Math.max(2, Math.round(steps || 48));
        var rr = Math.abs(rx), rh = Math.abs(ry);
        if (rr < EPS || rh < EPS) {
            // Degenerate: a straight line between the extreme points.
            return [
                { x: cx + rr * Math.cos(a0 || 0), y: cy + rh * Math.sin(a0 || 0) },
                { x: cx + rr * Math.cos(a1 || 0), y: cy + rh * Math.sin(a1 || 0) }
            ];
        }
        var out = [];
        for (var i = 0; i <= count; i++) {
            var a = (a0 || 0) + ((a1 || 0) - (a0 || 0)) * (i / count);
            out.push({ x: cx + rr * Math.cos(a), y: cy + rh * Math.sin(a) });
        }
        return out;
    }

    /**
     * Arc through three points (a-b-c). Collinear input degrades to a polyline.
     * Returns {pts, ok} — ok is false when the geometry was not a valid circle.
     */
    function sampleArcThrough(a, b, c, steps) {
        var fallback = [a, b, c].filter(function (p) { return p && isNum(p.x) && isNum(p.y); });
        if (fallback.length < 3) return { pts: fallback, ok: false };
        var ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
        var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-6) return { pts: fallback, ok: false };
        var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
        var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
        var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
        var r = Math.hypot(ax - ux, ay - uy);
        if (!isFinite(r) || r < EPS || r > 1e7) return { pts: fallback, ok: false };
        var a0 = Math.atan2(ay - uy, ax - ux);
        var ab = Math.atan2(by - uy, bx - ux);
        var a2ang = Math.atan2(cy - uy, cx - ux);
        var span = normAngle(a2ang - a0);
        var mid = normAngle(ab - a0);
        var ccw = mid <= span;
        var end = ccw ? a0 + span : a0 - (Math.PI * 2 - span);
        return { pts: sampleEllipse(ux, uy, r, r, a0, end, steps || 64), ok: true, cx: ux, cy: uy, r: r };
    }

    function sampleQuadratic(p0, ctrl, p1, steps) {
        if (!p0 || !ctrl || !p1) return [];
        var count = Math.max(2, Math.round(steps || 40));
        var out = [];
        for (var i = 0; i <= count; i++) {
            var t = i / count, mt = 1 - t;
            out.push({
                x: mt * mt * p0.x + 2 * mt * t * ctrl.x + t * t * p1.x,
                y: mt * mt * p0.y + 2 * mt * t * ctrl.y + t * t * p1.y
            });
        }
        return out;
    }

    /** Log spiral: r(θ) = r0 · growth^(θ/(π/2)), quarterTurns quarter arcs. */
    function sampleSpiral(cx, cy, r0, startAngle, growth, quarterTurns, stepsPerTurn) {
        if (!isNum(cx) || !isNum(cy) || !isNum(r0) || r0 <= 0) return [];
        var turns = Math.max(1, Math.round(quarterTurns || 4));
        var steps = Math.max(4, Math.round(stepsPerTurn || 24)) * turns;
        var g = isNum(growth) && growth > 1 ? growth : 1.618;
        var out = [];
        for (var i = 0; i <= steps; i++) {
            var theta = (Math.PI / 2) * turns * (i / steps);
            var r = r0 * Math.pow(g, theta / (Math.PI / 2));
            var a = (startAngle || 0) + theta;
            out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        return out;
    }

    /* ── Vector helpers ─────────────────────────────────────────────────── */

    function unit(p0, p1) {
        var dx = p1.x - p0.x, dy = p1.y - p0.y;
        var len = Math.hypot(dx, dy);
        if (len < EPS) return { x: 0, y: 0, len: 0 };
        return { x: dx / len, y: dy / len, len: len };
    }

    function perp(v) { return { x: -v.y, y: v.x }; }

    /** Offset a line p0→p1 so that it passes through `through`, keeping direction. */
    function parallelThrough(p0, p1, through) {
        var u = unit(p0, p1);
        if (!u.len) return { p0: through, p1: through };
        var n = perp(u);
        var d = (through.x - p0.x) * n.x + (through.y - p0.y) * n.y;
        return {
            p0: { x: p0.x + n.x * d, y: p0.y + n.y * d },
            p1: { x: p1.x + n.x * d, y: p1.y + n.y * d }
        };
    }

    /** Offset a line p0→p1 by `distance` along its normal. */
    function offsetLine(p0, p1, distance) {
        var u = unit(p0, p1);
        var n = perp(u);
        return {
            p0: { x: p0.x + n.x * distance, y: p0.y + n.y * distance },
            p1: { x: p1.x + n.x * distance, y: p1.y + n.y * distance }
        };
    }

    /** Point on the p0→p1 segment at `t` (not clamped). */
    function lerpPoint(p0, p1, t) {
        return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }

    function midpoint(p0, p1) { return lerpPoint(p0, p1, 0.5); }

    /* ── Fibonacci / Gann math ──────────────────────────────────────────── */

    function fibPrice(price0, price1, ratio) {
        return price0 + (price1 - price0) * ratio;
    }

    /** Horizontal fib levels between two pixel anchors. */
    function fibPixelLevels(y0, y1, ratios) {
        var out = [];
        (ratios || FIB_RETRACEMENT).forEach(function (ratio) {
            out.push({ ratio: ratio, y: y0 + (y1 - y0) * ratio });
        });
        return out;
    }

    /** Filter out labels that would visually collide; returns kept entries. */
    function dropCollidingLabels(items, minGap) {
        var gap = minGap == null ? 11 : minGap;
        var sorted = items.slice().sort(function (a, b) { return a.y - b.y; });
        var out = [];
        var last = null;
        sorted.forEach(function (item) {
            if (last == null || Math.abs(item.y - last) >= gap) {
                out.push(item);
                last = item.y;
            }
        });
        return out;
    }

    function gannAnglePoints(anchor, target, ratios) {
        var u = unit(anchor, target);
        if (!u.len) return [];
        var base = Math.atan2(u.y, u.x);
        var dx = target.x - anchor.x;
        return (ratios || GANN_FAN).map(function (ratio) {
            var angle = Math.atan2(Math.sin(base) * ratio, Math.cos(base));
            return {
                ratio: ratio,
                angle: angle,
                point: { x: anchor.x + Math.cos(angle) * Math.abs(dx || u.len), y: anchor.y + Math.sin(angle) * Math.abs(dx || u.len) }
            };
        });
    }

    /* ── Primitive hit-testing / bounds ─────────────────────────────────── */

    function textBBox(prim) {
        var w = prim.w != null ? prim.w : (prim.text ? String(prim.text).length * (prim.size || 12) * 0.58 : 0);
        var h = prim.h != null ? prim.h : (prim.size || 12) * 1.3;
        var x = prim.x - (prim.align === 'center' ? w / 2 : prim.align === 'right' ? w : 0);
        var y = prim.y - (prim.baseline === 'middle' ? h / 2 : prim.baseline === 'bottom' ? h : h * 0.85);
        return { x: x, y: y, w: w, h: h };
    }

    function hitPrimitive(prim, x, y, tol) {
        if (!prim) return false;
        var t = tol == null ? 6 : tol;
        if (prim.kind === 'path') {
            var pts = prim.pts || [];
            if (prim.closed && prim.fillAlpha > 0 && pointInPolygon(pts, x, y)) return true;
            return distToPolyline(pts, x, y, !!prim.closed) <= Math.max(t, (prim.width || 1) / 2 + 2);
        }
        if (prim.kind === 'text') {
            var bb = textBBox(prim);
            return x >= bb.x - 2 && x <= bb.x + bb.w + 2 && y >= bb.y - 2 && y <= bb.y + bb.h + 2;
        }
        if (prim.kind === 'arc') {
            var pts2 = sampleEllipse(prim.cx, prim.cy, prim.rx, prim.ry, prim.a0, prim.a1, 48);
            return distToPolyline(pts2, x, y, false) <= t;
        }
        if (prim.kind === 'dot') {
            return Math.hypot(x - prim.x, y - prim.y) <= (prim.r || 3) + t;
        }
        if (prim.kind === 'marker') {
            return Math.hypot(x - prim.x, y - prim.y) <= (prim.size || 14);
        }
        return false;
    }

    function hitPrimitives(prims, x, y, tol) {
        if (!prims || !prims.length) return false;
        for (var i = 0; i < prims.length; i++) {
            if (hitPrimitive(prims[i], x, y, tol)) return true;
        }
        return false;
    }

    function primitivesBBox(prims) {
        var boxes = [];
        (prims || []).forEach(function (prim) {
            if (prim.kind === 'path') boxes.push(bboxOfPoints(prim.pts));
            else if (prim.kind === 'text') boxes.push(textBBox(prim));
            else if (prim.kind === 'arc') {
                boxes.push({ x: prim.cx - Math.abs(prim.rx), y: prim.cy - Math.abs(prim.ry), w: Math.abs(prim.rx) * 2, h: Math.abs(prim.ry) * 2 });
            } else if (prim.kind === 'dot' || prim.kind === 'marker') {
                var r = prim.r || prim.size || 4;
                boxes.push({ x: prim.x - r, y: prim.y - r, w: r * 2, h: r * 2 });
            }
        });
        boxes = boxes.filter(Boolean);
        if (!boxes.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        boxes.forEach(function (b) {
            if (b.x < minX) minX = b.x;
            if (b.y < minY) minY = b.y;
            if (b.x + b.w > maxX) maxX = b.x + b.w;
            if (b.y + b.h > maxY) maxY = b.y + b.h;
        });
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /* ── Undo/redo reducer ──────────────────────────────────────────────── */

    function cloneDrawing(drawing) {
        return drawing == null ? drawing : JSON.parse(JSON.stringify(drawing));
    }

    /**
     * Pure command application over a drawings array. Every command returns a
     * NEW array; drawing objects that are unchanged keep their identity so the
     * renderer's per-drawing cache stays warm.
     */
    function applyCommand(drawings, cmd) {
        var list = Array.isArray(drawings) ? drawings.slice() : [];
        if (!cmd || !cmd.type) return list;
        if (cmd.type === 'add') {
            var item = cloneDrawing(cmd.drawing);
            var index = isNum(cmd.index) ? clamp(Math.round(cmd.index), 0, list.length) : list.length;
            list.splice(index, 0, item);
            return list;
        }
        if (cmd.type === 'addMany') {
            var items = (cmd.items || []).slice().sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
            items.forEach(function (entry) {
                var at = isNum(entry.index) ? clamp(Math.round(entry.index), 0, list.length) : list.length;
                list.splice(at, 0, cloneDrawing(entry.drawing));
            });
            return list;
        }
        if (cmd.type === 'remove') {
            return list.filter(function (d) { return d.id !== cmd.id; });
        }
        if (cmd.type === 'update') {
            return list.map(function (d) {
                return d.id === cmd.id ? cloneDrawing(cmd.after) : d;
            });
        }
        if (cmd.type === 'order') {
            return list.map(function (d) {
                return d.id === cmd.id ? Object.assign({}, d, { z: cmd.afterZ }) : d;
            });
        }
        if (cmd.type === 'clear') {
            var ids = {};
            (cmd.ids || []).forEach(function (id) { ids[id] = true; });
            return list.filter(function (d) { return !ids[d.id]; });
        }
        return list;
    }

    /** Inverse command for undo. The returned command fully reverses `cmd`. */
    function invertCommand(cmd, listBefore) {
        if (!cmd) return null;
        if (cmd.type === 'add') {
            return { type: 'remove', id: cmd.drawing.id };
        }
        if (cmd.type === 'addMany') {
            return { type: 'clear', ids: (cmd.items || []).map(function (i) { return i.drawing.id; }) };
        }
        if (cmd.type === 'remove') {
            return { type: 'add', drawing: cloneDrawing(cmd.drawing), index: cmd.index };
        }
        if (cmd.type === 'update') {
            return { type: 'update', id: cmd.id, after: cloneDrawing(cmd.before) };
        }
        if (cmd.type === 'order') {
            return { type: 'order', id: cmd.id, afterZ: cmd.beforeZ };
        }
        if (cmd.type === 'clear') {
            var items = (cmd.items || []).map(function (entry) {
                return { drawing: cloneDrawing(entry.drawing), index: entry.index };
            });
            return { type: 'addMany', items: items };
        }
        return null;
    }

    function DrawingHistory(limit) {
        this.limit = Math.max(1, Math.round(limit || 50));
        this.undoStack = [];
        this.redoStack = [];
    }

    DrawingHistory.prototype.record = function (cmd) {
        if (!cmd) return;
        this.undoStack.push(cmd);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
    };

    /** Returns the command to apply, or null. */
    DrawingHistory.prototype.undo = function () {
        if (!this.undoStack.length) return null;
        var cmd = this.undoStack.pop();
        this.redoStack.push(cmd);
        return cmd;
    };

    DrawingHistory.prototype.redo = function () {
        if (!this.redoStack.length) return null;
        var cmd = this.redoStack.pop();
        this.undoStack.push(cmd);
        return cmd;
    };

    DrawingHistory.prototype.canUndo = function () { return this.undoStack.length > 0; };
    DrawingHistory.prototype.canRedo = function () { return this.redoStack.length > 0; };
    DrawingHistory.prototype.clear = function () {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
    };

    /**
     * Apply a command to a drawings array and record it for undo. Returns
     * {list, cmd} where list is the new array.
     */
    DrawingHistory.prototype.apply = function (drawings, cmd) {
        // Capture removed drawings so a clear can always be undone, even when
        // the caller only supplies ids.
        if (cmd && cmd.type === 'clear' && !cmd.items) {
            var items = [];
            (drawings || []).forEach(function (d, index) {
                if ((cmd.ids || []).indexOf(d.id) >= 0) items.push({ drawing: cloneDrawing(d), index: index });
            });
            cmd.items = items;
        }
        var list = applyCommand(drawings, cmd);
        this.record(cmd);
        return { list: list, cmd: cmd };
    };

    /** Undo/redo helpers over a live drawings array. */
    DrawingHistory.prototype.undoList = function (drawings) {
        var cmd = this.undo();
        if (!cmd) return null;
        // A clear command without captured items is still invertible when the
        // caller supplies the current list: recover removed drawings by id.
        if (cmd.type === 'clear' && !cmd.items) {
            var items = [];
            (drawings || []).forEach(function (d, index) {
                if ((cmd.ids || []).indexOf(d.id) >= 0) items.push({ drawing: cloneDrawing(d), index: index });
            });
            cmd.items = items;
        }
        return { list: applyCommand(drawings, invertCommand(cmd)), cmd: cmd };
    };

    DrawingHistory.prototype.redoList = function (drawings) {
        var cmd = this.redo();
        if (!cmd) return null;
        return { list: applyCommand(drawings, cmd), cmd: cmd };
    };

    return {
        EPS: EPS,
        FIB_RETRACEMENT: FIB_RETRACEMENT,
        FIB_EXTENSION: FIB_EXTENSION,
        FIB_TIME: FIB_TIME,
        FIB_RADIAL: FIB_RADIAL,
        GANN_FAN: GANN_FAN,
        GANN_GRID: GANN_GRID,
        isNum: isNum,
        clamp: clamp,
        normAngle: normAngle,
        distToSegment: distToSegment,
        distToPolyline: distToPolyline,
        pointInPolygon: pointInPolygon,
        polygonArea: polygonArea,
        bboxOfPoints: bboxOfPoints,
        expandBBox: expandBBox,
        bboxIntersects: bboxIntersects,
        clipLine: clipLine,
        clipSegment: clipSegment,
        clipRay: clipRay,
        clipInfinite: clipInfinite,
        clipHorizontal: clipHorizontal,
        clipVertical: clipVertical,
        clipExtended: clipExtended,
        rdpSimplify: rdpSimplify,
        sampleEllipse: sampleEllipse,
        sampleArcThrough: sampleArcThrough,
        sampleQuadratic: sampleQuadratic,
        sampleSpiral: sampleSpiral,
        unit: unit,
        perp: perp,
        parallelThrough: parallelThrough,
        offsetLine: offsetLine,
        lerpPoint: lerpPoint,
        midpoint: midpoint,
        fibPrice: fibPrice,
        fibPixelLevels: fibPixelLevels,
        dropCollidingLabels: dropCollidingLabels,
        gannAnglePoints: gannAnglePoints,
        textBBox: textBBox,
        hitPrimitive: hitPrimitive,
        hitPrimitives: hitPrimitives,
        primitivesBBox: primitivesBBox,
        cloneDrawing: cloneDrawing,
        applyCommand: applyCommand,
        invertCommand: invertCommand,
        DrawingHistory: DrawingHistory
    };
});
