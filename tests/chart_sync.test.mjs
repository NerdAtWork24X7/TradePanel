/**
 * Unit tests for frontend/web/chart_sync.js — run with `node --test tests/`.
 * Charts are mocks: no DOM, no Lightweight Charts, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// `frontend/web` sits inside an ESM package ("type": "module"), so require()
// would treat this classic UMD script as ESM. Evaluate it the way a CommonJS
// loader would — wrapped in (module, exports) — but in this realm so object
// literals still satisfy deepStrictEqual.
const source = fs.readFileSync(new URL('../frontend/web/chart_sync.js', import.meta.url), 'utf8');
const factory = vm.runInThisContext(`(function (module, exports) {\n${source}\n})`, {
    filename: 'chart_sync.js',
});
const chartSyncModule = { exports: {} };
factory(chartSyncModule, chartSyncModule.exports);
const { ChartSyncManager, findNearestCandle } = chartSyncModule.exports;

const M5 = 300;
const H1 = 3600;
const T0 = 1_700_000_000; // aligned to 5m? 1700000000 % 300 = 200 → not aligned; use aligned base
const BASE = T0 - (T0 % H1);

function series(times, base = 100, step = 1) {
    return times.map((time, i) => ({
        time,
        open: base + i * step,
        high: base + i * step + 2,
        low: base + i * step - 2,
        close: base + i * step + 1,
        volume: 10 + i,
    }));
}

function candles5m(count = 100, base = 100) {
    const times = [];
    for (let i = 0; i < count; i++) times.push(BASE + i * M5);
    return series(times, base, 1);
}

function candles1h(count = 40, base = 5000) {
    const times = [];
    for (let i = 0; i < count; i++) times.push(BASE + i * H1);
    return series(times, base, 10);
}

function makeChart(initialRange = null) {
    const listeners = { crosshair: [], range: [] };
    const state = {
        crosshair: null,
        calls: [],
        visibleRange: initialRange || { from: BASE, to: BASE + 3600 },
        logical: { from: 0, to: 100 },
    };
    const timeScale = {
        subscribeVisibleTimeRangeChange(fn) { listeners.range.push(fn); },
        unsubscribeVisibleTimeRangeChange(fn) {
            const i = listeners.range.indexOf(fn);
            if (i >= 0) listeners.range.splice(i, 1);
        },
        getVisibleRange: () => ({ ...state.visibleRange }),
        setVisibleRange(range) {
            state.visibleRange = { from: range.from, to: range.to };
            state.calls.push({ op: 'setVisibleRange', range });
            listeners.range.slice().forEach((fn) => fn({ ...state.visibleRange }));
        },
        getVisibleLogicalRange: () => ({ ...state.logical }),
        setVisibleLogicalRange(range) {
            state.logical = { from: range.from, to: range.to };
            listeners.range.slice().forEach((fn) => fn({ ...state.visibleRange }));
        },
        coordinateToTime: () => null,
    };
    const chart = {
        timeScale: () => timeScale,
        subscribeCrosshairMove(fn) { listeners.crosshair.push(fn); },
        unsubscribeCrosshairMove(fn) {
            const i = listeners.crosshair.indexOf(fn);
            if (i >= 0) listeners.crosshair.splice(i, 1);
        },
        setCrosshairPosition(price, time, s) {
            state.crosshair = { price, time };
            state.calls.push({ op: 'setCrosshair', price, time });
        },
        clearCrosshairPosition() {
            state.crosshair = null;
            state.calls.push({ op: 'clearCrosshair' });
        },
    };
    return {
        chart,
        state,
        listeners,
        emitCrosshair(param) { listeners.crosshair.slice().forEach((fn) => fn(param)); },
        emitRange(range) { listeners.range.slice().forEach((fn) => fn(range)); },
    };
}

const RED = {
    id: 'g-red', name: 'BTC', color: '#FF5A3C', enabled: true,
    settings: { crosshair: true, timeRange: true, horizontalScroll: true, zoom: true, timeframe: false },
};
const BLUE = {
    id: 'g-blue', name: 'Alts', color: '#2962FF', enabled: true,
    settings: { crosshair: true, timeRange: true, horizontalScroll: true, zoom: true, timeframe: false },
};

function makeManager(extra) {
    return new ChartSyncManager({
        groups: [RED, BLUE],
        chartGroups: { a: 'g-red', b: 'g-red' },
        ...extra,
    });
}

function register(mgr, id, data, opts = {}) {
    const mock = makeChart(opts.range);
    const reg = {
        chartId: id,
        chart: mock.chart,
        mainSeries: { id },
        barSeconds: opts.barSeconds || 300,
        timeframe: opts.timeframe || '5m',
        getDataAtTime(time) { return data.find((c) => c.time === time); },
        getNearestDataAtTime(time, o) {
            return findNearestCandle(data, time, (o && o.policy) || 'closest',
                o ? o.maxDriftSeconds : null);
        },
        getVisiblePriceRange() {
            return opts.priceRange || null;
        },
        applyAbsoluteRange(range) {
            mock.state.calls.push({ op: 'absolute', range });
        },
        getInstrument() {
            return opts.instrument || { base: 'BTC', quote: 'USDT', lastPrice: 100 };
        },
    };
    mgr.register(reg);
    return { mock, reg };
}

/* ── nearest candle ─────────────────────────────────────────────────────── */

