/* ═══════════════════════════════════════════════════════════════════════════
 * TradePanelReplay — bar replay cursor + paper-trade (backtest) ledger
 *
 * Pure logic: no DOM, no chart API. The workspace feeds it bar closes and
 * renders the returned state; every formula is unit-testable in Node.
 *
 * Paper trading model (deliberately simple and honest):
 *   • full-notional entries (no leverage, no pyramiding)
 *   • 0.1 % fee per side
 *   • market fill at the current replay bar's close
 *   • equity = realised cash + unrealised PnL of the open position
 * The replay bar shows the live mark-to-market equity; the ledger records
 * closed trades only, with the entry fee folded into `pnl`.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TradePanelReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = 1;
    var INITIAL_BALANCE = 10000;
    var FEE_RATE = 0.001;
    var MAX_BARS = 3000;
    var MAX_TRADES = 500;

    // delay = milliseconds between automatic steps
    var SPEEDS = [
        { id: '10', label: '10×', delay: 100 },
        { id: '5', label: '5×', delay: 200 },
        { id: '2', label: '2×', delay: 500 },
        { id: '1', label: '1×', delay: 1000 },
        { id: '0.5', label: '0.5×', delay: 2000 },
        { id: '0.2', label: '0.2×', delay: 5000 }
    ];

    function clamp(value, lo, hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && isFinite(value);
    }

    function speedById(id) {
        for (var i = 0; i < SPEEDS.length; i++) {
            if (SPEEDS[i].id === id) return SPEEDS[i];
        }
        return SPEEDS[3];
    }

    function delayFor(id) {
        return speedById(id).delay;
    }

    /** Index of the last candle at or before `time`; -1 when none. */
    function indexAtTime(candles, time) {
        if (!Array.isArray(candles) || !candles.length || !isFiniteNumber(time)) return -1;
        var lo = 0, hi = candles.length - 1, best = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (candles[mid].time <= time) { best = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return best;
    }

    /** Default cursor: leave ~30 % of the loaded window for replay. */
    function defaultStartIndex(length, fraction) {
        if (!isFiniteNumber(length) || length < 3) return -1;
        var f = isFiniteNumber(fraction) ? clamp(fraction, 0.1, 0.95) : 0.7;
        return clamp(Math.floor((length - 1) * f), 1, length - 2);
    }

    function sliceTo(candles, index) {
        if (!Array.isArray(candles)) return [];
        return candles.slice(0, clamp(index + 1, 0, candles.length));
    }

    function createSession(balance) {
        var start = isFiniteNumber(balance) && balance > 0 ? balance : INITIAL_BALANCE;
        return {
            initial: start,
            equity: start,
            position: null,
            trades: []
        };
    }

    function sideLabel(side) {
        return side === 'short' ? 'Short' : 'Long';
    }

    /** Open a full-notional paper position at `price`. */
    function open(state, side, price, time) {
        if (!state) return { ok: false, error: 'No replay session.' };
        if (state.position) return { ok: false, error: 'Close the open position first.' };
        if (side !== 'long' && side !== 'short') return { ok: false, error: 'Unknown side.' };
        if (!isFiniteNumber(price) || price <= 0) return { ok: false, error: 'No tradable price.' };
        var equityBefore = state.equity;
        if (!(equityBefore > 0)) return { ok: false, error: 'Equity is exhausted.' };
        var entryFee = equityBefore * FEE_RATE;
        var notional = equityBefore - entryFee;
        var qty = notional / price;
        return {
            ok: true,
            state: {
                initial: state.initial,
                equity: notional,
                position: {
                    side: side,
                    qty: qty,
                    entry: price,
                    time: isFiniteNumber(time) ? time : 0,
                    notional: notional,
                    entryFee: entryFee,
                    equityBefore: equityBefore
                },
                trades: state.trades.slice()
            }
        };
    }

    /** Close the open position at `price` and append the trade to the ledger. */
    function close(state, price, time) {
        if (!state) return { ok: false, error: 'No replay session.' };
        var position = state.position;
        if (!position) return { ok: false, error: 'No open position.' };
        if (!isFiniteNumber(price) || price <= 0) return { ok: false, error: 'No tradable price.' };
        var dir = position.side === 'short' ? -1 : 1;
        var gross = position.qty * (price - position.entry) * dir;
        var exitFee = position.qty * price * FEE_RATE;
        var equityAfter = state.equity + gross - exitFee;
        var pnl = equityAfter - position.equityBefore;
        var trade = {
            side: position.side,
            entry: position.entry,
            exit: price,
            qty: position.qty,
            notional: position.notional,
            fees: position.entryFee + exitFee,
            pnl: pnl,
            pct: position.equityBefore ? (pnl / position.equityBefore) * 100 : 0,
            entryTime: position.time,
            exitTime: isFiniteNumber(time) ? time : 0,
            equityBefore: position.equityBefore,
            equityAfter: equityAfter
        };
        var trades = state.trades.concat([trade]);
        if (trades.length > MAX_TRADES) trades = trades.slice(trades.length - MAX_TRADES);
        return {
            ok: true,
            trade: trade,
            state: {
                initial: state.initial,
                equity: equityAfter,
                position: null,
                trades: trades
            }
        };
    }

    /** Mark-to-market snapshot for an open position. */
    function mark(state, price) {
        if (!state) return { equity: 0, pnl: 0, pnlPct: 0, open: false };
        var position = state.position;
        if (!position || !isFiniteNumber(price)) {
            return { equity: state.equity, pnl: 0, pnlPct: 0, open: false };
        }
        var dir = position.side === 'short' ? -1 : 1;
        var unrealised = position.qty * (price - position.entry) * dir;
        var equity = state.equity + unrealised;
        var pnl = equity - position.equityBefore;
        return {
            equity: equity,
            pnl: pnl,
            pnlPct: position.equityBefore ? (pnl / position.equityBefore) * 100 : 0,
            open: true,
            side: position.side,
            entry: position.entry,
            qty: position.qty
        };
    }

    /** Aggregate a closed-trade ledger. */
    function stats(trades, initial) {
        var start = isFiniteNumber(initial) && initial > 0 ? initial : INITIAL_BALANCE;
        var list = Array.isArray(trades) ? trades : [];
        var wins = 0, losses = 0, flat = 0, grossWin = 0, grossLoss = 0;
        var totalPnl = 0, best = null, worst = null;
        var peak = start, maxDd = 0, equity = start;
        for (var i = 0; i < list.length; i++) {
            var trade = list[i];
            var pnl = isFiniteNumber(trade.pnl) ? trade.pnl : 0;
            totalPnl += pnl;
            if (pnl > 0) { wins += 1; grossWin += pnl; }
            else if (pnl < 0) { losses += 1; grossLoss += Math.abs(pnl); }
            else flat += 1;
            if (!best || pnl > best.pnl) best = trade;
            if (!worst || pnl < worst.pnl) worst = trade;
            equity = isFiniteNumber(trade.equityAfter) ? trade.equityAfter : equity + pnl;
            if (equity > peak) peak = equity;
            var dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
            if (dd > maxDd) maxDd = dd;
        }
        var count = list.length;
        return {
            count: count,
            wins: wins,
            losses: losses,
            flat: flat,
            winRate: count ? (wins / count) * 100 : 0,
            totalPnl: totalPnl,
            totalReturnPct: start ? (totalPnl / start) * 100 : 0,
            endEquity: equity,
            maxDrawdownPct: maxDd,
            profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
            best: best,
            worst: worst
        };
    }

    function formatMoney(value, decimals) {
        if (!isFiniteNumber(value)) return '—';
        var p = isFiniteNumber(decimals) ? clamp(Math.round(decimals), 0, 8) : 2;
        var parts = value.toFixed(p).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    function formatPct(value, decimals) {
        if (!isFiniteNumber(value)) return '—';
        var p = isFiniteNumber(decimals) ? clamp(Math.round(decimals), 0, 4) : 2;
        return (value > 0 ? '+' : '') + value.toFixed(p) + '%';
    }

    /** Compact UTC stamp for the replay bar (seconds). */
    function timeLabel(seconds) {
        if (!isFiniteNumber(seconds) || seconds <= 0) return '—';
        return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }

    return {
        VERSION: VERSION,
        INITIAL_BALANCE: INITIAL_BALANCE,
        FEE_RATE: FEE_RATE,
        MAX_BARS: MAX_BARS,
        MAX_TRADES: MAX_TRADES,
        SPEEDS: SPEEDS,
        speedById: speedById,
        delayFor: delayFor,
        indexAtTime: indexAtTime,
        defaultStartIndex: defaultStartIndex,
        sliceTo: sliceTo,
        createSession: createSession,
        sideLabel: sideLabel,
        open: open,
        close: close,
        mark: mark,
        stats: stats,
        formatMoney: formatMoney,
        formatPct: formatPct,
        timeLabel: timeLabel
    };
});
