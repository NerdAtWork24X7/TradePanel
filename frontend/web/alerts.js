/* ═══════════════════════════════════════════════════════════════════════════
 * TradePanelAlerts — price-alert rules and evaluation
 *
 * Pure data + math: no DOM, no chart API. The workspace owns placement,
 * drawing, notifications and persistence; this module owns validation and the
 * crossing logic, so every rule can be unit-tested in Node.
 *
 * Semantics (OpenTrader/TradingView-style):
 *   crossing        fires on any sign change through the level
 *   crossing-up     fires when previous sample <= level < current
 *   crossing-down   fires when previous sample >  level >= current
 *   greater         fires when the "above" state becomes true
 *   less            fires when the "below" state becomes true
 * A rule never fires on the very first sample (that sample is a baseline),
 * and edge-triggered conditions cannot fire twice without leaving the state.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TradePanelAlerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = 1;
    var MAX_ALERTS = 200;
    var MAX_LOG = 100;
    var MAX_NOTE = 120;
    var MAX_PRICE = 1e12;

    var CONDITIONS = [
        { id: 'crossing', label: 'Crossing', short: 'crossing' },
        { id: 'crossing-up', label: 'Crossing up', short: 'crossing up' },
        { id: 'crossing-down', label: 'Crossing down', short: 'crossing down' },
        { id: 'greater', label: 'Greater than', short: 'above' },
        { id: 'less', label: 'Less than', short: 'below' }
    ];
    var FREQUENCIES = [
        { id: 'once', label: 'Once' },
        { id: 'repeating', label: 'Every time' }
    ];

    var CONDITION_IDS = CONDITIONS.map(function (c) { return c.id; });
    var FREQUENCY_IDS = FREQUENCIES.map(function (f) { return f.id; });
    var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
    var INDICATOR_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
    // Pseudo-condition id for indicators that call PineScript `alert()`
    // (`hasAlertFunction`), which have no `alertConditions` entry.
    var INDICATOR_CALL = 'alert-call';

    function condition(id) {
        for (var i = 0; i < CONDITIONS.length; i++) {
            if (CONDITIONS[i].id === id) return CONDITIONS[i];
        }
        return null;
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && isFinite(value);
    }

    function newId() {
        return 'a-' + Math.random().toString(36).slice(2, 10);
    }

    function upper(value, fallback) {
        if (typeof value !== 'string') return fallback;
        var text = value.trim().toUpperCase();
        return text ? text.slice(0, 32) : fallback;
    }

    function lower(value, fallback) {
        if (typeof value !== 'string') return fallback;
        var text = value.trim().toLowerCase();
        return text ? text.slice(0, 32) : fallback;
    }

    function money(value, precision) {
        if (!isFiniteNumber(value)) return '—';
        var p = isFiniteNumber(precision) ? Math.max(0, Math.min(8, Math.round(precision))) : 2;
        var parts = value.toFixed(p).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    /** Validate one persisted/created rule; returns null when unusable. */
    function normalizeAlert(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        var symbol = upper(raw.symbol, '');
        if (!symbol) return null;
        var source = raw.source === 'indicator' ? 'indicator' : 'price';
        var id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId();
        var note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
        var createdAt = Number(raw.createdAt);
        var base = {
            id: id,
            source: source,
            exchange: lower(raw.exchange, 'binance'),
            market: lower(raw.market, 'spot'),
            symbol: symbol,
            timeframe: typeof raw.timeframe === 'string' ? raw.timeframe.trim().slice(0, 8) : '',
            frequency: FREQUENCY_IDS.indexOf(raw.frequency) >= 0 ? raw.frequency : 'once',
            note: note,
            enabled: raw.enabled !== false,
            createdAt: isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt) : Date.now()
        };

        if (source === 'indicator') {
            var chartId = typeof raw.chartId === 'string' ? raw.chartId.trim() : '';
            var indicatorId = typeof raw.indicatorId === 'string'
                ? raw.indicatorId.trim().toLowerCase() : '';
            var conditionId = typeof raw.conditionId === 'string' ? raw.conditionId.trim().slice(0, 64) : '';
            if (!ID_RE.test(chartId) || !INDICATOR_RE.test(indicatorId) || !conditionId) return null;
            var position = Number(raw.indicatorIndex);
            base.chartId = chartId;
            base.indicatorId = indicatorId;
            base.indicatorIndex = isFinite(position) && position >= 0
                ? Math.min(64, Math.floor(position)) : 0;
            base.indicatorInputs = raw.indicatorInputs && typeof raw.indicatorInputs === 'object' &&
                !Array.isArray(raw.indicatorInputs) ? raw.indicatorInputs : {};
            base.conditionId = conditionId;
            var indicatorName = typeof raw.indicatorName === 'string'
                ? raw.indicatorName.trim().slice(0, 120) : '';
            var conditionTitle = typeof raw.conditionTitle === 'string'
                ? raw.conditionTitle.trim().slice(0, 120) : '';
            base.indicatorName = indicatorName || indicatorId;
            base.conditionTitle = conditionTitle || conditionId;
            base.indicatorMessage = typeof raw.indicatorMessage === 'string'
                ? raw.indicatorMessage.trim().slice(0, 240) : '';
            base.condition = 'indicator';
            base.price = null;
            return base;
        }

        var price = Number(raw.price);
        if (!isFinite(price) || price <= 0 || price > MAX_PRICE) return null;
        base.price = price;
        base.condition = CONDITION_IDS.indexOf(raw.condition) >= 0 ? raw.condition : 'crossing';
        return base;
    }

    /** Validate a list, dropping junk and duplicate ids. */
    function normalizeAlerts(list) {
        if (!Array.isArray(list)) return [];
        var out = [];
        var seen = Object.create(null);
        for (var i = 0; i < list.length && out.length < MAX_ALERTS; i++) {
            var alert = normalizeAlert(list[i], i);
            if (!alert || seen[alert.id]) continue;
            seen[alert.id] = true;
            out.push(alert);
        }
        return out;
    }

    function alertKey(alertOrConfig) {
        if (!alertOrConfig) return '';
        return lower(alertOrConfig.exchange, 'binance') + '|' +
            lower(alertOrConfig.market, 'spot') + '|' +
            upper(alertOrConfig.symbol, '');
    }

    function matches(alert, config) {
        if (!alert || !config) return false;
        return alert.symbol === upper(config.symbol, '') &&
            alert.exchange === lower(config.exchange, 'binance') &&
            alert.market === lower(config.market, 'spot');
    }

    /**
     * Evaluate one sample.
     * @param rule       normalized alert rule
     * @param prevPrice  previous sample (null on the first sample)
     * @param price      current sample
     * @param prevTrue   previous `trueState` returned by this function
     * @returns {{fire: boolean, above: boolean, trueState: boolean}}
     */
    function evaluate(rule, prevPrice, price, prevTrue) {
        var result = { fire: false, above: false, trueState: false };
        // Indicator rules are evaluated from bar-close alert output, not price.
        if (rule && rule.source === 'indicator') return result;
        var level = rule && isFiniteNumber(rule.price) ? rule.price : null;
        if (level == null || !isFiniteNumber(price)) return result;
        var above = price > level;
        result.above = above;
        if (rule.enabled === false) return result;

        var wasTrue = prevTrue === true;
        if (rule.condition === 'greater') result.trueState = above;
        else if (rule.condition === 'less') result.trueState = !above;

        if (!isFiniteNumber(prevPrice)) return result;
        var wasAbove = prevPrice > level;

        if (rule.condition === 'crossing') result.fire = wasAbove !== above;
        else if (rule.condition === 'crossing-up') result.fire = !wasAbove && above;
        else if (rule.condition === 'crossing-down') result.fire = wasAbove && !above;
        else if (rule.condition === 'greater') result.fire = above && !wasTrue;
        else if (rule.condition === 'less') result.fire = !above && !wasTrue;
        return result;
    }

    /**
     * Initial runtime truth for a rule when it is created/armed. Without it a
     * `greater` rule placed below the current price would fire immediately.
     */
    function initialState(rule, price) {
        if (!rule || !isFiniteNumber(price)) return false;
        if (rule.condition === 'greater') return price > rule.price;
        if (rule.condition === 'less') return price < rule.price;
        return false;
    }

    function describe(rule, precision) {
        if (!rule) return '';
        if (rule.source === 'indicator') {
            return rule.conditionTitle || rule.conditionId || 'indicator alert';
        }
        var meta = condition(rule.condition);
        return (meta ? meta.short : 'crossing') + ' ' + money(rule.price, precision);
    }

    function frequencyLabel(id) {
        for (var i = 0; i < FREQUENCIES.length; i++) {
            if (FREQUENCIES[i].id === id) return FREQUENCIES[i].label;
        }
        return 'Once';
    }

    /** Human sentence used by toasts, the shell event and the fired log. */
    function message(rule, price, precision) {
        if (!rule) return '';
        var text;
        if (rule.source === 'indicator') {
            text = rule.symbol + ' · ' + (rule.indicatorName || rule.indicatorId || 'indicator');
            var detail = rule.conditionTitle || rule.conditionId;
            if (detail) text += ' · ' + detail;
        } else {
            text = rule.symbol + ' ' + describe(rule, precision);
        }
        if (rule.note) text += ' — ' + rule.note;
        return text;
    }

    /** Expand PineScript alert placeholders ({{ticker}}, {{close}}, ...). */
    function renderPlaceholders(text, vars) {
        if (typeof text !== 'string' || !text) return '';
        return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, function (match, key) {
            var value = vars ? vars[key] : null;
            return value === null || value === undefined ? '' : String(value);
        });
    }

    /**
     * Progress a bar-time high-water mark for an indicator condition.
     * `signals` = `[{time, message}]` (order does not matter); `lastTime` is the
     * previous mark (0 arms at the newest signal so history is never replayed).
     * @returns {{baseline: number, fresh: Array<{time: number, message: string}>}}
     */
    function indicatorSignals(signals, lastTime) {
        var baseline = isFiniteNumber(lastTime) ? lastTime : 0;
        var clean = [];
        if (Array.isArray(signals)) {
            for (var i = 0; i < signals.length; i++) {
                var item = signals[i];
                var time = item ? Number(item.time) : NaN;
                if (!isFiniteNumber(time)) continue;
                clean.push({
                    time: time,
                    message: typeof item.message === 'string' ? item.message : ''
                });
            }
        }
        clean.sort(function (a, b) { return a.time - b.time; });
        if (!clean.length) return { baseline: baseline, fresh: [] };
        var newest = clean[clean.length - 1].time;
        if (!baseline) return { baseline: newest, fresh: [] };
        return {
            baseline: Math.max(baseline, newest),
            fresh: clean.filter(function (item) { return item.time > baseline; })
        };
    }

    function distancePercent(rule, price) {
        if (!rule || rule.source === 'indicator' || !isFiniteNumber(price) || !rule.price) return null;
        return (price / rule.price - 1) * 100;
    }

    /** One session-log entry for a trigger; the shell shows `message`. */
    function logEntry(rule, price, precision, text, source, time) {
        var indicator = !!rule && rule.source === 'indicator';
        return {
            alertId: rule ? rule.id : '',
            symbol: rule ? rule.symbol : '',
            exchange: rule ? rule.exchange : '',
            market: rule ? rule.market : '',
            message: typeof text === 'string' && text ? text : 'Alert triggered',
            price: isFiniteNumber(price) ? price : null,
            level: indicator ? null : (rule ? rule.price : null),
            condition: indicator ? (rule ? rule.conditionId : '') : (rule ? rule.condition : ''),
            note: rule && rule.note ? rule.note : '',
            precision: isFiniteNumber(precision) ? precision : 2,
            source: source || 'live',
            time: isFiniteNumber(time) ? time : Date.now()
        };
    }

    return {
        VERSION: VERSION,
        MAX_ALERTS: MAX_ALERTS,
        MAX_LOG: MAX_LOG,
        MAX_NOTE: MAX_NOTE,
        INDICATOR_CALL: INDICATOR_CALL,
        CONDITIONS: CONDITIONS,
        FREQUENCIES: FREQUENCIES,
        normalizeAlert: normalizeAlert,
        normalizeAlerts: normalizeAlerts,
        alertKey: alertKey,
        matches: matches,
        evaluate: evaluate,
        initialState: initialState,
        condition: condition,
        describe: describe,
        message: message,
        renderPlaceholders: renderPlaceholders,
        indicatorSignals: indicatorSignals,
        frequencyLabel: frequencyLabel,
        distancePercent: distancePercent,
        logEntry: logEntry,
        formatPrice: money,
        newId: newId
    };
});
