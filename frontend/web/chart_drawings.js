/* ═══════════════════════════════════════════════════════════════════════════
 * ChartDrawings — catalog, legacy migration and price-space helpers for the
 * `lightweight-charts-drawing` manager.
 *
 * Pure data + functions: no DOM, no Lightweight Charts, no DrawingManager
 * reference at load time, so it runs unchanged under `node --test`.
 *
 * Stored drawings stay in **raw price** space (the chart may display
 * percentage / indexed units); the integration layer projects them into the
 * chart's display space when handing them to the manager and back on change.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ChartDrawings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ── Tool catalog ─────────────────────────────────────────────────────
     * TradingView toolbar names/groups (lightweight-charts-drawing 0.6.3).
     * Position (long/short) tools are custom in this app (trade bridge),
     * table/image/font-icon need host editors that the workspace does not
     * ship, so they are intentionally absent. */

    var FAMILIES = [
        {
            id: 'lines', label: 'Trend lines', short: 'Lines',
            tools: [
                ['trend-line', 'Trend line'],
                ['ray', 'Ray'],
                ['info-line', 'Info line'],
                ['extended-line', 'Extended line'],
                ['trend-angle', 'Trend angle'],
                ['horizontal-line', 'Horizontal line'],
                ['horizontal-ray', 'Horizontal ray'],
                ['vertical-line', 'Vertical line'],
                ['cross-line', 'Cross line']
            ]
        },
        {
            id: 'channels', label: 'Channels', short: 'Channels',
            tools: [
                ['parallel-channel', 'Parallel channel'],
                ['regression-trend', 'Regression trend'],
                ['flat-top-bottom', 'Flat top / bottom'],
                ['disjoint-channel', 'Disjoint channel']
            ]
        },
        {
            id: 'pitchforks', label: 'Pitchforks', short: 'Pitchforks',
            tools: [
                ['pitchfork', 'Pitchfork'],
                ['schiff-pitchfork', 'Schiff pitchfork'],
                ['modified-schiff-pitchfork', 'Modified Schiff'],
                ['inside-pitchfork', 'Inside pitchfork']
            ]
        },
        {
            id: 'fib', label: 'Fibonacci', short: 'Fibonacci',
            tools: [
                ['fib-retracement', 'Fib retracement'],
                ['trend-based-fib-extension', 'Trend-based extension'],
                ['fib-channel', 'Fib channel'],
                ['fib-time-zone', 'Fib time zone'],
                ['fib-speed-resistance-fan', 'Speed resistance fan'],
                ['trend-based-fib-time', 'Trend-based fib time'],
                ['fib-circles', 'Fib circles'],
                ['fib-spiral', 'Fib spiral'],
                ['fib-speed-resistance-arcs', 'Speed resistance arcs'],
                ['fib-wedge', 'Fib wedge'],
                ['pitchfan', 'Pitchfan']
            ]
        },
        {
            id: 'gann', label: 'Gann', short: 'Gann',
            tools: [
                ['gann-box', 'Gann box'],
                ['gann-square-fixed', 'Gann square fixed'],
                ['gann-square', 'Gann square'],
                ['gann-fan', 'Gann fan']
            ]
        },
        {
            id: 'patterns', label: 'Chart patterns', short: 'Patterns',
            tools: [
                ['xabcd-pattern', 'XABCD pattern'],
                ['cypher-pattern', 'Cypher pattern'],
                ['head-and-shoulders', 'Head and shoulders'],
                ['abcd-pattern', 'ABCD pattern'],
                ['triangle-pattern', 'Triangle pattern'],
                ['three-drives-pattern', 'Three drives']
            ]
        },
        {
            id: 'elliott', label: 'Elliott waves', short: 'Elliott',
            tools: [
                ['elliott-impulse', 'Impulse (1-5)'],
                ['elliott-correction', 'Correction (A-B-C)'],
                ['elliott-triangle', 'Triangle (A-E)'],
                ['elliott-double-combo', 'Double combo (W-X-Y)'],
                ['elliott-triple-combo', 'Triple combo (W-X-Y-X-Z)']
            ]
        },
        {
            id: 'cycles', label: 'Cycles', short: 'Cycles',
            tools: [
                ['cyclic-lines', 'Cyclic lines'],
                ['time-cycles', 'Time cycles'],
                ['sine-line', 'Sine line']
            ]
        },
        {
            id: 'forecast', label: 'Forecasting', short: 'Forecast',
            tools: [
                ['long-position', 'Long position'],
                ['short-position', 'Short position'],
                ['position-forecast', 'Position forecast'],
                ['bar-pattern', 'Bars pattern'],
                ['ghost-feed', 'Ghost feed'],
                ['sector', 'Sector']
            ]
        },
        {
            id: 'volume', label: 'Volume-based', short: 'Volume',
            tools: [
                ['anchored-vwap', 'Anchored VWAP'],
                ['fixed-range-volume-profile', 'Fixed range profile'],
                ['anchored-volume-profile', 'Anchored profile']
            ]
        },
        {
            id: 'measure', label: 'Measurers', short: 'Measure',
            tools: [
                ['price-range', 'Price range'],
                ['date-range', 'Date range'],
                ['date-and-price-range', 'Date and price range']
            ]
        },
        {
            id: 'brushes', label: 'Brushes', short: 'Brushes',
            tools: [
                ['brush', 'Brush'],
                ['highlighter', 'Highlighter']
            ]
        },
        {
            id: 'arrows', label: 'Arrows', short: 'Arrows',
            tools: [
                ['arrow-marker', 'Arrow marker'],
                ['arrow', 'Arrow'],
                ['arrow-mark-up', 'Arrow up'],
                ['arrow-mark-down', 'Arrow down']
            ]
        },
        {
            id: 'shapes', label: 'Shapes', short: 'Shapes',
            tools: [
                ['rectangle', 'Rectangle'],
                ['rotated-rectangle', 'Rotated rectangle'],
                ['path', 'Path'],
                ['circle', 'Circle'],
                ['ellipse', 'Ellipse'],
                ['polyline', 'Polyline'],
                ['triangle', 'Triangle'],
                ['arc', 'Arc'],
                ['curve', 'Curve'],
                ['double-curve', 'Double curve']
            ]
        },
        {
            id: 'text', label: 'Text and notes', short: 'Text',
            tools: [
                ['text', 'Text'],
                ['note', 'Note'],
                ['price-note', 'Price note'],
                ['pin', 'Pin'],
                ['callout', 'Callout'],
                ['comment', 'Comment'],
                ['price-label', 'Price label'],
                ['signpost', 'Signpost'],
                ['flag-mark', 'Flag mark']
            ]
        },
        {
            id: 'content', label: 'Content', short: 'Content',
            tools: [
                ['table', 'Table'],
                ['image', 'Image'],
                ['font-icon', 'Font icon']
            ]
        }
    ];

    var TOOLS = [];
    var TOOL_BY_KIND = {};
    var FAMILY_BY_KIND = {};
    FAMILIES.forEach(function (family) {
        family.items = family.tools.map(function (pair) {
            var tool = { kind: pair[0], label: pair[1], family: family.id, familyLabel: family.label };
            TOOLS.push(tool);
            TOOL_BY_KIND[tool.kind] = tool;
            FAMILY_BY_KIND[tool.kind] = family.id;
            return tool;
        });
        delete family.tools;
    });

    var PICKER_KINDS = { image: 1, 'font-icon': 1 };

    var TEXT_KINDS = {
        text: 1, note: 1, 'price-note': 1, pin: 1, callout: 1,
        comment: 1, signpost: 1
    };

    /* Rail entries. `custom` tools are handled by workspace.js (position box,
     * measure); `select` clears the manager tool (chart pan/zoom). */
    var PRIMARY = [
        { id: 'select', label: 'Cursor — pan, select and move drawings', icon: ['M6 3l12 9-6.2 1.3L9.4 20 6 3z'] },
        { id: 'trend-line', label: 'Trend line (Alt+T)', icon: ['M4 19L20 5', 'M5 17.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M19 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z'] },
        { id: 'horizontal-line', label: 'Horizontal line (Alt+H)', icon: ['M3 12h18', 'M7 9.5v5M12 9.5v5M17 9.5v5'] },
        { id: 'rectangle', label: 'Rectangle (Alt+Shift+R)', icon: ['M4 5h16v14H4z'] },
        { id: 'fib-retracement', label: 'Fib retracement (Alt+F)', icon: ['M3 6h18M3 10h18M3 14h18M3 18h18', 'M2.5 4v4M21.5 16v4'] },
        { id: 'text', label: 'Text annotation', icon: ['M5 6h14', 'M12 6v13', 'M9 19h6'] },
        { id: 'brush', label: 'Brush — drag to draw freehand', icon: ['M4 20c3.5-.5 4-3 5.5-5.5S13 9 15 9s2.5 1.5 1.5 3S13 15 11 16', 'M15.5 4.5l4 4'] },
        { id: 'measure', label: 'Measure — drag to measure, drag to adjust', custom: true, icon: ['M4 17L20 7', 'M7 14l2 3', 'M11 12l2 3', 'M15 10l2 3'] },
        { id: 'long', label: 'Long position (trade) — drag entry to target', custom: true, icon: ['M12 20V5', 'M6.5 10.5L12 5l5.5 5.5'] },
        { id: 'short', label: 'Short position (trade) — drag entry to target', custom: true, icon: ['M12 4v15', 'M6.5 13.5L12 19l5.5-5.5'] }
    ];

    /* Rail glyph per family so any tool can become a favourite without
     * hand-drawing 86 icons. */
    var FAMILY_ICONS = {
        lines: ['M4 19L20 5'],
        channels: ['M3 17L15 9', 'M9 21L21 13'],
        pitchforks: ['M5 20L12 4', 'M12 4L19 20', 'M12 4v16'],
        fib: ['M3 6h18M3 10h18M3 14h18M3 18h18', 'M2.5 4v4M21.5 16v4'],
        gann: ['M4 4h16v16H4z', 'M4 10h16M4 15h16M10 4v16M15 4v16'],
        patterns: ['M3 18l5-9 4 6 4-11 5 14'],
        elliott: ['M3 17c2-6 4-6 6 0s4 6 6 0 4-6 6 0'],
        cycles: ['M3 12c2.5-6 5.5-6 8 0s5.5 6 8 0'],
        forecast: ['M4 19L20 5', 'M13 5h7v7'],
        volume: ['M5 19V9M10 19V5M15 19v-7M20 19v-4'],
        measure: ['M4 17L20 7', 'M7 14l2 3', 'M11 12l2 3', 'M15 10l2 3'],
        brushes: ['M4 20c3.5-.5 4-3 5.5-5.5S13 9 15 9s2.5 1.5 1.5 3S13 15 11 16', 'M15.5 4.5l4 4'],
        arrows: ['M4 20L20 4', 'M12 4h8v8'],
        shapes: ['M4 4h9v9H4z', 'M16.5 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
        text: ['M5 6h14', 'M12 6v13', 'M9 19h6'],
        content: ['M4 5h16v14H4z', 'M4 15l4-4 4 4 3-3 5 5', 'M9 9.5a1 1 0 1 0 0-.01']
    };

    var DEFAULT_FAVORITES = ['trend-line', 'horizontal-line', 'rectangle', 'fib-retracement', 'text', 'brush'];
    var MAX_FAVORITES = 8;

    function iconFor(kind) {
        for (var i = 0; i < PRIMARY.length; i++) {
            if (PRIMARY[i].id === kind) return PRIMARY[i].icon;
        }
        var family = FAMILY_BY_KIND[kind];
        return FAMILY_ICONS[family] || ['M4 12h16'];
    }

    var COLORS = ['#2962ff', '#f5c400', '#089981', '#f23645', '#9c27b0', '#00bcd4', '#dbdbdb', '#71717a'];
    var WIDTHS = [1, 2, 3];
    var DASHES = ['solid', 'dashed', 'dotted'];

    /* ── Legacy model (pre-integration custom shapes) ──────────────────── */

    var LEGACY_KIND = {
        hline: 'horizontal-line',
        vline: 'vertical-line',
        trend: 'trend-line',
        rect: 'rectangle',
        fib: 'fib-retracement',
        text: 'text'
    };

    function legacyKind(tool) {
        return LEGACY_KIND[tool] || null;
    }

    function isKnownKind(kind) {
        return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(TOOL_BY_KIND, kind);
    }

    function kindLabel(kind) {
        return TOOL_BY_KIND[kind] ? TOOL_BY_KIND[kind].label : String(kind || '');
    }

    function isTextKind(kind) {
        return !!TEXT_KINDS[kind];
    }

    /* ── Timeframe / interval ─────────────────────────────────────────── */

    var TF_INTERVAL = {
        '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
        '1h': '60', '2h': '120', '4h': '240', '6h': '360', '8h': '480',
        '12h': '720', '1d': '1D', '1w': '1W', '1M': '1M'
    };
    var INTRADAY = { '1d': 0, '1w': 0, '1M': 0 };

    function intervalForTimeframe(tf) {
        return TF_INTERVAL[tf] || undefined;
    }

    function isIntraday(tf) {
        return INTRADAY[tf] !== 0;
    }

    /* ── Price space (raw ↔ chart display units) ──────────────────────── */

    function rawToDisplay(price, mode, refPrice) {
        if (!isFinite(price)) return price;
        if (!refPrice || refPrice <= 0) return price;
        if (mode === 'percentage') return (price / refPrice - 1) * 100;
        if (mode === 'indexed') return (price / refPrice) * 100;
        return price;
    }

    function displayToRaw(value, mode, refPrice) {
        if (!isFinite(value)) return value;
        if (!refPrice || refPrice <= 0) return value;
        if (mode === 'percentage') return refPrice * (1 + value / 100);
        if (mode === 'indexed') return refPrice * (value / 100);
        return value;
    }

    /**
     * Copy a drawing list with its price anchors passed through `fn`.
     * Everything except `points[].price` is shared (style, text, flags).
     */
    function project(list, fn) {
        if (!Array.isArray(list) || typeof fn !== 'function') return [];
        return list.map(function (drawing) {
            if (!drawing || !Array.isArray(drawing.points)) return drawing;
            return Object.assign({}, drawing, {
                points: drawing.points.map(function (point) {
                    if (!point || !isFinite(point.price)) return point;
                    return Object.assign({}, point, { price: fn(point.price) });
                })
            });
        });
    }

    /* ── Load / migrate ───────────────────────────────────────────────── */

    function cleanPoints(points) {
        if (!Array.isArray(points)) return null;
        var out = [];
        for (var i = 0; i < points.length && out.length < 16; i++) {
            var point = points[i];
            if (!point || typeof point !== 'object') continue;
            var time = point.time;
            var price = Number(point.price);
            if (!isFinite(price) || price < -1e12 || price > 1e12) continue;
            if (typeof time !== 'number' && typeof time !== 'string' && !(time && typeof time === 'object')) continue;
            out.push({ time: time, price: price });
        }
        return out.length ? out : null;
    }

    /** Bounded deep copy of a JSON-ish payload (style, image, pattern...). */
    function cleanValue(value, depth) {
        if (value == null || depth > 6) return null;
        if (typeof value === 'string') return value.slice(0, 4000);
        if (typeof value === 'number') return isFinite(value) ? value : null;
        if (typeof value === 'boolean') return value;
        if (Array.isArray(value)) {
            var items = [];
            for (var i = 0; i < value.length && items.length < 256; i++) {
                var item = cleanValue(value[i], depth + 1);
                if (item !== null) items.push(item);
            }
            return items;
        }
        if (typeof value === 'object') {
            var out = {};
            var keys = Object.keys(value);
            for (var k = 0; k < keys.length && k < 60; k++) {
                var clean = cleanValue(value[keys[k]], depth + 1);
                if (clean !== null) out[keys[k].slice(0, 64)] = clean;
            }
            return out;
        }
        return null;
    }

    function cleanStyle(style) {
        if (!style || typeof style !== 'object' || Array.isArray(style)) return undefined;
        return cleanValue(style, 0) || undefined;
    }

    function newRecord(drawing, id) {
        var out = {
            id: typeof drawing.id === 'string' && drawing.id ? drawing.id.slice(0, 64) : id,
            kind: drawing.kind,
            points: cleanPoints(drawing.points)
        };
        if (!out.points) return null;
        var style = cleanStyle(drawing.style);
        if (style) out.style = style;
        if (typeof drawing.text === 'string') out.text = drawing.text.slice(0, 2000);
        if (typeof drawing.name === 'string') out.name = drawing.name.slice(0, 120);
        if (typeof drawing.group === 'string') out.group = drawing.group.slice(0, 64);
        if (typeof drawing.glyph === 'string') out.glyph = drawing.glyph.slice(0, 4000);
        if (drawing.locked === true) out.locked = true;
        if (drawing.hidden === true) out.hidden = true;
        if (drawing.closed === true) out.closed = true;
        if (drawing.fmt === 1 || drawing.fmt === 2) out.fmt = drawing.fmt;
        if (typeof drawing.owner === 'string') out.owner = drawing.owner.slice(0, 64);
        // Kind-specific payloads must survive the round-trip: the renderer
        // reads them back (image size/name, bar-pattern bars, ghost seed,
        // anchored fraction, table data, per-interval visibility).
        ['image', 'pattern', 'ghost', 'anchored', 'table', 'visibility'].forEach(function (field) {
            var cleaned = cleanStyle(drawing[field]);
            if (cleaned) out[field] = cleaned;
        });
        return out;
    }

    function legacyRecord(record, ctx, index) {
        var kind = legacyKind(record.tool);
        if (!kind) return null;
        var fallbackTime = ctx && isFinite(ctx.time) ? ctx.time : Math.floor(Date.now() / 1000);
        var fallbackPrice = ctx && isFinite(ctx.price) ? ctx.price : 1;
        var points = cleanPoints(record.points) || [];
        if (kind === 'horizontal-line') {
            points = [{ time: fallbackTime, price: points.length ? points[0].price : fallbackPrice }];
        } else if (kind === 'vertical-line') {
            points = [{ time: points.length && points[0].time ? points[0].time : fallbackTime, price: fallbackPrice }];
        } else if (kind === 'text') {
            points = [{ time: points.length ? points[0].time : fallbackTime, price: points.length ? points[0].price : fallbackPrice }];
        }
        while (points.length < 2 && kind !== 'horizontal-line' && kind !== 'vertical-line' && kind !== 'text') {
            points.push(Object.assign({}, points[points.length - 1] || { time: fallbackTime, price: fallbackPrice }));
        }
        var out = {
            id: typeof record.id === 'string' && record.id ? record.id : 'd-' + index + '-' + Math.random().toString(36).slice(2, 7),
            kind: kind,
            points: points
        };
        if (typeof record.text === 'string' && record.text) out.text = record.text.slice(0, 2000);
        return out;
    }

    /**
     * Validate/normalise stored drawings (new model, mixed with legacy
     * records from earlier builds). Returns a fresh array; never throws.
     */
    function normalize(list, ctx) {
        if (!Array.isArray(list)) return [];
        var out = [];
        for (var i = 0; i < list.length && out.length < 400; i++) {
            var raw = list[i];
            if (!raw || typeof raw !== 'object') continue;
            var record = null;
            if (isKnownKind(raw.kind)) record = newRecord(raw, 'dw-' + i);
            else if (raw.tool) record = legacyRecord(raw, ctx, i);
            if (record) out.push(record);
        }
        return out;
    }

    function needsMigration(list) {
        if (!Array.isArray(list)) return false;
        for (var i = 0; i < list.length; i++) {
            var raw = list[i];
            if (!raw || typeof raw !== 'object') return true;
            if (!isKnownKind(raw.kind)) return true;
        }
        return false;
    }

    function spaceSignature(mode, refPrice) {
        if (mode !== 'percentage' && mode !== 'indexed') return 'raw';
        return mode + ':' + (isFinite(refPrice) && refPrice ? refPrice : 0);
    }

    return {
        FAMILIES: FAMILIES,
        TOOLS: TOOLS,
        TOOL_BY_KIND: TOOL_BY_KIND,
        FAMILY_BY_KIND: FAMILY_BY_KIND,
        PRIMARY: PRIMARY,
        COLORS: COLORS,
        WIDTHS: WIDTHS,
        DASHES: DASHES,
        FAMILY_ICONS: FAMILY_ICONS,
        DEFAULT_FAVORITES: DEFAULT_FAVORITES,
        MAX_FAVORITES: MAX_FAVORITES,
        iconFor: iconFor,
        legacyKind: legacyKind,
        isKnownKind: isKnownKind,
        kindLabel: kindLabel,
        isTextKind: isTextKind,
        needsPicker: function (kind) { return !!PICKER_KINDS[kind]; },
        intervalForTimeframe: intervalForTimeframe,
        isIntraday: isIntraday,
        rawToDisplay: rawToDisplay,
        displayToRaw: displayToRaw,
        project: project,
        normalize: normalize,
        needsMigration: needsMigration,
        spaceSignature: spaceSignature
    };
});
