/* ═══════════════════════════════════════════════════════════════════════════
 * PositionTool — sizing/stats engine for the Long / Short position tools
 *
 * Pure math and formatting: no DOM, no canvas, no chart API. The workspace
 * projects the returned values onto the canvas, so every formula can be unit
 * tested in Node.
 *
 * Formulas follow TradingView's documented Long/Short position tool:
 *   Qty       = min(QtyRisk, QtyLvg)
 *   QtyRisk   = (RiskSize / |entry − stop|) / lotSize
 *   QtyLvg    = (account × leverage / entry) / lotSize
 *   RR        = rewardDistance / riskDistance
 *   PnL       = distance × qty × lotSize   (point value = 1)
 *   Balance   = account ± PnL at target/stop
 * Prices are the only market input; ticks derive from the instrument tick size.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PositionTool = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var DEFAULTS = {
        acct: 10000,
        riskMode: 'percent', // 'percent' | 'amount'
        riskPercent: 1,
        riskAmount: 100,
        lev: 10,
        lotSize: 1,
        qtyPrecision: 4,
        widthPx: 140,
        showStats: true,
        compactStats: false
    };

    var LIMITS = {
        acct: [1, 1e12],
        riskPercent: [0.01, 100],
        riskAmount: [0.01, 1e12],
        lev: [1, 125],
        lotSize: [1e-6, 1e6],
        qtyPrecision: [0, 8],
        widthPx: [40, 2000]
    };

    function isNum(value) { return typeof value === 'number' && isFinite(value); }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function num(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function inRange(value, key, fallback) {
        var limits = LIMITS[key];
        if (value == null || value === '') return fallback;
        var n = Number(value);
        if (!isFinite(n)) return fallback;
        return clamp(n, limits[0], limits[1]);
    }

    function normalizeSettings(raw) {
        var src = raw && typeof raw === 'object' ? raw : {};
        var acct = inRange(src.acct, 'acct', DEFAULTS.acct);
        // v1 stored a single `risk` percentage; keep those drawings meaningful.
        var legacy = num(src.risk, null);
        var riskMode = src.riskMode === 'amount' ? 'amount' : 'percent';
        var riskPercent = inRange(src.riskPercent != null ? src.riskPercent : legacy,
            'riskPercent', DEFAULTS.riskPercent);
        var riskAmount = inRange(src.riskAmount, 'riskAmount', acct * riskPercent / 100);
        return {
            acct: acct,
            riskMode: riskMode,
            riskPercent: riskPercent,
            riskAmount: riskAmount,
            lev: inRange(src.lev, 'lev', DEFAULTS.lev),
            lotSize: inRange(src.lotSize, 'lotSize', DEFAULTS.lotSize),
            qtyPrecision: Math.round(inRange(src.qtyPrecision, 'qtyPrecision', DEFAULTS.qtyPrecision)),
            widthPx: inRange(src.widthPx, 'widthPx', DEFAULTS.widthPx),
            showStats: src.showStats !== false,
            compactStats: src.compactStats === true
        };
    }

    /** Mirror the target around the entry (1:1 risk/reward creation default). */
    function mirrorStop(dir, entry, target) {
        var base = Number(entry);
        var stop = dir === 'short'
            ? base + (base - target)
            : base - (target - base);
        if (!isFinite(stop) || !(stop > 0)) {
            return isFinite(base) && base > 0 ? Math.max(base * 1e-6, 1e-9) : 1e-9;
        }
        return stop;
    }

    function normalizePosition(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var dir = raw.dir === 'short' ? 'short' : raw.dir === 'long' ? 'long' : null;
        if (!dir) return null;
        var entry = Number(raw.entry);
        var tp = Number(raw.tp);
        var sl = Number(raw.sl);
        if (![entry, tp, sl].every(function (v) { return isFinite(v) && v > 0; })) return null;
        var start = Number(raw.startTime);
        var end = Number(raw.endTime);
        if (!isFinite(start) || start <= 0) return null;
        if (!isFinite(end) || end <= start) end = start + 3600;
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : 'p-' + Math.random().toString(36).slice(2, 9),
            dir: dir,
            entry: entry,
            tp: tp,
            sl: sl,
            startTime: start,
            endTime: end
        };
    }

    /** Risk budget in account currency (absolute or % of the account). */
    function riskBudget(settings) {
        var s = normalizeSettings(settings);
        var amount = s.riskMode === 'amount' ? s.riskAmount : s.acct * s.riskPercent / 100;
        return { settings: s, riskAmount: Math.max(0, amount), riskPct: s.acct > 0 ? amount / s.acct * 100 : 0 };
    }

    /**
     * Full position metrics.
     * `market` = { precision, tickSize, lastPrice, closeAtEnd }
     * closeAtEnd is only set when the box's right edge is at/behind the newest
     * candle, which is what separates "Open PnL" from a planned trade.
     */
    function compute(position, settings, market) {
        var pos = normalizePosition(position);
        if (!pos) return null;
        var budget = riskBudget(settings);
        var s = budget.settings;
        var m = market && typeof market === 'object' ? market : {};
        var precision = clamp(Math.round(num(m.precision, 2)), 0, 8);
        var tickSize = num(m.tickSize, Math.pow(10, -precision));
        if (!(tickSize > 0)) tickSize = Math.pow(10, -precision);

        var long = pos.dir === 'long';
        var riskPerUnit = Math.abs(pos.entry - pos.sl);
        var rewardPerUnit = Math.abs(pos.tp - pos.entry);
        var rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;
        var riskPct = pos.entry > 0 ? riskPerUnit / pos.entry * 100 : 0;
        var rewardPct = pos.entry > 0 ? rewardPerUnit / pos.entry * 100 : 0;
        var tpTicks = Math.round(rewardPerUnit / tickSize);
        var slTicks = Math.round(riskPerUnit / tickSize);

        var lotSize = s.lotSize;
        var qtyRisk = riskPerUnit > 0 ? (budget.riskAmount / riskPerUnit) / lotSize : 0;
        var qtyLvg = pos.entry > 0 ? (s.acct * s.lev / pos.entry) / lotSize : 0;
        var qty = Math.max(0, Math.min(qtyRisk, qtyLvg));
        var units = qty * lotSize;
        var notional = units * pos.entry;
        var margin = s.lev > 0 ? notional / s.lev : 0;
        var risk = units * riskPerUnit;
        var reward = units * rewardPerUnit;
        var balanceAtTp = s.acct + reward;
        var balanceAtSl = s.acct - risk;

        var lastPrice = num(m.lastPrice, 0);
        var closeAtEnd = num(m.closeAtEnd, 0);
        var markPrice = closeAtEnd > 0 ? closeAtEnd : lastPrice;
        var hasMark = markPrice > 0;
        var openPnl = hasMark ? units * (long ? markPrice - pos.entry : pos.entry - markPrice) : 0;
        var openPct = hasMark && pos.entry > 0
            ? (long ? markPrice - pos.entry : pos.entry - markPrice) / pos.entry * 100
            : 0;
        var atEnd = closeAtEnd > 0;
        var state = 'open';
        if (closeAtEnd > 0) {
            if (long ? closeAtEnd >= pos.tp : closeAtEnd <= pos.tp) state = 'target';
            else if (long ? closeAtEnd <= pos.sl : closeAtEnd >= pos.sl) state = 'stop';
        }

        return {
            dir: pos.dir,
            long: long,
            precision: precision,
            tickSize: tickSize,
            entry: pos.entry,
            tp: pos.tp,
            sl: pos.sl,
            riskPerUnit: riskPerUnit,
            rewardPerUnit: rewardPerUnit,
            rr: rr,
            riskPct: riskPct,
            rewardPct: rewardPct,
            // Signed price moves from entry, the way the level tags read.
            tpMovePct: long ? rewardPct : -rewardPct,
            slMovePct: long ? -riskPct : riskPct,
            tpTicks: tpTicks,
            slTicks: slTicks,
            tpMoveTicks: long ? tpTicks : -tpTicks,
            slMoveTicks: long ? -slTicks : slTicks,
            acct: s.acct,
            leverage: s.lev,
            lotSize: lotSize,
            qtyPrecision: s.qtyPrecision,
            riskAmount: budget.riskAmount,
            qtyRisk: qtyRisk,
            qtyLvg: qtyLvg,
            qty: qty,
            units: units,
            notional: notional,
            margin: margin,
            risk: risk,
            reward: reward,
            balanceAtTp: balanceAtTp,
            balanceAtSl: balanceAtSl,
            markPrice: hasMark ? markPrice : 0,
            atEnd: atEnd,
            openPnl: openPnl,
            openPct: openPct,
            balanceNow: s.acct + openPnl,
            state: state,
            // Why the quantity is what it is, so the UI can explain a cap.
            capped: qtyLvg < qtyRisk ? 'leverage' : 'risk'
        };
    }

    /* ── Formatting ─────────────────────────────────────────────────────── */

    function groupDigits(text) {
        var parts = text.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    function formatNumber(value, dp) {
        if (!isNum(value)) return '—';
        var places = dp == null ? 2 : dp;
        var scale = Math.pow(10, places);
        var rounded = Math.round(value * scale) / scale;
        if (Math.abs(rounded) < 0.5 / scale) rounded = 0;
        return groupDigits(rounded.toFixed(places));
    }

    function formatMoney(value, dp) {
        if (!isNum(value)) return '—';
        return formatNumber(value, dp == null ? 2 : dp);
    }

    function formatQty(value, precision) {
        if (!isNum(value)) return '—';
        var places = clamp(Math.round(num(precision, 4)), 0, 8);
        return formatNumber(value, places);
    }

    function formatPct(value, dp) {
        if (!isNum(value)) return '—';
        var places = dp == null ? 2 : dp;
        var rounded = Math.round(value * Math.pow(10, places)) / Math.pow(10, places);
        if (Math.abs(rounded) < 0.5 / Math.pow(10, places)) rounded = 0;
        return (rounded > 0 ? '+' : '') + rounded.toFixed(places) + '%';
    }

    function formatTicks(value) {
        if (!isNum(value)) return '—';
        var rounded = Math.round(value);
        return (rounded > 0 ? '+' : '') + groupDigits(String(rounded)) + ' ticks';
    }

    function compactNumber(value) {
        if (!isNum(value)) return '—';
        var abs = Math.abs(value);
        var sign = value < 0 ? '-' : '';
        if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return sign + (abs / 1e3).toFixed(2) + 'K';
        return sign + abs.toFixed(2);
    }

    function rrLabel(rr) {
        if (!isNum(rr) || rr <= 0) return '—';
        return '1 : ' + (rr >= 100 ? rr.toFixed(0) : rr.toFixed(2));
    }

    /** Rows for the selected-position stats panel (TradingView metric set). */
    function statsRows(m) {
        if (!m) return [];
        return [
            { label: 'Quantity', value: formatQty(m.qty, m.qtyPrecision) + ' @ ' + formatMoney(m.entry, m.precision), tone: 'dir' },
            { label: 'R/R', value: rrLabel(m.rr), tone: 'text' },
            { label: 'Target', value: formatMoney(m.tp, m.precision) + ' · ' + formatPct(m.tpMovePct) + ' · ' + formatTicks(m.tpMoveTicks), tone: 'up' },
            { label: 'Stop', value: formatMoney(m.sl, m.precision) + ' · ' + formatPct(m.slMovePct) + ' · ' + formatTicks(m.slMoveTicks), tone: 'down' },
            { label: 'Risk', value: formatMoney(m.risk) + ' · ' + formatPct(-m.riskPct), tone: 'down' },
            { label: 'Reward', value: formatMoney(m.reward) + ' · ' + formatPct(m.rewardPct), tone: 'up' },
            { label: 'Balance @ TP', value: formatMoney(m.balanceAtTp), tone: 'up' },
            { label: 'Balance @ SL', value: formatMoney(m.balanceAtSl), tone: 'down' },
            { label: m.atEnd ? 'PnL at right edge' : 'Open PnL', value: formatMoney(m.openPnl) + ' · ' + formatPct(m.openPct), tone: m.openPnl >= 0 ? 'up' : 'down' }
        ];
    }

    /** Single-line summary used by compact mode and the placement preview. */
    function compactSummary(m) {
        if (!m) return '';
        return rrLabel(m.rr) + '  ·  Qty ' + formatQty(m.qty, m.qtyPrecision) +
            '  ·  ' + formatMoney(m.reward) + ' / −' + formatMoney(m.risk);
    }

    return {
        DEFAULTS: DEFAULTS,
        LIMITS: LIMITS,
        normalizeSettings: normalizeSettings,
        normalizePosition: normalizePosition,
        mirrorStop: mirrorStop,
        riskBudget: riskBudget,
        compute: compute,
        statsRows: statsRows,
        compactSummary: compactSummary,
        rrLabel: rrLabel,
        formatNumber: formatNumber,
        formatMoney: formatMoney,
        formatQty: formatQty,
        formatPct: formatPct,
        formatTicks: formatTicks,
        compactNumber: compactNumber
    };
});
