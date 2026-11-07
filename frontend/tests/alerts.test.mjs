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

function indicatorRule(overrides) {
    return A.normalizeAlert(Object.assign({
        id: 'a-9', source: 'indicator', exchange: 'binance', market: 'spot',
        symbol: 'btc/usdt', timeframe: '5m',
        chartId: 'c1', indicatorId: 'supertrend', indicatorIndex: 2,
        indicatorInputs: { factor: 3, atrPeriod: 10 },
        conditionId: 'alert0', conditionTitle: 'Downtrend to Uptrend',
        indicatorName: 'Supertrend', indicatorMessage: 'The Supertrend value switched',
        frequency: 'repeating', enabled: true, note: '  watch  ', createdAt: 1700000000000
    }, overrides));
}

test('normalizes an indicator alert rule', () => {
    const r = indicatorRule();
    assert.equal(r.source, 'indicator');
    assert.equal(r.symbol, 'BTC/USDT');
    assert.equal(r.price, null);
    assert.equal(r.condition, 'indicator');
    assert.equal(r.chartId, 'c1');
    assert.equal(r.indicatorId, 'supertrend');
    assert.equal(r.indicatorIndex, 2);
    assert.deepEqual({ ...r.indicatorInputs }, { factor: 3, atrPeriod: 10 });
    assert.equal(r.conditionId, 'alert0');
    assert.equal(r.conditionTitle, 'Downtrend to Uptrend');
    assert.equal(r.indicatorName, 'Supertrend');
    assert.equal(r.frequency, 'repeating');
    assert.equal(r.note, 'watch');
});

test('indicator rules require a chart, study and condition', () => {
    assert.equal(indicatorRule({ chartId: '' }), null);
    assert.equal(indicatorRule({ chartId: 'bad id!' }), null);
    assert.equal(indicatorRule({ indicatorId: '' }), null);
    assert.equal(indicatorRule({ conditionId: '' }), null);
    const call = indicatorRule({ conditionId: A.INDICATOR_CALL, conditionTitle: '' });
    assert.equal(call.conditionId, 'alert-call');
    assert.equal(call.conditionTitle, 'alert-call');
    const clamped = indicatorRule({ indicatorIndex: -5 });
    assert.equal(clamped.indicatorIndex, 0);
});

test('indicator rules never evaluate from a price sample', () => {
    const r = indicatorRule();
    assert.equal(A.evaluate(r, 99, 101, false).fire, false);
    assert.equal(A.evaluate(r, 101, 99, false).fire, false);
    assert.equal(A.distancePercent(r, 110), null);
});

test('indicator descriptions and messages', () => {
    const r = indicatorRule();
    assert.equal(A.describe(r, 2), 'Downtrend to Uptrend');
    assert.equal(
        A.message(r, null, 2),
        'BTC/USDT · Supertrend · Downtrend to Uptrend — watch',
    );
    assert.equal(
        A.renderPlaceholders('{{exchange}}:{{ticker}} close {{ close }}', {
            exchange: 'binance', ticker: 'BTC/USDT', close: 101.5,
        }),
        'binance:BTC/USDT close 101.5',
    );
    assert.equal(A.renderPlaceholders('{{missing}}', {}), '');
    assert.equal(A.renderPlaceholders('plain', null), 'plain');
});

test('a mixed alert list keeps both kinds', () => {
    const out = A.normalizeAlerts([indicatorRule(), rule({ id: 'a-2' })]);
    assert.equal(out.length, 2);
    assert.equal(out[0].source, 'indicator');
    assert.equal(out[1].source, 'price');
});

test('log entries always carry the message shown by the shell', () => {
    const price = A.logEntry(rule(), 101.5, 2, 'BTC/USDT crossing 100.00', 'live', 1700000000000);
    assert.equal(price.message, 'BTC/USDT crossing 100.00');
    assert.equal(price.alertId, 'a-1');
    assert.equal(price.symbol, 'BTC/USDT');
    assert.equal(price.level, 100);
    assert.equal(price.condition, 'crossing');
    assert.equal(price.price, 101.5);
    assert.equal(price.source, 'live');
    assert.equal(price.time, 1700000000000);

    const study = A.logEntry(indicatorRule(), null, 2, 'BTC/USDT · Supertrend · Buy', 'replay', 1700000000000);
    assert.equal(study.message, 'BTC/USDT · Supertrend · Buy');
    assert.equal(study.level, null);
    assert.equal(study.condition, 'alert0');
    assert.equal(study.price, null);
    assert.equal(study.source, 'replay');

    assert.equal(A.logEntry(null, NaN, NaN, '', null, NaN).message, 'Alert triggered');
    assert.equal(A.logEntry(null, NaN, NaN, '', null, NaN).price, null);
});

test('indicator signals arm at the newest bar and never replay history', () => {
    const signals = [
        { time: 300, message: 'c' },
        { time: 100, message: 'a' },
        { time: 200, message: 'b' },
        { time: 'x', message: 'junk' },
        null,
    ];
    const armed = A.indicatorSignals(signals, 0);
    assert.equal(armed.baseline, 300);
    assert.deepEqual(armed.fresh, []);

    const next = A.indicatorSignals(signals, 150);
    assert.equal(next.baseline, 300);
    assert.deepEqual(next.fresh.map((s) => [s.time, s.message]), [[200, 'b'], [300, 'c']]);

    const current = A.indicatorSignals(signals, 300);
    assert.equal(current.baseline, 300);
    assert.deepEqual(current.fresh, []);

    const ahead = A.indicatorSignals(signals, 400);
    assert.equal(ahead.baseline, 400);
    assert.deepEqual(ahead.fresh, []);

    const empty = A.indicatorSignals([], 250);
    assert.equal(empty.baseline, 250);
    assert.deepEqual(empty.fresh, []);
    assert.equal(A.indicatorSignals(null, 0).baseline, 0);
});
