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
        var price = Number(raw.price);
        if (!isFinite(price) || price <= 0 || price > MAX_PRICE) return null;
        var symbol = upper(raw.symbol, '');
        if (!symbol) return null;
        var id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId();
        var note = typeof raw.note === 'string' ? raw.note.trim().slice(0, MAX_NOTE) : '';
        var createdAt = Number(raw.createdAt);
        return {
            id: id,
            exchange: lower(raw.exchange, 'binance'),
            market: lower(raw.market, 'spot'),
            symbol: symbol,
            timeframe: typeof raw.timeframe === 'string' ? raw.timeframe.trim().slice(0, 8) : '',
            price: price,
            condition: CONDITION_IDS.indexOf(raw.condition) >= 0 ? raw.condition : 'crossing',
            frequency: FREQUENCY_IDS.indexOf(raw.frequency) >= 0 ? raw.frequency : 'once',
            note: note,
            enabled: raw.enabled !== false,
            createdAt: isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt) : Date.now()
        };
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
        var level = rule && isFiniteNumber(rule.price) ? rule.price : null;
        var result = { fire: false, above: false, trueState: false };
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
        var text = rule.symbol + ' ' + describe(rule, precision);
        if (rule.note) text += ' — ' + rule.note;
        return text;
    }

    function distancePercent(rule, price) {
        if (!rule || !isFiniteNumber(price) || !rule.price) return null;
        return (price / rule.price - 1) * 100;
    }

    return {
        VERSION: VERSION,
        MAX_ALERTS: MAX_ALERTS,
        MAX_LOG: MAX_LOG,
        MAX_NOTE: MAX_NOTE,
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
        frequencyLabel: frequencyLabel,
        distancePercent: distancePercent,
        formatPrice: money,
        newId: newId
    };
});
