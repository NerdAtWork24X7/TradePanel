/**
 * Formula, migration and guard tests for frontend/web/position_tool.js.
 * Reference: TradingView Long/Short position tool documentation.
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

const P = loadClassic('position_tool.js');
const BASELINE = { acct: 10000, riskMode: 'percent', riskPercent: 1, riskAmount: 100, lev: 10, lotSize: 1, qtyPrecision: 4 };
const MARKET = { precision: 2, tickSize: 0.01, lastPrice: 100 };

function pos(overrides) {
    return { id: 'p1', dir: 'long', entry: 100, tp: 102, sl: 99, startTime: 1000, endTime: 4600, ...overrides };
}

test('long position: qty, RR, PnL and balances follow the documented formulas', () => {
    const m = P.compute(pos(), BASELINE, MARKET);
    assert.equal(m.long, true);
    assert.equal(m.riskPerUnit, 1);
    assert.equal(m.rewardPerUnit, 2);
    assert.equal(m.rr, 2);
    assert.equal(m.riskPct, 1);
    assert.equal(m.rewardPct, 2);
    assert.equal(m.qtyRisk, 100);          // 100 USDT risk / 1 per unit
    assert.equal(m.qtyLvg, 1000);          // 10,000 * 10 / 100
    assert.equal(m.qty, 100);              // min(qtyRisk, qtyLvg)
    assert.equal(m.margin, 1000);          // notional / leverage
    assert.equal(m.risk, 100);
    assert.equal(m.reward, 200);
    assert.equal(m.balanceAtTp, 10200);
    assert.equal(m.balanceAtSl, 9900);
    assert.equal(m.tpTicks, 200);
    assert.equal(m.slTicks, 100);
    assert.equal(m.tpMovePct, 2);
    assert.equal(m.slMovePct, -1);
    assert.equal(m.tpMoveTicks, 200);
    assert.equal(m.slMoveTicks, -100);
    assert.equal(m.capped, 'risk');
});

test('short position mirrors quantities and rewards', () => {
    const m = P.compute(pos({ dir: 'short', tp: 98, sl: 101 }), BASELINE, MARKET);
    assert.equal(m.long, false);
    assert.equal(m.dir, 'short');
    assert.equal(m.riskPerUnit, 1);
    assert.equal(m.rewardPerUnit, 2);
    assert.equal(m.rr, 2);
    assert.equal(m.qty, 100);
    assert.equal(m.reward, 200);
    assert.equal(m.balanceAtTp, 10200);
    assert.equal(m.balanceAtSl, 9900);
    assert.equal(m.tpTicks, 200);
    assert.equal(m.tpMovePct, -2);
    assert.equal(m.slMovePct, 1);
    assert.equal(m.tpMoveTicks, -200);
    assert.equal(m.slMoveTicks, 100);
});

test('leverage caps quantity when the risk budget would need more notional', () => {
    const m = P.compute(pos(), { ...BASELINE, acct: 100, riskPercent: 50, lev: 1 }, MARKET);
    assert.equal(m.qtyRisk, 50);
    assert.equal(m.qtyLvg, 1);
    assert.equal(m.qty, 1);
    assert.equal(m.capped, 'leverage');
    assert.equal(m.risk, 1);              // actual risk is smaller than the budget
    assert.equal(m.reward, 2);
});

test('absolute risk mode ignores the percentage and uses the amount', () => {
    const m = P.compute(pos(), { ...BASELINE, riskMode: 'amount', riskAmount: 250, riskPercent: 50 }, MARKET);
    assert.equal(m.riskAmount, 250);
    assert.equal(m.qtyRisk, 250);
    assert.equal(m.risk, 250);
    assert.equal(m.balanceAtSl, 9750);
});

test('lot size scales lots, not risk', () => {
    const m = P.compute(pos(), { ...BASELINE, lotSize: 0.1 }, MARKET);
    assert.equal(m.qtyRisk, 1000);        // 100 / 1 / 0.1
    assert.equal(m.qtyLvg, 10000);        // 1000 / 0.1
    assert.equal(m.qty, 1000);
    assert.equal(m.units, 100);
    assert.equal(m.risk, 100);
    assert.equal(m.reward, 200);
    assert.equal(m.margin, 1000);
});

test('zero-distance and invalid levels never produce NaN or Infinity', () => {
    const zero = P.compute(pos({ sl: 100 }), BASELINE, MARKET);
    assert.equal(zero.riskPerUnit, 0);
    assert.equal(zero.rr, 0);
    assert.equal(zero.qtyRisk, 0);
    assert.equal(zero.qty, 0);
    assert.equal(zero.risk, 0);
    assert.ok(Number.isFinite(zero.balanceAtTp));
    assert.ok(Number.isFinite(zero.balanceAtSl));
    assert.equal(P.compute(pos({ entry: 0 }), BASELINE, MARKET), null);
    assert.equal(P.compute(pos({ tp: NaN }), BASELINE, MARKET), null);
    assert.equal(P.compute(null, BASELINE, MARKET), null);
});

test('open PnL uses the right-edge close when the box is in the past', () => {
    const ended = P.compute(pos(), BASELINE, { ...MARKET, lastPrice: 130, closeAtEnd: 101.5 });
    assert.equal(ended.atEnd, true);
    assert.equal(ended.openPnl, 150);
    assert.equal(ended.openPct, 1.5);
    assert.equal(ended.state, 'open');
    assert.equal(ended.balanceNow, 10150);

    const won = P.compute(pos(), BASELINE, { ...MARKET, closeAtEnd: 102.5 });
    assert.equal(won.state, 'target');
    assert.equal(won.openPnl, 250);

    const lost = P.compute(pos(), BASELINE, { ...MARKET, closeAtEnd: 98.5 });
    assert.equal(lost.state, 'stop');
    assert.equal(lost.openPnl, -150);

    const future = P.compute(pos(), BASELINE, { ...MARKET, lastPrice: 101, closeAtEnd: 0 });
    assert.equal(future.atEnd, false);
    assert.equal(future.openPnl, 100);
    assert.equal(future.state, 'open');
});

test('mirrorStop keeps 1:1 and never returns a non-positive stop', () => {
    assert.equal(P.mirrorStop('long', 100, 102), 98);
    assert.equal(P.mirrorStop('short', 100, 98), 102);
    assert.equal(P.mirrorStop('long', 100, 250), Math.max(100 * 1e-6, 1e-9));
    assert.ok(P.mirrorStop('short', 100, 0.0001) > 0);
    assert.ok(P.mirrorStop('long', Number.NaN, 2) > 0);
});

test('settings normalize, clamp and migrate the v1 risk percentage', () => {
    const legacy = P.normalizeSettings({ acct: 5000, risk: 2, lev: 5, widthBars: 20 });
    assert.equal(legacy.acct, 5000);
    assert.equal(legacy.riskMode, 'percent');
    assert.equal(legacy.riskPercent, 2);
    assert.equal(legacy.riskAmount, 100);   // migrated from 2% of 5000
    assert.equal(legacy.lev, 5);
    assert.equal(legacy.lotSize, 1);
    assert.equal(legacy.qtyPrecision, 4);
    assert.equal(legacy.showStats, true);
    assert.equal(legacy.compactStats, false);

    const junk = P.normalizeSettings({ acct: -5, riskPercent: 500, lev: 0, lotSize: 0, qtyPrecision: 99, widthPx: 1 });
    assert.equal(junk.acct, 1);
    assert.equal(junk.riskPercent, 100);
    assert.equal(junk.lev, 1);
    assert.ok(junk.lotSize > 0);
    assert.equal(junk.qtyPrecision, 8);
    assert.equal(junk.widthPx, 40);

    const defaults = P.normalizeSettings(null);
    assert.equal(defaults.acct, P.DEFAULTS.acct);
    assert.equal(defaults.riskMode, 'percent');
    assert.equal(defaults.riskPercent, 1);
    assert.equal(defaults.riskAmount, 100);
    assert.deepEqual(P.normalizeSettings({}), defaults);
});

test('position records are validated and repaired on load', () => {
    const good = P.normalizePosition(pos());
    assert.equal(good.dir, 'long');
    assert.equal(good.startTime, 1000);
    assert.equal(good.endTime, 4600);

    assert.equal(P.normalizePosition({ ...pos(), dir: 'sideways' }), null);
    assert.equal(P.normalizePosition({ ...pos(), entry: -1 }), null);
    assert.equal(P.normalizePosition({ ...pos(), startTime: 0 }), null);

    const repaired = P.normalizePosition(pos({ endTime: 10 }));
    assert.equal(repaired.endTime, 1000 + 3600);
    const generated = P.normalizePosition(pos({ id: undefined }));
    assert.match(generated.id, /^p-/);
});

test('formatters are locale independent, signed and NaN-safe', () => {
    assert.equal(P.formatMoney(1234.5), '1,234.50');
    assert.equal(P.formatMoney(-1234.5), '-1,234.50');
    assert.equal(P.formatMoney(NaN), '—');
    assert.equal(P.formatPct(2), '+2.00%');
    assert.equal(P.formatPct(-1), '-1.00%');
    assert.equal(P.formatPct(-0.0001), '0.00%');
    assert.equal(P.formatQty(1.234567, 2), '1.23');
    assert.equal(P.formatQty(1.234567, 0), '1');
    assert.equal(P.formatTicks(200), '+200 ticks');
    assert.equal(P.formatTicks(-200), '-200 ticks');
    assert.equal(P.rrLabel(2), '1 : 2.00');
    assert.equal(P.rrLabel(0), '—');
    assert.equal(P.compactNumber(1250), '1.25K');
    assert.equal(P.compactNumber(-2e6), '-2.00M');
});

test('stats rows expose every documented metric with tones', () => {
    const m = P.compute(pos(), BASELINE, { ...MARKET, closeAtEnd: 101.5 });
    const rows = P.statsRows(m);
    const labels = rows.map((r) => r.label);
    assert.deepEqual(labels, [
        'Quantity', 'R/R', 'Target', 'Stop', 'Risk', 'Reward', 'Balance @ TP', 'Balance @ SL', 'PnL at right edge'
    ]);
    assert.match(rows.find((r) => r.label === 'Target').value, /102\.00 · \+2\.00% · \+200 ticks/);
    assert.match(rows.find((r) => r.label === 'Stop').value, /99\.00 · -1\.00% · -100 ticks/);
    const risk = rows.find((r) => r.label === 'Risk');
    assert.equal(risk.tone, 'down');
    assert.match(risk.value, /100\.00/);
    const rr = rows.find((r) => r.label === 'R/R');
    assert.equal(rr.value, '1 : 2.00');
    assert.match(P.compactSummary(m), /^1 : 2\.00\s+·\s+Qty 100\.0000\s+·\s+200\.00 \/ −100\.00$/);
});