test('findNearestCandle: policies and drift cap', () => {
    const data = candles5m(10);
    assert.equal(findNearestCandle(data, data[3].time + 60, 'closest').time, data[3].time);
    assert.equal(findNearestCandle(data, data[3].time + 60, 'previous').time, data[3].time);
    assert.equal(findNearestCandle(data, data[3].time + 60, 'next').time, data[4].time);
    assert.equal(findNearestCandle(data, data[3].time + 60, 'none'), undefined);
    assert.equal(findNearestCandle(data, data[3].time, 'none').time, data[3].time);
    assert.equal(findNearestCandle(data, data[9].time + 5000, 'next'), undefined);
    assert.equal(findNearestCandle(data, data[3].time + 150, 'closest', 100), undefined);
    assert.equal(findNearestCandle(data, data[3].time + 150, 'closest', 300).time, data[3].time);
    assert.equal(findNearestCandle(data, 0, 'previous'), undefined);
    assert.equal(findNearestCandle([], 100, 'closest'), undefined);
});

/* ── crosshair ──────────────────────────────────────────────────────────── */

test('crosshair: same symbol syncs timestamp and uses destination price', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(50, 100));
    const b = register(mgr, 'b', candles5m(50, 200));
    const t = a.reg.getNearestDataAtTime(a.reg.getVisiblePriceRange ? BASE + 10 * M5 : 0).time;

    a.mock.emitCrosshair({ time: t, point: { x: 1, y: 2 } });
    mgr.flushPending();

    const target = b.mock.state.crosshair;
    assert.ok(target, 'destination crosshair set');
    assert.equal(target.time, t);
    const destCandle = b.reg.getDataAtTime(t);
    assert.equal(target.price, destCandle.close);
    assert.notEqual(target.price, a.reg.getDataAtTime(t).close,
        'destination price comes from its own market data');
});

test('crosshair: different symbols use their own price (never source price)', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-red' } });
    const a = register(mgr, 'a', candles5m(30, 100), { instrument: { quote: 'USDT', lastPrice: 100 } });
    const b = register(mgr, 'b', candles5m(30, 9000), { instrument: { quote: 'USDT', lastPrice: 9000 } });
    const t = BASE + 5 * M5;
    a.mock.emitCrosshair({ time: t });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair.price, b.reg.getDataAtTime(t).close);
    assert.ok(b.mock.state.crosshair.price > 8000);
});

