/* ═══════════════════════════════════════════════════════════════════════════
 * ChartSyncManager — framework-free multi-chart synchronization
 *
 * Knows only about Lightweight Charts instances and candle data. It has no
 * knowledge of the workspace DOM, exchanges, React/Vue or QWebChannel, which
 * makes it unit-testable in Node with mock charts.
 *
 * Features
 *   • crosshair sync (timestamp based, destination price from its own data)
 *   • visible timestamp-range sync (scroll / zoom gated independently)
 *   • timeframe propagation (opt-in)
 *   • synchronization groups with independent settings
 *   • absolute price-scale coordination (compatibility guarded)
 *   • rAF coalescing + re-entrancy guards (no feedback loops)
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ChartSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var PRICE_SCALE_MODES = ['independent', 'absolute', 'percentage', 'indexed'];
    var NEAREST_POLICIES = ['closest', 'previous', 'next', 'none'];

    var DEFAULT_SETTINGS = {
        crosshair: true,
        timeRange: true,
        horizontalScroll: true,
        zoom: true,
        timeframe: false,
        priceScale: 'independent',
        nearestPolicy: 'previous',
        maxDriftBars: 2,
        referenceMode: 'first_visible',
        referenceTime: null,
    };

    var INDEPENDENT = {
        crosshair: false,
        timeRange: false,
        horizontalScroll: false,
        zoom: false,
        timeframe: false,
        priceScale: 'independent',
        nearestPolicy: 'previous',
        maxDriftBars: 0,
        referenceMode: 'first_visible',
        referenceTime: null,
    };

    function mergeSettings() {
        var out = {};
        for (var i = 0; i < arguments.length; i++) {
            var src = arguments[i];
            if (!src) continue;
            for (var key in src) {
                if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
                    out[key] = src[key];
                }
            }
        }
        return out;
    }

    /** Lightweight Charts can emit business-day objects; normalize to seconds. */
    function toTimestamp(time) {
        if (typeof time === 'number') return time;
        if (time && typeof time === 'object' && time.year && time.month && time.day) {
            return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
        }
        return null;
    }

    /**
     * Binary-search the candle with a timestamp matching the requested policy.
     * Never uses array indices from another chart's dataset.
     *
     * @param {Array<{time:number}>} candles ascending
     * @param {number} time target UTC seconds
     * @param {'closest'|'previous'|'next'|'none'} policy
     * @param {number|null} maxDriftSeconds reject candles farther than this
     */
    function findNearestCandle(candles, time, policy, maxDriftSeconds) {
        if (!Array.isArray(candles) || !candles.length || time == null) return undefined;
        var lo = 0;
        var hi = candles.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (candles[mid].time < time) lo = mid + 1;
            else hi = mid;
        }
        var next = candles[lo];
        var prev = candles[lo - 1];
        var exact = !!(next && next.time === time);
        var pick;
        if (policy === 'previous') pick = exact ? next : prev;
        else if (policy === 'next') pick = next;
        else if (policy === 'none') pick = exact ? next : undefined;
        else if (prev && next) pick = (time - prev.time <= next.time - time) ? prev : next;
        else pick = prev || next;
        if (!pick) return undefined;
        if (maxDriftSeconds != null && maxDriftSeconds >= 0 &&
            Math.abs(pick.time - time) > maxDriftSeconds) {
            return undefined;
        }
        return pick;
    }

    function rangeEquals(a, b, tolerance) {
        if (!a || !b) return false;
        var tol = tolerance || 0;
        return Math.abs(a.from - b.from) <= tol && Math.abs(a.to - b.to) <= tol;
    }

    /**
     * @param {Object} [options]
     * @param {Object} [options.settings]
     * @param {Array}  [options.groups]
     * @param {Object} [options.chartGroups] map chartId -> groupId
     * @param {Function} [options.onCrosshair] (chartId, time|null)
     * @param {Function} [options.onRangeApplied] (chartId, range, clamped)
     * @param {Function} [options.onCoverageGap] (chartId, range)
     * @param {Function} [options.onError] (chartId, operation, error)
     */
    function ChartSyncManager(options) {
        options = options || {};
        this._globalSettings = mergeSettings(DEFAULT_SETTINGS, options.settings);
        this._groups = [];
        this._groupsById = {};
        this._chartGroup = {};           // chartId -> groupId
        this._charts = {};               // chartId -> registration
        this._applying = 0;
        this._suppressUntil = {};
        this._lastWidth = {};
        this._pendingCrosshair = null;
        this._pendingPriceGroups = {};
        this._rafId = null;
        this._raf = (typeof requestAnimationFrame === 'function')
            ? function (fn) { return window.requestAnimationFrame(fn); }
            : function (fn) { return setTimeout(fn, 16); };
        this._cancelRaf = (typeof cancelAnimationFrame === 'function')
            ? function (id) { window.cancelAnimationFrame(id); }
            : function (id) { clearTimeout(id); };
        this._now = function () { return Date.now(); };
        this.onCrosshair = options.onCrosshair || null;
        this.onRangeApplied = options.onRangeApplied || null;
        this.onCoverageGap = options.onCoverageGap || null;
        this.onTimeframeSync = options.onTimeframeSync || null;
        this.onError = options.onError || null;
        if (options.groups) this.setGroups(options.groups);
        if (options.chartGroups) this.setChartGroups(options.chartGroups);
    }

    /* ── Groups & settings ──────────────────────────────────────────────── */

    ChartSyncManager.prototype.setGroups = function (groups) {
        this._groups = (Array.isArray(groups) ? groups : []).map(function (g) {
            return {
                id: String(g.id),
                name: g.name || String(g.id),
                color: g.color || '#F5C400',
                enabled: g.enabled !== false,
                settings: mergeSettings(DEFAULT_SETTINGS, g.settings),
            };
        });
        this._groupsById = {};
        for (var i = 0; i < this._groups.length; i++) {
            this._groupsById[this._groups[i].id] = this._groups[i];
        }
        // Drop assignments to deleted groups so those charts become independent.
        for (var chartId in this._chartGroup) {
            if (this._chartGroup[chartId] && !this._groupsById[this._chartGroup[chartId]]) {
                this._chartGroup[chartId] = null;
            }
        }
    };

    ChartSyncManager.prototype.setChartGroups = function (map) {
        if (!map) return;
        for (var chartId in map) {
            if (!Object.prototype.hasOwnProperty.call(map, chartId)) continue;
            this.setChartGroup(chartId, map[chartId]);
        }
    };

    ChartSyncManager.prototype.setChartGroup = function (chartId, groupId) {
        var exists = groupId != null && !!this._groupsById[groupId];
        this._chartGroup[chartId] = exists ? groupId : null;
    };

    ChartSyncManager.prototype.getChartGroup = function (chartId) {
        var groupId = this._chartGroup[chartId];
        return groupId && this._groupsById[groupId] ? this._groupsById[groupId] : null;
    };

    /**
     * Patch settings globally (all groups) or for a single group.
     * @param {Object} patch
     * @param {string} [groupId]
     */
    ChartSyncManager.prototype.setSettings = function (patch, groupId) {
        if (!patch) return;
        if (groupId) {
            var group = this._groupsById[groupId];
            if (group) group.settings = mergeSettings(group.settings, patch);
        } else {
            this._globalSettings = mergeSettings(this._globalSettings, patch);
            for (var i = 0; i < this._groups.length; i++) {
                this._groups[i].settings = mergeSettings(this._groups[i].settings, patch);
            }
        }
        this.schedulePriceScaleRefresh();
    };

    ChartSyncManager.prototype.getGlobalSettings = function () {
        return mergeSettings(DEFAULT_SETTINGS, this._globalSettings);
    };

    /** Seed defaults without overwriting per-group settings (used on restore). */
    ChartSyncManager.prototype.setDefaultSettings = function (patch) {
        this._globalSettings = mergeSettings(this._globalSettings, patch);
    };

    ChartSyncManager.prototype.settingsFor = function (chartId) {
        var group = this.getChartGroup(chartId);
        if (!group || group.enabled === false) return mergeSettings(INDEPENDENT);
        return mergeSettings(DEFAULT_SETTINGS, this._globalSettings, group.settings);
    };

    ChartSyncManager.prototype.getLinkedCharts = function (sourceId) {
        var group = this.getChartGroup(sourceId);
        if (!group || group.enabled === false) return [];
        var out = [];
        for (var id in this._charts) {
            if (id === sourceId) continue;
            if (this._chartGroup[id] !== group.id) continue;
            if (!this._charts[id].enabled) continue;
            out.push(this._charts[id]);
        }
        return out;
    };

    /* ── Registration / lifecycle ───────────────────────────────────────── */

    /**
     * @param {Object} reg
     * @param {string} reg.chartId
     * @param {Object} reg.chart IChartApi
     * @param {Object} reg.mainSeries ISeriesApi
     * @param {Function} reg.getDataAtTime (time) => candle|undefined
     * @param {Function} reg.getNearestDataAtTime (time, opts) => candle|undefined
     * @param {Function} [reg.getVisiblePriceRange] () => {min,max}|null
     * @param {Function} [reg.applyAbsoluteRange] (range|null) => void
     * @param {Function} [reg.getInstrument] () => {base,quote,lastPrice}
     * @param {number}   [reg.barSeconds]
     * @param {string}   [reg.groupId]
     */
    ChartSyncManager.prototype.register = function (reg) {
        if (!reg || !reg.chartId || !reg.chart) throw new Error('register() requires chartId and chart');
        if (this._charts[reg.chartId]) this.unregister(reg.chartId);
        var self = this;
        var timeScale = reg.chart.timeScale();

        reg.enabled = reg.enabled !== false;

        if (reg.groupId !== undefined) this.setChartGroup(reg.chartId, reg.groupId);

        reg._onCrosshair = function (param) { self._handleCrosshair(reg.chartId, param); };
        reg._onRange = function (range) { self._handleVisibleRange(reg.chartId, range); };

        if (typeof reg.chart.subscribeCrosshairMove === 'function') {
            reg.chart.subscribeCrosshairMove(reg._onCrosshair);
            reg._subscribedCrosshair = true;
        }
        if (timeScale && typeof timeScale.subscribeVisibleTimeRangeChange === 'function') {
            timeScale.subscribeVisibleTimeRangeChange(reg._onRange);
            reg._subscribedRange = true;
        }
        var logicalRange = timeScale && timeScale.getVisibleLogicalRange
            ? timeScale.getVisibleLogicalRange() : null;
        this._lastWidth[reg.chartId] = logicalRange ? logicalRange.to - logicalRange.from : null;
        this._charts[reg.chartId] = reg;
        this.schedulePriceScaleRefresh();
        return reg;
    };

    ChartSyncManager.prototype.updateRegistration = function (chartId, patch) {
        var reg = this._charts[chartId];
        if (!reg) return;
        for (var key in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) reg[key] = patch[key];
        }
        this.schedulePriceScaleRefresh();
    };

    ChartSyncManager.prototype.unregister = function (chartId) {
        var reg = this._charts[chartId];
        if (!reg) return;
        try {
            if (reg._subscribedCrosshair && reg.chart.unsubscribeCrosshairMove) {
                reg.chart.unsubscribeCrosshairMove(reg._onCrosshair);
            }
            var ts = reg.chart.timeScale();
            if (reg._subscribedRange && ts && ts.unsubscribeVisibleTimeRangeChange) {
                ts.unsubscribeVisibleTimeRangeChange(reg._onRange);
            }
        } catch (err) {
            this._reportError(chartId, 'unregister', err);
        }
        delete this._charts[chartId];
        delete this._lastWidth[chartId];
        delete this._suppressUntil[chartId];
        delete this._chartGroup[chartId];
    };

    ChartSyncManager.prototype.destroy = function () {
        var ids = Object.keys(this._charts);
        for (var i = 0; i < ids.length; i++) this.unregister(ids[i]);
        if (this._rafId != null) {
            this._cancelRaf(this._rafId);
            this._rafId = null;
        }
        this._pendingCrosshair = null;
    };

    ChartSyncManager.prototype.getChartIds = function () {
        return Object.keys(this._charts);
    };

    /* ── Crosshair synchronization ──────────────────────────────────────── */

    ChartSyncManager.prototype._handleCrosshair = function (chartId, param) {
        var time = null;
        if (param) {
            if (param.time !== undefined) {
                time = toTimestamp(param.time);
            } else if (param.point && param.point.x !== undefined) {
                try {
                    var ts = this._charts[chartId].chart.timeScale();
                    if (ts && ts.coordinateToTime) {
                        time = toTimestamp(ts.coordinateToTime(param.point.x));
                    }
                } catch (err) {
                    time = null;
                }
            }
        }
        this._pendingCrosshair = { chartId: chartId, time: time };
        this._scheduleFlush();
    };

    /**
     * Public for tests and for programmatic callers (e.g. a crosshair readout).
     * @param {string} sourceChartId
     * @param {number|null} time UTC seconds
     */
    ChartSyncManager.prototype.handleCrosshairMove = function (sourceChartId, time) {
        if (this._applying > 0) return;
        if (this._isSuppressed(sourceChartId)) return;
        var settings = this.settingsFor(sourceChartId);
        if (!settings.crosshair) return;
        if (time == null) {
            this.clearCrosshairsExcept(sourceChartId);
            if (this.onCrosshair) this.onCrosshair(sourceChartId, null);
            return;
        }
        // Cursor sync is global across every open chart, regardless of sync group.
        // Cursor sync spans every enabled grouped chart, even across sync groups.
        var targets = [];
        for (var cid in this._charts) {
            if (cid === sourceChartId) continue;
            if (!this._charts[cid].enabled) continue;
            var g = this.getChartGroup(cid);
            if (!g || g.enabled === false) continue;
            if (!this.settingsFor(cid).crosshair) continue;
            targets.push(this._charts[cid]);
        }
        if (!targets.length) {
            if (this.onCrosshair) this.onCrosshair(sourceChartId, time);
            return;
        }
        this._applying++;
        try {
            for (var i = 0; i < targets.length; i++) {
                this._applyCrosshair(targets[i], time, settings);
            }
        } finally {
            this._applying--;
        }
        if (this.onCrosshair) this.onCrosshair(sourceChartId, time);
    };

    ChartSyncManager.prototype._applyCrosshair = function (target, time, settings) {
        var candle = null;
        try {
            var barSeconds = target.barSeconds || 0;
            var maxDrift = (settings.maxDriftBars != null && barSeconds)
                ? settings.maxDriftBars * barSeconds : null;
            if (typeof target.getNearestDataAtTime === 'function') {
                candle = target.getNearestDataAtTime(time, {
                    policy: settings.nearestPolicy,
                    maxDriftSeconds: maxDrift,
                });
            } else if (typeof target.getDataAtTime === 'function') {
                candle = target.getDataAtTime(time);
            }
        } catch (err) {
            this._reportError(target.chartId, 'nearest', err);
            candle = null;
        }
        try {
            if (!candle) {
                if (target.chart.clearCrosshairPosition) target.chart.clearCrosshairPosition();
                return;
            }
            target.chart.setCrosshairPosition(candle.close, candle.time, target.mainSeries);
            // Some chart builds emit crosshair events for programmatic moves;
            // suppress the echo so it cannot bounce back.
            this._suppressUntil[target.chartId] = this._now() + 60;
        } catch (err) {
            this._reportError(target.chartId, 'crosshair', err);
        }
    };

    ChartSyncManager.prototype.clearCrosshairsExcept = function (sourceChartId) {
        var reg = this._charts[sourceChartId];
        if (!reg) return;
        var targets = this.getLinkedCharts(sourceChartId);
        this._applying++;
        try {
            for (var i = 0; i < targets.length; i++) {
                try {
                    if (targets[i].chart.clearCrosshairPosition) {
                        targets[i].chart.clearCrosshairPosition();
                    }
                } catch (err) {
                    this._reportError(targets[i].chartId, 'clearCrosshair', err);
                }
            }
        } finally {
            this._applying--;
        }
    };

    /** Clear every programmatic crosshair (layout switch, sync disabled, …). */
    ChartSyncManager.prototype.clearAllCrosshairs = function () {
        this._applying++;
        try {
            for (var id in this._charts) {
                try {
                    if (this._charts[id].chart.clearCrosshairPosition) {
                        this._charts[id].chart.clearCrosshairPosition();
                    }
                } catch (err) {
                    this._reportError(id, 'clearCrosshair', err);
                }
            }
        } finally {
            this._applying--;
        }
    };

    /* ── Visible range (scroll / zoom) synchronization ──────────────────── */

    ChartSyncManager.prototype._handleVisibleRange = function (chartId, range) {
        var reg = this._charts[chartId];
        if (!reg) return;
        if (this._applying > 0 || this._isSuppressed(chartId)) {
            // Keep the zoom/scroll classifier in sync with programmatic moves
            // so the next user gesture is classified correctly.
            this._classifyRangeChange(chartId, reg);
            return;
        }

        var kind = this._classifyRangeChange(chartId, reg);
        var settings = this.settingsFor(chartId);
        if (!settings.timeRange) return;
        if (kind === 'zoom' && !settings.zoom) return;
        if (kind === 'scroll' && !settings.horizontalScroll) return;
        if (!range) return;
        this.applyVisibleRange(chartId, range);
        var group = this.getChartGroup(chartId);
        if (group) this.schedulePriceScaleRefresh(group.id);
    };

    ChartSyncManager.prototype._classifyRangeChange = function (chartId, reg) {
        var width = null;
        try {
            var lr = reg.chart.timeScale().getVisibleLogicalRange();
            if (lr) width = lr.to - lr.from;
        } catch (err) {
            width = null;
        }
        var prev = this._lastWidth[chartId];
        this._lastWidth[chartId] = width;
        if (prev == null || width == null) return 'scroll';
        return Math.abs(width - prev) > 0.25 ? 'zoom' : 'scroll';
    };

    ChartSyncManager.prototype.applyVisibleRange = function (sourceChartId, range) {
        if (!range) return;
        var settings = this.settingsFor(sourceChartId);
        if (!settings.timeRange) return;
        var targets = this.getLinkedCharts(sourceChartId);
        if (!targets.length) return;
        this._applying++;
        try {
            for (var i = 0; i < targets.length; i++) {
                this._applyRangeToTarget(targets[i], range);
            }
        } finally {
            this._applying--;
        }
    };

    ChartSyncManager.prototype._applyRangeToTarget = function (target, range) {
        // Charts that have not loaded data yet reject time ranges; wait for them.
        if (typeof target.isReady === 'function' && !target.isReady()) return;
        var ts = target.chart.timeScale();
        var tolerance = (target.barSeconds || 60) / 2;
        var applied = null;
        try {
            ts.setVisibleRange({ from: range.from, to: range.to });
            applied = ts.getVisibleRange ? ts.getVisibleRange() : null;
        } catch (err) {
            // Insufficient history can make a range invalid for this dataset.
            this._reportError(target.chartId, 'setVisibleRange', err);
            return;
        }
        // Programmatic range changes are delivered asynchronously by LWC;
        // suppress the echo so it cannot bounce back to the source chart.
        this._suppressUntil[target.chartId] = this._now() + 160;

        var clampedStart = applied && applied.from > range.from + tolerance;
        var clampedEnd = applied && applied.to < range.to - tolerance;
        if ((clampedStart || clampedEnd) && this.onCoverageGap && clampedStart) {
            this.onCoverageGap(target.chartId, range);
        }
        if (this.onRangeApplied) {
            this.onRangeApplied(target.chartId, applied || range,
                !!(clampedStart || clampedEnd));
        }
    };

    /* ── Timeframe propagation ─────────────────────────────────────────── */

    /**
     * Returns the linked chart ids that should switch timeframe, or [] when the
     * group has timeframe sync disabled. The workspace performs the reload.
     */
    ChartSyncManager.prototype.getTimeframeTargets = function (sourceChartId, timeframe) {
        var settings = this.settingsFor(sourceChartId);
        if (!settings.timeframe) return [];
        return this.getLinkedCharts(sourceChartId)
            .filter(function (reg) { return reg.timeframe !== timeframe; })
            .map(function (reg) { return reg.chartId; });
    };

    ChartSyncManager.prototype.notifyTimeframeChange = function (sourceChartId, timeframe) {
        var targetIds = this.getTimeframeTargets(sourceChartId, timeframe);
        if (targetIds.length && this.onTimeframeSync) {
            this.onTimeframeSync(sourceChartId, timeframe, targetIds);
        }
        return targetIds;
    };

    /* ── Price-scale coordination ──────────────────────────────────────── */

    ChartSyncManager.prototype._compatible = function (a, b) {
        if (!a || !b || typeof a.getInstrument !== 'function' ||
            typeof b.getInstrument !== 'function') return true;
        var ia = a.getInstrument();
        var ib = b.getInstrument();
        if (!ia || !ib) return true;
        if (String(ia.quote || '').toUpperCase() !== String(ib.quote || '').toUpperCase()) {
            return false;
        }
        var pa = Number(ia.lastPrice) || 0;
        var pb = Number(ib.lastPrice) || 0;
        if (pa > 0 && pb > 0) {
            var ratio = pa > pb ? pa / pb : pb / pa;
            if (ratio > 5) return false;    // BTC vs ETH/SOL must not share a scale
        }
        return true;
    };

    ChartSyncManager.prototype.schedulePriceScaleRefresh = function (groupId) {
        if (groupId) this._pendingPriceGroups[groupId] = true;
        else this._pendingPriceGroups['*'] = true;
        this._scheduleFlush();
    };

    ChartSyncManager.prototype._flushPriceScale = function (pending) {
        var all = !!pending['*'];
        var groups = {};
        for (var id in this._charts) {
            var group = this.getChartGroup(id);
            if (!group) continue;
            if (!all && !pending[group.id]) continue;
            (groups[group.id] = groups[group.id] || []).push(this._charts[id]);
        }
        for (var gid in groups) {
            var regs = groups[gid];
            var mode = this.settingsFor(regs[0].chartId).priceScale;
            if (mode !== 'absolute') {
                for (var i = 0; i < regs.length; i++) this._applyAbsolute(regs[i], null);
                continue;
            }
            var anchor = regs[0];
            var compatible = regs.filter(function (reg) { return this._compatible(reg, anchor); }, this);
            var union = null;
            for (var j = 0; j < compatible.length; j++) {
                var pr = null;
                try {
                    pr = compatible[j].getVisiblePriceRange
                        ? compatible[j].getVisiblePriceRange() : null;
                } catch (err) {
                    pr = null;
                }
                if (!pr || !isFinite(pr.min) || !isFinite(pr.max) || pr.max <= pr.min) continue;
                union = union || { min: pr.min, max: pr.max };
                if (pr.min < union.min) union.min = pr.min;
                if (pr.max > union.max) union.max = pr.max;
            }
            if (union) {
                var pad = (union.max - union.min) * 0.02;
                union = { min: union.min - pad, max: union.max + pad };
            }
            for (var k = 0; k < regs.length; k++) {
                var ok = compatible.indexOf(regs[k]) >= 0;
                this._applyAbsolute(regs[k], ok ? union : null);
            }
        }
    };

    ChartSyncManager.prototype._applyAbsolute = function (reg, range) {
        if (typeof reg.applyAbsoluteRange !== 'function') return;
        try {
            reg.applyAbsoluteRange(range);
        } catch (err) {
            this._reportError(reg.chartId, 'absoluteRange', err);
        }
    };

    /* ── Scheduling helpers ────────────────────────────────────────────── */

    ChartSyncManager.prototype._scheduleFlush = function () {
        if (this._rafId != null) return;
        var self = this;
        this._rafId = this._raf(function () {
            self._rafId = null;
            self.flushPending();
        });
    };

    /** Apply the last queued crosshair + price-scale work immediately. */
    ChartSyncManager.prototype.flushPending = function () {
        var pending = this._pendingCrosshair;
        this._pendingCrosshair = null;
        if (pending) this.handleCrosshairMove(pending.chartId, pending.time);
        var groups = this._pendingPriceGroups;
        this._pendingPriceGroups = {};
        if (Object.keys(groups).length) this._flushPriceScale(groups);
    };

    ChartSyncManager.prototype._isSuppressed = function (chartId) {
        var until = this._suppressUntil[chartId];
        return !!until && this._now() < until;
    };

    ChartSyncManager.prototype._reportError = function (chartId, operation, err) {
        if (this.onError) this.onError(chartId, operation, err);
        else if (typeof console !== 'undefined' && console.warn) {
            console.warn('[ChartSync] ' + operation + ' failed for ' + chartId, err);
        }
    };

    return {
        ChartSyncManager: ChartSyncManager,
        findNearestCandle: findNearestCandle,
        toTimestamp: toTimestamp,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        PRICE_SCALE_MODES: PRICE_SCALE_MODES,
        NEAREST_POLICIES: NEAREST_POLICIES,
    };
});
