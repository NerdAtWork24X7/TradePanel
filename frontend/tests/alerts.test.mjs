/**
 * Rule validation + crossing semantics for frontend/web/alerts.js.
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

const A = loadClassic('alerts.js');

function rule(overrides) {
    return A.normalizeAlert(Object.assign({
        id: 'a-1', exchange: 'binance', market: 'spot', symbol: 'btc/usdt',
        timeframe: '5m',
        price: 100, condition: 'crossing', frequency: 'once', enabled: true,
        note: '  breakout  ', createdAt: 1700000000000
    }, overrides));
}

test('normalizes and clamps a rule', () => {
    const r = rule();
    assert.equal(r.symbol, 'BTC/USDT');
    assert.equal(r.exchange, 'binance');
    assert.equal(r.market, 'spot');
    assert.equal(r.timeframe, '5m');
    assert.equal(r.note, 'breakout');
    assert.equal(r.condition, 'crossing');
    assert.equal(r.frequency, 'once');
    assert.equal(r.enabled, true);
    assert.equal(r.createdAt, 1700000000000);
});

test('drops unusable rules and falls back for bad enums', () => {
    assert.equal(A.normalizeAlert(null), null);
    assert.equal(A.normalizeAlert({ symbol: 'BTC/USDT', price: 0 }), null);
    assert.equal(A.normalizeAlert({ symbol: 'BTC/USDT', price: 'x' }), null);
    assert.equal(A.normalizeAlert({ symbol: '', price: 100 }), null);
    const r = rule({ condition: 'nope', frequency: 'sometimes', enabled: 'yes' });
    assert.equal(r.condition, 'crossing');
    assert.equal(r.frequency, 'once');
    assert.equal(r.enabled, true);
});

test('normalizeAlerts dedupes ids and caps the list', () => {
    const list = [];
    for (let i = 0; i < 250; i++) {
        list.push({ id: `a-${i}`, symbol: 'BTC/USDT', price: 100 + i });
    }
    list.push({ id: 'a-5', symbol: 'ETH/USDT', price: 200 });
    const out = A.normalizeAlerts(list);
    assert.equal(out.length, A.MAX_ALERTS);
    assert.equal(out.filter((a) => a.id === 'a-5').length, 1);
    assert.equal(out[5].symbol, 'BTC/USDT');
    assert.deepEqual(A.normalizeAlerts('junk'), []);
});

test('crossing fires on both directions, once per sign change', () => {
    const r = rule({ condition: 'crossing' });
    assert.equal(A.evaluate(r, null, 100.5, false).fire, false, 'baseline never fires');
    assert.equal(A.evaluate(r, 99, 101, false).fire, true, 'cross up');
    assert.equal(A.evaluate(r, 101, 102, false).fire, false, 'still above');
    assert.equal(A.evaluate(r, 101, 99, false).fire, true, 'cross down');
    assert.equal(A.evaluate(r, 100, 100, false).fire, false, 'touching is not crossing');
});

test('crossing-up and crossing-down are directional', () => {
    const up = rule({ condition: 'crossing-up' });
    const down = rule({ condition: 'crossing-down' });
    assert.equal(A.evaluate(up, 99, 101, false).fire, true);
    assert.equal(A.evaluate(up, 101, 99, false).fire, false);
    assert.equal(A.evaluate(down, 101, 99, false).fire, true);
    assert.equal(A.evaluate(down, 99, 101, false).fire, false);
});

test('greater / less are edge-triggered state checks', () => {
    const greater = rule({ condition: 'greater' });
    const less = rule({ condition: 'less' });
    const g1 = A.evaluate(greater, 99, 101, false);
    assert.equal(g1.fire, true);
    assert.equal(g1.trueState, true);
    assert.equal(A.evaluate(greater, 101, 102, g1.trueState).fire, false);
    assert.equal(A.evaluate(greater, 99, 101, false).fire, true, 're-arms after leaving');

    const l1 = A.evaluate(less, 101, 99, false);
    assert.equal(l1.fire, true);
    assert.equal(l1.trueState, true);
    assert.equal(A.evaluate(less, 99, 98, l1.trueState).fire, false);
});

test('initial state suppresses an immediate level-check fire', () => {
    const greater = rule({ condition: 'greater' });
    const less = rule({ condition: 'less' });
    assert.equal(A.initialState(greater, 101), true);
    assert.equal(A.initialState(greater, 99), false);
    assert.equal(A.initialState(less, 99), true);
    assert.equal(A.initialState(less, 101), false);
    assert.equal(A.initialState(greater, null), false);
});

test('disabled rules never fire and invalid prices are ignored', () => {
    const r = rule({ enabled: false });
    assert.equal(A.evaluate(r, 99, 101, false).fire, false);
    assert.equal(A.evaluate(rule(), null, NaN, false).fire, false);
    assert.equal(A.evaluate(rule(), 99, Infinity, false).fire, false);
});

test('keys, matching and descriptions', () => {
    const r = rule();
    assert.equal(A.alertKey(r), 'binance|spot|BTC/USDT');
    assert.equal(A.matches(r, { exchange: 'BINANCE', market: 'Spot', symbol: 'btc/usdt' }), true);
    assert.equal(A.matches(r, { exchange: 'bybit', market: 'spot', symbol: 'BTC/USDT' }), false);
    assert.equal(A.describe(r, 2), 'crossing 100.00');
    assert.equal(A.describe(rule({ condition: 'crossing-up' }), 1), 'crossing up 100.0');
    assert.equal(A.message(r, 101, 2), 'BTC/USDT crossing 100.00 — breakout');
    assert.equal(A.formatPrice(1234567.891, 2), '1,234,567.89');
});

test('distance and frequency labels', () => {
    assert.ok(Math.abs(A.distancePercent(rule(), 110) - 10) < 1e-9);
    assert.ok(Math.abs(A.distancePercent(rule(), 90) + 10) < 1e-9);
    assert.equal(A.distancePercent(rule(), null), null);
    assert.equal(A.frequencyLabel('repeating'), 'Every time');
    assert.equal(A.frequencyLabel('nope'), 'Once');
    assert.equal(A.condition('crossing-down').label, 'Crossing down');
});