test('crosshair: different timeframes map to nearest bar of the destination', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(100, 100), { barSeconds: M5, timeframe: '5m' });
    const b = register(mgr, 'b', candles1h(10, 5000), { barSeconds: H1, timeframe: '1h' });
    const t = BASE + 3 * H1 + 7 * M5;            // 12:35 inside the 4th hourly bar
    a.mock.emitCrosshair({ time: t });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair.time, BASE + 3 * H1);
    const dest = b.reg.getDataAtTime(BASE + 3 * H1);
    assert.equal(b.mock.state.crosshair.price, dest.close);
});

test('crosshair: missing timestamp clears destination instead of inventing data', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(20));
    const b = register(mgr, 'b', candles5m(20));
    a.mock.emitCrosshair({ time: BASE + 12 * M5 });
    mgr.flushPending();
    assert.ok(b.mock.state.crosshair);
    // Far outside target history and beyond the drift cap.
    a.mock.emitCrosshair({ time: BASE + 500 * M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair, null);
    assert.ok(b.mock.state.calls.some((c) => c.op === 'clearCrosshair'));
});

test('crosshair: leaving the source clears linked charts only', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-red', c: 'g-blue' } });
    const a = register(mgr, 'a', candles5m(20));
    const b = register(mgr, 'b', candles5m(20));
    const c = register(mgr, 'c', candles5m(20));
    b.mock.state.crosshair = { price: 1, time: BASE };
    c.mock.state.crosshair = { price: 2, time: BASE };
    a.mock.emitCrosshair({ time: undefined });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair, null);
    assert.deepEqual(c.mock.state.crosshair, { price: 2, time: BASE });
});

test('crosshair: disabled setting and ungrouped charts stay independent', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-red', c: null } });
    const a = register(mgr, 'a', candles5m(20));
    const b = register(mgr, 'b', candles5m(20));
    const c = register(mgr, 'c', candles5m(20));
    a.mock.emitCrosshair({ time: BASE + M5 });
    mgr.flushPending();
    assert.ok(b.mock.state.crosshair);
    assert.equal(c.mock.state.crosshair, null);

    mgr.setSettings({ crosshair: false });
    a.mock.emitCrosshair({ time: BASE + 2 * M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair.time, BASE + M5, 'unchanged while disabled');
});

test('crosshair: throttles bursts into one update per target', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(50));
    const b = register(mgr, 'b', candles5m(50));
    a.mock.emitCrosshair({ time: BASE + M5 });
    a.mock.emitCrosshair({ time: BASE + 2 * M5 });
    a.mock.emitCrosshair({ time: BASE + 3 * M5 });
    mgr.flushPending();
    const sets = b.mock.state.calls.filter((c) => c.op === 'setCrosshair');
    assert.equal(sets.length, 1);
    assert.equal(sets[0].time, BASE + 3 * M5);
});

test('crosshair: recursion guard prevents echo loops', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(30));
    const b = register(mgr, 'b', candles5m(30));
    // Simulate a chart implementation that emits crosshair events from
    // setCrosshairPosition (some versions/plugins do).
    b.mock.chart.setCrosshairPosition = (price, time) => {
        b.state.crosshair = { price, time };
        b.state.calls.push({ op: 'setCrosshair', price, time });
        b.emitCrosshair({ time });
    };
    let events = 0;
    mgr.onCrosshair = () => { events += 1; };
    a.mock.emitCrosshair({ time: BASE + 2 * M5 });
    mgr.flushPending();
    assert.equal(events, 1);
    assert.equal(a.mock.state.crosshair, null);
});

/* ── visible range ─────────────────────────────────────────────────────── */

test('range: scroll sync preserves the timestamp viewport', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(100));
    const b = register(mgr, 'b', candles5m(100));
    a.mock.chart.timeScale().setVisibleRange({ from: BASE + 10 * M5, to: BASE + 40 * M5 });
    const applied = b.mock.state.calls.filter((c) => c.op === 'setVisibleRange').pop();
    assert.deepEqual(applied.range, { from: BASE + 10 * M5, to: BASE + 40 * M5 });
});

