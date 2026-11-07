/**
 * Cursor helpers + paper-trade ledger math for frontend/web/replay.js.
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

const R = loadClassic('replay.js');

function candles(n, step = 300) {
    return Array.from({ length: n }, (_, i) => ({ time: 1000 + i * step, close: 100 + i }));
}

test('indexAtTime finds the last bar at or before a time', () => {
    const bars = candles(10);
    assert.equal(R.indexAtTime(bars, bars[0].time), 0);
    assert.equal(R.indexAtTime(bars, bars[4].time + 1), 4);
    assert.equal(R.indexAtTime(bars, 0), -1);
    assert.equal(R.indexAtTime(bars, bars[9].time + 10), 9);
    assert.equal(R.indexAtTime([], 100), -1);
});

test('defaultStartIndex leaves room for replay and never hits the edges', () => {
    assert.equal(R.defaultStartIndex(100), 69);
    assert.equal(R.defaultStartIndex(3), 1);
    assert.equal(R.defaultStartIndex(2), -1);
    assert.equal(R.defaultStartIndex(0), -1);
    assert.equal(R.defaultStartIndex(100, 0.05), 9);
    assert.equal(R.defaultStartIndex(100, 0.99), 94);
});

test('sliceTo truncates inclusively', () => {
    const bars = candles(5);
    assert.equal(R.sliceTo(bars, 0).length, 1);
    assert.equal(R.sliceTo(bars, 2).length, 3);
    assert.equal(R.sliceTo(bars, 99).length, 5);
    assert.equal(R.sliceTo(bars, -1).length, 0);
});

test('long paper trade charges 0.1% per side', () => {
    let s = R.createSession(10000);
    const opened = R.open(s, 'long', 100, 1000);
    assert.equal(opened.ok, true);
    s = opened.state;
    assert.equal(s.equity, 9990);            // 10 entry fee
    assert.equal(s.position.qty, 99.9);
    const closed = R.close(s, 110, 2000);
    assert.equal(closed.ok, true);
    assert.ok(Math.abs(closed.state.equity - 10978.011) < 1e-9);
    assert.ok(Math.abs(closed.trade.pnl - 978.011) < 1e-9);
    assert.ok(Math.abs(closed.trade.pct - 9.78011) < 1e-6);
    assert.equal(closed.trade.fees > 20, true);
    assert.equal(closed.state.position, null);
});

test('short paper trade profits when price falls', () => {
    let s = R.open(R.createSession(10000), 'short', 100, 1000).state;
    const closed = R.close(s, 90, 2000);
    assert.ok(Math.abs(closed.state.equity - 10980.009) < 1e-9);
    assert.ok(Math.abs(closed.trade.pnl - 980.009) < 1e-9);
});

test('guards: no pyramiding, no close without a position, bad prices', () => {
    const s = R.createSession();
    assert.equal(R.open(s, 'long', 0, 1).ok, false);
    assert.equal(R.open(s, 'nope', 100, 1).ok, false);
    assert.equal(R.close(s, 100, 1).ok, false);
    const once = R.open(s, 'long', 100, 1).state;
    assert.equal(R.open(once, 'short', 101, 2).ok, false);
    assert.equal(R.close(once, 0, 2).ok, false);
});

test('mark to market reports floating PnL and equity', () => {
    const s = R.open(R.createSession(10000), 'long', 100, 1000).state;
    const m = R.mark(s, 105);
    assert.equal(m.open, true);
    assert.equal(m.side, 'long');
    assert.ok(Math.abs(m.equity - (9990 + 99.9 * 5)) < 1e-9);
    assert.ok(Math.abs(m.pnl - (99.9 * 5 - 10)) < 1e-9);
    assert.equal(R.mark(R.createSession(), 100).open, false);
    assert.equal(R.mark(s, NaN).equity, s.equity);
});

test('ledger stats: wins, drawdown, profit factor', () => {
    const trades = [
        { pnl: 1000, equityAfter: 11000 },
        { pnl: -500, equityAfter: 10500 },
        { pnl: -1000, equityAfter: 9500 }
    ];
    const s = R.stats(trades, 10000);
    assert.equal(s.count, 3);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 2);
    assert.equal(s.flat, 0);
    assert.ok(Math.abs(s.winRate - 33.333333) < 1e-4);
    assert.equal(s.totalPnl, -500);
    assert.equal(s.endEquity, 9500);
    assert.ok(Math.abs(s.totalReturnPct + 5) < 1e-9);
    assert.ok(Math.abs(s.maxDrawdownPct - (1500 / 11000) * 100) < 1e-9);
    assert.ok(Math.abs(s.profitFactor - 1000 / 1500) < 1e-9);
    assert.equal(s.best.pnl, 1000);
    assert.equal(s.worst.pnl, -1000);
});

test('empty ledger and formatting', () => {
    const s = R.stats([], 10000);
    assert.equal(s.count, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.profitFactor, 0);
    assert.equal(s.endEquity, 10000);
    assert.equal(R.formatMoney(1234.5), '1,234.50');
    assert.equal(R.formatMoney(0.0000123, 6), '0.000012');
    assert.equal(R.formatPct(1.234), '+1.23%');
    assert.equal(R.formatPct(-1.234), '-1.23%');
    assert.equal(R.timeLabel(0), '—');
    assert.equal(R.timeLabel(1700000000), '2023-11-14 22:13 UTC');
    assert.equal(R.delayFor('2'), 500);
    assert.equal(R.speedById('nope').id, '1');
    assert.equal(R.sideLabel('short'), 'Short');
});
