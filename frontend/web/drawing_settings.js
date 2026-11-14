/* ═══════════════════════════════════════════════════════════════════════════
 * DrawingSettings — declarative per-tool settings schema for the chart
 * drawing layer (lightweight-charts-drawing 0.6.3).
 *
 * `lightweight-charts-drawing` exposes one flat `DrawingStyle`; this module
 * maps each tool kind to the sections and fields that actually apply to it,
 * so the workspace never shows a single generic dialog for all 86 tools.
 *
 * Pure metadata + dotted-path helpers: no DOM, no library reference at load
 * time, so it runs unchanged under `node --test`.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DrawingSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* ── Declaration helpers ───────────────────────────────────────────── */

    function field(key, type, label, extra) {
        var out = { key: key, type: type, label: label };
        if (extra) {
            Object.keys(extra).forEach(function (name) { out[name] = extra[name]; });
        }
        return out;
    }

    function toggle(key, label) { return field(key, 'toggle', label); }
    function color(key, label) { return field(key, 'color', label); }
    function text(key, label, extra) { return field(key, 'text', label, extra); }
    function textarea(key, label) { return field(key, 'textarea', label); }
    function number(key, label, min, max, step) {
        return field(key, 'number', label, { min: min, max: max, step: step == null ? 1 : step });
    }
    function select(key, label, options) {
        return field(key, 'select', label, {
            options: options.map(function (pair) {
                return { value: pair[0], label: pair[1] };
            })
        });
    }
    function section(id, label, fields) { return { id: id, label: label, fields: fields }; }

    function alignX(key, label) {
        return select(key, label, [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]);
    }
    function alignY(key, label) {
        return select(key, label, [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]);
    }
    function lineStyle(key, label) {
        return select(key, label, [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]);
    }

    /* ── Tool families ─────────────────────────────────────────────────── */

    var LINE_KINDS = [
        'trend-line', 'ray', 'extended-line', 'info-line', 'trend-angle',
        'arrow', 'arrow-marker'
    ];
    var LEVEL_LINE_KINDS = ['horizontal-line', 'horizontal-ray', 'vertical-line', 'cross-line'];
    var MARK_KINDS = ['arrow-mark-up', 'arrow-mark-down', 'flag-mark', 'price-label'];

    var FIB_KINDS = [
        'fib-retracement', 'trend-based-fib-extension', 'fib-channel', 'fib-time-zone',
        'fib-speed-resistance-fan', 'trend-based-fib-time', 'fib-circles', 'fib-spiral',
        'fib-speed-resistance-arcs', 'fib-wedge', 'pitchfan'
    ];
    var GANN_KINDS = ['gann-box', 'gann-square-fixed', 'gann-square', 'gann-fan'];
    var PITCHFORK_KINDS = [
        'pitchfork', 'schiff-pitchfork', 'modified-schiff-pitchfork', 'inside-pitchfork'
    ];
    var CHANNEL_KINDS = ['parallel-channel', 'flat-top-bottom', 'disjoint-channel'];

    var PATTERN_KINDS = [
        'xabcd-pattern', 'cypher-pattern', 'head-and-shoulders', 'abcd-pattern',
        'triangle-pattern', 'three-drives-pattern'
    ];
    var ELLIOTT_KINDS = [
        'elliott-impulse', 'elliott-correction', 'elliott-triangle',
        'elliott-double-combo', 'elliott-triple-combo'
    ];
    var CYCLE_KINDS = ['cyclic-lines', 'time-cycles', 'sine-line'];

    var SHAPE_KINDS = [
        'rectangle', 'rotated-rectangle', 'path', 'circle', 'ellipse', 'polyline',
        'triangle', 'arc', 'curve', 'double-curve'
    ];
    var BRUSH_KINDS = ['brush', 'highlighter'];
    var TEXT_KINDS = [
        'text', 'note', 'price-note', 'pin', 'callout', 'comment', 'price-label',
        'signpost', 'flag-mark'
    ];
    var POSITION_KINDS = ['long-position', 'short-position', 'position-forecast'];
    var RANGE_KINDS = ['price-range', 'date-range', 'date-and-price-range'];
    var VOLUME_PROFILE_KINDS = ['fixed-range-volume-profile', 'anchored-volume-profile'];

    /* ── Shared sections ───────────────────────────────────────────────── */

    function generalFields(kind) {
        if (kind === 'image') return [];
        if (kind === 'font-icon') return [color('color', 'Colour'), number('fontSize', 'Size', 8, 200, 1), number('transparency', 'Transparency', 0, 100, 1)];
        if (kind === 'table') {
            return [
                color('color', 'Border'),
                color('textColor', 'Text'),
                color('backgroundColor', 'Background'),
                number('fontSize', 'Font size', 8, 48, 1)
            ];
        }
        if (TEXT_KINDS.indexOf(kind) >= 0) {
            return [color('color', 'Accent')];
        }
        return [
            color('color', 'Line'),
            number('width', 'Width', 0, 12, 1),
            lineStyle('lineStyle', 'Line style')
        ];
    }

    function fillSection(label) {
        return section('fill', label || 'Background', [
            toggle('fillBackground', 'Fill background'),
            color('backgroundColor', 'Background colour'),
            number('transparency', 'Transparency', 0, 100, 1)
        ]);
    }

    function lineEndsSection() {
        return section('ends', 'Ends & extension', [
            toggle('extendLeft', 'Extend left'),
            toggle('extendRight', 'Extend right'),
            select('leftEnd', 'Left end', [[0, 'None'], [1, 'Arrow']]),
            select('rightEnd', 'Right end', [[0, 'None'], [1, 'Arrow']]),
            toggle('showMiddlePoint', 'Show middle point'),
            toggle('showPriceLabels', 'Price labels'),
            toggle('showTime', 'Time label')
        ]);
    }

    function labelSection() {
        return section('label', 'Label on line', [
            text('text', 'Text'),
            color('textColor', 'Text colour'),
            number('fontSize', 'Font size', 8, 48, 1),
            toggle('bold', 'Bold'),
            toggle('italic', 'Italic'),
            alignX('horzLabelsAlign', 'Horizontal align'),
            alignY('vertLabelsAlign', 'Vertical align')
        ]);
    }

    function statsSection() {
        return section('stats', 'Stats', [
            toggle('showStats', 'Show stats'),
            select('statsPosition', 'Position', [[0, 'Left'], [1, 'Center'], [2, 'Right'], [3, 'Auto']]),
            toggle('showPriceRange', 'Price range'),
            toggle('showPercentPriceRange', 'Percent range'),
            toggle('showPipsPriceRange', 'Pips range'),
            toggle('showBarsRange', 'Bars range'),
            toggle('showDateTimeRange', 'Date & time range'),
            toggle('showDistance', 'Distance'),
            toggle('showAngle', 'Angle')
        ]);
    }

    function lineSections(kind) {
        var out = [lineEndsSection(), labelSection(), statsSection()];
        if (kind === 'vertical-line' || kind === 'cross-line') {
            out.push(section('axis', 'Axis', [
                toggle('extendLine', 'Extend through panes'),
                select('textOrientation', 'Text orientation', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])
            ]));
        }
        return out;
    }

    function levelSections(kind) {
        var out = [];
        if (FIB_KINDS.indexOf(kind) >= 0 && kind !== 'fib-spiral') {
            out.push(section('levels', 'Levels', [
                field('levels', 'levels', 'Level values'),
                toggle('reverse', 'Reverse'),
                toggle('fibLevelsAsPercents', 'Levels as percents'),
                toggle('fibLevelsBasedOnLogScale', 'Log-scale levels'),
                toggle('showText', 'Level text'),
                alignX('horzTextAlign', 'Text horizontal align'),
                alignY('vertTextAlign', 'Text vertical align'),
                toggle('showLabels', 'Labels')
            ]));
        }
        if (PITCHFORK_KINDS.indexOf(kind) >= 0) {
            out.push(section('levels', 'Levels', [
                field('levels', 'levels', 'Level values'),
                toggle('extendLines', 'Extend lines')
            ]));
        }
        if (GANN_KINDS.indexOf(kind) >= 0) {
            out.push(section('labels', 'Labels', [
                toggle('showLeftLabels', 'Left labels'),
                toggle('showRightLabels', 'Right labels'),
                toggle('showTopLabels', 'Top labels'),
                toggle('showBottomLabels', 'Bottom labels'),
                toggle('showLabels', 'Time labels'),
                number('labelFontSize', 'Label font size', 8, 32, 1),
                toggle('fillVertBackground', 'Vertical background'),
                number('vertTransparency', 'Vertical transparency', 0, 100, 1)
            ]));
        }
        if (CHANNEL_KINDS.indexOf(kind) >= 0) {
            out.push(section('channel', 'Channel', [
                toggle('middleLine', 'Middle line'),
                toggle('showPrices', 'Price labels'),
                toggle('showCoeffs', 'Coefficient labels')
            ]));
        }
        if (kind === 'fib-channel') {
            out.push(section('channel', 'Channel', [
                toggle('showPrices', 'Price labels'),
                toggle('showCoeffs', 'Coefficient labels'),
                number('labelFontSize', 'Label font size', 8, 32, 1)
            ]));
        }
        if (kind === 'fib-speed-resistance-arcs') out.push(section('arcs', 'Arcs', [toggle('fullCircles', 'Full circles')]));
        if (kind === 'fib-spiral') out.push(section('spiral', 'Spiral', [toggle('counterclockwise', 'Counterclockwise')]));
        if (kind === 'anchored-vwap') {
            out.push(section('vwap', 'VWAP', [
                select('vwapSource', 'Source', [
                    ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close'],
                    ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['ohlc4', 'OHLC4'], ['hlcc4', 'HLCC4']
                ]),
                select('vwapBandsMode', 'Bands mode', [['stdev', 'Standard deviation'], ['percent', 'Percentage']]),
                field('levels', 'levels', 'Band multipliers'),
                toggle('vwapPriceLabel', 'Price label')
            ]));
        }
        out.push(fillSection());
        return out;
    }

    function shapeSections(kind) {
        var out = [];
        out.push(fillSection());
        if (kind === 'rectangle') {
            out.push(section('middle', 'Middle line', [
                toggle('rectMiddleLine.visible', 'Show middle line'),
                color('rectMiddleLine.color', 'Middle line colour'),
                number('rectMiddleLine.width', 'Middle line width', 0, 8, 1),
                lineStyle('rectMiddleLine.style', 'Middle line style')
            ]));
        }
        return out;
    }

    function textSections(kind) {
        var out = [
            section('content', 'Text', [
                textarea('@text', 'Text'),
                color('textColor', 'Text colour'),
                number('fontSize', 'Font size', 8, 72, 1),
                toggle('bold', 'Bold'),
                toggle('italic', 'Italic'),
                alignX('horzLabelsAlign', 'Horizontal align'),
                alignY('vertLabelsAlign', 'Vertical align')
            ]),
            fillSection('Box'),
            section('box', 'Box border & wrap', [
                toggle('drawBorder', 'Draw border'),
                color('borderColor', 'Border colour'),
                toggle('wordWrap', 'Word wrap'),
                number('wordWrapWidth', 'Wrap width', 60, 800, 10)
            ])
        ];
        if (kind === 'price-label' || kind === 'price-note') {
            out.push(section('priceLabel', 'Price label', [
                toggle('showPriceLabels', 'Show price label'),
                color('priceLabelTextColor', 'Label text'),
                number('priceLabelFontSize', 'Label font size', 8, 32, 1),
                toggle('priceLabelBold', 'Label bold'),
                toggle('priceLabelItalic', 'Label italic'),
                color('priceLabelBackgroundColor', 'Label background'),
                color('priceLabelBorderColor', 'Label border')
            ]));
        }
        if (kind === 'signpost') {
            out.push(section('signpost', 'Signpost', [
                toggle('showImage', 'Show pin'),
                color('plateColor', 'Plate colour'),
                number('signpostPosition', 'Pane position (%)', 0, 100, 1)
            ]));
        }
        return out;
    }

    function positionSections(kind) {
        var out = [
            section('sizing', 'Position sizing', [
                number('stopLevel', 'Stop level', 0, 1e9, 0.01),
                number('profitLevel', 'Target level', 0, 1e9, 0.01),
                number('accountSize', 'Account size', 0, 1e12, 1),
                number('riskPercent', 'Risk %', 0, 100, 0.1),
                select('riskDisplayMode', 'Risk display', [['percents', 'Percent'], ['money', 'Money']]),
                number('riskAmount', 'Risk amount', 0, 1e12, 1),
                number('lotSize', 'Lot size', 0.0001, 1e6, 0.0001),
                number('leverage', 'Leverage', 1, 1000000, 1),
                select('qtyPrecision', 'Qty precision', [
                    ['default', 'Default'], ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'],
                    ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8']
                ]),
                toggle('compactStats', 'Compact stats'),
                toggle('showPriceLabels', 'Price labels')
            ]),
            section('colours', 'Stop & target', [
                color('stopColor', 'Stop colour'),
                number('stopTransparency', 'Stop transparency', 0, 100, 1),
                color('targetColor', 'Target colour'),
                number('targetTransparency', 'Target transparency', 0, 100, 1)
            ])
        ];
        if (kind === 'position-forecast') {
            out.push(section('forecast', 'Forecast balloons', [
                color('sourceTextColor', 'Source text'),
                color('sourceBackColor', 'Source background'),
                color('sourceStrokeColor', 'Source stroke'),
                color('targetTextColor', 'Target text'),
                color('targetBackColor', 'Target background'),
                color('targetStrokeColor', 'Target stroke'),
                color('successTextColor', 'Success text'),
                color('successBackground', 'Success background'),
                color('failureTextColor', 'Failure text'),
                color('failureBackground', 'Failure background')
            ]));
        }
        return out;
    }

    function rangeSections() {
        return [
            section('range', 'Range', [
                toggle('extendTop', 'Extend top'),
                toggle('extendBottom', 'Extend bottom'),
                toggle('showVolume', 'Show volume'),
                text('text', 'Custom text'),
                color('customTextColor', 'Custom text colour'),
                number('customTextSize', 'Custom text size', 8, 32, 1),
                toggle('customTextBold', 'Custom text bold'),
                toggle('customTextItalic', 'Custom text italic')
            ]),
            fillSection(),
            section('rangeLabel', 'Label', [
                color('textColor', 'Text colour'),
                number('fontSize', 'Font size', 8, 32, 1),
                toggle('fillLabelBackground', 'Label background'),
                color('labelBackgroundColor', 'Label background colour'),
                number('borderWidth', 'Border width', 0, 8, 1)
            ])
        ];
    }

    function regressionSections() {
        return [
            section('regression', 'Regression', [
                number('upperDeviation', 'Upper deviation', -10, 10, 0.1),
                number('lowerDeviation', 'Lower deviation', -10, 10, 0.1),
                toggle('useUpperDeviation', 'Use upper deviation'),
                toggle('useLowerDeviation', 'Use lower deviation'),
                select('regressionSource', 'Source', [
                    ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close'],
                    ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['ohlc4', 'OHLC4'], ['hlcc4', 'HLCC4']
                ]),
                toggle('showPearsons', "Pearson's R"),
                toggle('showStats', 'Stats')
            ]),
            fillSection()
        ];
    }

    function volumeProfileSections() {
        var lines = ['vah', 'val', 'poc', 'developingPoc', 'developingVah', 'developingVal'];
        var lineFields = [];
        lines.forEach(function (id) {
            lineFields.push(toggle('vp.' + id + '.visible', id + ' line'));
            lineFields.push(color('vp.' + id + '.color', id + ' colour'));
        });
        return [
            section('vpInputs', 'Profile inputs', [
                select('vp.rowsLayout', 'Row layout', [['rows', 'Rows'], ['ticks', 'Ticks per row']]),
                number('vp.rows', 'Rows', 1, 500, 1),
                select('vp.volume', 'Volume', [['upDown', 'Up / Down'], ['total', 'Total'], ['delta', 'Delta']]),
                number('vp.vaVolume', 'Value area %', 0, 100, 1),
                toggle('vp.extendRight', 'Extend right'),
                toggle('vp.visible', 'Show histogram')
            ]),
            section('vpStyle', 'Profile style', [
                toggle('vp.showValues', 'Show values'),
                color('vp.valuesColor', 'Values colour'),
                number('vp.percentWidth', 'Width (%)', 1, 100, 1),
                select('vp.placement', 'Placement', [['left', 'Left'], ['right', 'Right']]),
                color('vp.upColor', 'Up colour'),
                color('vp.downColor', 'Down colour'),
                color('vp.vaUpColor', 'Value-area up'),
                color('vp.vaDownColor', 'Value-area down'),
                color('vp.boxColor', 'Box colour')
            ]),
            section('vpLines', 'Profile lines', lineFields)
        ];
    }

    function patternSections() {
        return [
            fillSection(),
            section('patternText', 'Pattern labels', [
                color('textColor', 'Text colour'),
                number('fontSize', 'Font size', 8, 32, 1)
            ])
        ];
    }

    function elliottSections() {
        return [section('elliott', 'Elliott wave', [
            number('elliottDegree', 'Wave degree', 0, 14, 1),
            toggle('showWave', 'Wave lines')
        ])];
    }

    function cycleSections() {
        return [fillSection()];
    }

    function markSections(kind) {
        if (kind === 'price-label') return textSections(kind);
        return [
            section('mark', 'Marker', [
                number('fontSize', 'Font size', 8, 48, 1),
                toggle('bold', 'Bold'),
                toggle('fillBackground', 'Fill background'),
                color('backgroundColor', 'Background colour'),
                number('transparency', 'Transparency', 0, 100, 1)
            ])
        ];
    }

    function forecastSections(kind) {
        if (kind === 'bar-pattern') {
            return [section('pattern', 'Bar pattern', [
                select('patternMode', 'Display', [
                    ['bars', 'Bars'], ['oc', 'Open / close'], ['line', 'Close line'],
                    ['line-open', 'Open line'], ['line-high', 'High line'],
                    ['line-low', 'Low line'], ['line-hl2', 'HL2 line']
                ]),
                toggle('mirrored', 'Mirrored'),
                toggle('flipped', 'Flipped')
            ])];
        }
        if (kind === 'ghost-feed') {
            return [section('ghost', 'Ghost feed', [
                number('variance', 'Randomness', 0, 100, 1),
                number('transparency', 'Transparency', 0, 100, 1),
                color('ghostCandle.upColor', 'Up candle'),
                color('ghostCandle.downColor', 'Down candle'),
                toggle('ghostCandle.drawBorder', 'Candle borders'),
                color('ghostCandle.borderUpColor', 'Up border'),
                color('ghostCandle.borderDownColor', 'Down border'),
                toggle('ghostCandle.drawWick', 'Wicks'),
                color('ghostCandle.wickColor', 'Wick colour')
            ])];
        }
        if (kind === 'sector') {
            return [section('sector', 'Gradient', [
                color('sectorColor1', 'From colour'),
                color('sectorColor2', 'To colour'),
                toggle('fillBackground', 'Fill background'),
                number('transparency', 'Transparency', 0, 100, 1)
            ])];
        }
        return [];
    }

    /* ── Kind → sections ───────────────────────────────────────────────── */

    var SPECIFIC = {};

    function add(kinds, builder) {
        kinds.forEach(function (kind) { SPECIFIC[kind] = builder; });
    }

    add(LINE_KINDS, lineSections);
    add(LEVEL_LINE_KINDS, function () {
        return [section('axis', 'Axis', [
            toggle('showPriceLabels', 'Price labels'),
            toggle('showTime', 'Time label'),
            toggle('extendLine', 'Extend through panes'),
            select('textOrientation', 'Text orientation', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])
        ]), labelSection(), statsSection()];
    });
    add(FIB_KINDS, levelSections);
    add(GANN_KINDS, levelSections);
    add(PITCHFORK_KINDS, levelSections);
    add(CHANNEL_KINDS, levelSections);
    add(['anchored-vwap'], levelSections);
    add(SHAPE_KINDS, shapeSections);
    add(BRUSH_KINDS, shapeSections);
    add(TEXT_KINDS, textSections);
    add(POSITION_KINDS, positionSections);
    add(RANGE_KINDS, rangeSections);
    add(['regression-trend'], regressionSections);
    add(VOLUME_PROFILE_KINDS, volumeProfileSections);
    add(PATTERN_KINDS, patternSections);
    add(ELLIOTT_KINDS, elliottSections);
    add(CYCLE_KINDS, cycleSections);
    add(MARK_KINDS, markSections);
    add(['bar-pattern', 'ghost-feed', 'sector'], forecastSections);
    add(['table'], function () {
        return [section('table', 'Table', [alignX('horzLabelsAlign', 'Horizontal align')])];
    });
    add(['image'], function () {
        return [section('image', 'Image', [number('transparency', 'Transparency', 0, 100, 1)])];
    });
    add(['font-icon'], function () {
        return [section('glyph', 'Icon', [textarea('@glyph', 'Emoji or SVG markup')])];
    });

    /* ── Read / write dotted style paths ───────────────────────────────── */

    function split(key) { return String(key || '').split('.'); }

    function get(style, key) {
        var parts = split(key);
        var value = style;
        for (var i = 0; i < parts.length && value != null; i++) value = value[parts[i]];
        return value;
    }

    /** Returns a new style object (never mutates the input). */
    function set(style, key, value) {
        var parts = split(key);

        function walk(node, index) {
            var copy = node && typeof node === 'object' && !Array.isArray(node)
                ? Object.assign({}, node)
                : {};
            var part = parts[index];
            copy[part] = index === parts.length - 1 ? value : walk(node == null ? undefined : node[part], index + 1);
            return copy;
        }

        return walk(style, 0);
    }

    function sections(kind) {
        var builder = SPECIFIC[kind];
        var specific = builder ? builder(kind) : [];
        var general = generalFields(kind);
        return (general.length ? [section('general', 'Style', general)] : []).concat(specific);
    }

    function has(kind) {
        return Object.prototype.hasOwnProperty.call(SPECIFIC, kind);
    }

    return {
        sections: sections,
        has: has,
        get: get,
        set: set
    };
});