test('range: zoom is gated independently from horizontal scroll', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(100));
    const b = register(mgr, 'b', candles5m(100));
    mgr.setSettings({ zoom: false });

    // Same logical width -> scroll -> synchronized.
    a.mock.chart.timeScale().setVisibleRange({ from: BASE + 5 * M5, to: BASE + 30 * M5 });
    assert.equal(b.mock.state.calls.filter((c) => c.op === 'setVisibleRange').length, 1);

    // Width change -> zoom -> blocked.
    a.mock.state.logical = { from: 0, to: 50 };
    a.mock.emitRange({ from: BASE + 5 * M5, to: BASE + 50 * M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.calls.filter((c) => c.op === 'setVisibleRange').length, 1);

    mgr.setSettings({ zoom: true });
    a.mock.state.logical = { from: 0, to: 20 };
    a.mock.emitRange({ from: BASE + 2 * M5, to: BASE + 20 * M5 });
    const ranges = b.mock.state.calls.filter((c) => c.op === 'setVisibleRange');
    assert.equal(ranges.length, 2);
    assert.deepEqual(ranges[1].range, { from: BASE + 2 * M5, to: BASE + 20 * M5 });
});

test('range: programmatic echoes do not bounce back to the source', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(100));
    const b = register(mgr, 'b', candles5m(100));
    a.mock.chart.timeScale().setVisibleRange({ from: BASE + 10 * M5, to: BASE + 20 * M5 });
    // b's setVisibleRange fired its range listener synchronously; the echo must
    // not move a.
    const aSets = a.mock.state.calls.filter((c) => c.op === 'setVisibleRange');
    assert.equal(aSets.length, 1, 'only the direct call, never an echo');
    assert.equal(mgr._applying, 0);
});

test('range: coverage gap callback asks for older history', () => {
    const gaps = [];
    const mgr = makeManager({ onCoverageGap: (id, range) => gaps.push([id, range]) });
    const a = register(mgr, 'a', candles5m(100));
    const b = register(mgr, 'b', candles5m(100));
    b.mock.chart.timeScale().setVisibleRange = (range) => {
        // Emulate LWC clamping to the target's available history.
        b.mock.state.calls.push({ op: 'setVisibleRange', range });
        b.mock.state.visibleRange = { from: Math.max(range.from, BASE), to: range.to };
        b.mock.emitRange({ ...b.mock.state.visibleRange });
    };
    a.mock.chart.timeScale().setVisibleRange({ from: BASE - 50 * M5, to: BASE + 10 * M5 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0][0], 'b');
});

test('range: timeframe propagation is opt-in', () => {
    const synced = [];
    const mgr = makeManager({ onTimeframeSync: (src, tf, ids) => synced.push([src, tf, ids]) });
    const a = register(mgr, 'a', candles5m(10));
    register(mgr, 'b', candles5m(10));
    assert.deepEqual(mgr.notifyTimeframeChange('a', '1h'), []);
    assert.deepEqual(synced, []);
    mgr.setSettings({ timeframe: true });
    assert.deepEqual(mgr.notifyTimeframeChange('a', '1h'), ['b']);
    assert.equal(synced.length, 1);
});

/* ── groups ────────────────────────────────────────────────────────────── */

test('groups: independent settings and membership', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-blue', c: 'g-red' } });
    const a = register(mgr, 'a', candles5m(30));
    const b = register(mgr, 'b', candles5m(30));
    const c = register(mgr, 'c', candles5m(30));
    mgr.setSettings({ crosshair: false }, 'g-blue');
    a.mock.emitCrosshair({ time: BASE + M5 });
    mgr.flushPending();
    assert.ok(c.mock.state.crosshair, 'red group still syncs');
    assert.equal(b.mock.state.crosshair, null, 'blue group disabled');

    mgr.setChartGroup('c', null);
    c.mock.state.crosshair = null;
    a.mock.emitCrosshair({ time: BASE + 2 * M5 });
    mgr.flushPending();
    assert.equal(c.mock.state.crosshair, null, 'removed chart is independent');
});

