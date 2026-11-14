import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, defaultInputs, inputConfig, plotConfig } from '../src/indicators/my_indicator.mjs';

const STEP = 15 * 60;
const START = Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000);

function seededBars(count) {
    const bars = [];
    for (let i = 0; i < count; i++) {
        const base = 100 + Math.sin(i / 17) * 3 + i * 0.01;
        bars.push({
            time: START + i * STEP,
            open: base,
            high: base + 1 + (i % 5) * 0.05,
            low: base - 1 - (i % 3) * 0.05,
            close: base + 0.4,
            volume: 1000 + ((i * 37) % 800),
        });
    }
    return bars;
}

const BARS = seededBars(9 * 96); // nine UTC days of 15m bars

function near(a, b, epsilon = 1e-9) {
    assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
}

test('defaults leave the VWAP hidden but keep the four EMAs', () => {
    const result = calculate(BARS, {}, { mintick: 0.01 });
    for (const id of ['plot0', 'plot1', 'plot2', 'plot3']) {
        assert.equal(result.plots[id].length, BARS.length, id);
        assert.ok(Number.isFinite(result.plots[id][BARS.length - 1].value), id);
    }
    assert.equal(result.visibility.vwap, false);
    assert.equal(result.plots.plot4.length, BARS.length);
    assert.ok(result.plots.plot4.every((point) => Number.isFinite(point.value)), 'values exist; the plot is just hidden');
    assert.deepEqual(result.fills, []);
});

test('session boxes and labels cover each first-15m window', () => {
    const result = calculate(BARS, { showSession: true }, { mintick: 0.01 });
    assert.ok(result.boxes.length > 0);
    assert.ok(result.labels.some((label) => label.text === 'Asia'));
    const firstAsia = result.boxes[0];
    assert.equal(firstAsia.time1, BARS[0].time);
    assert.ok(firstAsia.price1 > firstAsia.price2);
    assert.ok(firstAsia.time2 > firstAsia.time1, 'the box extends until the next session starts');
    assert.equal(firstAsia.price1, BARS[0].high);
    assert.equal(firstAsia.price2, BARS[0].low);
    assert.equal(result.labels.filter((label) => label.text === 'Asia').length, 9, 'one box per day');
    assert.equal(result.boxes.length, 9 * 4, 'four sessions per UTC day');
});

test('VWAP bands and their fills follow the show switches', () => {
    const result = calculate(BARS, {
        showVwap: true,
        showVwapBand: true,
        showBand1: true,
        showBand2: true,
        showBand3: true,
    }, { mintick: 0.01 });
    assert.equal(result.visibility.vwap, true);
    assert.equal(result.visibility.band1, true);
    assert.equal(result.visibility.band3, true);
    assert.equal(result.fills.length, 2);
    const last = result.plots.plot4.length - 1;
    const vwap = result.plots.plot4[last].value;
    assert.ok(Number.isFinite(vwap));
    assert.ok(result.plots.plot5[last].value > vwap);
    assert.ok(result.plots.plot6[last].value < vwap);
});

test('hide-on-DWM empties the VWAP on a daily chart', () => {
    const result = calculate(BARS, {
        showVwap: true,
        hideVwapDwm: true,
        showBand1: true,
    }, { timeframe: '1D', mintick: 0.01 });
    assert.ok(result.plots.plot4.every((point) => Number.isNaN(point.value)));
    assert.equal(result.visibility.vwap, false);
    assert.equal(result.fills.length, 0);
});

test('previous-day profile draws VAH / VAL / POC around the day range', () => {
    const result = calculate(BARS, { showVolumeProfile: true }, { mintick: 0.01 });
    assert.ok(result.lines.length >= 3 * 8, 'one VAH/VAL/POC set per completed day');
    const firstSet = result.lines.slice(0, 3);
    assert.equal(firstSet[0].price1, firstSet[0].price2);
    assert.ok(firstSet[0].price1 >= firstSet[2].price1);
    assert.ok(firstSet[1].price1 <= firstSet[2].price1);
    for (const line of firstSet) assert.ok(line.time2 >= line.time1);
});

test('volume bubbles and significant levels are capped', () => {
    const result = calculate(BARS, {
        bubbles: true,
        showLevels: true,
        levelsQty: 5,
        threshold: 0.1,
    }, { mintick: 0.01 });
    assert.ok(result.markers.length > 0);
    assert.ok(result.labels.some((label) => /^\d/.test(label.text)));
    const volumeLines = result.lines.filter((line) => line.width === 2 && line.style === 'solid');
    assert.ok(volumeLines.length <= 5);
});

test('a volume-less symbol warns instead of drawing bubbles', () => {
    const bars = BARS.map((bar) => ({ ...bar, volume: 0 }));
    const result = calculate(bars, { bubbles: true, showVolumeProfile: false }, { mintick: 0.01 });
    assert.equal(result.markers.length, 0);
    assert.ok(result.labels.some((label) => label.text.indexOf('No Volume Data Provided') >= 0));
});

test('every declared input and plot is wired', () => {
    assert.deepEqual(Object.keys(defaultInputs).sort(), inputConfig.map((input) => input.id).sort());
    assert.equal(plotConfig.length, 11);
    const result = calculate(BARS, {}, { mintick: 0.01 });
    for (const plot of plotConfig) assert.ok(Array.isArray(result.plots[plot.id]), plot.id);
});

test('the EMA offset shifts the plot times without dropping values', () => {
    const shifted = calculate(BARS, { emaOffset: 3 }, { mintick: 0.01 });
    assert.equal(shifted.plots.plot2.length, BARS.length);
    assert.equal(shifted.plots.plot2[0].time, BARS[3].time);
    const normal = calculate(BARS, {}, { mintick: 0.01 });
    near(shifted.plots.plot2[100].value, normal.plots.plot2[100].value);
});

test('empty input is safe', () => {
    const result = calculate([], {}, {});
    for (const plot of plotConfig) assert.deepEqual(result.plots[plot.id], []);
    assert.deepEqual(result.markers, []);
});