test('groups: disabling a group stops both directions', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(30));
    const b = register(mgr, 'b', candles5m(30));
    mgr.setGroups([{ ...RED, enabled: false }, BLUE]);
    a.mock.emitCrosshair({ time: BASE + M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair, null);
    assert.deepEqual(mgr.getLinkedCharts('a'), []);
});

/* ── price scale ───────────────────────────────────────────────────────── */

test('price scale: absolute unions compatible charts and rejects incompatible scales', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-red', c: 'g-red' } });
    const a = register(mgr, 'a', candles5m(10), {
        priceRange: { min: 100, max: 110 },
        instrument: { quote: 'USDT', lastPrice: 105 },
    });
    const b = register(mgr, 'b', candles5m(10), {
        priceRange: { min: 102, max: 120 },
        instrument: { quote: 'USDT', lastPrice: 110 },
    });
    const c = register(mgr, 'c', candles5m(10), {
        priceRange: { min: 1, max: 2 },
        instrument: { quote: 'BTC', lastPrice: 0.0001 },
    });
    mgr.setSettings({ priceScale: 'absolute' });
    mgr.flushPending();

    const absoluteCalls = (mock) => mock.state.calls.filter((c) => c.op === 'absolute');
    const aCall = absoluteCalls(a.mock);
    assert.ok(aCall.length, 'absolute range applied');
    assert.ok(aCall[0].range.min < 100, 'padded below');
    assert.ok(aCall[0].range.max > 120, 'union above');
    const cCall = absoluteCalls(c.mock).pop();
    assert.equal(cCall.range, null, 'incompatible quote falls back to independent');
});

test('price scale: non-absolute modes clear absolute providers', () => {
    const mgr = makeManager();
    register(mgr, 'a', candles5m(10), { priceRange: { min: 1, max: 2 } });
    const b = register(mgr, 'b', candles5m(10), { priceRange: { min: 1, max: 2 } });
    mgr.setSettings({ priceScale: 'percentage' });
    mgr.flushPending();
    const last = b.mock.state.calls.filter((c) => c.op === 'absolute').pop();
    assert.equal(last.range, null);
});

/* ── lifecycle ─────────────────────────────────────────────────────────── */

test('lifecycle: unregister unsubscribes and clears registration', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(20));
    const b = register(mgr, 'b', candles5m(20));
    mgr.unregister('b');
    a.mock.emitCrosshair({ time: BASE + M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair, null);
    assert.equal(mgr.getChartIds().length, 1);
    assert.equal(mgr._charts.b, undefined);
    assert.equal(b.mock.listeners.crosshair.length, 0);
    assert.equal(b.mock.listeners.range.length, 0);
});

test('lifecycle: destroy removes every subscription', () => {
    const mgr = makeManager();
    const a = register(mgr, 'a', candles5m(20));
    const b = register(mgr, 'b', candles5m(20));
    mgr.destroy();
    assert.equal(a.mock.listeners.crosshair.length, 0);
    assert.equal(b.mock.listeners.range.length, 0);
    assert.deepEqual(mgr.getChartIds(), []);
});

test('destinations with no local candle are cleared, not extrapolated', () => {
    const mgr = makeManager({ chartGroups: { a: 'g-red', b: 'g-red' } });
    const a = register(mgr, 'a', candles5m(50));
    const b = register(mgr, 'b', candles5m(5));
    a.mock.emitCrosshair({ time: BASE + 40 * M5 });
    mgr.flushPending();
    assert.equal(b.mock.state.crosshair, null);
});
