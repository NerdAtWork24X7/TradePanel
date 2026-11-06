/* ═══════════════════════════════════════════════════════════════════════════
 * Multi-Chart Workspace
 *
 * Vanilla JS (the project has no front-end framework). One Lightweight Charts
 * instance per panel; ChartSyncManager (chart_sync.js) owns synchronization.
 * All exchange I/O is delegated to Python through the host bridge.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w', '1M'];
    var TF_SECONDS = {
        '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
        '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
        '1d': 86400, '1w': 604800, '1M': 2592000
    };
    var CHART_TYPES = [
        { id: 'candlestick', label: 'Candles' },
        { id: 'hollow', label: 'Hollow candles' },
        { id: 'bar', label: 'OHLC bars' },
        { id: 'line', label: 'Line' },
        { id: 'area', label: 'Area' },
        { id: 'baseline', label: 'Baseline' }
    ];
    var LAYOUTS = {
        '1': { cols: 1, rows: 1, label: '1 chart' },
        '2h': { cols: 2, rows: 1, label: '2 horizontal' },
        '2v': { cols: 1, rows: 2, label: '2 vertical' },
        '4': { cols: 2, rows: 2, label: '4 charts (2x2)' },
        '6': { cols: 3, rows: 2, label: '6 charts (3x2)' },
        '8': { cols: 4, rows: 2, label: '8 charts (4x2)' },
        'custom': { cols: 0, rows: 0, label: 'Custom' }
    };
    var GROUP_COLORS = ['#e3b24f', '#6aa2f0', '#ffd43b', '#83cf9c', '#ad8cf2', '#7fd4d4'];
    var DEFAULT_SLOTS = [
        ['binance', 'BTC/USDT', '5m'], ['bybit', 'BTC/USDT', '5m'],
        ['binance', 'ETH/USDT', '15m'], ['okx', 'SOL/USDT', '1h'],
        ['kraken', 'BTC/USDT', '1h'], ['coinbase', 'ETH/USDT', '5m'],
        ['kucoin', 'SOL/USDT', '15m'], ['gate', 'BTC/USDT', '4h'],
        ['bitget', 'ETH/USDT', '1h'], ['binance', 'XRP/USDT', '5m'],
        ['bybit', 'SOL/USDT', '5m'], ['okx', 'BTC/USDT', '15m']
    ];
    var PREFS_KEY = 'trade_panel.workspace.prefs.v1';
    var WS = {
        meta: null,
        store: null,
        activeId: null,
        charts: {},
        sync: null,
        maximized: null,
        focused: null,
        pending: {},
        reqSeq: 0,
        saving: false,
        saveQueued: false,
        saveCallback: null,
        dirty: false,
        dirtyShown: false,
        staleBackendWarned: false,
        shuttingDown: false,
        active: true,
        prefs: { recent: [] },
        modal: null,
        menu: null,
        menuAnchor: null,
        dragChartId: null,
        drawDrag: null,
        statusTimer: null,
        fullscreenOn: false
    };
    window.WS = WS;

    /* ── Small helpers ────────────────────────────────────────────────────── */

    function $(sel, root) { return (root || document).querySelector(sel); }

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function icon(svg) {
        var span = document.createElement('span');
        span.innerHTML = svg;
        return span.firstChild;
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function formatPrice(value, precision) {
        if (value == null || !isFinite(value)) return '—';
        var p = precision == null ? 2 : precision;
        var parts = Number(value).toFixed(p).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    }

    function tfLabel(tf) { return tf === '1M' ? '1M' : tf; }

    function lowerBound(candles, time) {
        var lo = 0, hi = candles.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (candles[mid].time < time) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    function nearestCandle(candles, time, policy, drift) {
        if (!window.ChartSync) return undefined;
        return window.ChartSync.findNearestCandle(candles, time, policy || 'previous', drift);
    }

    function barSeconds(tf) { return TF_SECONDS[tf] || 300; }

    function activeWorkspace() {
        if (!WS.store) return null;
        var id = WS.activeId;
        for (var i = 0; i < WS.store.workspaces.length; i++) {
            if (WS.store.workspaces[i].id === id) return WS.store.workspaces[i];
        }
        return WS.store.workspaces[0];
    }

    function capacity(ws) {
        if (!ws) return 1;
        if (ws.layout === 'custom') return ws.charts.length;
        var spec = LAYOUTS[ws.layout] || LAYOUTS['4'];
        return spec.cols * spec.rows;
    }

    /* ── Bridge (Qt QWebChannel or test stub) ─────────────────────────────── */

    var Bridge = {
        obj: null,
        ready: false,
        stub: null,
        connect: function (cb) {
            if (window.__WS_STUB__) {
                this.stub = window.__WS_STUB__;
                this.obj = this.stub;
                this.ready = true;
                this._attach(function (reqId, payload) {
                    Bridge._resolve(reqId, payload);
                });
                cb();
                return;
            }
            if (typeof QWebChannel === 'undefined' || typeof qt === 'undefined') {
                console.error('QWebChannel unavailable');
                cb(new Error('QWebChannel unavailable'));
                return;
            }
            new QWebChannel(qt.webChannelTransport, function (channel) {
                Bridge.obj = channel.objects.bridge;
                Bridge.ready = true;
                Bridge._attach(function (reqId, payload) {
                    Bridge._resolve(reqId, payload);
                });
                cb();
            });
        },
        _attach: function (handler) {
            if (this.stub) {
                this.stub.on('dataReady', handler);
            } else if (this.obj && this.obj.dataReady) {
                this.obj.dataReady.connect(handler);
            }
        },
        _resolve: function (reqId, payload) {
            var entry = WS.pending[reqId];
            if (!entry) return;
            clearTimeout(entry.timer);
            delete WS.pending[reqId];
            var parsed = payload;
            if (typeof payload === 'string') {
                try { parsed = JSON.parse(payload); }
                catch (err) { entry.reject(new Error('Malformed bridge payload')); return; }
            }
            if (parsed && parsed.ok === false) entry.reject(new Error(parsed.error || 'Request failed'));
            else entry.resolve(parsed);
        },
        /**
         * QWebChannel methods return values through a callback appended to the
         * argument list (there is no synchronous return). Wrap that in a Promise.
         */
        call: function (method, args) {
            if (!this.ready || !this.obj || typeof this.obj[method] !== 'function') {
                return Promise.reject(new Error('Bridge method unavailable: ' + method));
            }
            return new Promise(function (resolve, reject) {
                var done = function (raw) {
                    try {
                        resolve(typeof raw === 'string' ? JSON.parse(raw) : raw);
                    } catch (err) {
                        reject(new Error('Malformed bridge response: ' + method));
                    }
                };
                try {
                    Bridge.obj[method].apply(Bridge.obj, (args || []).concat([done]));
                } catch (err) {
                    reject(err);
                }
            });
        },
        request: function (method, args) {
            if (!this.ready) return Promise.reject(new Error('Bridge not connected'));
            var reqId = String(++WS.reqSeq);
            return new Promise(function (resolve, reject) {
                var timer = setTimeout(function () {
                    delete WS.pending[reqId];
                    reject(new Error('Request timed out'));
                }, 30000);
                WS.pending[reqId] = { resolve: resolve, reject: reject, timer: timer };
                try {
                    Bridge.obj[method].apply(Bridge.obj, [reqId].concat(args || []));
                } catch (err) {
                    clearTimeout(timer);
                    delete WS.pending[reqId];
                    reject(err);
                }
            });
        }
    };

    /* ── Status / toast / prefs ───────────────────────────────────────────── */

    function setStatus(text, kind) {
        var pill = $('#ws-status');
        if (!pill) return;
        pill.textContent = text;
        pill.className = 'status-pill' + (kind ? ' ' + kind : '');
    }

    function toast(message, isError) {
        var node = $('#ws-toast');
        node.textContent = message;
        node.className = isError ? 'error show' : 'show';
        clearTimeout(WS.statusTimer);
        WS.statusTimer = setTimeout(function () { node.className = ''; }, 2600);
    }

    function loadPrefs() {
        try {
            var raw = localStorage.getItem(PREFS_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.recent)) WS.prefs.recent = parsed.recent.slice(0, 12);
                if (parsed && (parsed.drawMagnet === 'off' || parsed.drawMagnet === 'weak')) {
                    WS.prefs.drawMagnet = parsed.drawMagnet;
                }
                if (parsed && Array.isArray(parsed.drawRecent)) {
                    WS.prefs.drawRecent = parsed.drawRecent.filter(function (kind) {
                        return ChartDrawings.isKnownKind(kind);
                    }).slice(0, 8);
                }
                if (parsed && Array.isArray(parsed.drawFavorites)) {
                    WS.prefs.drawFavorites = parsed.drawFavorites.filter(function (kind) {
                        return ChartDrawings.isKnownKind(kind);
                    }).slice(0, ChartDrawings.MAX_FAVORITES);
                }
            }
        } catch (err) { /* storage may be unavailable */ }
    }

    function savePrefs() {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(WS.prefs)); } catch (err) { /* ignore */ }
    }

    function prefKey(exchange, market, symbol) { return exchange + '|' + market + '|' + symbol; }

    function touchRecent(exchange, market, symbol) {
        var key = prefKey(exchange, market, symbol);
        WS.prefs.recent = WS.prefs.recent.filter(function (k) { return k !== key; });
        WS.prefs.recent.unshift(key);
        WS.prefs.recent = WS.prefs.recent.slice(0, 10);
        savePrefs();
    }

    /* ── Menu / modal primitives ──────────────────────────────────────────── */

    function closeMenu() {
        var menu = $('#pop-menu');
        if (!menu) return;
        menu.classList.remove('open');
        menu.innerHTML = '';
        WS.menu = null;
        WS.menuAnchor = null;
    }

    function openMenu(anchor, items, title) {
        var menu = $('#pop-menu');
        menu.innerHTML = '';
        if (title) menu.appendChild(el('div', 'pop-title', title));
        items.forEach(function (item) {
            if (!item) return;
            if (item.sep) { menu.appendChild(el('div', 'pop-sep')); return; }
            var btn = el('button', 'pop-item');
            btn.type = 'button';
            btn.setAttribute('role', 'menuitem');
            if (item.checked) btn.setAttribute('aria-checked', 'true');
            if (item.disabled) btn.disabled = true;
            if (item.icon) btn.appendChild(panelIcon(item.icon, 16));
            btn.appendChild(el('span', '', item.label));
            if (item.hint) btn.appendChild(el('span', 'key', item.hint));
            if (item.tag) btn.appendChild(el('span', 'tag', item.tag));
            btn.addEventListener('click', function () {
                closeMenu();
                if (item.onClick) item.onClick();
            });
            menu.appendChild(btn);
        });
        var rect = anchor.getBoundingClientRect();
        menu.classList.add('open');
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var left = Math.min(rect.left, window.innerWidth - mw - 8);
        var top = rect.bottom + 4;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
        menu.style.left = Math.max(6, left) + 'px';
        menu.style.top = top + 'px';
        WS.menu = menu;
        WS.menuAnchor = anchor;
    }

    function openModal(opts) {
        closeMenu();
        WS.modal = opts;
        $('#modal-title').textContent = opts.title || '';
        $('#modal-sub').textContent = opts.sub || '';
        var body = $('#modal-body');
        body.innerHTML = '';
        if (opts.body) body.appendChild(opts.body);
        var foot = $('#modal-foot');
        foot.innerHTML = '';
        if (opts.foot) foot.appendChild(opts.foot);
        $('#ws-modal-backdrop').classList.add('open');
        if (opts.onOpen) setTimeout(opts.onOpen, 0);
    }

    function closeModal() {
        var modal = WS.modal;
        WS.modal = null;
        $('#ws-modal-backdrop').classList.remove('open');
        $('#modal-body').innerHTML = '';
        $('#modal-foot').innerHTML = '';
        // A dialog may hold uncommitted state (the study settings preview):
        // it gets the dismissal so it can roll back.
        if (modal && typeof modal.onClose === 'function') {
            try { modal.onClose(); } catch (err) { console.error('modal onClose failed', err); }
        }
    }

    function openPrompt(title, value, onOk) {
        var input = el('input', 'input');
        input.value = value || '';
        input.maxLength = 60;
        input.style.width = '100%';
        var body = el('div');
        body.appendChild(input);
        var foot = document.createElement('div');
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        foot.style.marginLeft = 'auto';
        var cancel = el('button', 'btn-ghost', 'Cancel');
        var ok = el('button', 'btn-ghost primary', 'Apply');
        cancel.addEventListener('click', closeModal);
        ok.addEventListener('click', function () {
            var text = input.value.trim();
            if (!text) { input.focus(); return; }
            closeModal();
            onOk(text);
        });
        input.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') ok.click();
            if (ev.key === 'Escape') closeModal();
        });
        foot.appendChild(cancel);
        foot.appendChild(ok);
        openModal({ title: title, body: body, foot: foot, onOpen: function () { input.focus(); input.select(); } });
    }

    /** Small blocking dialog: `choices` = [{label, action, primary}] (last = default). */
    function openChoice(title, message, choices) {
        var body = el('div', 'choice-body');
        var text = el('p', 'choice-text');
        text.textContent = message;
        body.appendChild(text);
        var foot = document.createElement('div');
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        foot.style.marginLeft = 'auto';
        choices.forEach(function (choice) {
            var button = el('button', 'btn-ghost' + (choice.primary ? ' primary' : ''), choice.label);
            button.type = 'button';
            button.addEventListener('click', function () {
                closeModal();
                if (typeof choice.action === 'function') choice.action();
            });
            foot.appendChild(button);
        });
        openModal({ title: title, body: body, foot: foot });
    }

    /* ── Sync manager wiring ──────────────────────────────────────────────── */

    function createSyncManager(ws) {
        WS.sync = new window.ChartSync.ChartSyncManager({
            groups: ws.syncGroups,
            settings: ws.globalSettings,
            onCrosshair: function (chartId, time) {
                updateSyncedStrips(chartId, time);
            },
            onCoverageGap: function (chartId, range) {
                var entry = WS.charts[chartId];
                if (entry && range) maybeLoadOlder(entry, range.from);
            },
            onTimeframeSync: function (sourceId, tf, ids) {
                ids.forEach(function (id) {
                    var entry = WS.charts[id];
                    if (entry) changeTimeframe(entry, tf, true);
                });
            },
            onError: function (chartId, op, err) {
                console.warn('[sync]', chartId, op, err && err.message ? err.message : err);
            }
        });
        WS.sync.setDefaultSettings(ws.globalSettings);
        var map = {};
        ws.charts.forEach(function (cfg) { map[cfg.id] = cfg.groupId; });
        WS.sync.setChartGroups(map);
    }

    /* ── Panel construction ───────────────────────────────────────────────── */

    function panelIcon(paths, size) {
        if (typeof paths === 'string') {
            var named = window.OTIcons && window.OTIcons.el(paths, size || 18);
            if (named) return named;
            paths = ['M4 12h16'];
        }
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        paths.forEach(function (d) {
            var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        });
        return svg;
    }

    /** Fill static `data-icon` placeholders from the shared SVG registry. */
    function hydrateIcons() {
        if (!window.OTIcons) return;
        document.querySelectorAll('[data-icon]').forEach(function (node) {
            var name = node.getAttribute('data-icon');
            if (!name || !window.OTIcons.has(name)) return;
            var size = Number(node.getAttribute('data-icon-size')) || 18;
            var icon = window.OTIcons.el(name, size);
            if (icon) node.replaceChildren(icon);
        });
        syncThemeButton();
    }

    function syncThemeButton() {
        var btn = $('#btn-theme');
        if (!btn) return;
        var light = currentTheme() === 'light';
        btn.replaceChildren(panelIcon(light ? 'tp-sun' : 'tp-moon', 18));
        btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
        btn.setAttribute('aria-label', btn.title);
    }

    function buildPanel(entry) {
        var cfg = entry.config;
        var panel = el('section', 'panel');
        panel.dataset.chartId = cfg.id;

        var head = el('header', 'panel-head');

        var grip = el('span', 'drag-grip');
        grip.appendChild(panelIcon('dt-drag', 14));
        grip.title = 'Drag to rearrange panels';
        grip.setAttribute('draggable', 'true');
        head.appendChild(grip);

        var dot = el('button', 'group-dot');
        dot.type = 'button';
        dot.title = 'Synchronization group';
        dot.setAttribute('aria-label', 'Synchronization group');
        head.appendChild(dot);

        var symBtn = el('button', 'symbol-btn');
        symBtn.type = 'button';
        symBtn.title = 'Change exchange / symbol';
        var exSpan = el('span', 'ex', cfg.exchange);
        var symSpan = el('span', 'sym', cfg.symbol);
        var mktSpan = el('span', 'mkt', cfg.market === 'futures' ? 'PERP' : 'SPOT');
        symBtn.appendChild(exSpan);
        symBtn.appendChild(symSpan);
        symBtn.appendChild(mktSpan);
        head.appendChild(symBtn);

        var tfBtn = el('button', 'head-btn tf-btn');
        tfBtn.type = 'button';
        tfBtn.title = 'Timeframe';
        tfBtn.appendChild(el('span', 'tf-label', tfLabel(cfg.timeframe)));
        tfBtn.appendChild(panelIcon('tp-chevron-down', 12));
        head.appendChild(tfBtn);

        var typeBtn = el('button', 'head-btn type-btn');
        typeBtn.type = 'button';
        typeBtn.title = 'Chart type';
        var typeIco = el('span', 'type-ico');
        typeIco.appendChild(panelIcon('header-candles', 15));
        typeBtn.appendChild(typeIco);
        typeBtn.appendChild(el('span', 'type-label', ''));
        typeBtn.appendChild(panelIcon('tp-chevron-down', 12));
        head.appendChild(typeBtn);

        var priceSpan = el('span', 'head-price', '—');
        var chgSpan = el('span', 'head-chg flat', '—');
        head.appendChild(priceSpan);
        head.appendChild(chgSpan);

        var tools = el('div', 'panel-tools');
        var indBtn = el('button', 'icon-btn');
        indBtn.type = 'button';
        indBtn.dataset.action = 'indicators';
        indBtn.title = 'Indicators';
        indBtn.setAttribute('aria-label', 'Indicators');
        indBtn.appendChild(panelIcon('header-indicators-metrics-and-strategies', 17));
        var refBtn = el('button', 'icon-btn');
        refBtn.type = 'button';
        refBtn.dataset.action = 'reference';
        refBtn.title = 'Price-scale reference point';
        refBtn.setAttribute('aria-label', 'Price-scale reference point');
        refBtn.appendChild(panelIcon('dt-anchor', 17));
        refBtn.style.display = 'none';
        var drawBtn = el('button', 'icon-btn');
        drawBtn.type = 'button';
        drawBtn.dataset.action = 'draw';
        drawBtn.title = 'Drawing tools';
        drawBtn.setAttribute('aria-label', 'Drawing tools');
        drawBtn.appendChild(panelIcon('draw-brush', 17));
        var statsBtn = el('button', 'icon-btn');
        statsBtn.type = 'button';
        statsBtn.dataset.action = 'stats';
        statsBtn.dataset.statsToggle = '1';
        entry.statsButtons = [statsBtn];
        syncStatsButtons(entry);
        var maxBtn = el('button', 'icon-btn');
        maxBtn.type = 'button';
        maxBtn.dataset.action = 'maximize';
        maxBtn.title = 'Maximize / restore';
        maxBtn.setAttribute('aria-label', 'Maximize or restore');
        maxBtn.appendChild(panelIcon('chart-maximize', 17));
        var closeBtn = el('button', 'icon-btn');
        closeBtn.type = 'button';
        closeBtn.dataset.action = 'close';
        closeBtn.title = 'Remove chart';
        closeBtn.setAttribute('aria-label', 'Remove chart');
        closeBtn.appendChild(panelIcon('tab-close', 17));
        tools.appendChild(indBtn);
        tools.appendChild(refBtn);
        tools.appendChild(drawBtn);
        tools.appendChild(statsBtn);
        tools.appendChild(maxBtn);
        tools.appendChild(closeBtn);
        head.appendChild(tools);

        var body = el('div', 'panel-body');
        var host = el('div', 'chart-host');
        var hostInner = el('div');
        host.appendChild(hostInner);
        body.appendChild(host);

        // OHLC readout follows the crosshair; indicator legends are anchored
        // to the top-left of their own pane (OpenTrader layout).
        var strip = el('div', 'ohlc-strip');
        var stripValues = el('div', 'lv-values');
        strip.appendChild(stripValues);
        body.appendChild(strip);

        var legend = el('div', 'ind-legend-layer');
        body.appendChild(legend);

        var agg = el('div', 'agg-note');
        body.appendChild(agg);

        var rail = buildDrawRail(entry);
        body.appendChild(rail);

        var textEditor = el('div', 'text-editor');
        var textInput = el('input');
        textInput.type = 'text';
        textInput.maxLength = 120;
        textInput.placeholder = 'Annotation…';
        textEditor.appendChild(textInput);
        body.appendChild(textEditor);

        var overlay = el('div', 'panel-overlay');
        body.appendChild(overlay);

        var drawCanvas = el('canvas', 'draw-layer');
        body.appendChild(drawCanvas);

        var controls = buildChartControls(entry);
        body.appendChild(controls);

        var foot = el('footer', 'panel-foot');
        var live = el('span', 'live', 'live');
        var bars = el('span', 'bars', '—');
        var ms = el('span', 'ms', '');
        foot.appendChild(live);
        foot.appendChild(bars);
        foot.appendChild(el('span', 'spacer'));
        foot.appendChild(ms);

        panel.appendChild(head);
        panel.appendChild(body);
        panel.appendChild(foot);

        entry.panel = panel;
        entry.head = head;
        entry.host = hostInner;
        entry.body = body;
        entry.ohlcStrip = strip;
        entry.stripValues = stripValues;
        entry.aggNote = agg;
        entry.overlay = overlay;
        entry.drawCanvas = drawCanvas;
        entry.legend = legend;
        entry.chartControls = controls;
        entry.textEditor = textEditor;
        entry.textInput = textInput;
        entry.priceSpan = priceSpan;
        entry.chgSpan = chgSpan;
        entry.tfBtn = tfBtn;
        entry.typeBtn = typeBtn;
        entry.symBtn = symBtn;
        entry.groupDot = dot;
        entry.rail = rail;
        entry.refBtn = refBtn;
        entry.liveEl = live;
        entry.barsEl = bars;
        entry.msEl = ms;

        wirePanel(entry);
        updateTypeLabel(entry);
        updateGroupVisual(entry);
        return panel;
    }

    function statsToggleIcon(visible) {
        return visible ? 'st-legend-eye-show' : 'draw-hide-indicators';
    }

    function syncStatsButtons(entry) {
        var visible = entry.posSettings.showStats !== false;
        (entry.statsButtons || []).forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(visible));
            btn.title = visible ? 'Hide position stats card' : 'Show position stats card';
            btn.setAttribute('aria-label', btn.title);
            btn.replaceChildren(panelIcon(statsToggleIcon(visible)));
        });
    }

    function togglePositionStats(entry) {
        entry.posSettings.showStats = entry.posSettings.showStats === false;
        savePositionSettings(entry);
        syncStatsButtons(entry);
        renderDrawings(entry);
    }

    /** Floating pane navigation: zoom, reset view, jump to the latest bar. */
    function buildChartControls(entry) {
        var bar = el('div', 'chart-controls');
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Chart navigation');
        bar.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });

        function control(icon, title, action) {
            var btn = el('button', 'cc-btn');
            btn.type = 'button';
            btn.title = title;
            btn.setAttribute('aria-label', title);
            btn.appendChild(panelIcon(icon, 16));
            btn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                action();
            });
            bar.appendChild(btn);
            return btn;
        }

        function zoom(factor) {
            var chart = entry.chart;
            if (!chart) return;
            var ts = chart.timeScale();
            var range = ts.getVisibleLogicalRange();
            if (!range) return;
            var mid = (range.from + range.to) / 2;
            var half = Math.max(4, (range.to - range.from) * factor / 2);
            ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
        }

        control('chart-zoom-out', 'Zoom out (Ctrl + ↓)', function () { zoom(1.25); });
        control('chart-zoom-in', 'Zoom in (Ctrl + ↑)', function () { zoom(0.8); });
        control('chart-reset-view', 'Reset chart view (Alt + R)', function () {
            if (!entry.chart) return;
            resetPricePan(entry);
            entry.chart.timeScale().fitContent();
        });
        control('chart-goto-realtime', 'Go to the latest bar (→)', function () {
            if (!entry.chart) return;
            var ts = entry.chart.timeScale();
            if (ts.scrollToRealTime) ts.scrollToRealTime();
            else {
                var range = ts.getVisibleLogicalRange();
                if (range) {
                    var span = range.to - range.from;
                    ts.setVisibleLogicalRange({ from: entry.candles.length - span, to: entry.candles.length });
                }
            }
        });
        return bar;
    }

    function toolIconName(id) {
        if (id === 'select') return 'draw-cursor';
        if (id === 'measure') return 'draw-measure';
        if (id === 'long') return 'draw-position';
        if (id === 'short') return 'draw-short-position';
        return ChartDrawings.iconNameFor(id);
    }

    function railButton(entry, spec, onActivate) {
        var btn = el('button');
        btn.type = 'button';
        btn.dataset.tool = spec.id;
        btn.title = spec.label;
        btn.setAttribute('aria-label', spec.label);
        btn.setAttribute('aria-pressed', 'false');
        btn.appendChild(panelIcon(toolIconName(spec.id) || spec.icon));
        btn.addEventListener('click', onActivate);
        return btn;
    }

    function buildDrawRail(entry) {
        var rail = el('div', 'draw-rail');
        entry.rail = rail;
        renderDrawRail(entry);
        return rail;
    }

    /** Toolbar = cursor + the user's pinned tools + app utilities. */
    function renderDrawRail(entry) {
        var rail = entry.rail;
        if (!rail) return;
        rail.innerHTML = '';

        var cursor = ChartDrawings.PRIMARY[0];
        rail.appendChild(railButton(entry, cursor, function () { chooseDrawTool(entry, 'select'); }));

        var favorites = drawFavorites();
        if (favorites.length) {
            rail.appendChild(el('div', 'sep'));
            favorites.forEach(function (kind) {
                var tool = ChartDrawings.TOOL_BY_KIND[kind];
                if (!tool) return;
                var btn = railButton(entry, {
                    id: kind,
                    label: tool.label + ' — pinned · right-click to unpin',
                    icon: ChartDrawings.iconFor(kind)
                }, function () { chooseDrawTool(entry, kind); });
                btn.title = tool.label + ' — pinned · right-click to unpin';
                btn.addEventListener('contextmenu', function (ev) {
                    ev.preventDefault();
                    toggleDrawFavorite(kind);
                });
                rail.appendChild(btn);
            });
        }

        rail.appendChild(el('div', 'sep'));
        var allBtn = el('button');
        allBtn.type = 'button';
        allBtn.dataset.action = 'all-tools';
        allBtn.title = 'All drawing tools';
        allBtn.setAttribute('aria-label', 'All drawing tools');
        allBtn.setAttribute('aria-haspopup', 'dialog');
        allBtn.appendChild(panelIcon('draw-show-favorite-drawing-tools-toolbar'));
        allBtn.addEventListener('click', function () { openToolPalette(entry); });
        rail.appendChild(allBtn);

        var magnetBtn = el('button');
        magnetBtn.type = 'button';
        magnetBtn.title = 'Magnet — snap anchors to OHLC';
        magnetBtn.setAttribute('aria-label', 'Toggle magnet');
        magnetBtn.appendChild(panelIcon('draw-magnet'));
        magnetBtn.addEventListener('click', function () { toggleDrawMagnet(entry); });
        entry.drawMagnetBtn = magnetBtn;
        rail.appendChild(magnetBtn);

        var eyeBtn = el('button');
        eyeBtn.type = 'button';
        eyeBtn.title = 'Hide all drawings';
        eyeBtn.setAttribute('aria-label', 'Hide or show all drawings');
        eyeBtn.appendChild(panelIcon('draw-hide-all-drawings'));
        eyeBtn.addEventListener('click', function () { toggleDrawVisibility(entry); });
        entry.drawEyeBtn = eyeBtn;
        rail.appendChild(eyeBtn);

        rail.appendChild(el('div', 'sep'));
        ChartDrawings.PRIMARY.slice(-3).forEach(function (tool) {
            rail.appendChild(railButton(entry, {
                id: tool.id,
                label: tool.label,
                icon: tool.icon
            }, function () { chooseDrawTool(entry, tool.id); }));
        });

        rail.appendChild(el('div', 'sep'));
        var gear = el('button');
        gear.type = 'button';
        gear.title = 'Trade position tool — account, risk, display';
        gear.setAttribute('aria-label', 'Position settings');
        gear.appendChild(panelIcon('dt-settings'));
        gear.addEventListener('click', function () { openPositionSettings(entry); });
        rail.appendChild(gear);

        var railStatsBtn = el('button');
        railStatsBtn.type = 'button';
        railStatsBtn.dataset.statsToggle = '1';
        railStatsBtn.addEventListener('click', function () { togglePositionStats(entry); });
        entry.statsButtons = (entry.statsButtons || []).filter(function (btn) {
            return btn.isConnected && !btn.closest('.draw-rail');
        });
        entry.statsButtons.push(railStatsBtn);
        syncStatsButtons(entry);
        rail.appendChild(railStatsBtn);

        var clear = el('button');
        clear.type = 'button';
        clear.title = 'Clear all drawings, position boxes and the measurement';
        clear.setAttribute('aria-label', 'Clear all drawings');
        clear.appendChild(panelIcon('draw-trash'));
        clear.addEventListener('click', function () {
            if (entry.drawMgr) entry.drawMgr.clear();
            entry.config.drawings = [];
            entry.positions.length = 0;
            entry.measure = null;
            entry.measureDraft = null;
            entry.measureDrag = null;
            entry.selectedMeasure = false;
            entry.selectedPosition = null;
            savePositions(entry);
            updateDrawStyleBar(entry);
            renderDrawings(entry);
            scheduleSave();
        });
        rail.appendChild(clear);
        syncDrawToolButtons(entry);
    }

    /* ── Favourite tools (pinned on the rail) ───────────────────────────── */

    function drawFavorites() {
        var stored = WS.prefs.drawFavorites;
        if (!Array.isArray(stored)) return ChartDrawings.DEFAULT_FAVORITES.slice();
        var seen = {};
        return stored.filter(function (kind) {
            if (!ChartDrawings.isKnownKind(kind) || seen[kind]) return false;
            seen[kind] = true;
            return true;
        }).slice(0, ChartDrawings.MAX_FAVORITES);
    }

    function toggleDrawFavorite(kind) {
        if (!ChartDrawings.isKnownKind(kind)) return;
        var list = drawFavorites().slice();
        var index = list.indexOf(kind);
        if (index >= 0) {
            list.splice(index, 1);
        } else {
            if (list.length >= ChartDrawings.MAX_FAVORITES) {
                toast('Up to ' + ChartDrawings.MAX_FAVORITES + ' pinned tools — unpin one first', true);
                return;
            }
            list.push(kind);
        }
        WS.prefs.drawFavorites = list;
        savePrefs();
        Object.keys(WS.charts).forEach(function (id) { renderDrawRail(WS.charts[id]); });
        syncFavoriteButtons();
        toast(index >= 0
            ? ChartDrawings.kindLabel(kind) + ' unpinned'
            : ChartDrawings.kindLabel(kind) + ' pinned to the drawing toolbar');
    }

    function starIcon(on) {
        return on ? 'draw-remove-from-favorites' : 'draw-add-to-favorites';
    }

    function syncFavoriteButtons() {
        var favorites = drawFavorites();
        document.querySelectorAll('.draw-palette .dp-fav').forEach(function (btn) {
            var on = favorites.indexOf(btn.dataset.favorite) >= 0;
            btn.setAttribute('aria-pressed', String(on));
            btn.title = on ? 'Remove from the drawing toolbar' : 'Pin to the drawing toolbar';
            btn.setAttribute('aria-label', btn.title);
            btn.replaceChildren(panelIcon(starIcon(on), 15));
        });
    }

    /** Single entry point for picking a tool from the rail or the catalog. */
    function chooseDrawTool(entry, kind) {
        if (kind === 'image') { pickDrawImage(entry); return; }
        if (kind === 'font-icon') { pickDrawGlyph(entry); return; }
        setDrawTool(entry, kind);
    }

    function wirePanel(entry) {
        var cfg = entry.config;
        var panel = entry.panel;

        panel.addEventListener('pointerdown', function () {
            focusChart(entry);
        }, true);

        panel.addEventListener('dragstart', function (ev) {
            if (!ev.target.classList || !ev.target.classList.contains('drag-grip')) {
                ev.preventDefault();
                return;
            }
            WS.dragChartId = cfg.id;
            ev.dataTransfer.effectAllowed = 'move';
            try { ev.dataTransfer.setData('text/plain', cfg.id); } catch (err) { /* ignore */ }
        });
        panel.addEventListener('dragover', function (ev) {
            if (!WS.dragChartId || WS.dragChartId === cfg.id) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            panel.classList.add('drag-over');
        });
        panel.addEventListener('dragleave', function () { panel.classList.remove('drag-over'); });
        panel.addEventListener('drop', function (ev) {
            ev.preventDefault();
            panel.classList.remove('drag-over');
            var dragged = WS.dragChartId;
            WS.dragChartId = null;
            if (!dragged || dragged === cfg.id) return;
            reorderCharts(dragged, cfg.id);
        });
        panel.addEventListener('dragend', function () {
            WS.dragChartId = null;
            panel.classList.remove('drag-over');
        });

        entry.head.querySelectorAll('.panel-tools .icon-btn').forEach(function (btn) {
            btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                switch (btn.dataset.action) {
                    case 'indicators': openIndicatorModal(entry); break;
                    case 'reference': openReferenceMenu(entry, btn); break;
                    case 'draw': toggleRail(entry); break;
                    case 'stats': togglePositionStats(entry); break;
                    case 'maximize': toggleMaximize(entry); break;
                    case 'close': removeChart(entry); break;
                    default: break;
                }
            });
        });

        entry.symBtn.addEventListener('click', function () { openSymbolModal(entry); });
        entry.tfBtn.addEventListener('click', function () { openTimeframeMenu(entry); });
        entry.typeBtn.addEventListener('click', function () { openChartTypeMenu(entry); });
        entry.groupDot.addEventListener('click', function () { openGroupMenu(entry); });
        entry.head.addEventListener('dblclick', function (ev) {
            if (ev.target.closest('button')) return;
            toggleMaximize(entry);
        });

        entry.textInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                if (entry.tableEditRef) commitDrawTableCell(entry);
                else commitDrawText(entry);
            } else if (ev.key === 'Escape') {
                if (entry.tableEditRef) cancelDrawTableCell(entry);
                else cancelDrawText(entry);
            }
        });
        entry.textInput.addEventListener('blur', function () {
            setTimeout(function () {
                if (entry.tableEditRef) cancelDrawTableCell(entry);
                else if (entry.pendingText) cancelDrawText(entry);
            }, 120);
        });

        wireDrawingCanvas(entry);
    }

    /* ── Theme ───────────────────────────────────────────────────────────────
       Pi Scope tokens in workspace.html are the single source of truth; the
       canvas needs concrete colours, so they are cached here and re-read when
       the shell toggles the theme (localStorage `tp-theme`, same origin). */
    function readTheme() {
        var cs = window.getComputedStyle(document.documentElement);
        var pick = function (name, fallback) {
            var value = cs.getPropertyValue(name);
            value = value ? value.trim() : '';
            return value || fallback;
        };
        THEME = {
            bg: pick('--chart-bg', '#1c1c1b'),
            panel: pick('--panel', '#1a1a19'),
            text: pick('--chart-text', '#b1b0a7'),
            muted: pick('--chart-muted', '#a09f95'),
            ink: pick('--chart-ink', '#f3f1e9'),
            grid: pick('--chart-grid', 'rgba(255,255,255,0.045)'),
            crosshair: pick('--chart-crosshair', '#6f6e66'),
            border: pick('--chart-border', '#3b3b36'),
            up: pick('--chart-up', '#089981'),
            down: pick('--chart-down', '#f23645'),
            upText: pick('--chart-up-text', '#22ab94'),
            downText: pick('--chart-down-text', '#f7525f'),
            upRgb: pick('--chart-up-rgb', '8, 153, 129'),
            downRgb: pick('--chart-down-rgb', '242, 54, 69'),
            accent: pick('--accent', '#ffd43b'),
            accentRgb: pick('--accent-rgb', '255, 212, 59')
        };
    }
    var THEME = {};
    readTheme();

    function rgbaOf(name, alpha) {
        return 'rgba(' + THEME[name] + ',' + alpha + ')';
    }

    function volumeAlpha() {
        return currentTheme() === 'light' ? 0.45 : 0.32;
    }

    function themeOptions() {
        return {
            layout: {
                background: { type: 'solid', color: THEME.bg },
                textColor: THEME.text,
                fontSize: 12,
                fontFamily: "'MesloLGS NFM', 'JetBrains Mono', ui-monospace, monospace"
            },
            grid: {
                vertLines: { color: THEME.grid },
                horzLines: { color: THEME.grid }
            },
            crosshair: {
                vertLine: { color: THEME.crosshair, width: 1, style: window.LightweightCharts.LineStyle.Dashed, labelBackgroundColor: THEME.accent },
                horzLine: { color: THEME.crosshair, width: 1, style: window.LightweightCharts.LineStyle.Dashed, labelBackgroundColor: THEME.accent }
            },
            rightPriceScale: { borderColor: THEME.border },
            timeScale: { borderColor: THEME.border }
        };
    }

    /** Series colours per chart style, derived from the active theme. */
    function seriesTheme(type) {
        if (type === 'hollow') {
            return {
                upColor: THEME.bg, downColor: THEME.down,
                borderUpColor: THEME.up, borderDownColor: THEME.down,
                wickUpColor: THEME.up, wickDownColor: THEME.down,
                borderVisible: true
            };
        }
        if (type === 'bar') return { upColor: THEME.up, downColor: THEME.down, thinBars: false };
        if (type === 'line') return { color: THEME.accent, lineWidth: 2 };
        if (type === 'area') {
            return {
                lineColor: THEME.accent, lineWidth: 2,
                topColor: rgbaOf('accentRgb', 0.24), bottomColor: rgbaOf('accentRgb', 0.02)
            };
        }
        if (type === 'baseline') {
            return {
                topLineColor: THEME.up, bottomLineColor: THEME.down,
                topFillColor1: rgbaOf('upRgb', 0.22), topFillColor2: rgbaOf('upRgb', 0.02),
                bottomFillColor1: rgbaOf('downRgb', 0.02), bottomFillColor2: rgbaOf('downRgb', 0.22)
            };
        }
        return {
            upColor: THEME.up, downColor: THEME.down,
            borderUpColor: THEME.up, borderDownColor: THEME.down,
            wickUpColor: THEME.up, wickDownColor: THEME.down
        };
    }

    /* ── Chart lifecycle ──────────────────────────────────────────────────── */

    // Right-scale padding; temporarily zeroed while a vertical price drag is
    // active so the frozen range maps 1:1 to the pane (see capturePanBase).
    var PRICE_SCALE_MARGINS = { top: 0.08, bottom: 0.22 };

    function chartOptions() {
        var options = themeOptions();
        options.crosshair.mode = window.LightweightCharts.CrosshairMode.Normal;
        options.rightPriceScale.scaleMargins = {
            top: PRICE_SCALE_MARGINS.top,
            bottom: PRICE_SCALE_MARGINS.bottom
        };
        options.rightPriceScale.minimumWidth = 72;
        options.timeScale.timeVisible = true;
        options.timeScale.secondsVisible = false;
        options.timeScale.rightOffset = 6;
        options.timeScale.barSpacing = 7;
        options.handleScroll = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
        options.handleScale = { mouseWheel: true, pinch: true, axisPressedMouseMove: true };
        return options;
    }

    function makeEntry(cfg) {
        var entry = {
            id: cfg.id,
            config: cfg,
            candles: [],
            display: [],
            rawByTime: new Map(),
            indicatorRuntimes: [],
            indicatorSignature: null,
            indicatorSeq: 0,
            indicatorPaneCount: 0,
            indicatorRangeTimer: null,
            precision: 2,
            minMove: 0.01,
            refPrice: null,
            absRange: null,
            priceOffset: 0,
            pricePan: null,
            panBase: null,
            hasMore: true,
            loadingOlder: false,
            loadSeq: 0,
            loadedAt: 0,
            lastBarTime: null,
            tickTimer: null,
            tickSeq: 0,
            drawTool: null,
            drawMgr: null,
            drawSpace: null,
            drawSyncing: false,
            drawDirty: false,
            drawStyleBar: null,
            drawPalette: null,
            drawMagnetBtn: null,
            drawEyeBtn: null,
            directPointerId: null,
            positions: [],
            selectedPosition: null,
            posSettings: null,
            measure: null,
            positions: [],
            selectedPosition: null,
            positionDrag: null,
            posDraft: null,
            posSettings: loadPositionSettings(),
            pendingOverlay: null,
            focusRange: null,
            measure: null,
            measureDraft: null,
            measureDrag: null,
            selectedMeasure: false,
            drawDrag: null,
            pendingText: null,
            tableEditRef: null,
            pickRef: false,
            rafId: null,
            allowBackfill: false,
            destroyed: false
        };
        WS.charts[cfg.id] = entry;
        entry.positions = loadPositions(entry);
        entry.panel = buildPanel(entry);
        createChart(entry);
        $('#ws-grid').appendChild(entry.panel);
        loadData(entry, { resetView: true, view: cfg.view });
        return entry;
    }

    function createChart(entry) {
        var chart = window.LightweightCharts.createChart(entry.host, chartOptions());
        entry.chart = chart;
        entry.mainSeries = createMainSeries(entry, entry.config.chartType);
        entry.volumeSeries = chart.addSeries(window.LightweightCharts.HistogramSeries, {
            priceScaleId: 'volume',
            priceFormat: { type: 'volume' }
        });
        entry.volumeSeries.applyOptions({
            title: '',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            visible: entry.config.showVolume !== false
        });
        chart.priceScale('volume').applyOptions({
            visible: false,
            borderVisible: false,
            scaleMargins: { top: 0.84, bottom: 0 }
        });
        installAutoscaleProvider(entry);
        attachDrawings(entry);

        wireChartUI(entry);

        entry.resizeObserver = new ResizeObserver(function () {
            if (entry.destroyed) return;
            var w = entry.host.clientWidth, h = entry.host.clientHeight;
            if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
            resizeDrawCanvas(entry);
            positionIndicatorLegends(entry);
            scheduleDraw(entry);
        });
        entry.resizeObserver.observe(entry.host);

        entry.rangeHandler = function (range) {
            if (entry.destroyed) return;
            scheduleDraw(entry);
            if (range) {
                if (entry.config.referenceMode === 'first_visible' &&
                    (entry.config.priceScaleMode === 'percentage' || entry.config.priceScaleMode === 'indexed')) {
                    scheduleReferenceRefresh(entry);
                }
                scheduleVisibleRangeIndicators(entry);
            }
        };
        chart.timeScale().subscribeVisibleTimeRangeChange(entry.rangeHandler);

        // Lazy history: requested when a *user* gesture reaches the left edge
        // (LWC clamps time ranges to loaded data, so logical range is the signal).
        entry.logicalRangeHandler = function (logical) {
            if (entry.destroyed || !logical || !entry.allowBackfill) return;
            if (logical.from <= 3) {
                maybeLoadOlder(entry, entry.candles.length
                    ? entry.candles[0].time - barSeconds(entry.config.timeframe)
                    : null);
            }
        };
        chart.timeScale().subscribeVisibleLogicalRangeChange(entry.logicalRangeHandler);

        WS.sync.register({
            chartId: entry.id,
            chart: chart,
            mainSeries: entry.mainSeries,
            barSeconds: barSeconds(entry.config.timeframe),
            timeframe: entry.config.timeframe,
            groupId: entry.config.groupId,
            isReady: function () { return entry.candles.length > 0; },
            getDataAtTime: function (time) { return entry.rawByTime.get(time); },
            getNearestDataAtTime: function (time, opts) {
                var policy = (opts && opts.policy) || 'previous';
                var drift = opts ? opts.maxDriftSeconds : null;
                return nearestCandle(entry.display, time, policy, drift);
            },
            getVisiblePriceRange: function () { return visiblePriceRange(entry); },
            applyAbsoluteRange: function (range) { applyAbsoluteRange(entry, range); },
            getInstrument: function () {
                return {
                    base: (entry.config.symbol || '').split('/')[0],
                    quote: (entry.config.symbol || '').split('/')[1],
                    lastPrice: entry.candles.length ? entry.candles[entry.candles.length - 1].close : 0
                };
            }
        });
    }

    function createMainSeries(entry, type) {
        var chart = entry.chart;
        var opts = {
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: true
        };
        var series;
        var seriesOpts = Object.assign({}, opts, seriesTheme(type));
        var defs = window.LightweightCharts;
        if (type === 'bar') series = chart.addSeries(defs.BarSeries, seriesOpts);
        else if (type === 'line') series = chart.addSeries(defs.LineSeries, seriesOpts);
        else if (type === 'area') series = chart.addSeries(defs.AreaSeries, seriesOpts);
        else if (type === 'baseline') series = chart.addSeries(defs.BaselineSeries, seriesOpts);
        else series = chart.addSeries(defs.CandlestickSeries, seriesOpts);
        series.applyOptions({ priceFormat: priceFormatFor(entry) });
        return series;
    }

    /**
     * Autoscale provider shared by every series on the right price scale.
     * Overlay indicators (SMA/EMA/BB/VWAP/ribbon) contribute their own
     * autoscale ranges; offsetting the main series alone would grow the
     * union while panning and rescale the axis.  Applying the same offset
     * (or the same frozen window while the manual price scale is active) to
     * every series keeps the scale a pure translation.
     */
    function priceScaleRangeProvider(entry) {
        return function (original) {
            var offset = Number(entry.priceOffset) || 0;
            if (entry.panBase) {
                return {
                    priceRange: {
                        minValue: entry.panBase.min + offset,
                        maxValue: entry.panBase.max + offset
                    },
                    margins: { above: 0, below: 0 }
                };
            }
            if (entry.absRange && entry.config.priceScaleMode === 'absolute') {
                return {
                    priceRange: {
                        minValue: entry.absRange.min + offset,
                        maxValue: entry.absRange.max + offset
                    },
                    margins: { above: 0, below: 0 }
                };
            }
            var info = original();
            if (!info || !info.priceRange) return info;
            var minValue = info.priceRange.minValue + offset;
            var maxValue = info.priceRange.maxValue + offset;
            if (entry.focusRange) {
                minValue = Math.min(minValue, entry.focusRange.min);
                maxValue = Math.max(maxValue, entry.focusRange.max);
            }
            if (!offset && !entry.focusRange) return info;
            return {
                priceRange: { minValue: minValue, maxValue: maxValue },
                margins: info.margins
            };
        };
    }

    function attachPriceScaleProvider(entry, series) {
        if (!series || !series.applyOptions) return;
        series.applyOptions({ autoscaleInfoProvider: priceScaleRangeProvider(entry) });
    }

    function installAutoscaleProvider(entry) {
        attachPriceScaleProvider(entry, entry.mainSeries);
    }

    /**
     * Vertical price panning.  Lightweight Charts v4 only pans the time axis
     * with pressedMouseMove; there is no price-range panning API.  We shift the
     * price range through the autoscale provider and force it to re-evaluate
     * by re-updating the latest data point (cheap and does not move the view).
     */
    function pricePanTargets(entry) {
        if (!entry || entry.config.priceScaleMode !== 'absolute' || !entry.config.groupId) {
            return entry ? [entry] : [];
        }
        var out = [];
        Object.keys(WS.charts).forEach(function (id) {
            var other = WS.charts[id];
            if (!other || other.destroyed) return;
            if (other === entry ||
                (other.config.groupId === entry.config.groupId &&
                 other.config.priceScaleMode === 'absolute')) {
                out.push(other);
            }
        });
        return out;
    }

    function refreshPriceOffset(entry, forceAutoScale) {
        if (!entry || entry.destroyed || !entry.mainSeries) return;
        if (forceAutoScale || entry.priceOffset) {
            try { entry.mainSeries.priceScale().applyOptions({ autoScale: true }); } catch (err) { /* ignore */ }
        }
        var data = entry.mainSeries.data ? entry.mainSeries.data() : [];
        if (data && data.length) {
            try { entry.mainSeries.update(data[data.length - 1]); } catch (err) { /* ignore */ }
        }
        scheduleDraw(entry);
    }

    /**
     * Freeze the visible price range when a vertical pan starts.  The frozen
     * window (plus the pan offset) is returned by every series on the right
     * scale, so time pans/zooms and live updates translate the chart without
     * rescaling it; it stays in effect as a manual price scale until reset
     * (double-click the price axis, Center, symbol/timeframe/mode change) or a
     * price-axis gesture.  Lightweight Charts applies scaleMargins on top of
     * the provider range, so the captured display range is only 1:1 with the
     * scale margins zeroed.
     */
    function capturePanBase(entry) {
        if (!entry || entry.destroyed || !entry.mainSeries || entry.panBase) return;
        var box = plotBox(entry);
        if (!box || !isFinite(box.h) || box.h < 1) return;
        var top = entry.mainSeries.coordinateToPrice(0);
        var bottom = entry.mainSeries.coordinateToPrice(Math.max(1, box.h - 1));
        if (top == null || bottom == null || !isFinite(top) || !isFinite(bottom) || top <= bottom) return;
        // The captured range already includes any previous offset.
        entry.priceOffset = 0;
        entry.panBase = { min: bottom, max: top };
        // Zero the scale padding so the frozen range maps 1:1 to the pane
        // (LWC applies scaleMargins on top of the provider range).
        entry.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
    }

    function restoreScaleMargins(entry) {
        try {
            entry.chart.priceScale('right').applyOptions({
                scaleMargins: { top: PRICE_SCALE_MARGINS.top, bottom: PRICE_SCALE_MARGINS.bottom }
            });
        } catch (err) { /* ignore */ }
    }

    function releasePanBase(entry) {
        if (!entry || entry.destroyed || !entry.panBase) return;
        entry.panBase = null;
        restoreScaleMargins(entry);
        refreshPriceOffset(entry, true);
    }

    function clearPanBase(entry) {
        pricePanTargets(entry).forEach(releasePanBase);
    }

    function resetPricePan(entry) {
        pricePanTargets(entry).forEach(function (target) {
            if (!target || target.destroyed) return;
            var hadPanBase = !!target.panBase;
            target.priceOffset = 0;
            target.panBase = null;
            target.focusRange = null;
            if (hadPanBase) restoreScaleMargins(target);
            refreshPriceOffset(target, true);
        });
    }

    function applyVerticalPan(entry, delta) {
        if (!entry || !isFinite(delta) || Math.abs(delta) < 1e-12) return;
        pricePanTargets(entry).forEach(function (target) {
            if (!target || target.destroyed) return;
            capturePanBase(target);
            if (!target.panBase) return;
            target.priceOffset = (Number(target.priceOffset) || 0) + delta;
            refreshPriceOffset(target);
        });
    }

    function destroyEntry(id) {
        var entry = WS.charts[id];
        if (!entry) return;
        entry.destroyed = true;
        clearTimeout(entry.tickTimer);
        clearTimeout(entry.refTimer);
        if (entry.rafId) cancelAnimationFrame(entry.rafId);
        try { if (WS.sync) WS.sync.unregister(id); } catch (err) { /* ignore */ }
        try {
            entry.chart.timeScale().unsubscribeVisibleTimeRangeChange(entry.rangeHandler);
            if (entry.logicalRangeHandler) {
                entry.chart.timeScale().unsubscribeVisibleLogicalRangeChange(entry.logicalRangeHandler);
            }
            if (entry.clickHandler) entry.chart.unsubscribeClick(entry.clickHandler);
            if (entry.crosshairHandler) entry.chart.unsubscribeCrosshairMove(entry.crosshairHandler);
        } catch (err) { /* ignore */ }
        try { if (entry.resizeObserver) entry.resizeObserver.disconnect(); } catch (err) { /* ignore */ }
        try { if (entry.paneObserver) entry.paneObserver.disconnect(); } catch (err) { /* ignore */ }
        try { if (entry._drawDocCleanup) entry._drawDocCleanup(); } catch (err) { /* ignore */ }
        detachDrawings(entry);
        try { entry.chart.remove(); } catch (err) { /* ignore */ }
        if (entry.panel && entry.panel.parentNode) entry.panel.parentNode.removeChild(entry.panel);
        delete WS.charts[id];
        if (WS.focused === id) WS.focused = null;
    }

    function destroyAllCharts() {
        Object.keys(WS.charts).forEach(destroyEntry);
    }

    /* ── Chart UI wiring ─────────────────────────────────────────────────── */

    function wireChartUI(entry) {
        entry.crosshairHandler = function (param) {
            if (entry.destroyed) return;
            if (!param || param.time === undefined || !param.point) {
                hideStrip(entry);
                return;
            }
            var candle = entry.rawByTime.get(param.time);
            if (!candle) {
                candle = nearestCandle(entry.candles, param.time, 'previous', barSeconds(entry.config.timeframe));
            }
            if (candle) showStrip(entry, candle);
            else hideStrip(entry);
            updateLegendValues(entry, param.time == null ? null : param.time);
        };
        entry.chart.subscribeCrosshairMove(entry.crosshairHandler);

        entry.clickHandler = function (param) {
            if (entry.destroyed || !entry.pickRef) return;
            entry.pickRef = false;
            if (param && param.time != null) {
                entry.config.referenceMode = 'custom';
                entry.config.referenceTime = param.time;
                rebuildDisplay(entry, { preserve: true });
                toast('Reference set to ' + new Date(param.time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
                scheduleSave();
            }
        };
        entry.chart.subscribeClick(entry.clickHandler);
    }

    /* ── Data loading / rendering ────────────────────────────────────────── */

    function chartLimit(tf) {
        if (tf === '1M') return 60;
        if (tf === '1w') return 200;
        if (tf === '1d') return 400;
        return 600;
    }

    function loadData(entry, opts) {
        opts = opts || {};
        var cfg = entry.config;
        var seq = ++entry.loadSeq;
        // Invalidate in-flight ticks so a slow response cannot repaint the
        // previous instrument/timeframe over the new data.
        entry.tickSeq = (entry.tickSeq || 0) + 1;
        clearTimeout(entry.tickTimer);
        showLoading(entry);
        Bridge.request('requestCandles', [
            cfg.exchange, cfg.market, cfg.symbol, cfg.timeframe,
            opts.limit || chartLimit(cfg.timeframe), opts.endTime || 0
        ]).then(function (payload) {
            if (entry.destroyed || seq !== entry.loadSeq) return;
            applyPayload(entry, payload, opts);
        }).catch(function (err) {
            if (entry.destroyed || seq !== entry.loadSeq) return;
            showError(entry, err && err.message ? err.message : String(err));
        });
    }

    function applyPayload(entry, payload, opts) {
        if (!payload || !payload.candles || !payload.candles.length) {
            showError(entry, 'No candles returned for ' + entry.config.symbol + ' ' + entry.config.timeframe);
            return;
        }
        entry.candles = payload.candles.slice();
        entry.loadedAt = Date.now();
        entry.rawByTime = new Map();
        entry.candles.forEach(function (c) { entry.rawByTime.set(c.time, c); });
        entry.hasMore = payload.has_more !== false;
        entry.aggregatedFrom = payload.aggregated_from || null;
        entry.officialSymbol = payload.symbol || entry.config.symbol;
        entry.precision = detectPrecision(entry.candles);
        entry.minMove = Math.pow(10, -entry.precision);
        entry.lastBarTime = entry.candles.length ? entry.candles[entry.candles.length - 1].time : null;

        rebuildDisplay(entry, { resetView: opts.resetView, view: opts.view });
        hideOverlays(entry);
        markLive(entry, true);
        updateHeader(entry);
        updateAggNote(entry);
        refreshIndicators(entry);
        startPolling(entry);
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
        applyPendingTradeOverlay(entry);
    }

    function detectPrecision(candles) {
        var maxDp = 0;
        var start = Math.max(0, candles.length - 120);
        for (var i = start; i < candles.length; i++) {
            var raw = String(candles[i].close);
            var dp = 0;
            if (raw.indexOf('e') >= 0 || raw.indexOf('E') >= 0) {
                var abs = Math.abs(Number(raw));
                if (abs > 0) dp = Math.min(8, Math.max(0, Math.ceil(-Math.log10(abs)) + 1));
            } else {
                var dot = raw.indexOf('.');
                dp = dot >= 0 ? raw.length - dot - 1 : 0;
            }
            if (dp > maxDp) maxDp = dp;
        }
        return Math.min(8, Math.max(2, maxDp));
    }

    function priceFormatFor(entry) {
        var mode = entry.config.priceScaleMode;
        if (mode === 'percentage') {
            return {
                type: 'custom', minMove: 0.01,
                formatter: function (v) { return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
            };
        }
        if (mode === 'indexed') {
            return {
                type: 'custom', minMove: 0.01,
                formatter: function (v) { return Number(v).toFixed(2); }
            };
        }
        return { type: 'price', precision: entry.precision, minMove: entry.minMove };
    }

    function referenceCandle(entry) {
        var cfg = entry.config;
        if (cfg.referenceMode === 'custom' && cfg.referenceTime) {
            return nearestCandle(entry.candles, cfg.referenceTime, 'previous', null) || entry.candles[0];
        }
        if (cfg.referenceMode === 'first_visible') {
            var range = entry.chart && entry.chart.timeScale().getVisibleRange();
            if (range) {
                var c = nearestCandle(entry.candles, range.from, 'previous', null);
                if (c) return c;
            }
        }
        return entry.candles[0];
    }

    function transformValue(entry, value) {
        var mode = entry.config.priceScaleMode;
        if (mode === 'percentage' && entry.refPrice) return (value / entry.refPrice - 1) * 100;
        if (mode === 'indexed' && entry.refPrice) return (value / entry.refPrice) * 100;
        return value;
    }

    function toRawPrice(entry, value) {
        var mode = entry.config.priceScaleMode;
        if (mode === 'percentage' && entry.refPrice) return entry.refPrice * (1 + value / 100);
        if (mode === 'indexed' && entry.refPrice) return entry.refPrice * (value / 100);
        return value;
    }

    function rebuildDisplay(entry, opts) {
        opts = opts || {};
        var mode = entry.config.priceScaleMode;
        if (mode === 'percentage' || mode === 'indexed') {
            var ref = referenceCandle(entry);
            entry.refPrice = ref ? ref.close : null;
            entry.display = entry.candles.map(function (c) {
                return {
                    time: c.time,
                    open: transformValue(entry, c.open),
                    high: transformValue(entry, c.high),
                    low: transformValue(entry, c.low),
                    close: transformValue(entry, c.close),
                    volume: c.volume
                };
            });
        } else {
            entry.refPrice = null;
            entry.display = entry.candles;
        }
        applyDisplayData(entry, opts);
        reprojectDrawings(entry);
    }

    function seriesData(entry) {
        var type = entry.config.chartType;
        if (type === 'line' || type === 'area' || type === 'baseline') {
            return entry.display.map(function (c) { return { time: c.time, value: c.close }; });
        }
        return entry.display.map(function (c) {
            return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        });
    }

    function volumeData(entry) {
        return entry.candles.map(function (c) {
            return {
                time: c.time,
                value: c.volume,
                color: c.close >= c.open ? rgbaOf('upRgb', volumeAlpha()) : rgbaOf('downRgb', volumeAlpha())
            };
        });
    }

    function applyDisplayData(entry, opts) {
        var chart = entry.chart;
        if (!chart) return;
        var hadData = entry.mainSeries.data().length > 0;
        var preserved = (!opts.resetView && hadData) ? chart.timeScale().getVisibleLogicalRange() : null;
        var shift = opts.logicalShift || 0;

        entry.mainSeries.applyOptions({ priceFormat: priceFormatFor(entry) });
        if (entry.config.chartType === 'baseline') {
            var base = entry.display.length ? entry.display[0].close : 0;
            entry.mainSeries.applyOptions({ baseValue: { type: 'price', price: base } });
        }
        entry.mainSeries.setData(seriesData(entry));
        entry.volumeSeries.setData(volumeData(entry));

        if (opts.resetView || !hadData) {
            chart.timeScale().fitContent();
            if (opts.view) {
                try { chart.timeScale().setVisibleRange({ from: opts.view.from, to: opts.view.to }); } catch (err) { /* clamped */ }
            }
        } else if (preserved) {
            chart.timeScale().setVisibleLogicalRange({ from: preserved.from + shift, to: preserved.to + shift });
        }
        entry.barsEl.textContent = entry.candles.length + ' bars';
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
        scheduleDraw(entry);
    }

    function scheduleReferenceRefresh(entry) {
        if (entry.refTimer) return;
        entry.refTimer = setTimeout(function () {
            entry.refTimer = null;
            if (entry.destroyed) return;
            var mode = entry.config.priceScaleMode;
            if (mode !== 'percentage' && mode !== 'indexed') return;
            var ref = referenceCandle(entry);
            if (!ref || (entry.refPrice && ref.close === entry.refPrice)) return;
            // The display units are re-based; a frozen price window is stale.
            resetPricePan(entry);
            rebuildDisplay(entry, { preserve: true });
            refreshIndicators(entry);
        }, 180);
    }

    /* ── Header / strips ─────────────────────────────────────────────────── */

    function updateHeader(entry) {
        var candles = entry.candles;
        if (!candles.length) return;
        var last = candles[candles.length - 1];
        entry.priceSpan.textContent = formatPrice(last.close, entry.precision);
        var prev = null;
        for (var i = candles.length - 1; i >= 0; i--) {
            if (candles[i].time <= last.time - 86400) { prev = candles[i]; break; }
        }
        if (!prev) prev = candles[0];
        var chg = prev.close ? (last.close / prev.close - 1) * 100 : 0;
        entry.chgSpan.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        entry.chgSpan.className = 'head-chg ' + (chg > 0.0001 ? 'up' : chg < -0.0001 ? 'down' : 'flat');
        entry.chgSpan.title = 'Change vs 24h ago (visible data)';
        if (!entry.stripCandle || entry.candles.indexOf(entry.stripCandle) < 0) {
            showStrip(entry, last);
        }
    }

    function showStrip(entry, candle) {
        var div = entry.ohlcStrip;
        var box = entry.stripValues;
        if (!div || !box || !candle) return;
        entry.stripCandle = candle;
        box.innerHTML = '';
        var fields = [
            ['O', candle.open], ['H', candle.high], ['L', candle.low], ['C', candle.close]
        ];
        fields.forEach(function (pair) {
            var span = el('span');
            span.appendChild(document.createTextNode(pair[0]));
            var b = el('b', '', formatPrice(pair[1], entry.precision));
            b.style.color = candle.close >= candle.open ? THEME.upText : THEME.downText;
            span.appendChild(b);
            box.appendChild(span);
        });
        var vol = el('span');
        vol.appendChild(document.createTextNode('V'));
        vol.appendChild(el('b', '', compactNumber(candle.volume)));
        box.appendChild(vol);

        var idx = entry.candles ? entry.candles.indexOf(candle) : -1;
        var prev = idx > 0 ? entry.candles[idx - 1].close : candle.open;
        var pct = prev ? (candle.close / prev - 1) * 100 : 0;
        var chg = el('span', 'lv-change ' + (pct >= 0 ? 'up' : 'down'),
            (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%');
        box.appendChild(chg);
        div.classList.add('show');
    }

    /** Leaving the plot restores the legend to the latest bar. */
    function hideStrip(entry) {
        if (entry.candles && entry.candles.length) showStrip(entry, entry.candles[entry.candles.length - 1]);
        else if (entry.ohlcStrip) entry.ohlcStrip.classList.remove('show');
    }

    function compactNumber(v) {
        if (!isFinite(v)) return '—';
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
        return v.toFixed(2);
    }

    function updateAggNote(entry) {
        var note = entry.aggNote;
        if (entry.aggregatedFrom) {
            note.textContent = tfLabel(entry.config.timeframe) + ' ← ' + entry.aggregatedFrom;
            note.classList.add('show');
            note.title = 'Aggregated from ' + entry.aggregatedFrom + ' OHLCV (exchange does not list this interval)';
        } else {
            note.classList.remove('show');
        }
    }

    function updateTypicalHeading(entry) {
        entry.symBtn.querySelector('.ex').textContent = entry.config.exchange;
        entry.symBtn.querySelector('.sym').textContent = entry.config.symbol;
        entry.symBtn.querySelector('.mkt').textContent = entry.config.market === 'futures' ? 'PERP' : 'SPOT';
        var tfLabelEl = entry.tfBtn.querySelector('.tf-label');
        if (tfLabelEl) tfLabelEl.textContent = tfLabel(entry.config.timeframe);
    }

    var TYPE_ICONS = {
        candles: 'header-candles',
        bar: 'menu-candles-bars',
        line: 'menu-candles-line',
        area: 'menu-candles-area',
        baseline: 'menu-candles-baseline'
    };

    function updateTypeLabel(entry) {
        var found = CHART_TYPES.filter(function (t) { return t.id === entry.config.chartType; })[0];
        var label = entry.typeBtn.querySelector('.type-label');
        if (label) label.textContent = found ? found.label : 'Candles';
        var holder = entry.typeBtn.querySelector('.type-ico');
        if (holder) holder.replaceChildren(panelIcon(TYPE_ICONS[entry.config.chartType] || 'header-candles', 15));
    }

    /** Active studies of a chart: what AI analysis computes for that screen. */
    function activeIndicators(entry) {
        return chartIndicators(entry)
            .filter(function (cfg) { return cfg.visible !== false; })
            .map(function (cfg) {
                return { id: cfg.id, inputs: sanitizeIndicatorInputs(cfg.inputs) };
            });
    }

    function notifyFocused(entry) {
        try {
            if (Bridge.obj && Bridge.obj.onFocusedChartChanged) {
                Bridge.obj.onFocusedChartChanged(
                    entry.config.symbol, entry.config.exchange,
                    entry.config.market, entry.config.timeframe,
                    JSON.stringify(activeIndicators(entry))
                );
            }
        } catch (err) { /* bridge not ready */ }
    }

    function notifyIndicatorsChanged(entry) {
        if (WS.focused === entry.id) notifyFocused(entry);
    }

    function updateGroupVisual(entry) {
        var group = null;
        if (WS.sync) group = WS.sync.getChartGroup(entry.id);
        else if (entry.config.groupId && WS.activeWorkspace()) {
            group = WS.activeWorkspace().syncGroups.filter(function (g) { return g.id === entry.config.groupId; })[0];
        }
        var color = group ? group.color : '#3A3A3A';
        entry.panel.style.setProperty('--g', color);
        entry.groupDot.style.setProperty('--g', color);
        entry.groupDot.className = 'group-dot' + (group ? '' : ' ungrouped');
        entry.groupDot.title = group ? 'Group: ' + group.name : 'No synchronization group';
    }

    function focusChart(entry) {
        if (WS.focused === entry.id) return;
        WS.focused = entry.id;
        notifyFocused(entry);
        Object.keys(WS.charts).forEach(function (id) {
            WS.charts[id].panel.classList.toggle('is-focused', id === entry.id);
        });
        var mode = $('#price-mode');
        if (mode) mode.value = entry.config.priceScaleMode;
        var refBtn = entry.refBtn;
        if (refBtn) refBtn.style.display = (entry.config.priceScaleMode === 'percentage' || entry.config.priceScaleMode === 'indexed') ? '' : 'none';
    }

    /* ── Realtime ticks ──────────────────────────────────────────────────── */

    function updateSyncedStrips(chartId, time) {
        if (!WS.sync) return;
        var sourceGroup = WS.sync.getChartGroup(chartId);
        Object.keys(WS.charts).forEach(function (id) {
            var entry = WS.charts[id];
            if (!entry) return;
            var group = WS.sync.getChartGroup(id);
            var linked = id === chartId || (group && sourceGroup && group.id === sourceGroup.id);
            if (!linked) return;
            if (time == null) { hideStrip(entry); return; }
            var settings = WS.sync.settingsFor(id);
            var drift = (settings.maxDriftBars || 0) * barSeconds(entry.config.timeframe);
            var candle = nearestCandle(entry.candles, time, settings.nearestPolicy,
                settings.maxDriftBars ? drift : null);
            if (candle) showStrip(entry, candle);
            else hideStrip(entry);
        });
    }

    function pollInterval(tf) {
        // Refresh often enough for the live candle to feel live, but never
        // faster than 3 s or slower than 12 s for intraday bars. Daily and
        // longer intervals are polled sparingly (aggregated fetches cost more).
        var sec = barSeconds(tf);
        if (sec >= 604800) return 60000;
        if (sec >= 86400) return 30000;
        return clamp(Math.round(sec * 1000 / 60), 3000, 12000);
    }

    function startPolling(entry, delay) {
        clearTimeout(entry.tickTimer);
        if (entry.destroyed) return;
        var wait = delay == null ? pollInterval(entry.config.timeframe) : delay;
        entry.tickTimer = setTimeout(function () { tick(entry); }, wait);
    }

    function tick(entry) {
        if (entry.destroyed || WS.shuttingDown) return;
        if (!WS.active || document.hidden || !entry.panel.isConnected) {
            startPolling(entry);
            return;
        }
        var cfg = entry.config;
        var seq = entry.tickSeq;
        Bridge.request('requestTick', [cfg.exchange, cfg.market, cfg.symbol, cfg.timeframe]).then(function (payload) {
            if (entry.destroyed || seq !== entry.tickSeq) return;
            markLive(entry, true);
            if (!payload || !payload.candles || !payload.candles.length) return;
            var last = payload.candles[payload.candles.length - 1];
            var newBar = entry.lastBarTime != null && last.time > entry.lastBarTime;
            mergeTicks(entry, payload.candles);
            entry.lastBarTime = last.time;
            refreshAfterTick(entry, newBar);
            refreshIndicators(entry, { reuse: true });
            if (newBar) maybeFinalizePrevious(entry);
        }).catch(function (err) {
            if (entry.destroyed) return;
            markLive(entry, false, err && err.message ? err.message : 'feed error');
        }).finally(function () {
            if (!entry.destroyed) startPolling(entry);
        });
    }

    function mergeTicks(entry, ticks) {
        ticks.forEach(function (bar) {
            var idx = entry.candles.length - 1;
            if (entry.candles.length && entry.candles[idx].time === bar.time) {
                entry.candles[idx] = bar;
            } else if (!entry.candles.length || bar.time > entry.candles[idx].time) {
                entry.candles.push(bar);
            } else {
                var pos = lowerBound(entry.candles, bar.time);
                if (entry.candles[pos] && entry.candles[pos].time === bar.time) entry.candles[pos] = bar;
                else entry.candles.splice(pos, 0, bar);
            }
            entry.rawByTime.set(bar.time, bar);
        });
    }

    function refreshAfterTick(entry, newBar) {
        var mode = entry.config.priceScaleMode;
        if (mode === 'percentage' || mode === 'indexed') {
            var ref = referenceCandle(entry);
            entry.refPrice = ref ? ref.close : entry.refPrice;
            entry.display = entry.candles.map(function (c) {
                return {
                    time: c.time,
                    open: transformValue(entry, c.open), high: transformValue(entry, c.high),
                    low: transformValue(entry, c.low), close: transformValue(entry, c.close),
                    volume: c.volume
                };
            });
        } else {
            entry.display = entry.candles;
        }
        var last = entry.display[entry.display.length - 1];
        var type = entry.config.chartType;
        try {
            if (type === 'line' || type === 'area' || type === 'baseline') {
                entry.mainSeries.update({ time: last.time, value: last.close });
            } else {
                entry.mainSeries.update(last);
            }
            var rawLast = entry.candles[entry.candles.length - 1];
            entry.volumeSeries.update({
                time: rawLast.time, value: rawLast.volume,
                color: rawLast.close >= rawLast.open ? rgbaOf('upRgb', volumeAlpha()) : rgbaOf('downRgb', volumeAlpha())
            });
        } catch (err) {
            console.warn('tick update failed, rebuilding', err);
            try { rebuildDisplay(entry, { resetView: false }); } catch (e2) { console.warn('rebuild failed', e2); }
        }
        var oldPrice = parseFloat((entry.priceSpan.textContent || '').replace(/,/g, ''));
        updateHeader(entry);
        var newPrice = entry.candles.length ? entry.candles[entry.candles.length - 1].close : 0;
        if (oldPrice && newPrice !== oldPrice) {
            entry.priceSpan.classList.remove('flash-up', 'flash-down');
            void entry.priceSpan.offsetWidth;
            entry.priceSpan.classList.add(newPrice > oldPrice ? 'flash-up' : 'flash-down');
        }
        entry.barsEl.textContent = entry.candles.length + ' bars';
        if (newBar) scheduleDraw(entry);
    }

    function maybeFinalizePrevious(entry) {
        // Re-request the last two bars once a new bar opens so the completed bar
        // is exactly what the exchange reports (not the last partial tick).
        var cfg = entry.config;
        Bridge.request('requestCandles', [cfg.exchange, cfg.market, cfg.symbol, cfg.timeframe, 3, 0])
            .then(function (payload) {
                if (entry.destroyed || !payload.candles || !payload.candles.length) return;
                mergeTicks(entry, payload.candles);
                refreshAfterTick(entry, false);
                refreshIndicators(entry);
            }).catch(function () { /* non-fatal */ });
    }

    function markLive(entry, ok, message) {
        entry.liveEl.className = 'live' + (ok ? '' : ' stale');
        entry.liveEl.textContent = ok ? 'live' : 'stale';
        entry.msEl.textContent = message ? String(message) : (new Date().toISOString().slice(11, 19) + ' UTC');
    }

    /* ── Lazy history ────────────────────────────────────────────────────── */

    function maybeLoadOlder(entry, from) {
        if (!entry.hasMore || entry.loadingOlder || !entry.candles.length || !from) return;
        // Avoid a backfill storm while a workspace is still restoring and each
        // chart is applying its saved viewport.
        if (Date.now() - (entry.loadedAt || 0) < 1500) return;
        var first = entry.candles[0].time;
        if (from > first) return;          // nothing older than the loaded window requested
        entry.loadingOlder = true;
        var cfg = entry.config;
        var oldLen = entry.candles.length;
        Bridge.request('requestCandles', [
            cfg.exchange, cfg.market, cfg.symbol, cfg.timeframe,
            500, first - 1
        ]).then(function (payload) {
            if (entry.destroyed || !payload.candles || !payload.candles.length) return;
            var merged = payload.candles.concat(entry.candles);
            var byTime = {};
            merged.forEach(function (c) { byTime[c.time] = c; });
            var keys = Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; });
            var deduped = keys.map(function (t) { return byTime[t]; });
            var added = Math.max(0, deduped.length - oldLen);
            entry.candles = deduped;
            entry.rawByTime = new Map();
            entry.candles.forEach(function (c) { entry.rawByTime.set(c.time, c); });
            entry.hasMore = payload.has_more !== false;
            rebuildDisplay(entry, { preserve: true, logicalShift: added });
            refreshIndicators(entry);
            entry.barsEl.textContent = entry.candles.length + ' bars';
        }).catch(function () {
            /* keep current view */
        }).finally(function () {
            entry.loadingOlder = false;
        });
    }

    /* ── Overlays (error / loading) ──────────────────────────────────────── */

    function showLoading(entry) {
        entry.overlay.className = 'panel-overlay show';
        entry.overlay.innerHTML = '';
        entry.overlay.appendChild(el('div', 'spinner'));
        entry.overlay.appendChild(el('div', 'ov-title', 'Loading ' + entry.config.symbol));
        entry.overlay.appendChild(el('div', '', entry.config.exchange + ' · ' + entry.config.market + ' · ' + entry.config.timeframe));
    }

    function showError(entry, message) {
        if (entry.pendingOverlay) {
            entry.pendingOverlay = null;
            reportTradeOverlay({
                ok: false,
                message: 'Could not load ' + entry.config.symbol + ' candles for the plan overlay.'
            });
        }
        entry.overlay.className = 'panel-overlay show error';
        entry.overlay.innerHTML = '';
        entry.overlay.appendChild(el('div', 'ov-title', 'Data unavailable'));
        var detail = el('div', '', message || 'Unknown exchange error');
        detail.style.maxWidth = '340px';
        detail.style.lineHeight = '1.5';
        entry.overlay.appendChild(detail);
        var retry = el('button', 'btn-ghost', 'Retry');
        retry.addEventListener('click', function () { loadData(entry, { resetView: true }); });
        entry.overlay.appendChild(retry);
        var change = el('button', 'btn-ghost', 'Change pair');
        change.addEventListener('click', function () { openSymbolModal(entry); });
        entry.overlay.appendChild(change);
        entry.liveEl.className = 'live offline';
        entry.liveEl.textContent = 'offline';
    }

    function hideOverlays(entry) { entry.overlay.className = 'panel-overlay'; }

    /* ── Indicators (lightweight-charts-indicators) ──────────────────────── */

    // The engine is a ~10 MB IIFE that publishes the registry + renderer on
    // `window.TradePanelIndicators`; the catalog is compact JSON for the
    // pickers. Both are built by `npm run indicators` (frontend/scripts).
    var INDICATOR_ENGINE_SRC = 'indicators/engine.js';
    var INDICATOR_CATALOG_SRC = 'indicators/catalog.json';
    var MAX_CHART_INDICATORS = 20;
    var INDICATOR_SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
    var INDICATOR_GROUPS = [
        { id: 'standard', label: 'Technical' },
        { id: 'community', label: 'Community' },
        { id: 'candlestick', label: 'Patterns' }
    ];

    var INDICATORS = {
        enginePromise: null,
        catalogPromise: null,
        catalog: null,
        catalogById: null,
        lookup: null
    };

    function loadIndicatorEngine() {
        if (window.TradePanelIndicators) return Promise.resolve(window.TradePanelIndicators);
        if (!window.LightweightCharts) {
            return Promise.reject(new Error('Lightweight Charts is not loaded'));
        }
        if (INDICATORS.enginePromise) return INDICATORS.enginePromise;
        INDICATORS.enginePromise = new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = INDICATOR_ENGINE_SRC;
            script.async = true;
            script.onload = function () {
                if (window.TradePanelIndicators) resolve(window.TradePanelIndicators);
                else reject(new Error('the indicator engine loaded without a registry'));
            };
            script.onerror = function () {
                INDICATORS.enginePromise = null;
                script.remove();
                reject(new Error('could not load ' + INDICATOR_ENGINE_SRC));
            };
            document.head.appendChild(script);
        });
        return INDICATORS.enginePromise;
    }

    function loadIndicatorCatalog() {
        if (INDICATORS.catalog) return Promise.resolve(INDICATORS.catalog);
        if (INDICATORS.catalogPromise) return INDICATORS.catalogPromise;
        INDICATORS.catalogPromise = fetch(INDICATOR_CATALOG_SRC, { cache: 'force-cache' })
            .then(function (response) {
                if (!response.ok) throw new Error('indicator catalog unavailable (HTTP ' + response.status + ')');
                return response.json();
            })
            .then(function (list) {
                if (!Array.isArray(list)) throw new Error('indicator catalog is malformed');
                INDICATORS.catalog = list;
                INDICATORS.catalogById = {};
                list.forEach(function (item) { INDICATORS.catalogById[item.id] = item; });
                return list;
            })
            .catch(function (err) {
                INDICATORS.catalogPromise = null;
                throw err;
            });
        return INDICATORS.catalogPromise;
    }

    function engineIndicator(id) {
        var kit = window.TradePanelIndicators;
        if (!kit) return null;
        if (!INDICATORS.lookup) {
            INDICATORS.lookup = {};
            kit.indicatorRegistry.forEach(function (entry) { INDICATORS.lookup[entry.id] = entry; });
        }
        return INDICATORS.lookup[id] || null;
    }

    function catalogIndicator(id) {
        return INDICATORS.catalogById ? INDICATORS.catalogById[id] || null : null;
    }

    function indicatorMeta(id) {
        return engineIndicator(id) || catalogIndicator(id);
    }

    function indicatorPatch(id) {
        var meta = indicatorMeta(id);
        var plots = meta && meta.plotConfig ? meta.plotConfig : [];
        return (plots[0] && plots[0].color) || '#a1a1aa';
    }

    /* ── Indicator chart config ──────────────────────────────────────────── */

    function chartIndicators(entry) {
        if (!entry.config || !Array.isArray(entry.config.indicators)) entry.config.indicators = [];
        return entry.config.indicators;
    }

    /**
     * Studies are addressed by position, not by id: the same indicator may be
     * added several times (two VWAPs with different anchors, RSI 14 + RSI 50).
     */
    function chartIndicatorAt(entry, index) {
        var list = chartIndicators(entry);
        return typeof index === 'number' && index >= 0 && index < list.length ? list[index] : null;
    }

    /** Effective line colour of one instance (plot style > plot default). */
    function indicatorColor(cfg, meta) {
        var plot = (meta && meta.plotConfig ? meta.plotConfig : [])[0];
        var style = cfg && cfg.plots && plot ? cfg.plots[plot.id] : null;
        if (style && style.color) return style.color;
        return (plot && plot.color) || '#a1a1aa';
    }

    // Duplicate instances must not stack invisibly on top of each other, so a
    // new copy takes the first palette colour its siblings are not using.
    var INDICATOR_PALETTE = ['#2962FF', '#F23645', '#089981', '#F5A623', '#A78BFA', '#06B6D4', '#EC4899', '#84CC16'];

    function nextInstancePlots(entry, meta) {
        var siblings = chartIndicators(entry).filter(function (cfg) { return cfg.id === meta.id; });
        var plot = (meta.plotConfig || [])[0];
        if (!siblings.length || !plot) return {};
        var used = {};
        var mark = function (color) { if (color) used[String(color).toLowerCase()] = true; };
        mark(plot.color);
        siblings.forEach(function (cfg) { mark(indicatorColor(cfg, meta)); });
        var color = null;
        for (var i = 0; i < INDICATOR_PALETTE.length && !color; i++) {
            if (!used[INDICATOR_PALETTE[i].toLowerCase()]) color = INDICATOR_PALETTE[i];
        }
        var plots = {};
        plots[plot.id] = { color: color || INDICATOR_PALETTE[siblings.length % INDICATOR_PALETTE.length] };
        return plots;
    }

    function sanitizeInputValue(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return isFinite(value) && Math.abs(value) <= 1e9 ? value : undefined;
        if (typeof value === 'string') return value.length > 120 ? value.slice(0, 120) : value;
        return undefined;
    }

    function sanitizeIndicatorInputs(raw) {
        var out = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        Object.keys(raw).slice(0, 64).forEach(function (key) {
            var value = sanitizeInputValue(raw[key]);
            if (value !== undefined) out[key] = value;
        });
        return out;
    }

    function sanitizeIndicatorPlots(raw) {
        var out = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        Object.keys(raw).slice(0, 32).forEach(function (plotId) {
            var item = raw[plotId];
            if (!item || typeof item !== 'object') return;
            var clean = {};
            if (typeof item.color === 'string' && /^(#[0-9a-fA-F]{3,8}|transparent)$/.test(item.color)) {
                clean.color = item.color;
            }
            if (typeof item.lineWidth === 'number' && isFinite(item.lineWidth)) {
                clean.lineWidth = Math.max(0, Math.min(4, Math.round(item.lineWidth)));
            }
            if (typeof item.visible === 'boolean') clean.visible = item.visible;
            if (Object.keys(clean).length) out[plotId] = clean;
        });
        return out;
    }

    function mergeIndicatorInputs(meta, overrides) {
        var merged = clone((meta && meta.defaultInputs) || {});
        var known = {};
        Object.keys(merged).forEach(function (key) { known[key] = true; });
        ((meta && meta.inputConfig) || []).forEach(function (input) { known[input.id] = true; });
        var clean = sanitizeIndicatorInputs(overrides);
        Object.keys(clean).forEach(function (key) {
            if (!meta || known[key]) merged[key] = clean[key];
        });
        return merged;
    }

    /** Normalise persisted/legacy chart config: list of {id, inputs, plots, visible}.
     *  Ids may repeat — one entry per on-chart instance. */
    function normalizeChartIndicators(raw) {
        if (!Array.isArray(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length && out.length < MAX_CHART_INDICATORS; i++) {
            var item = raw[i];
            if (!item || typeof item !== 'object') continue;
            var id = typeof item.id === 'string' ? item.id.trim() : '';
            if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) continue;
            out.push({
                id: id,
                inputs: sanitizeIndicatorInputs(item.inputs),
                plots: sanitizeIndicatorPlots(item.plots),
                visible: item.visible !== false
            });
        }
        return out;
    }

    function ensureChartIndicatorConfig(config) {
        config.indicators = normalizeChartIndicators(config.indicators);
        if (typeof config.showVolume !== 'boolean') config.showVolume = true;
    }

    function indicatorSignature(entry) {
        try { return JSON.stringify(chartIndicators(entry)); } catch (err) { return ''; }
    }

    function addChartIndicator(entry, meta) {
        if (!meta || !meta.id) return false;
        var list = chartIndicators(entry);
        if (list.length >= MAX_CHART_INDICATORS) {
            toast('A chart can show at most ' + MAX_CHART_INDICATORS + ' indicators');
            return false;
        }
        // The picker hands us a catalog row (browse metadata only); the engine
        // registry entry carries default inputs and plot styles.
        var full = engineIndicator(meta.id) || meta;
        list.push({
            id: meta.id,
            inputs: sanitizeIndicatorInputs(full.defaultInputs),
            plots: nextInstancePlots(entry, full),
            visible: true
        });
        refreshIndicators(entry, { rebuild: true });
        notifyIndicatorsChanged(entry);
        scheduleSave();
        return true;
    }

    function removeChartIndicator(entry, index) {
        var list = chartIndicators(entry);
        if (!(typeof index === 'number' && index >= 0 && index < list.length)) return false;
        list.splice(index, 1);
        refreshIndicators(entry, { rebuild: true });
        notifyIndicatorsChanged(entry);
        scheduleSave();
        return true;
    }

    function toggleIndicatorVisibility(entry, index) {
        var cfg = chartIndicatorAt(entry, index);
        if (!cfg) return;
        cfg.visible = cfg.visible === false;
        refreshIndicators(entry, { rebuild: true });
        notifyIndicatorsChanged(entry);
        scheduleSave();
    }

    /* ── Rendering ───────────────────────────────────────────────────────── */

    function indicatorBars(entry) {
        var source = entry.display && entry.display.length ? entry.display : entry.candles;
        return source.map(function (candle) {
            return {
                time: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume
            };
        });
    }

    /* The indicator engine uses its own period grammar ("15", "60", "1D");
       the workspace speaks the exchange grammar ("15m", "1h", "1d"). Passing
       the raw workspace string makes every engine lookup of the chart
       timeframe throw `Invalid timeframe` (e.g. market-anchored VWAP). */
    var ENGINE_TIMEFRAME = /^(\d+)([mhdwM])$/;

    function engineTimeframe(timeframe) {
        var text = String(timeframe || '');
        var match = ENGINE_TIMEFRAME.exec(text);
        if (!match) return text;
        var amount = Number(match[1]);
        if (!amount) return text;
        switch (match[2]) {
            case 'm': return String(amount);
            case 'h': return String(amount * 60);
            case 'd': return amount + 'D';
            case 'w': return amount + 'W';
            default: return amount + 'M';
        }
    }

    function indicatorChartContext(entry) {
        var context = { timeframe: engineTimeframe(entry.config.timeframe), lastBarConfirmed: true };
        try {
            var range = entry.chart.timeScale().getVisibleRange();
            if (range) {
                // Bars carry UTC seconds; the engine compares visible-range
                // bounds against `bar.time * 1000`.
                context.leftVisibleBarTime = range.from * 1000;
                context.rightVisibleBarTime = range.to * 1000;
            }
        } catch (err) { /* chart mid-teardown */ }
        return context;
    }

    function updateVolumeVisibility(entry) {
        if (!entry.volumeSeries) return;
        entry.volumeSeries.applyOptions({ visible: entry.config.showVolume !== false });
    }

    function clearIndicatorRuntimes(entry) {
        (entry.indicatorRuntimes || []).forEach(function (runtime) {
            if (!runtime.renderer) return;
            try { runtime.renderer.clear(); } catch (err) { /* pane already gone */ }
            runtime.renderer = null;
        });
        entry.indicatorRuntimes = [];
        entry.indicatorPaneCount = 0;
    }

    function refreshIndicators(entry, opts) {
        opts = opts || {};
        if (!entry || entry.destroyed || !entry.chart) return;
        updateVolumeVisibility(entry);
        var configs = chartIndicators(entry);
        var signature = indicatorSignature(entry);
        var rebuild = opts.rebuild === true || signature !== entry.indicatorSignature;
        if (!configs.length) {
            clearIndicatorRuntimes(entry);
            entry.indicatorSignature = signature;
            renderLegend(entry);
            return;
        }
        var seq = (entry.indicatorSeq || 0) + 1;
        entry.indicatorSeq = seq;
        loadIndicatorEngine().then(function () {
            if (entry.destroyed || !entry.chart || seq !== entry.indicatorSeq) return;
            applyIndicatorSet(entry, rebuild, opts.reuse === true);
            entry.indicatorSignature = indicatorSignature(entry);
        }).catch(function (err) {
            if (entry.destroyed || seq !== entry.indicatorSeq) return;
            console.warn('Indicator engine unavailable', err);
            toast('Indicators unavailable: ' + err.message, 'error');
            renderLegend(entry);
        });
    }

    function applyIndicatorSet(entry, rebuild, reuse) {
        var configs = chartIndicators(entry);
        var kit = window.TradePanelIndicators;
        if (!kit) return;
        if (rebuild) clearIndicatorRuntimes(entry);

        var previous = entry.indicatorRuntimes || [];
        var runtimes = [];
        configs.forEach(function (cfg, index) {
            var meta = engineIndicator(cfg.id);
            if (!meta) {
                console.warn('Unknown indicator id', cfg.id);
                return;
            }
            // Instances live at fixed positions, so a live refresh reuses the
            // runtime belonging to this entry — not the first one with this id.
            var runtime = null;
            if (!rebuild && previous[index] && previous[index].id === cfg.id) {
                runtime = previous[index];
            }
            if (!runtime) {
                runtime = { id: cfg.id, meta: meta, renderer: null, pane: 0, result: null, plots: [], error: null };
            }
            runtime.index = index;
            runtime.meta = meta;
            runtime.config = cfg;
            runtime.inputs = mergeIndicatorInputs(meta, cfg.inputs);
            runtime.hidden = cfg.visible === false;
            runtimes.push(runtime);
        });
        previous.forEach(function (runtime) {
            if (runtimes.indexOf(runtime) >= 0 || !runtime.renderer) return;
            try { runtime.renderer.clear(); } catch (err) { /* ignore */ }
        });
        entry.indicatorRuntimes = runtimes;

        var paneIndex = 0;
        runtimes.forEach(function (runtime) {
            if (runtime.hidden) { runtime.pane = 0; return; }
            runtime.pane = runtime.meta.overlay ? 0 : ++paneIndex;
        });

        var bars = indicatorBars(entry);
        var context = indicatorChartContext(entry);
        var keepSeries = reuse && !rebuild;
        runtimes.forEach(function (runtime) {
            runtime.error = null;
            if (runtime.hidden) {
                if (runtime.renderer) {
                    try { runtime.renderer.clear(); } catch (err) { /* ignore */ }
                    runtime.renderer = null;
                }
                return;
            }
            try {
                runtime.result = runtime.meta.calculate(bars, runtime.inputs, context);
            } catch (err) {
                runtime.result = null;
                runtime.plots = [];
                runtime.error = err && err.message ? err.message : String(err);
            }
            if (!runtime.result) {
                if (runtime.renderer) {
                    try { runtime.renderer.clear(); } catch (err) { /* ignore */ }
                    runtime.renderer = null;
                }
                return;
            }
            try {
                if (!runtime.renderer) {
                    runtime.renderer = new kit.IndicatorRenderer(entry.chart, {
                        paneIndex: runtime.pane,
                        mainSeries: entry.mainSeries
                    });
                } else {
                    runtime.renderer.setPaneIndex(runtime.pane);
                }
                runtime.renderer.render(runtime.meta, runtime.result, bars, {
                    inputs: runtime.inputs,
                    plots: runtime.config && runtime.config.plots,
                    reuseSeries: keepSeries,
                    lastValueVisible: !runtime.meta.overlay
                });
                indexIndicatorPlots(runtime);
            } catch (err) {
                runtime.error = err && err.message ? err.message : String(err);
                runtime.plots = [];
                if (runtime.renderer) {
                    try { runtime.renderer.clear(); } catch (clearErr) { /* ignore */ }
                    runtime.renderer = null;
                }
            }
        });

        sizeIndicatorPanes(entry, paneIndex, rebuild);
        renderLegend(entry);
    }

    function indexIndicatorPlots(runtime) {
        var plots = runtime.result && runtime.result.plots ? runtime.result.plots : {};
        var out = [];
        (runtime.meta.plotConfig || []).forEach(function (plot) {
            var values = plots[plot.id];
            if (!Array.isArray(values) || !values.length) return;
            if (plot.display === 'none') return;
            if (plot.visible === false) return;
            if (typeof plot.visible === 'string' && runtime.inputs[plot.visible] === false) return;
            out.push({ id: plot.id, title: plot.title || plot.id, color: plot.color || '', values: values });
        });
        runtime.plots = out;
    }

    function sizeIndicatorPanes(entry, paneCount, force) {
        if (!paneCount || (!force && entry.indicatorPaneCount === paneCount)) return;
        entry.indicatorPaneCount = paneCount;
        var panes;
        try { panes = entry.chart.panes(); } catch (err) { return; }
        // Stretch factors distribute the available height without fighting
        // LWC's own min-height rebalancing (setHeight is only exact when it is
        // the sole pane-changing call). 3:1 keeps the price pane dominant.
        panes.forEach(function (pane, index) {
            if (typeof pane.setStretchFactor !== 'function') return;
            try { pane.setStretchFactor(index === 0 ? 3 : 1); } catch (err) { /* ignore */ }
        });
    }

    function plotValueAt(plot, time) {
        var values = plot.values;
        if (!values || !values.length) return null;
        var lo = 0, hi = values.length - 1, best = null;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (values[mid].time <= time) { best = values[mid]; lo = mid + 1; }
            else hi = mid - 1;
        }
        return best ? best.value : null;
    }

    function plotLastValue(plot) {
        var values = plot.values;
        for (var i = values.length - 1; i >= 0; i--) {
            var value = values[i].value;
            if (value != null && isFinite(value)) return value;
        }
        return null;
    }

    function formatIndicatorValue(value) {
        if (value == null || !isFinite(value)) return '—';
        var abs = Math.abs(value);
        if (abs >= 10000) return value.toFixed(0);
        if (abs >= 100) return value.toFixed(1);
        if (abs >= 1) return value.toFixed(2);
        if (abs === 0) return '0';
        return value.toPrecision(3);
    }

    function indicatorValueText(runtime, time) {
        if (runtime.hidden) return 'hidden';
        if (runtime.error) return 'error';
        if (!runtime.plots || !runtime.plots.length) return '—';
        var parts = [];
        for (var i = 0; i < runtime.plots.length && parts.length < 2; i++) {
            var plot = runtime.plots[i];
            var style = runtime.config && runtime.config.plots && runtime.config.plots[plot.id];
            if (style && style.visible === false) continue;
            if (plot.color === '#00000000' || plot.color === 'transparent') continue;
            var value = time == null ? plotLastValue(plot) : plotValueAt(plot, time);
            if (value == null || !isFinite(value)) continue;
            parts.push(formatIndicatorValue(value));
        }
        return parts.length ? parts.join(' · ') : '—';
    }

    function legendButton(iconName, title, onClick, modifier) {
        var button = el('button', 'ind-legend-btn' + (modifier ? ' ' + modifier : ''));
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.appendChild(panelIcon(iconName, 13));
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function legendSignature(entry) {
        return (entry.indicatorRuntimes || []).map(function (runtime) {
            return runtime.index + ':' + runtime.id + ':' + (runtime.hidden ? 1 : 0) + ':' +
                (runtime.error ? 1 : 0) + ':' + indicatorColor(runtime.config, runtime.meta);
        }).join('|');
    }

    function renderLegend(entry) {
        var layer = entry.legend;
        if (!layer) return;
        var runtimes = entry.indicatorRuntimes || [];
        var signature = legendSignature(entry);
        if (signature === entry.legendSignature && layer.childNodes.length === runtimes.length) {
            positionIndicatorLegends(entry);
            updateLegendValues(entry, null);
            return;
        }
        entry.legendSignature = signature;
        layer.innerHTML = '';
        if (!runtimes.length) return;
        var overlayRow = 0;
        runtimes.forEach(function (runtime) {
            var row = el('div', 'ind-pane-legend');
            row.dataset.indicator = runtime.id;
            row.dataset.instance = String(runtime.index);
            row.dataset.pane = String(runtime.pane);
            var hidden = runtime.hidden;
            if (runtime.error) row.classList.add('error');
            if (hidden) row.classList.add('hidden');
            row.style.setProperty('--lite', indicatorColor(runtime.config, runtime.meta));
            var eyeTitle = hidden ? 'Show ' + (runtime.meta.shortName || runtime.id) : 'Hide ' + (runtime.meta.shortName || runtime.id);
            row.appendChild(legendButton(
                hidden ? 'draw-hide-indicators' : 'st-legend-eye-show',
                eyeTitle,
                function () { toggleIndicatorVisibility(entry, runtime.index); }
            ));
            var title = el('span', 'ind-legend-title', runtime.meta.shortName || runtime.meta.name || runtime.id);
            title.title = (runtime.meta.name || runtime.id) + ' — click to configure';
            title.addEventListener('click', function () { openIndicatorSettings(entry, runtime.index); });
            row.appendChild(title);
            var value = el('b', 'ind-legend-value', '—');
            row.appendChild(value);
            row.appendChild(legendButton('dt-settings', 'Settings for ' + (runtime.meta.name || runtime.id), function () {
                openIndicatorSettings(entry, runtime.index);
            }));
            row.appendChild(legendButton('tab-close', 'Remove ' + (runtime.meta.name || runtime.id) + ' from chart', function () {
                removeChartIndicator(entry, runtime.index);
            }, 'danger'));
            if (runtime.pane === 0) {
                row.dataset.row = String(overlayRow);
                overlayRow += 1;
            }
            layer.appendChild(row);
            runtime.legendEl = row;
        });
        positionIndicatorLegends(entry);
        updateLegendValues(entry, null);
    }

    /** Keep a legend row glued to the top-left of its pane (drag, resize, zoom). */
    function observeIndicatorPanes(entry) {
        if (typeof ResizeObserver !== 'function' || !entry.chart) return;
        var panes;
        try { panes = entry.chart.panes(); } catch (err) { return; }
        if (!entry.paneObserver) {
            entry.paneObserver = new ResizeObserver(function () {
                if (!entry.destroyed) positionIndicatorLegends(entry);
            });
        }
        var watched = entry.paneObserverPanes || (entry.paneObserverPanes = []);
        panes.forEach(function (pane) {
            if (typeof pane.getHTMLElement !== 'function') return;
            var el = pane.getHTMLElement();
            if (!el || watched.indexOf(el) >= 0) return;
            watched.push(el);
            entry.paneObserver.observe(el);
        });
    }

    function positionIndicatorLegends(entry) {
        if (!entry.legend || !entry.chart || !entry.body) return;
        var panes;
        try { panes = entry.chart.panes(); } catch (err) { return; }
        observeIndicatorPanes(entry);
        var bodyRect = entry.body.getBoundingClientRect();
        var priceRows = 0;
        (entry.indicatorRuntimes || []).forEach(function (runtime) {
            var row = runtime.legendEl;
            if (!row) return;
            var pane = panes[runtime.pane] || panes[0];
            if (!pane || typeof pane.getHTMLElement !== 'function') return;
            var paneEl = pane.getHTMLElement();
            if (!paneEl) return;
            var rect = paneEl.getBoundingClientRect();
            var top = rect.top - bodyRect.top + 4;
            if (runtime.pane === 0) {
                // Clear the OHLC readout that sits at the price pane's top-left.
                top += 24 + priceRows * 17;
                priceRows += 1;
            }
            row.style.top = Math.round(top) + 'px';
            row.style.left = Math.round(rect.left - bodyRect.left + 8) + 'px';
        });
    }

    function updateLegendValues(entry, time) {
        if (!entry.indicatorRuntimes || !entry.indicatorRuntimes.length) return;
        entry.indicatorRuntimes.forEach(function (runtime) {
            var row = runtime.legendEl;
            if (!row) return;
            var valueNode = row.querySelector('.ind-legend-value');
            if (!valueNode) return;
            var text = indicatorValueText(runtime, time);
            if (valueNode.textContent !== text) valueNode.textContent = text;
        });
    }

    function scheduleVisibleRangeIndicators(entry) {
        var runtimes = entry.indicatorRuntimes || [];
        var needed = false;
        for (var i = 0; i < runtimes.length; i++) {
            if (runtimes[i].meta && runtimes[i].meta.usesVisibleRange) { needed = true; break; }
        }
        if (!needed || entry.indicatorRangeTimer) return;
        entry.indicatorRangeTimer = setTimeout(function () {
            entry.indicatorRangeTimer = null;
            if (!entry.destroyed) refreshIndicators(entry, { reuse: true });
        }, 160);
    }

    /* ── Settings inputs ─────────────────────────────────────────────────── */

    function inputConditionHolds(condition, inputs, configs) {
        function value(id) {
            if (inputs && inputs[id] !== undefined) return inputs[id];
            for (var i = 0; i < configs.length; i++) if (configs[i].id === id) return configs[i].defval;
            return undefined;
        }
        if (typeof condition === 'string') return value(condition) === true;
        if (condition && typeof condition === 'object') {
            if ('not' in condition) return !inputConditionHolds(condition.not, inputs, configs);
            if ('any' in condition) return condition.any.some(function (c) { return inputConditionHolds(c, inputs, configs); });
            if ('all' in condition) return condition.all.every(function (c) { return inputConditionHolds(c, inputs, configs); });
            var current = value(condition.input);
            if (!('eq' in condition) && !('ne' in condition)) return current === true;
            return (!('eq' in condition) || current === condition.eq) &&
                (!('ne' in condition) || current !== condition.ne);
        }
        return true;
    }

    function indicatorInputActive(input, inputs, configs) {
        if (input.active === undefined) return true;
        if (typeof input.active === 'boolean') return input.active;
        return inputConditionHolds(input.active, inputs, configs);
    }

    function indicatorInputControl(input, value, onCommit) {
        var type = input.type || 'text';
        var node;
        if (type === 'bool') {
            node = el('input');
            node.type = 'checkbox';
            node.checked = value === undefined ? !!input.defval : !!value;
            node.addEventListener('change', function () { onCommit(node.checked); });
        } else if (type === 'int' || type === 'float') {
            node = el('input');
            node.type = 'number';
            node.value = value === undefined ? input.defval : value;
            if (input.min != null) node.min = String(input.min);
            if (input.max != null) node.max = String(input.max);
            node.step = type === 'int' ? '1' : (input.step != null ? String(input.step) : 'any');
            node.addEventListener('change', function () {
                var next = Number(node.value);
                if (!isFinite(next)) next = Number(input.defval) || 0;
                if (input.min != null) next = Math.max(Number(input.min), next);
                if (input.max != null) next = Math.min(Number(input.max), next);
                if (type === 'int') next = Math.round(next);
                node.value = String(next);
                onCommit(next);
            });
        } else if (Array.isArray(input.options)) {
            node = el('select');
            input.options.forEach(function (option) {
                var item = el('option', null, String(option));
                item.value = String(option);
                node.appendChild(item);
            });
            node.value = value === undefined ? String(input.defval) : String(value);
            node.addEventListener('change', function () { onCommit(node.value); });
        } else if (type === 'source') {
            node = el('select');
            INDICATOR_SOURCES.forEach(function (source) {
                var item = el('option', null, source);
                item.value = source;
                node.appendChild(item);
            });
            if (INDICATOR_SOURCES.indexOf(String(value)) < 0) node.appendChild(el('option', null, String(value || input.defval)));
            node.value = value === undefined ? String(input.defval) : String(value);
            node.addEventListener('change', function () { onCommit(node.value); });
        } else {
            node = el('input');
            node.type = 'text';
            node.value = value === undefined || value === null ? (input.defval == null ? '' : String(input.defval)) : String(value);
            node.addEventListener('change', function () { onCommit(node.value.trim()); });
        }
        node.title = input.tooltip || input.title || input.id;
        node.setAttribute('aria-label', input.title || input.id);
        return node;
    }

    function buildIndicatorInputs(meta, inputs, inputConfig, onChange) {
        var box = el('div', 'ind-settings');
        var configs = inputConfig || (meta && meta.inputConfig) || [];
        var visible = configs.filter(function (input) { return input.display !== 'none'; });
        if (!visible.length) {
            box.appendChild(el('div', 'ind-desc', 'This indicator has no configurable inputs.'));
            return box;
        }
        var group = null;
        var groupBox = null;
        visible.forEach(function (input) {
            var active = indicatorInputActive(input, inputs, configs);
            if (input.group !== group) {
                group = input.group || '';
                groupBox = el('div', 'ind-group');
                if (group) groupBox.appendChild(el('div', 'ind-group-title', group));
                box.appendChild(groupBox);
            }
            var row = el('label', 'ind-field');
            row.appendChild(el('span', 'ind-field-label', input.title || input.id));
            var control = indicatorInputControl(input, inputs[input.id], function (value) {
                inputs[input.id] = value;
                onChange(inputs);
            });
            control.disabled = !active;
            row.appendChild(control);
            (groupBox || box).appendChild(row);
        });
        return box;
    }

    /* ── Study settings dialog (Inputs / Style / Visibility) ─────────────── */

    function openIndicatorSettings(entry, index) {
        var list = chartIndicators(entry);
        var cfg = chartIndicatorAt(entry, index);
        if (!cfg) return;
        var id = cfg.id;
        var original = clone(cfg);
        var draft = clone(cfg);
        var meta = indicatorMeta(id) || { id: id, name: id, plotConfig: [], inputConfig: [], defaultInputs: {} };
        var activeTab = 'inputs';
        var previewTimer = null;

        var body = el('div', 'ind-settings-dialog');
        var tabs = el('div', 'ind-settings-tabs');
        var pane = el('div', 'ind-settings-pane');
        body.appendChild(tabs);
        body.appendChild(pane);

        function preview() {
            writeback(clone(draft));
            refreshIndicators(entry, { rebuild: true });
        }

        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(function () {
                previewTimer = null;
                if (!entry.destroyed) preview();
            }, 220);
        }

        function commitInputs(inputs) {
            draft.inputs = sanitizeIndicatorInputs(inputs);
            schedulePreview();
        }

        function renderInputs() {
            var box = buildIndicatorInputs(meta, mergeIndicatorInputs(meta, draft.inputs), meta.inputConfig, commitInputs);
            pane.appendChild(box);
        }

        function plotStyle(plotId, create) {
            if (!draft.plots || !draft.plots[plotId]) {
                if (!create) return {};
                if (!draft.plots) draft.plots = {};
                draft.plots[plotId] = {};
            }
            return draft.plots[plotId];
        }

        function renderStyle() {
            var plots = (meta.plotConfig || []).filter(function (plot) { return plot.display !== 'none'; });
            var box = el('div', 'ind-settings');
            if (!plots.length) {
                box.appendChild(el('div', 'ind-desc', 'This indicator exposes no editable plots.'));
                pane.appendChild(box);
                return;
            }
            plots.forEach(function (plot) {
                var style = (draft.plots && draft.plots[plot.id]) || {};
                var row = el('div', 'ind-field style-row');
                row.appendChild(el('span', 'ind-field-label', plot.title || plot.id));
                var controls = el('div', 'ind-style-controls');
                var color = el('input');
                var current = typeof style.color === 'string' ? style.color : (plot.color || '#2962FF');
                if (/^#[0-9a-fA-F]{6}$/.test(current)) {
                    color.type = 'color';
                } else {
                    color.type = 'text';
                }
                color.value = current;
                color.title = 'Line colour';
                color.setAttribute('aria-label', (plot.title || plot.id) + ' colour');
                color.addEventListener('input', function () {
                    if (/^(#[0-9a-fA-F]{3,8}|transparent)$/.test(color.value)) {
                        plotStyle(plot.id, true).color = color.value;
                        schedulePreview();
                    }
                });
                var width = el('select');
                [0, 1, 2, 3, 4].forEach(function (value) {
                    var option = el('option', null, value === 0 ? '0 px' : value + ' px');
                    option.value = String(value);
                    width.appendChild(option);
                });
                width.value = String(style.lineWidth != null ? style.lineWidth : (plot.lineWidth != null ? plot.lineWidth : 1));
                width.title = 'Line width';
                width.setAttribute('aria-label', (plot.title || plot.id) + ' width');
                width.addEventListener('change', function () {
                    plotStyle(plot.id, true).lineWidth = Number(width.value);
                    schedulePreview();
                });
                var show = el('input');
                show.type = 'checkbox';
                show.checked = style.visible !== false && plot.visible !== 'none';
                show.title = 'Draw this plot';
                show.setAttribute('aria-label', 'Draw ' + (plot.title || plot.id));
                show.addEventListener('change', function () {
                    plotStyle(plot.id, true).visible = show.checked;
                    schedulePreview();
                });
                var reset = el('button', 'ind-icon-btn', '↺');
                reset.type = 'button';
                reset.title = 'Reset this plot';
                reset.setAttribute('aria-label', reset.title);
                reset.addEventListener('click', function () {
                    if (draft.plots) {
                        delete draft.plots[plot.id];
                        if (!Object.keys(draft.plots).length) draft.plots = {};
                    }
                    schedulePreview();
                    renderPane();
                });
                controls.append(color, width, show, reset);
                row.appendChild(controls);
                box.appendChild(row);
            });
            pane.appendChild(box);
        }

        function renderVisibility() {
            var box = el('div', 'ind-settings');
            var row = el('label', 'ind-field');
            row.appendChild(el('span', 'ind-field-label', 'Show on chart'));
            var toggle = el('input');
            toggle.type = 'checkbox';
            toggle.checked = draft.visible !== false;
            toggle.addEventListener('change', function () {
                draft.visible = toggle.checked;
                preview();
            });
            row.appendChild(toggle);
            box.appendChild(row);
            box.appendChild(el('div', 'ind-desc',
                'Hidden studies keep their inputs and styles, and can be shown again from the chart legend.'));
            pane.appendChild(box);
        }

        function renderPane() {
            pane.innerHTML = '';
            if (activeTab === 'inputs') renderInputs();
            else if (activeTab === 'style') renderStyle();
            else renderVisibility();
            tabs.querySelectorAll('button').forEach(function (button) {
                button.setAttribute('aria-pressed', String(button.dataset.tab === activeTab));
            });
        }

        [
            ['inputs', 'Inputs'],
            ['style', 'Style'],
            ['visibility', 'Visibility']
        ].forEach(function (pair) {
            var button = el('button', 'ind-settings-tab', pair[1]);
            button.type = 'button';
            button.dataset.tab = pair[0];
            button.addEventListener('click', function () {
                activeTab = pair[0];
                renderPane();
            });
            tabs.appendChild(button);
        });

        // The list is the live chart config; never write past a removal that
        // happened while the dialog was open.
        function writeback(value) {
            if (!chartIndicatorAt(entry, index) || chartIndicators(entry)[index].id !== id) return false;
            chartIndicators(entry)[index] = value;
            return true;
        }

        // Live preview mutates the chart config, so a dismissal (X, Escape,
        // backdrop) must roll the study back — otherwise the change looks
        // applied but is never saved and disappears on the next start.
        var settled = false;

        var cancel = el('button', 'btn-ghost', 'Cancel');
        cancel.addEventListener('click', function () {
            settled = true;
            clearTimeout(previewTimer);
            writeback(original);
            refreshIndicators(entry, { rebuild: true });
            // A save may have raced the live preview: persist the rollback so
            // the dismissed values cannot come back on the next start.
            scheduleSave();
            closeModal();
        });
        var apply = el('button', 'btn-ghost primary', 'Apply');
        apply.addEventListener('click', function () {
            settled = true;
            clearTimeout(previewTimer);
            writeback(clone(draft));
            refreshIndicators(entry, { rebuild: true });
            notifyIndicatorsChanged(entry);
            scheduleSave();
            closeModal();
        });
        var foot = el('div');
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        foot.style.marginLeft = 'auto';
        foot.append(cancel, apply);

        var ordinal = 0;
        var total = 0;
        list.forEach(function (item, i) {
            if (item.id !== id) return;
            total += 1;
            if (i <= index) ordinal += 1;
        });

        openModal({
            title: (meta.name || id) + ' settings' + (total > 1 ? ' · ' + ordinal + '/' + total : ''),
            sub: entry.config.symbol + ' · ' + entry.config.timeframe,
            body: body,
            foot: foot,
            onClose: function () {
                clearTimeout(previewTimer);
                if (settled) return;
                settled = true;
                writeback(original);
                refreshIndicators(entry, { rebuild: true });
                scheduleSave();
            }
        });
        renderPane();
    }

    /* ── Indicator picker dialog ─────────────────────────────────────────── */

    function openIndicatorModal(entry) {
        var wrap = el('div', 'ind-picker');
        var top = el('div', 'ind-picker-top');
        var search = el('input', 'ind-search');
        search.type = 'search';
        search.placeholder = 'Search indicators — name, id or category';
        search.setAttribute('aria-label', 'Search indicators');
        top.appendChild(search);
        wrap.appendChild(top);

        var tabs = el('div', 'ind-cats');
        wrap.appendChild(tabs);
        var list = el('div', 'ind-list');
        wrap.appendChild(list);
        var status = el('div', 'ind-status', 'Loading indicator catalog…');
        wrap.appendChild(status);

        var state = { query: '', group: 'standard' };

        /** How many instances of each study are on the chart right now. */
        function appliedCounts() {
            var out = {};
            chartIndicators(entry).forEach(function (cfg) { out[cfg.id] = (out[cfg.id] || 0) + 1; });
            return out;
        }

        function groupItems() {
            var catalog = INDICATORS.catalog || [];
            var query = state.query.trim().toLowerCase();
            if (query) {
                return catalog.filter(function (item) {
                    return (item.name + ' ' + item.shortName + ' ' + item.id + ' ' + item.category).toLowerCase().indexOf(query) >= 0;
                });
            }
            return catalog.filter(function (item) { return item.group === state.group; });
        }

        function addRow(item, count) {
            var button = el('button', 'ind-pick');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(count > 0));
            var dot = el('span', 'dot');
            dot.style.setProperty('--c', indicatorPatch(item.id));
            button.appendChild(dot);
            var nameWrap = el('span', 'ind-pick-name');
            nameWrap.appendChild(document.createTextNode(item.name));
            nameWrap.appendChild(el('em', '', item.shortName || item.id));
            button.appendChild(nameWrap);
            button.appendChild(el('span', 'ind-pick-cat', item.category || ''));
            button.appendChild(el('span', 'ind-pick-state', count > 0 ? 'Add · ' + count : 'Add'));
            button.title = (item.description || item.name) + ' · ' + (item.category || '') +
                (count > 0 ? ' · ' + count + ' on chart — click to add another instance' : '');
            // A study can be added repeatedly: each click is a new, independent
            // instance with its own inputs and style.
            button.addEventListener('click', function () {
                if (addChartIndicator(entry, item)) {
                    render();
                    search.focus();
                }
            });
            list.appendChild(button);
        }

        function render() {
            tabs.innerHTML = '';
            var catalog = INDICATORS.catalog || [];
            if (catalog.length) {
                INDICATOR_GROUPS.forEach(function (group) {
                    var count = catalog.filter(function (item) { return item.group === group.id; }).length;
                    if (!count) return;
                    var button = el('button', 'ind-cat', group.label + ' ' + count);
                    button.type = 'button';
                    button.setAttribute('aria-pressed', String(!state.query && state.group === group.id));
                    button.addEventListener('click', function () {
                        state.group = group.id;
                        state.query = '';
                        search.value = '';
                        render();
                    });
                    tabs.appendChild(button);
                });
            }
            var scrollTop = list.scrollTop;
            list.innerHTML = '';
            list.classList.toggle('searching', !!state.query);
            if (!INDICATORS.catalog) return;
            var items = groupItems();
            if (!items.length) {
                list.appendChild(el('div', 'ind-empty', state.query ? 'No indicator matches “' + state.query + '”.' : 'No indicators in this group.'));
                return;
            }
            var applied = appliedCounts();
            var limit = state.query ? 200 : 150;
            var category = null;
            items.slice(0, limit).forEach(function (item) {
                if (!state.query && item.category !== category) {
                    category = item.category;
                    list.appendChild(el('div', 'ind-group-title ind-list-group', category || 'Other'));
                }
                addRow(item, applied[item.id] || 0);
            });
            if (items.length > limit) {
                list.appendChild(el('div', 'ind-status',
                    'Showing ' + limit + ' of ' + items.length + ' matches — refine the search.'));
            }
            list.scrollTop = scrollTop;
        }

        search.addEventListener('input', function () {
            state.query = search.value;
            render();
        });
        search.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            var items = groupItems();
            if (items.length === 1) {
                addChartIndicator(entry, items[0]);
                render();
                search.select();
            }
        });

        var done = el('button', 'btn-ghost primary', 'Done');
        done.addEventListener('click', closeModal);
        var appliedCount = el('span', 'ind-status');
        appliedCount.id = 'ind-applied-count';
        var foot = el('div');
        foot.style.display = 'flex';
        foot.style.alignItems = 'center';
        foot.style.gap = '10px';
        foot.style.marginLeft = 'auto';
        foot.append(appliedCount, done);

        openModal({
            title: 'Indicators',
            sub: entry.config.symbol + ' · ' + entry.config.timeframe,
            body: wrap,
            foot: foot,
            onOpen: function () { search.focus(); }
        });

        function updateCount() {
            appliedCount.textContent = chartIndicators(entry).length + ' / ' + MAX_CHART_INDICATORS + ' applied';
        }
        var baseRender = render;
        render = function () { baseRender(); updateCount(); };
        updateCount();
        loadIndicatorCatalog().then(function () {
            status.remove();
            render();
            // Warm the engine so added studies render (and show their real
            // plot colours) without a visible delay.
            loadIndicatorEngine().then(function () { render(); }).catch(function () { /* reported on add */ });
        }).catch(function (err) {
            status.className = 'ind-status error';
            status.textContent = err.message;
        });
    }

    /* ── Price scale modes / reference ──────────────────────────────────── */

    function visiblePriceRange(entry) {
        if (!entry.chart) return null;
        var range = entry.chart.timeScale().getVisibleRange();
        if (!range) return null;
        var arr = entry.display;
        if (!arr.length) return null;
        var lo = lowerBound(arr, range.from);
        var hi = lowerBound(arr, range.to + 1);
        if (hi <= lo) return null;
        var min = Infinity, max = -Infinity;
        for (var i = lo; i < hi; i++) {
            if (arr[i].low < min) min = arr[i].low;
            if (arr[i].high > max) max = arr[i].high;
        }
        if (!isFinite(min) || !isFinite(max)) return null;
        return { min: min, max: max };
    }

    function applyAbsoluteRange(entry, range) {
        entry.absRange = range && isFinite(range.min) && isFinite(range.max) ? range : null;
        if (!entry.chart) return;
        entry.chart.priceScale('right').applyOptions({ autoScale: true });
        var data = entry.mainSeries && entry.mainSeries.data ? entry.mainSeries.data() : [];
        if (data && data.length) {
            // Force the autoscale provider to re-evaluate (v4 applyOptions is
            // a no-op when autoScale is already true).
            try { entry.mainSeries.update(data[data.length - 1]); } catch (err) { /* ignore */ }
        }
    }

    function setPriceMode(entry, mode, opts) {
        opts = opts || {};
        if (!LAYOUTS) return;
        entry.config.priceScaleMode = mode;
        entry.absRange = null;
        resetPricePan(entry);
        rebuildDisplay(entry, { preserve: true });
        refreshIndicators(entry, { rebuild: true });
        entry.mainSeries.applyOptions({ priceFormat: priceFormatFor(entry) });
        entry.refBtn.style.display = (mode === 'percentage' || mode === 'indexed') ? '' : 'none';
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
        if (!opts.silent) {
            $('#price-mode').value = mode;
            scheduleSave();
        }
    }

    function applyPriceModeAll(mode) {
        var ws = activeWorkspace();
        Object.keys(WS.charts).forEach(function (id) { setPriceMode(WS.charts[id], mode, { silent: true }); });
        ws.globalSettings.priceScale = mode;
        ws.charts.forEach(function (c) { c.priceScaleMode = mode; });
        ws.syncGroups.forEach(function (g) { g.settings.priceScale = mode; });
        if (WS.sync) WS.sync.setSettings({ priceScale: mode });
        Object.keys(WS.charts).forEach(function (id) { updateGroupVisual(WS.charts[id]); });
        scheduleSave();
    }

    function openReferenceMenu(entry, anchor) {
        var mode = entry.config.referenceMode;
        openMenu(anchor, [
            { label: 'First visible candle', checked: mode === 'first_visible', onClick: function () { setReference(entry, 'first_visible', null); } },
            { label: 'Start of loaded history', checked: mode === 'history_start', onClick: function () { setReference(entry, 'history_start', null); } },
            { label: 'User-selected timestamp…', checked: mode === 'custom', onClick: function () {
                entry.pickRef = true;
                toast('Click a candle to set the reference point');
            } },
            { sep: true },
            { label: 'Clear reference time', disabled: !entry.config.referenceTime, onClick: function () { setReference(entry, 'first_visible', null); } }
        ], 'Reference point');
    }

    function setReference(entry, mode, time) {
        entry.config.referenceMode = mode;
        entry.config.referenceTime = time || null;
        resetPricePan(entry);
        rebuildDisplay(entry, { preserve: true });
        refreshIndicators(entry, { rebuild: true });
        scheduleSave();
    }

    /* ── Chart type / timeframe / symbol menus ───────────────────────────── */

    function openChartTypeMenu(entry) {
        openMenu(entry.typeBtn, CHART_TYPES.map(function (type) {
            return {
                label: type.label,
                icon: TYPE_ICONS[type.id] || 'header-candles',
                checked: entry.config.chartType === type.id,
                onClick: function () { setChartType(entry, type.id); }
            };
        }), 'Chart type');
    }

    function setChartType(entry, type) {
        if (entry.config.chartType === type) return;
        var range = entry.chart.timeScale().getVisibleLogicalRange();
        // The primitive is bound to the old series: detach before it is removed.
        detachDrawings(entry);
        entry.config.chartType = type;
        try { entry.chart.removeSeries(entry.mainSeries); } catch (err) { /* ignore */ }
        entry.mainSeries = createMainSeries(entry, type);
        installAutoscaleProvider(entry);
        entry.mainSeries.setData(seriesData(entry));
        if (type === 'baseline' && entry.display.length) {
            entry.mainSeries.applyOptions({
                baseValue: { type: 'price', price: entry.display[0].close }
            });
        }
        if (range) entry.chart.timeScale().setVisibleLogicalRange(range);
        attachDrawings(entry);
        updateTypeLabel(entry);
        if (WS.sync) WS.sync.updateRegistration(entry.id, { mainSeries: entry.mainSeries });
        // Renderers hold the replaced price series (markers, bar colours).
        refreshIndicators(entry, { rebuild: true });
        scheduleSave();
    }

    function timeframesFor(exchange, market) {
        if (!WS.meta) return TIMEFRAMES;
        var ex = (WS.meta.exchanges || []).filter(function (e) { return e.id === exchange; })[0];
        if (!ex) return TIMEFRAMES;
        var mk = (ex.markets || []).filter(function (m) { return m.id === market; })[0];
        return mk ? mk.timeframes : TIMEFRAMES;
    }

    function openTimeframeMenu(entry) {
        var supported = timeframesFor(entry.config.exchange, entry.config.market);
        var caps = WS.meta && WS.meta.aggregations ? WS.meta.aggregations[entry.config.exchange] : null;
        var agg = caps && caps[entry.config.market] ? caps[entry.config.market].aggregated : {};
        openMenu(entry.tfBtn, TIMEFRAMES.map(function (tf) {
            var supportedTf = supported.indexOf(tf) >= 0;
            return {
                label: tfLabel(tf),
                checked: entry.config.timeframe === tf,
                disabled: !supportedTf,
                tag: agg && agg[tf] ? 'agg ' + agg[tf][0] : (supportedTf ? '' : 'n/a'),
                onClick: function () { changeTimeframe(entry, tf, false); }
            };
        }), 'Timeframe');
    }

    function changeTimeframe(entry, tf, fromSync) {
        if (!entry || entry.config.timeframe === tf) return;
        var supported = timeframesFor(entry.config.exchange, entry.config.market);
        if (supported.indexOf(tf) < 0) {
            toast(tf + ' is not available on ' + entry.config.exchange + ' ' + entry.config.market, true);
            return;
        }
        var view = null;
        try { view = entry.chart.timeScale().getVisibleRange(); } catch (err) { view = null; }
        entry.config.timeframe = tf;
        var tfLabelEl = entry.tfBtn.querySelector('.tf-label');
        if (tfLabelEl) tfLabelEl.textContent = tfLabel(tf);
        if (entry.drawMgr) entry.drawMgr.setInterval(ChartDrawings.intervalForTimeframe(tf));
        resetPricePan(entry);
        entry.loadSeq++;
        loadData(entry, { resetView: true, view: view });
        if (WS.focused === entry.id) notifyFocused(entry);
        if (WS.sync) {
            WS.sync.updateRegistration(entry.id, { timeframe: tf, barSeconds: barSeconds(tf) });
            if (!fromSync) WS.sync.notifyTimeframeChange(entry.id, tf);
        }
        scheduleSave();
    }

    function setInstrument(entry, exchange, market, symbol) {
        savePositions(entry);
        entry.config.exchange = exchange;
        entry.config.market = market;
        entry.config.symbol = symbol;
        entry.config.view = null;
        resetPricePan(entry);
        entry.selectedPosition = null;
        entry.selectedMeasure = false;
        entry.measure = null;
        entry.measureDraft = null;
        entry.measureDrag = null;
        entry.positions = loadPositions(entry);
        updateTypicalHeading(entry);
        forceRefetch(entry);
        // Keep the shell's instrument row on the chart that is actually shown
        // (symbol changes do not move focus, so notify explicitly).
        if (WS.focused === entry.id) notifyFocused(entry);
        scheduleSave();
    }

    function forceRefetch(entry) {
        entry.hasMore = true;
        entry.loadingOlder = false;
        loadData(entry, { resetView: true });
    }

    /* ── Symbol picker ───────────────────────────────────────────────────── */

    function openSymbolModal(entry) {
        var exchanges = (WS.meta && WS.meta.exchanges) || [];
        var state = {
            exchange: entry.config.exchange,
            market: entry.config.market,
            query: '',
            results: [],
            loading: false,
            token: 0,
            selected: null
        };

        var wrap = el('div', 'sym-grid');
        var left = el('div', 'sym-list');
        var search = el('input', 'input');
        search.placeholder = 'Search exchange';
        search.setAttribute('aria-label', 'Search exchange');
        var searchWrap = el('div');
        searchWrap.style.padding = '6px';
        searchWrap.appendChild(search);
        var leftInner = el('div');
        var right = el('div', 'sym-main');
        var marketSeg = el('div', 'seg');
        var searchRow = el('div', 'sym-tools');
        var symInput = el('input', 'input mono');
        symInput.placeholder = 'Search pair (e.g. BTC/USDT)';
        symInput.setAttribute('aria-label', 'Search trading pair');
        searchRow.appendChild(symInput);
        var results = el('div', 'sym-results');
        var chips = el('div', 'chips-row');
        var hint = el('div', 'modal-sub');

        left.appendChild(searchWrap);
        left.appendChild(leftInner);
        right.appendChild(marketSeg);
        right.appendChild(searchRow);
        right.appendChild(results);
        right.appendChild(chips);
        right.appendChild(hint);
        wrap.appendChild(left);
        wrap.appendChild(right);

        var foot = el('div');
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        foot.style.marginLeft = 'auto';
        var cancel = el('button', 'btn-ghost', 'Cancel');
        cancel.addEventListener('click', closeModal);
        var applyBtn = el('button', 'btn-ghost primary', 'Apply');
        applyBtn.addEventListener('click', apply);
        foot.appendChild(cancel);
        foot.appendChild(applyBtn);

        function renderExchanges() {
            leftInner.innerHTML = '';
            var q = search.value.trim().toLowerCase();
            exchanges.forEach(function (ex) {
                if (q && ex.name.toLowerCase().indexOf(q) < 0) return;
                var btn = el('button', 'ex-item');
                btn.type = 'button';
                btn.setAttribute('aria-pressed', String(ex.id === state.exchange));
                btn.appendChild(el('span', 'nm', ex.name));
                btn.appendChild(el('span', 'mk', ex.markets.map(function (m) { return m.id === 'spot' ? 'S' : 'F'; }).join('')));
                btn.addEventListener('click', function () {
                    state.exchange = ex.id;
                    var supported = ex.markets.map(function (m) { return m.id; });
                    if (supported.indexOf(state.market) < 0) state.market = supported[0];
                    renderAll();
                });
                leftInner.appendChild(btn);
            });
        }

        function renderMarkets() {
            marketSeg.innerHTML = '';
            var ex = exchanges.filter(function (e) { return e.id === state.exchange; })[0];
            var markets = ex ? ex.markets : [{ id: 'spot', label: 'Spot' }];
            markets.forEach(function (m) {
                var btn = el('button', '', m.label);
                btn.type = 'button';
                btn.setAttribute('aria-pressed', String(m.id === state.market));
                btn.addEventListener('click', function () { state.market = m.id; renderAll(); });
                marketSeg.appendChild(btn);
            });
        }

        function renderResults() {
            results.innerHTML = '';
            if (state.loading) {
                results.appendChild(el('div', 'sym-empty', 'Searching ' + state.exchange + '…'));
                return;
            }
            if (!state.results.length) {
                results.appendChild(el('div', 'sym-empty', 'No matches for “' + (state.query || '') + '” on ' + state.exchange + ' ' + state.market));
                return;
            }
            state.results.forEach(function (item) {
                var row = el('button', 'sym-row');
                row.type = 'button';
                row.setAttribute('aria-selected', String(state.selected === item.symbol));
                row.appendChild(el('span', '', item.symbol));
                row.appendChild(el('span', '', item.native));
                row.addEventListener('click', function () {
                    state.selected = item.symbol;
                    renderResults();
                });
                row.addEventListener('dblclick', function () { apply(); });
                results.appendChild(row);
            });
        }

        function renderChips() {
            chips.innerHTML = '';
            var shown = WS.prefs.recent.slice(0, 6).map(function (key) {
                var parts = key.split('|');
                return { key: key, label: parts[0] + ' · ' + parts[2] };
            });
            if (!shown.length) return;
            var label = el('div', 'modal-sub', 'Recent');
            label.style.width = '100%';
            chips.appendChild(label);
            shown.forEach(function (item) {
                var btn = el('button', 'mini-chip', item.label);
                btn.type = 'button';
                btn.addEventListener('click', function () {
                    var parts = item.key.split('|');
                    state.exchange = parts[0];
                    state.market = parts[1];
                    state.query = parts[2];
                    symInput.value = parts[2];
                    state.selected = null;
                    renderAll();
                    searchPairs(parts[2]);
                });
                chips.appendChild(btn);
            });
        }

        function searchPairs(query) {
            state.query = query;
            state.loading = true;
            state.token++;
            var token = state.token;
            renderResults();
            Bridge.request('searchSymbols', [state.exchange, state.market, query || ''])
                .then(function (payload) {
                    if (token !== state.token) return;
                    state.results = (payload && payload.symbols) || [];
                    if (state.selected && !state.results.some(function (r) { return r.symbol === state.selected; })) {
                        state.selected = null;
                    }
                    state.loading = false;
                    renderResults();
                })
                .catch(function (err) {
                    if (token !== state.token) return;
                    state.loading = false;
                    state.results = [];
                    hint.textContent = err.message || 'Search failed';
                    renderResults();
                });
        }

        function renderAll() {
            renderExchanges();
            renderMarkets();
            renderChips();
            searchPairs(symInput.value.trim());
            hint.textContent = 'Only intervals supported by the selected exchange are offered.';
        }

        var debounce = null;
        symInput.addEventListener('input', function () {
            clearTimeout(debounce);
            debounce = setTimeout(function () { searchPairs(symInput.value.trim()); }, 260);
        });
        search.addEventListener('input', renderExchanges);
        symInput.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                if (state.results.length) { state.selected = state.results[0].symbol; apply(); }
            }
        });

        function apply() {
            var symbol = state.selected || (state.results[0] && state.results[0].symbol);
            if (!symbol) return;
            if (state.results.length && !state.results.some(function (r) { return r.symbol === symbol; })) {
                hint.textContent = 'That pair is not listed on this exchange / market.';
                return;
            }
            closeModal();
            setInstrument(entry, state.exchange, state.market, symbol);
            touchRecent(state.exchange, state.market, symbol);
        }

        openModal({
            title: 'Exchange & trading pair',
            sub: entry.config.exchange + ' · ' + entry.config.symbol + ' · chart ' + entry.id,
            body: wrap,
            foot: foot,
            onOpen: function () { symInput.focus(); }
        });
        renderAll();
    }

    /* ── Credentials modal (API keys) ────────────────────────────────────── */

    var CRED_GROUP_ORDER = ['Hyperliquid'];

    function openCredentialsModal() {
        var body = el('div', 'cred-body');
        body.appendChild(el('div', 'cred-note',
            'Values are stored in keys/.env on this machine. Saved secrets are never sent back to the UI — leave a secret blank to keep the current value.'));
        var fieldsWrap = el('div');
        fieldsWrap.style.display = 'flex';
        fieldsWrap.style.flexDirection = 'column';
        fieldsWrap.style.gap = '15px';
        body.appendChild(fieldsWrap);
        var errorBox = el('div', 'cred-error');
        errorBox.setAttribute('role', 'alert');
        body.appendChild(errorBox);
        var loading = el('div', 'cred-note', 'Loading credential status…');
        fieldsWrap.appendChild(loading);

        var rows = [];
        var groups = {};

        function groupBlock(name) {
            if (groups[name]) return groups[name];
            var wrap = el('div', 'cred-group');
            var head = el('div', 'cred-group-head');
            head.appendChild(el('span', '', name));
            var count = el('span', 'cred-count', '');
            head.appendChild(count);
            wrap.appendChild(head);
            fieldsWrap.appendChild(wrap);
            groups[name] = { wrap: wrap, count: count, total: 0, set: 0 };
            return groups[name];
        }

        function addField(field) {
            var group = groupBlock(field.group || 'Other');
            group.total += 1;
            if (field.set) group.set += 1;

            var row = el('div', 'cred-row');
            var label = el('label', '', field.label);
            var inputId = 'cred-' + field.key.toLowerCase();
            label.htmlFor = inputId;
            row.appendChild(label);

            var meta = el('div', 'cred-meta');
            var state = el('span', 'cred-state' + (field.set ? ' set' : ''), field.set ? 'set' : 'not set');
            meta.appendChild(state);
            var clearBtn = el('button', 'cred-clear' + (field.set ? '' : ' hidden'), '×');
            clearBtn.type = 'button';
            clearBtn.title = 'Remove stored value';
            clearBtn.setAttribute('aria-label', 'Clear ' + field.label);
            meta.appendChild(clearBtn);
            row.appendChild(meta);

            var input = el('input', 'input mono');
            input.id = inputId;
            input.spellcheck = false;
            input.autocomplete = 'new-password';
            if (field.secret) {
                input.type = 'password';
                input.placeholder = field.set ? 'Stored — leave blank to keep' : 'Not set';
            } else {
                input.type = 'text';
                input.value = field.value || '';
            }
            row.appendChild(input);
            group.wrap.appendChild(row);

            var item = { field: field, input: input, state: state, clear: clearBtn, pending: false };
            rows.push(item);

            clearBtn.addEventListener('click', function () {
                item.pending = true;
                input.value = '';
                state.className = 'cred-state pending';
                state.textContent = 'clear on save';
                clearBtn.classList.add('hidden');
                input.focus();
            });
            input.addEventListener('input', function () {
                if (!item.pending) return;
                item.pending = false;
                state.className = 'cred-state' + (field.set ? ' set' : '');
                state.textContent = field.set ? 'set' : 'not set';
                clearBtn.classList.remove('hidden');
            });
        }

        function render(fields) {
            fieldsWrap.innerHTML = '';
            rows = [];
            groups = {};
            var order = CRED_GROUP_ORDER.slice();
            fields.forEach(function (field) {
                if (order.indexOf(field.group) === -1) order.push(field.group);
            });
            order.forEach(function (name) {
                var members = fields.filter(function (field) { return field.group === name; });
                if (!members.length) return;
                members.forEach(addField);
                var group = groups[name];
                group.count.textContent = group.set + ' / ' + group.total + ' set';
            });
        }

        function collect() {
            var values = {};
            var clear = [];
            rows.forEach(function (item) {
                var field = item.field;
                if (item.pending) { clear.push(field.key); return; }
                var raw = item.input.value;
                if (field.secret) {
                    if (raw.trim()) values[field.key] = raw;
                    return;
                }
                var value = raw.trim();
                if (value === (field.value || '')) return;
                if (value) values[field.key] = value;
                else clear.push(field.key);
            });
            return { values: values, clear: clear };
        }

        var foot = el('div');
        foot.style.marginLeft = 'auto';
        foot.style.display = 'flex';
        foot.style.alignItems = 'center';
        foot.style.gap = '8px';
        var note = el('span', 'cred-foot-note', 'OS keyring');
        var cancel = el('button', 'btn-ghost', 'Cancel');
        cancel.addEventListener('click', closeModal);
        var save = el('button', 'btn-ghost primary', 'Save keys');
        save.disabled = true;
        save.addEventListener('click', function () {
            var payload = collect();
            if (!Object.keys(payload.values).length && !payload.clear.length) {
                toast('No credential changes');
                return;
            }
            errorBox.textContent = '';
            save.disabled = true;
            save.textContent = 'Saving…';
            Bridge.call('saveCredentials', [JSON.stringify(payload)]).then(function (res) {
                if (!res || res.ok !== true) throw new Error((res && res.error) || 'Save failed');
                var count = (res.keys || []).length;
                closeModal();
                toast(count ? 'Credentials saved to the OS keyring' : 'No credential changes');
            }).catch(function (err) {
                save.disabled = false;
                save.textContent = 'Save keys';
                errorBox.textContent = err.message || 'Could not save credentials';
            });
        });
        foot.appendChild(note);
        foot.appendChild(cancel);
        foot.appendChild(save);

        openModal({
            title: 'API keys',
            sub: 'Hyperliquid trading wallet · stored in the OS credential store',
            body: body,
            foot: foot
        });

        Bridge.call('credentialStatus').then(function (res) {
            if (!res || !Array.isArray(res.fields) || !res.fields.length) {
                throw new Error('Credential status unavailable');
            }
            render(res.fields);
            save.disabled = false;
            var first = rows.filter(function (item) { return !item.field.set; })[0] || rows[0];
            if (first) setTimeout(function () { first.input.focus(); }, 0);
        }).catch(function (err) {
            fieldsWrap.innerHTML = '';
            errorBox.textContent = err.message || 'Could not load credential status';
        });
    }

    /**
     * Draw an AI trade plan as a position box on the chart for its instrument.
     * Purely visual: it never fills the ticket and never submits an order.
     * The outcome is returned and relayed to the shell (bridge event) so the
     * toast appears in the sidebar instead of the chart frame.
     */
    WS.overlayTrade = function (trade) {
        var result = overlayTrade(trade);
        reportTradeOverlay(result);
        return result;
    };

    WS.setFocusedCoin = function (coin) {
        var entry = WS.charts[WS.focused];
        if (!entry || !coin) return;
        var base = String(coin).toUpperCase().replace('/USDT', '').replace('/USD', '');
        Bridge.request('searchSymbols', [entry.config.exchange, entry.config.market, base])
            .then(function (payload) {
                var rows = (payload && payload.symbols) || [];
                var match = rows.filter(function (r) { return r.base === base && r.quote === 'USDT'; })[0]
                    || rows.filter(function (r) { return r.base === base && r.quote === 'USD'; })[0]
                    || rows.filter(function (r) { return r.base === base; })[0];
                if (!match) {
                    toast(base + ' is not listed on ' + entry.config.exchange + ' ' + entry.config.market, true);
                    return;
                }
                setInstrument(entry, entry.config.exchange, entry.config.market, match.symbol);
            })
            .catch(function (err) { toast('Symbol lookup failed: ' + err.message, true); });
    };

    WS.setFocusedTimeframe = function (timeframe) {
        var entry = WS.charts[WS.focused];
        if (entry && timeframe) changeTimeframe(entry, timeframe, false);
    };

    WS.centerFocused = function () {
        var entry = WS.charts[WS.focused];
        if (!entry || !entry.chart) return;
        resetPricePan(entry);
        entry.chart.priceScale('right').applyOptions({ autoScale: true });
        entry.chart.timeScale().fitContent();
    };

    /* ── Groups ──────────────────────────────────────────────────────────── */

    function openGroupMenu(entry) {
        var ws = activeWorkspace();
        var items = [{
            label: 'No group (independent)',
            checked: !entry.config.groupId,
            onClick: function () { assignGroup(entry, null); }
        }];
        ws.syncGroups.forEach(function (group) {
            items.push({
                label: group.name,
                checked: entry.config.groupId === group.id,
                tag: group.enabled ? '' : 'off',
                onClick: function () { assignGroup(entry, group.id); }
            });
        });
        items.push({ sep: true });
        items.push({ label: 'Manage groups…', onClick: openDrawer });
        openMenu(entry.groupDot, items, 'Synchronize with');
    }

    function assignGroup(entry, groupId) {
        entry.config.groupId = groupId;
        if (WS.sync) {
            WS.sync.setChartGroup(entry.id, groupId);
            WS.sync.clearAllCrosshairs();
            WS.sync.schedulePriceScaleRefresh();
        }
        updateGroupVisual(entry);
        renderGroupChips();
        renderDrawer();
        scheduleSave();
    }

    function openDrawer() {
        renderDrawer();
        $('#ws-drawer').classList.add('open');
        var backdrop = $('#ws-drawer-backdrop');
        if (backdrop) backdrop.classList.add('open');
    }

    function closeDrawer() {
        $('#ws-drawer').classList.remove('open');
        var backdrop = $('#ws-drawer-backdrop');
        if (backdrop) backdrop.classList.remove('open');
    }

    function groupUsage(groupId) {
        var ws = activeWorkspace();
        return ws.charts.filter(function (c) { return c.groupId === groupId; });
    }

    function renderGroupChips() {
        var wrap = $('#group-chips');
        var ws = activeWorkspace();
        if (!wrap || !ws) return;
        wrap.innerHTML = '';
        ws.syncGroups.forEach(function (group) {
            var chip = el('button', 'group-chip');
            chip.type = 'button';
            chip.style.setProperty('--g', group.color);
            chip.setAttribute('aria-pressed', String(group.enabled));
            var sw = el('span', 'swatch');
            chip.appendChild(sw);
            chip.appendChild(el('span', '', group.name));
            chip.appendChild(el('span', 'n', String(groupUsage(group.id).length)));
            chip.title = group.enabled ? 'Disable group synchronization' : 'Enable group synchronization';
            chip.addEventListener('click', function (ev) {
                if (ev.altKey) { openDrawer(); return; }
                setGroupEnabled(group.id, !group.enabled);
            });
            chip.addEventListener('dblclick', openDrawer);
            wrap.appendChild(chip);
        });
    }

    function renderDrawer() {
        var body = $('#drawer-body');
        if (!body) return;
        var ws = activeWorkspace();
        body.innerHTML = '';
        ws.syncGroups.forEach(function (group) {
            var card = el('div', 'group-card');
            var head = el('div', 'group-card-head');
            var color = el('input');
            color.type = 'color';
            color.value = group.color;
            color.title = 'Group colour';
            color.addEventListener('input', function () {
                group.color = color.value;
                renderGroupChips();
                renderDrawerCharts();
                scheduleSave();
            });
            head.appendChild(color);
            var name = el('input', 'gname');
            name.value = group.name;
            name.maxLength = 40;
            name.addEventListener('change', function () {
                group.name = name.value.trim() || group.name;
                renderGroupChips();
                scheduleSave();
            });
            head.appendChild(name);
            var sw = el('button', 'switch');
            sw.type = 'button';
            sw.setAttribute('role', 'switch');
            sw.setAttribute('aria-checked', String(group.enabled));
            sw.addEventListener('click', function () { setGroupEnabled(group.id, !group.enabled); });
            head.appendChild(sw);
            card.appendChild(head);

            var grid = el('div', 'sync-grid');
            [['crosshair', 'Crosshair'], ['timeRange', 'Time'], ['horizontalScroll', 'Scroll'], ['zoom', 'Zoom'], ['timeframe', 'TF']].forEach(function (pair) {
                var toggle = el('button', 'sync-toggle', pair[1]);
                toggle.type = 'button';
                toggle.setAttribute('aria-pressed', String(!!group.settings[pair[0]]));
                toggle.addEventListener('click', function () {
                    group.settings[pair[0]] = !group.settings[pair[0]];
                    if (WS.sync) WS.sync.setGroups(ws.syncGroups);
                    renderDrawer();
                    scheduleSave();
                });
                grid.appendChild(toggle);
            });
            card.appendChild(grid);

            var members = el('div', 'group-members');
            var used = groupUsage(group.id);
            members.textContent = used.length ? used.map(function (c) { return c.symbol + ' ' + c.timeframe; }).join('  ·  ') : 'No charts assigned';
            card.appendChild(members);

            var row = el('div', 'row');
            var del = el('button', 'btn-ghost', 'Delete group');
            del.addEventListener('click', function () {
                if (used.length) {
                    toast('Move its charts to another group first', true);
                    return;
                }
                ws.syncGroups = ws.syncGroups.filter(function (g) { return g.id !== group.id; });
                if (WS.sync) WS.sync.setGroups(ws.syncGroups);
                renderGroupChips();
                renderDrawer();
                scheduleSave();
            });
            row.appendChild(del);
            card.appendChild(row);
            body.appendChild(card);
        });

        var create = el('button', 'btn-ghost primary', '+ New group');
        create.addEventListener('click', function () {
            var id = 'g-' + Math.random().toString(36).slice(2, 8);
            var wsx = activeWorkspace();
            wsx.syncGroups.push({
                id: id,
                name: 'Group ' + (wsx.syncGroups.length + 1),
                color: GROUP_COLORS[wsx.syncGroups.length % GROUP_COLORS.length],
                enabled: true,
                settings: clone(wsx.globalSettings)
            });
            if (WS.sync) WS.sync.setGroups(wsx.syncGroups);
            renderGroupChips();
            renderDrawer();
            scheduleSave();
        });
        body.appendChild(create);
        body.appendChild(el('div', 'group-members', 'A chart with no group stays fully independent. Group settings override the workspace defaults.'));
        renderDrawerCharts();
    }

    function renderDrawerCharts() {
        // Panel accents need refreshing after group colour edits.
        Object.keys(WS.charts).forEach(function (id) { updateGroupVisual(WS.charts[id]); });
    }

    function setGroupEnabled(groupId, enabled) {
        var ws = activeWorkspace();
        var group = ws.syncGroups.filter(function (g) { return g.id === groupId; })[0];
        if (!group) return;
        group.enabled = enabled;
        if (WS.sync) {
            WS.sync.setGroups(ws.syncGroups);
            WS.sync.clearAllCrosshairs();
            WS.sync.schedulePriceScaleRefresh();
        }
        renderGroupChips();
        renderDrawer();
        scheduleSave();
    }

    /* ── Layout engine ───────────────────────────────────────────────────── */

    function buildLayoutSwitch() {
        var wrap = $('#layout-switch');
        wrap.innerHTML = '';
        var icons = {
            '1': 'menu-layout-setup-1',
            '2h': 'menu-layout-setup-2h',
            '2v': 'menu-layout-setup-2h',
            '4': 'menu-layout-setup-4',
            '6': 'menu-layout-setup-6',
            '8': 'menu-layout-setup-8',
            'custom': 'scr-chart-grid'
        };
        Object.keys(LAYOUTS).forEach(function (key) {
            var spec = LAYOUTS[key];
            var btn = el('button', 'layout-btn');
            btn.type = 'button';
            btn.title = spec.label;
            btn.setAttribute('aria-label', spec.label);
            btn.dataset.layout = key;
            var icon = panelIcon(icons[key] || 'menu-layout-setup-1', 17);
            icon.style.display = 'block';
            if (key === '2v') icon.style.transform = 'rotate(90deg)';
            btn.appendChild(icon);
            btn.addEventListener('click', function () { setLayout(key); });
            wrap.appendChild(btn);
        });
    }

    function equalFractions(count) {
        var out = [];
        for (var i = 0; i < count; i++) out.push(1 / count);
        return out;
    }

    function presetForCount(n) {
        if (n <= 1) return '1';
        if (n === 2) return '2h';
        if (n === 4) return '4';
        if (n === 6) return '6';
        if (n === 8) return '8';
        return 'custom';
    }

    function customGridFor(n) {
        var cols = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : 4;
        var rows = Math.ceil(n / cols);
        return { columns: equalFractions(cols), rows: equalFractions(rows) };
    }

    function setLayout(layout) {
        var ws = activeWorkspace();
        if (!ws) return;
        if (layout === ws.layout) return;
        var spec = LAYOUTS[layout];
        ws.layout = layout;
        if (layout === 'custom') {
            var grid = customGridFor(ws.charts.length);
            ws.columns = grid.columns;
            ws.rows = grid.rows;
        } else {
            var cap = spec.cols * spec.rows;
            while (ws.charts.length < cap) ws.charts.push(defaultChartConfig(ws.charts.length));
            ws.columns = equalFractions(spec.cols);
            ws.rows = equalFractions(spec.rows);
        }
        WS.maximized = null;
        applyGridTemplate(ws);
        syncPanels(ws);
        updateLayoutButtons();
        renderGutters();
        scheduleSave();
    }

    function applyGridTemplate(ws) {
        var grid = $('#ws-grid');
        var cols = ws.columns && ws.columns.length ? ws.columns : [1];
        var rows = ws.rows && ws.rows.length ? ws.rows : [1];
        if (ws.layout !== 'custom') {
            var spec = LAYOUTS[ws.layout] || LAYOUTS['4'];
            cols = equalFractions(spec.cols);
            rows = equalFractions(spec.rows);
        }
        grid.style.setProperty('--ws-cols', cols.map(function (v) { return 'minmax(0, ' + v.toFixed(5) + 'fr)'; }).join(' '));
        grid.style.setProperty('--ws-rows', rows.map(function (v) { return 'minmax(0, ' + v.toFixed(5) + 'fr)'; }).join(' '));
    }

    function updateLayoutButtons() {
        var ws = activeWorkspace();
        document.querySelectorAll('.layout-btn').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.dataset.layout === ws.layout));
        });
    }

    function defaultChartConfig(index) {
        var slot = DEFAULT_SLOTS[index % DEFAULT_SLOTS.length];
        var ws = activeWorkspace();
        var group = ws && ws.syncGroups.length ? ws.syncGroups[index % ws.syncGroups.length] : null;
        return {
            id: nextChartId(),
            exchange: slot[0],
            market: 'spot',
            symbol: slot[1],
            timeframe: slot[2],
            chartType: 'candlestick',
            priceScaleMode: (ws && ws.globalSettings.priceScale) || 'independent',
            referenceMode: 'first_visible',
            referenceTime: null,
            indicators: [],
            showVolume: true,
            groupId: group ? group.id : null,
            drawings: [],
            view: null
        };
    }

    function ensureIndicators(config) {
        ensureChartIndicatorConfig(config);
    }

    function nextChartId() {
        var n = 1;
        var ids = {};
        if (WS.store) {
            WS.store.workspaces.forEach(function (w) {
                w.charts.forEach(function (c) { ids[c.id] = true; });
            });
        }
        while (ids['c' + n]) n++;
        return 'c' + n;
    }

    function activeConfigs(ws) {
        if (!ws) return [];
        if (ws.layout === 'custom') return ws.charts;
        return ws.charts.slice(0, capacity(ws));
    }

    function syncPanels(ws) {
        var configs = activeConfigs(ws);
        var wanted = {};
        configs.forEach(function (cfg) { wanted[cfg.id] = true; });
        Object.keys(WS.charts).forEach(function (id) {
            if (!wanted[id]) destroyEntry(id);
        });
        configs.forEach(function (cfg) {
            var entry = WS.charts[cfg.id];
            if (!entry) entry = makeEntry(cfg);
            if (entry.panel.parentNode !== $('#ws-grid')) $('#ws-grid').appendChild(entry.panel);
        });
        configs.forEach(function (cfg) {
            var entry = WS.charts[cfg.id];
            if (entry) $('#ws-grid').appendChild(entry.panel);
        });
        if (!configs.length) { renderEmptyCells(); return; }
        if (!WS.focused || !WS.charts[WS.focused]) focusChart(WS.charts[configs[0].id]);
        renderEmptyCells();
    }

    function renderEmptyCells() {
        var grid = $('#ws-grid');
        if (!grid) return;
        Array.prototype.forEach.call(grid.querySelectorAll('.empty-cell'), function (node) {
            node.remove();
        });
        var ws = activeWorkspace();
        if (!ws) return;
        var cap = ws.layout === 'custom' ? ws.charts.length : capacity(ws);
        var used = activeConfigs(ws).length;
        for (var i = used; i < cap; i++) {
            var cell = el('button', 'empty-cell');
            cell.type = 'button';
            cell.setAttribute('aria-label', 'Add chart');
            cell.appendChild(el('span', 'plus', '+'));
            cell.appendChild(el('span', 't', 'Add chart'));
            cell.appendChild(el('span', 's', 'Panel ' + (i + 1)));
            cell.addEventListener('click', function () { addChart(); });
            grid.appendChild(cell);
        }
    }

    /**
     * Add a chart panel. `patch` lets callers (AI plan overlays) pin the
     * instrument/timeframe; keep it out of the click handlers so a DOM event
     * can never be merged into the config.
     */
    function addChart(patch) {
        var ws = activeWorkspace();
        if (!ws) return null;
        if (ws.charts.length >= 12) { toast('Maximum 12 charts', true); return null; }
        var cfg = defaultChartConfig(ws.charts.length);
        if (patch) Object.assign(cfg, patch);
        var cap = capacity(ws);
        if (ws.layout !== 'custom' && ws.charts.length < cap) {
            ws.charts.push(cfg);
            syncPanels(ws);
        } else if (ws.layout !== 'custom' && cap < 8) {
            var next = cap === 1 ? '2h' : cap === 2 ? '4' : cap === 4 ? '6' : '8';
            ws.layout = next;
            var spec = LAYOUTS[next];
            ws.columns = equalFractions(spec.cols);
            ws.rows = equalFractions(spec.rows);
            ws.charts.push(cfg);
            applyGridTemplate(ws);
            syncPanels(ws);
            updateLayoutButtons();
            renderGutters();
        } else {
            ws.layout = 'custom';
            ws.charts.push(cfg);
            var grid = customGridFor(ws.charts.length);
            ws.columns = grid.columns;
            ws.rows = grid.rows;
            applyGridTemplate(ws);
            syncPanels(ws);
            updateLayoutButtons();
            renderGutters();
        }
        scheduleSave();
        return cfg;
    }

    function removeChart(entry) {
        var ws = activeWorkspace();
        if (ws.charts.length <= 1) { toast('At least one chart is required', true); return; }
        destroyEntry(entry.id);
        ws.charts = ws.charts.filter(function (c) { return c.id !== entry.id; });
        if (ws.layout !== 'custom') {
            var preset = presetForCount(ws.charts.length);
            ws.layout = preset;
            if (preset === 'custom') {
                var grid = customGridFor(ws.charts.length);
                ws.columns = grid.columns;
                ws.rows = grid.rows;
            } else {
                var spec = LAYOUTS[preset];
                ws.columns = equalFractions(spec.cols);
                ws.rows = equalFractions(spec.rows);
            }
        } else {
            var grid2 = customGridFor(ws.charts.length);
            ws.columns = grid2.columns;
            ws.rows = grid2.rows;
        }
        WS.maximized = null;
        $('#ws-grid').classList.remove('maximized');
        applyGridTemplate(ws);
        syncPanels(ws);
        updateLayoutButtons();
        renderGutters();
        renderGroupChips();
        scheduleSave();
    }

    function reorderCharts(fromId, toId) {
        var ws = activeWorkspace();
        var fromIdx = ws.charts.findIndex(function (c) { return c.id === fromId; });
        var toIdx = ws.charts.findIndex(function (c) { return c.id === toId; });
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
        var moved = ws.charts.splice(fromIdx, 1)[0];
        ws.charts.splice(toIdx, 0, moved);
        syncPanels(ws);
        if (WS.maximized) toggleMaximize(WS.charts[WS.maximized], true);
        scheduleSave();
    }

    function toggleMaximize(entry, forceRestore) {
        if (!entry) return;
        var grid = $('#ws-grid');
        var next = forceRestore ? null : (WS.maximized === entry.id ? null : entry.id);
        WS.maximized = next;
        grid.classList.toggle('maximized', !!next);
        Object.keys(WS.charts).forEach(function (id) {
            WS.charts[id].panel.classList.toggle('is-maximized', id === next);
        });
        renderGutters();
        setTimeout(function () {
            Object.keys(WS.charts).forEach(function (id) {
                var e = WS.charts[id];
                if (!e || !e.chart) return;
                var w = e.host.clientWidth, h = e.host.clientHeight;
                if (w > 0 && h > 0) e.chart.applyOptions({ width: w, height: h });
                resizeDrawCanvas(e);
                scheduleDraw(e);
            });
        }, 30);
    }

    /* ── Custom resizable grid ───────────────────────────────────────────── */

    function renderGutters() {
        var layer = $('#ws-gutters');
        if (!layer) return;
        layer.innerHTML = '';
        var ws = activeWorkspace();
        if (!ws || ws.layout !== 'custom' || WS.maximized) return;
        var grid = $('#ws-grid');
        var rect = grid.getBoundingClientRect();
        var padding = 6;
        var gap = 6;
        var usableW = rect.width - padding * 2 - gap * Math.max(0, ws.columns.length - 1);
        var usableH = rect.height - padding * 2 - gap * Math.max(0, ws.rows.length - 1);
        var acc = 0;
        for (var i = 0; i < ws.columns.length - 1; i++) {
            acc += ws.columns[i];
            (function (index, left) {
                var gutter = el('div', 'ws-gutter v');
                gutter.style.left = (padding + left * usableW + gap * index + gap / 2) + 'px';
                gutter.style.top = padding + 'px';
                gutter.style.bottom = padding + 'px';
                gutter.title = 'Drag to resize columns';
                gutter.addEventListener('pointerdown', function (ev) {
                    startGutterDrag(ev, 'columns', index, rect, padding, usableW);
                });
                layer.appendChild(gutter);
            })(i, acc);
        }
        acc = 0;
        for (var j = 0; j < ws.rows.length - 1; j++) {
            acc += ws.rows[j];
            (function (index, top) {
                var gutter = el('div', 'ws-gutter h');
                gutter.style.top = (padding + top * usableH + gap * index + gap / 2) + 'px';
                gutter.style.left = padding + 'px';
                gutter.style.right = padding + 'px';
                gutter.title = 'Drag to resize rows';
                gutter.addEventListener('pointerdown', function (ev) {
                    startGutterDrag(ev, 'rows', index, rect, padding, usableH);
                });
                layer.appendChild(gutter);
            })(j, acc);
        }
    }

    function startGutterDrag(ev, kind, index, rect, padding, usable) {
        ev.preventDefault();
        var ws = activeWorkspace();
        var origin = kind === 'columns' ? rect.left : rect.top;
        var sizes = ws[kind].slice();
        var prefix = sizes.slice(0, index).reduce(function (a, b) { return a + b; }, 0);
        var pairTotal = sizes[index] + sizes[index + 1];
        var gapOffset = 6 * index;
        function onMove(moveEv) {
            var pos = kind === 'columns' ? moveEv.clientX : moveEv.clientY;
            var frac = (pos - origin - padding - gapOffset) / usable;
            var local = frac - prefix;
            var min = 0.08;
            local = clamp(local, min, pairTotal - min);
            sizes[index] = local;
            sizes[index + 1] = pairTotal - local;
            ws[kind] = sizes.slice();
            applyGridTemplate(ws);
            Object.keys(WS.charts).forEach(function (id) {
                var e = WS.charts[id];
                var w = e.host.clientWidth, h = e.host.clientHeight;
                if (w > 0 && h > 0) e.chart.applyOptions({ width: w, height: h });
            });
        }
        function onUp() {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            renderGutters();
            scheduleSave();
        }
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }

    /* ── Drawing tools (lightweight-charts-drawing) ─────────────────────────
       One DrawingManager per chart renders the TradingView tool set as a v5
       series primitive.  Drawings live in the chart's workspace config, always
       in raw price units; the manager works in the chart's display units
       (percentage / indexed modes remap prices), so the integration projects
       at the boundary and reprojects when the reference price moves. */
    var ChartDrawings = window.ChartDrawings;

    function drawPriceSpace(entry) {
        return {
            mode: entry.config.priceScaleMode,
            refPrice: entry.refPrice
        };
    }

    function drawingToDisplay(entry, price) {
        var space = drawPriceSpace(entry);
        return ChartDrawings.rawToDisplay(price, space.mode, space.refPrice);
    }

    function drawingToRaw(entry, price) {
        var space = drawPriceSpace(entry);
        return ChartDrawings.displayToRaw(price, space.mode, space.refPrice);
    }

    /** Display-space OHLCV for the manager (magnet, VWAP, volume profiles). */
    function displayBars(entry) {
        var out = [];
        var rows = entry.display || [];
        var raw = entry.candles || [];
        for (var i = 0; i < rows.length; i++) {
            var bar = rows[i];
            var source = raw[i];
            out.push({
                time: bar.time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: source && isFinite(source.volume) ? source.volume : 0
            });
        }
        return out;
    }

    function drawMigrationContext(entry) {
        var last = entry.candles && entry.candles.length ? entry.candles[entry.candles.length - 1] : null;
        return {
            time: last ? last.time : Math.floor(Date.now() / 1000),
            price: last && last.close ? last.close : 1
        };
    }

    function drawMagnet() {
        return WS.prefs.drawMagnet === 'off' ? 'off' : 'weak';
    }

    function attachDrawings(entry) {
        var DW = window.LightweightChartsDrawing;
        if (!DW || !entry.chart || !entry.mainSeries) return;
        detachDrawings(entry);
        var needsSave = ChartDrawings.needsMigration(entry.config.drawings);
        var stored = ChartDrawings.normalize(entry.config.drawings, drawMigrationContext(entry));
        entry.config.drawings = stored;
        if (needsSave) scheduleSave();

        var manager = new DW.DrawingManager(entry.chart, entry.mainSeries, {
            bars: function () { return displayBars(entry); },
            fontFamily: "'MesloLGS NFM', 'JetBrains Mono', ui-monospace, monospace",
            magnet: drawMagnet(),
            interval: ChartDrawings.intervalForTimeframe(entry.config.timeframe),
            timeInfo: function () {
                return {
                    timeZone: 'UTC',
                    intraday: ChartDrawings.isIntraday(entry.config.timeframe)
                };
            },
            stayInDrawingMode: false
        });
        entry.drawMgr = manager;
        entry.drawSyncing = true;
        restoreDrawImages(entry);
        manager.importJSON(ChartDrawings.project(stored, function (price) {
            return drawingToDisplay(entry, price);
        }));
        entry.drawSyncing = false;
        entry.drawSpace = ChartDrawings.spaceSignature(entry.config.priceScaleMode, entry.refPrice);

        manager.on('change', function () {
            if (entry.drawSyncing || entry.destroyed) return;
            // The library holds the chart during a drag / placement; serialising
            // every intermediate frame is wasted work. Commit once at the end.
            if (manager.savedScroll || manager.gesture) {
                entry.drawDirty = true;
                return;
            }
            commitDrawings(entry);
        });
        manager.on('gestureEnd', function () {
            if (!entry.drawDirty) return;
            entry.drawDirty = false;
            commitDrawings(entry);
        });
        manager.on('selection', function () {
            updateDrawStyleBar(entry);
        });
        manager.on('tool', function (kind) {
            // Placement ends the armed tool (one-shot, TV default); mirror it
            // on the host state unless the host is mid-switch.
            if (!kind && !entry.drawArming && entry.drawTool &&
                entry.drawTool !== 'select' && !isCustomDrawTool(entry.drawTool)) {
                entry.drawTool = null;
            }
            syncDrawToolButtons(entry);
        });
        manager.on('textEdit', function (drawing, point) {
            openDrawTextEditor(entry, drawing, point);
        });
        manager.on('tableEdit', function (drawing, cell, box) {
            openDrawTableCellEditor(entry, drawing, cell, box);
        });
        // Safety net for presses without a prior hover (touch / fast drags):
        // as soon as the manager mutates a drawing, undo any price pan the
        // chart gesture already applied.
        manager.on('update', function () {
            if (entry.pricePan && entry.pricePan.active && entry.pricePan.cancel) {
                entry.pricePan.cancel();
            }
        });
        updateDrawStyleBar(entry);
        syncDrawToolButtons(entry);
    }

    function detachDrawings(entry) {
        var manager = entry.drawMgr;
        entry.drawMgr = null;
        entry.drawSpace = null;
        if (!manager) return;
        try { manager.select([]); } catch (err) { /* ignore */ }
        try { manager.destroy(); } catch (err) { /* ignore */ }
    }

    /** Persist the manager's display-space points back into raw config space. */
    function commitDrawings(entry) {
        if (!entry.drawMgr) return;
        var raw = ChartDrawings.project(entry.drawMgr.drawings(), function (price) {
            return drawingToRaw(entry, price);
        });
        entry.config.drawings = ChartDrawings.normalize(raw, drawMigrationContext(entry));
        entry.drawSpace = ChartDrawings.spaceSignature(entry.config.priceScaleMode, entry.refPrice);
        scheduleSave();
    }

    /**
     * A new reference price re-bases percentage / indexed units; shift every
     * stored anchor into the new display space without dropping selection.
     */
    function reprojectDrawings(entry) {
        if (!entry.drawMgr || !entry.config.drawings || !entry.config.drawings.length) return;
        var signature = ChartDrawings.spaceSignature(entry.config.priceScaleMode, entry.refPrice);
        if (signature === entry.drawSpace) return;
        entry.drawSpace = signature;
        var byId = {};
        entry.config.drawings.forEach(function (drawing) { byId[drawing.id] = drawing; });
        entry.drawSyncing = true;
        entry.drawMgr.drawings().forEach(function (current) {
            var stored = byId[current.id];
            if (!stored || !current.points) return;
            var points = current.points.map(function (point, index) {
                var source = stored.points[index];
                var rawPrice = source && isFinite(source.price) ? source.price : drawingToRaw(entry, point.price);
                return { time: point.time, price: drawingToDisplay(entry, rawPrice) };
            });
            entry.drawMgr.update(Object.assign({}, current, { points: points }));
        });
        entry.drawSyncing = false;
    }

    function isCustomDrawTool(tool) {
        return tool === 'long' || tool === 'short' || tool === 'measure';
    }

    function setDrawTool(entry, tool, options) {
        if (entry.drawTool === tool) tool = null;
        entry.drawTool = tool;
        var custom = isCustomDrawTool(tool);
        var library = !!tool && !custom && tool !== 'select';
        entry.drawCanvas.classList.toggle('active', custom);
        entry.panel.classList.toggle('drawing', custom);
        try {
            if (custom) {
                entry.chart.applyOptions({ handleScroll: false, handleScale: false });
            } else {
                entry.chart.applyOptions({
                    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
                    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
                });
            }
        } catch (err) { /* ignore */ }
        if (entry.drawMgr) {
            if (library) entry.drawMgr.setDrawingsVisible(true);
            entry.drawArming = true;
            entry.drawMgr.setTool(library ? tool : null, library && options && options.glyph ? { glyph: options.glyph } : undefined);
            entry.drawArming = false;
        }
        if (custom) resizeDrawCanvas(entry);
        entry.selectedPosition = null;
        entry.selectedMeasure = false;
        if (tool !== 'long' && tool !== 'short') entry.posDraft = null;
        if (tool !== 'measure') entry.measureDraft = null;
        entry.measureDrag = null;
        syncDrawToolButtons(entry);
        updateDrawStyleBar(entry);
        if (custom) {
            renderDrawings(entry);
            entry.drawCanvas.focus && entry.drawCanvas.focus();
        }
    }

    function toggleRail(entry) {
        if (entry.rail.classList.contains('open')) {
            entry.rail.classList.remove('open');
            closeToolPalette(entry);
            setDrawTool(entry, null);
        } else {
            entry.rail.classList.add('open');
            setDrawTool(entry, 'select');
        }
    }

    function syncDrawToolButtons(entry) {
        if (!entry.rail) return;
        var active = entry.drawTool;
        entry.rail.querySelectorAll('button[data-tool]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.dataset.tool === active));
        });
        var allTools = entry.rail.querySelector('[data-action="all-tools"]');
        if (allTools) allTools.setAttribute('aria-expanded', String(!!entry.drawPalette));
        if (entry.drawPalette) {
            entry.drawPalette.querySelectorAll('button[data-kind]').forEach(function (btn) {
                btn.setAttribute('aria-pressed', String(btn.dataset.kind === active));
            });
        }
        if (entry.drawMagnetBtn) {
            var on = drawMagnet() !== 'off';
            entry.drawMagnetBtn.setAttribute('aria-pressed', String(on));
            entry.drawMagnetBtn.title = on ? 'Magnet on — snapping to OHLC' : 'Magnet off';
        }
        if (entry.drawEyeBtn && entry.drawMgr) {
            var visible = entry.drawMgr.drawingsVisible();
            entry.drawEyeBtn.setAttribute('aria-pressed', String(!visible));
            entry.drawEyeBtn.title = visible ? 'Hide all drawings' : 'Show all drawings';
            entry.drawEyeBtn.replaceChildren(panelIcon(visible ? 'draw-hide-all-drawings' : 'draw-hide-all-mode-active'));
        }
    }

    function resizeDrawCanvas(entry) {
        var canvas = entry.drawCanvas;
        var dpr = window.devicePixelRatio || 1;
        var w = entry.body.clientWidth;
        var h = entry.host.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
        }
    }

    /** Re-paint every live chart after the shell switches light/dark. */
    function applyTheme() {
        readTheme();
        Object.keys(WS.charts).forEach(function (id) {
            var entry = WS.charts[id];
            if (!entry || entry.destroyed || !entry.chart) return;
            try {
                entry.chart.applyOptions(themeOptions());
                if (entry.mainSeries) entry.mainSeries.applyOptions(seriesTheme(entry.config.chartType));
                // Volume bar colours are baked per point, so repaint the series.
                if (entry.volumeSeries && entry.candles && entry.candles.length) {
                    entry.volumeSeries.setData(volumeData(entry));
                }
                if (entry.legend) renderLegend(entry);
                if (entry.stripCandle && entry.ohlcStrip.classList.contains('show')) {
                    showStrip(entry, entry.stripCandle);
                }
                if (entry.drawMgr) entry.drawMgr.redraw();
                scheduleDraw(entry);
            } catch (err) { /* a chart mid-teardown must not break the switch */ }
        });
    }

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function syncTheme(theme) {
        if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
        else document.documentElement.removeAttribute('data-theme');
        applyTheme();
        syncThemeButton();
    }

    // The shell writes `tp-theme`; same-origin storage events reach this frame.
    window.addEventListener('storage', function (event) {
        if (event.key !== 'tp-theme') return;
        syncTheme(event.newValue === 'light' ? 'light' : 'dark');
    });
    WS.setTheme = syncTheme;
    WS.currentTheme = currentTheme;

    function scheduledDraw(entry) {
        if (entry.rafId) return;
        entry.rafId = requestAnimationFrame(function () {
            entry.rafId = null;
            renderDrawings(entry);
        });
    }
    var scheduleDraw = scheduledDraw;

    function xForTime(entry, time) {
        var ts = entry.chart.timeScale();
        var x = ts.timeToCoordinate(time);
        if (x != null) return x;
        var candles = entry.candles;
        if (candles.length < 2) return null;
        var last = candles[candles.length - 1];
        var prev = candles[candles.length - 2];
        var x1 = ts.timeToCoordinate(last.time);
        var x0 = ts.timeToCoordinate(prev.time);
        if (x1 == null || x0 == null || x1 === x0) return null;
        return x1 + (time - last.time) * (x1 - x0) / (last.time - prev.time);
    }

    function timeForX(entry, x) {
        var ts = entry.chart.timeScale();
        var t = ts.coordinateToTime(x);
        if (t != null) return t;
        var candles = entry.candles;
        if (candles.length < 2) return null;
        var last = candles[candles.length - 1];
        var prev = candles[candles.length - 2];
        var x1 = ts.timeToCoordinate(last.time);
        var x0 = ts.timeToCoordinate(prev.time);
        if (x1 == null || x0 == null || x1 === x0) return null;
        return Math.round(last.time + (x - x1) * (last.time - prev.time) / (x1 - x0));
    }

    function priceForY(entry, y) {
        var p = entry.mainSeries.coordinateToPrice(y);
        return p == null ? null : toRawPrice(entry, p);
    }

    function yForPrice(entry, price) {
        var p = entry.mainSeries.priceToCoordinate(transformValue(entry, price));
        return p == null ? null : p;
    }

    function plotBox(entry) {
        var ts = entry.chart.timeScale();
        // The time-axis strip is separate from the plot; the overlay canvas
        // spans the host, so subtract the axis height.
        var axisHeight = ts.height ? ts.height() : 28;
        return {
            w: ts.width ? ts.width() : entry.host.clientWidth - 72,
            h: Math.max(1, entry.host.clientHeight - axisHeight)
        };
    }

    function renderDrawings(entry) {
        if (!entry || !entry.chart || entry.destroyed) return;
        resizeDrawCanvas(entry);
        var canvas = entry.drawCanvas;
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var w = canvas.width / dpr, h = canvas.height / dpr;
        ctx.clearRect(0, 0, w, h);
        var box = plotBox(entry);
        drawPositions(entry, ctx, box);
        drawPositionGuide(entry, ctx, box);
        drawPositionDraft(entry, ctx, box);
        drawMeasure(entry, ctx, box);
    }

    /* ── Selected-drawing style bar ─────────────────────────────────────── */

    function ensureDrawStyleBar(entry) {
        if (entry.drawStyleBar) return entry.drawStyleBar;
        var bar = el('div', 'draw-stylebar');
        bar.hidden = true;
        bar.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
        entry.body.appendChild(bar);
        entry.drawStyleBar = bar;
        return bar;
    }

    function selectedDrawings(entry) {
        if (!entry.drawMgr) return [];
        return entry.drawMgr.selection().map(function (id) {
            return entry.drawMgr.get(id);
        }).filter(Boolean);
    }

    function styleButton(parent, label, title, onClick) {
        var btn = el('button', 'dsb-btn', label);
        btn.type = 'button';
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            onClick(btn);
        });
        parent.appendChild(btn);
        return btn;
    }

    function applyDrawStyle(entry, patch) {
        var selected = selectedDrawings(entry);
        if (!selected.length || !entry.drawMgr) return;
        selected.forEach(function (drawing) {
            entry.drawMgr.update(Object.assign({}, drawing, {
                style: Object.assign({}, drawing.style, patch)
            }));
        });
        updateDrawStyleBar(entry);
    }

    function updateDrawStyleBar(entry) {
        var bar = ensureDrawStyleBar(entry);
        var selected = selectedDrawings(entry);
        if (!selected.length) {
            bar.hidden = true;
            return;
        }
        var primary = selected[0];
        var style = primary.style || {};
        bar.hidden = false;
        bar.innerHTML = '';

        var title = el('span', 'dsb-kind',
            selected.length > 1
                ? selected.length + ' drawings'
                : ChartDrawings.kindLabel(primary.kind));
        bar.appendChild(title);

        var colors = el('span', 'dsb-colors');
        ChartDrawings.COLORS.forEach(function (color) {
            var swatch = el('button', 'dsb-swatch');
            swatch.type = 'button';
            swatch.style.background = color;
            swatch.title = 'Colour ' + color;
            swatch.setAttribute('aria-label', 'Colour ' + color);
            if ((style.color || '').toLowerCase() === color.toLowerCase()) {
                swatch.setAttribute('aria-pressed', 'true');
            }
            swatch.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                applyDrawStyle(entry, { color: color });
            });
            colors.appendChild(swatch);
        });
        bar.appendChild(colors);

        bar.appendChild(el('span', 'dsb-sep'));
        var widths = el('span', 'dsb-group');
        ChartDrawings.WIDTHS.forEach(function (width) {
            var btn = styleButton(widths, String(width), width + 'px line', function () {
                applyDrawStyle(entry, { width: width, lineWidth: width });
            });
            if (Number(style.width) === width) btn.setAttribute('aria-pressed', 'true');
        });
        bar.appendChild(widths);

        var dashes = el('span', 'dsb-group');
        ChartDrawings.DASHES.forEach(function (dash) {
            var btn = styleButton(dashes, '', dash + ' line', function () {
                applyDrawStyle(entry, { lineStyle: dash, lineStyleName: dash });
            });
            btn.classList.add('dsb-dash', 'dsb-dash-' + dash);
            if ((style.lineStyle || 'solid') === dash) btn.setAttribute('aria-pressed', 'true');
        });
        bar.appendChild(dashes);

        bar.appendChild(el('span', 'dsb-sep'));
        var locked = !!primary.locked;
        var lock = styleButton(bar, '', locked ? 'Unlock drawing' : 'Lock drawing', function () {
            selected.forEach(function (drawing) {
                entry.drawMgr.update(Object.assign({}, drawing, { locked: !drawing.locked }));
            });
            updateDrawStyleBar(entry);
        });
        lock.classList.add('dsb-icon', 'dsb-lock');
        lock.appendChild(panelIcon(locked ? 'dt-cm-unlock' : 'draw-lock'));
        if (locked) lock.setAttribute('aria-pressed', 'true');

        var remove = styleButton(bar, '', 'Delete selected drawings', function () {
            var ids = entry.drawMgr.selection().slice();
            ids.forEach(function (id) { entry.drawMgr.remove(id); });
            updateDrawStyleBar(entry);
        });
        remove.classList.add('dsb-icon', 'dsb-danger');
        remove.appendChild(panelIcon('dt-remove'));

        var close = styleButton(bar, '', 'Deselect', function () {
            entry.drawMgr.select([]);
            updateDrawStyleBar(entry);
        });
        close.classList.add('dsb-icon');
        close.appendChild(panelIcon('tab-close'));
    }

    /* ── Tool palette ───────────────────────────────────────────────────── */

    function drawRecent() {
        return Array.isArray(WS.prefs.drawRecent) ? WS.prefs.drawRecent.slice(0, 8) : [];
    }

    function touchDrawRecent(kind) {
        var list = drawRecent().filter(function (item) { return item !== kind; });
        list.unshift(kind);
        WS.prefs.drawRecent = list.slice(0, 8);
        savePrefs();
    }

    function closeToolPalette(entry) {
        if (!entry.drawPalette) return;
        entry.drawPalette.remove();
        entry.drawPalette = null;
        syncDrawToolButtons(entry);
    }

    function openToolPalette(entry) {
        if (entry.drawPalette) { closeToolPalette(entry); return; }
        var panel = el('div', 'draw-palette');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Drawing tools');
        panel.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });

        var head = el('div', 'dp-head');
        var searchIcon = el('span', 'dp-search-ico');
        searchIcon.appendChild(panelIcon('scr-search', 15));
        head.appendChild(searchIcon);
        var search = el('input', 'dp-search');
        search.type = 'search';
        search.placeholder = 'Search ' + ChartDrawings.TOOLS.length + ' tools…';
        search.setAttribute('aria-label', 'Search drawing tools');
        head.appendChild(search);
        var close = el('button', 'dp-close');
        close.type = 'button';
        close.title = 'Close tool palette';
        close.setAttribute('aria-label', 'Close tool palette');
        close.appendChild(panelIcon('tab-close'));
        close.addEventListener('click', function () { closeToolPalette(entry); });
        head.appendChild(close);
        panel.appendChild(head);

        var body = el('div', 'dp-body');
        panel.appendChild(body);

        var foot = el('div', 'dp-foot');
        var magnet = el('button', 'dp-toggle');
        magnet.type = 'button';
        magnet.appendChild(panelIcon('draw-magnet', 15));
        magnet.appendChild(document.createTextNode('Magnet'));
        magnet.setAttribute('aria-pressed', String(drawMagnet() !== 'off'));
        magnet.addEventListener('click', function () { toggleDrawMagnet(entry); });
        foot.appendChild(magnet);

        var eye = el('button', 'dp-toggle');
        eye.type = 'button';
        eye.appendChild(panelIcon('draw-hide-all-drawings', 15));
        eye.appendChild(document.createTextNode('Hide all'));
        eye.addEventListener('click', function () { toggleDrawVisibility(entry); });
        foot.appendChild(eye);
        foot.appendChild(el('span', 'dp-hint', 'Enter picks · Esc closes'));
        panel.appendChild(foot);

        entry.drawPalette = panel;
        entry.body.appendChild(panel);
        syncDrawToolButtons(entry);

        function renderPalette(filter) {
            body.innerHTML = '';
            var query = (filter || '').trim().toLowerCase();
            var matches = ChartDrawings.TOOLS.filter(function (tool) {
                if (!query) return true;
                return tool.label.toLowerCase().indexOf(query) >= 0 ||
                    tool.kind.indexOf(query) >= 0 ||
                    tool.familyLabel.toLowerCase().indexOf(query) >= 0;
            });
            if (!query) {
                var recent = drawRecent().map(function (kind) {
                    return ChartDrawings.TOOL_BY_KIND[kind];
                }).filter(Boolean);
                if (recent.length) body.appendChild(renderGroup('Recent', recent));
            }
            if (!matches.length) {
                body.appendChild(el('p', 'dp-empty', 'No tool matches “' + (filter || '') + '”.'));
                return;
            }
            ChartDrawings.FAMILIES.forEach(function (family) {
                var items = matches.filter(function (tool) { return tool.family === family.id; });
                if (items.length) body.appendChild(renderGroup(family.label, items));
            });
            syncFavoriteButtons();
        }

        function renderGroup(label, items) {
            var group = el('div', 'dp-group');
            var heading = el('div', 'dp-group-title');
            var titleWrap = el('span', 'dp-group-name');
            if (items.length) titleWrap.appendChild(panelIcon(ChartDrawings.familyIconName(items[0].family), 15));
            titleWrap.appendChild(el('span', '', label));
            heading.appendChild(titleWrap);
            heading.appendChild(el('span', 'dp-count', String(items.length)));
            group.appendChild(heading);
            var grid = el('div', 'dp-grid');
            items.forEach(function (tool) {
                var item = el('div', 'dp-item');
                var btn = el('button', 'dp-tool');
                btn.type = 'button';
                btn.dataset.kind = tool.kind;
                btn.title = ChartDrawings.isTextKind(tool.kind)
                    ? tool.label + ' — place, then type'
                    : tool.label;
                btn.setAttribute('aria-pressed', String(entry.drawTool === tool.kind));
                btn.appendChild(panelIcon(toolIconName(tool.kind), 18));
                btn.appendChild(el('span', 'dp-tool-label', tool.label));
                btn.addEventListener('click', function () {
                    touchDrawRecent(tool.kind);
                    closeToolPalette(entry);
                    chooseDrawTool(entry, tool.kind);
                });
                var favorite = el('button', 'dp-fav');
                favorite.type = 'button';
                favorite.dataset.favorite = tool.kind;
                favorite.appendChild(panelIcon(starIcon(false), 15));
                favorite.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggleDrawFavorite(tool.kind);
                });
                item.appendChild(btn);
                item.appendChild(favorite);
                grid.appendChild(item);
            });
            group.appendChild(grid);
            return group;
        }

        search.addEventListener('input', function () { renderPalette(search.value); });
        search.addEventListener('keydown', function (ev) {
            var tools = body.querySelectorAll('button.dp-tool');
            if (ev.key === 'Escape') { ev.stopPropagation(); closeToolPalette(entry); return; }
            if (ev.key === 'Enter' && tools.length) {
                ev.preventDefault();
                tools[0].click();
                return;
            }
            if (ev.key === 'ArrowDown' && tools.length) {
                ev.preventDefault();
                tools[0].focus();
            }
        });
        body.addEventListener('keydown', function (ev) {
            var tools = Array.prototype.slice.call(body.querySelectorAll('button.dp-tool'));
            var index = tools.indexOf(document.activeElement);
            if (ev.key === 'Escape') { ev.stopPropagation(); closeToolPalette(entry); return; }
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
                ev.preventDefault();
                (tools[index + 1] || tools[0]).focus();
            } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
                ev.preventDefault();
                (tools[index <= 0 ? tools.length - 1 : index - 1]).focus();
            }
        });

        renderPalette('');
        search.focus();
    }

    function toggleDrawMagnet(entry) {
        WS.prefs.drawMagnet = drawMagnet() === 'off' ? 'weak' : 'off';
        savePrefs();
        Object.keys(WS.charts).forEach(function (id) {
            var chart = WS.charts[id];
            if (chart.drawMgr) chart.drawMgr.setMagnet(drawMagnet());
            syncDrawToolButtons(chart);
        });
        if (entry.drawPalette) {
            var toggle = entry.drawPalette.querySelector('.dp-toggle');
            if (toggle) toggle.setAttribute('aria-pressed', String(drawMagnet() !== 'off'));
        }
    }

    function toggleDrawVisibility(entry) {
        if (!entry.drawMgr) return;
        entry.drawMgr.setDrawingsVisible(!entry.drawMgr.drawingsVisible());
        syncDrawToolButtons(entry);
        if (entry.drawPalette) {
            var eye = entry.drawPalette.querySelectorAll('.dp-toggle')[1];
            if (eye) eye.setAttribute('aria-pressed', String(!entry.drawMgr.drawingsVisible()));
        }
    }

    /* ── Host text editor for text-family drawings ───────────────────────── */

    function openDrawTextEditor(entry, drawing, point) {
        if (!drawing) return;
        entry.pendingText = drawing.id;
        var ed = entry.textEditor;
        var x = point && isFinite(point.x) ? point.x : 12;
        var y = point && isFinite(point.y) ? point.y : 40;
        ed.style.left = clamp(x, 4, Math.max(4, entry.body.clientWidth - 190)) + 'px';
        ed.style.top = clamp(y - 30, 4, Math.max(4, entry.body.clientHeight - 40)) + 'px';
        ed.classList.add('show');
        entry.textInput.value = drawing.text || '';
        // The placement click's own pointer-up lands after this event and can
        // move focus to the chart, so grab it once the gesture is complete.
        setTimeout(function () {
            if (entry.pendingText !== drawing.id) return;
            entry.textInput.focus({ preventScroll: true });
            entry.textInput.select();
        }, 70);
    }

    function commitDrawText(entry) {
        if (!entry.pendingText) return;
        var id = entry.pendingText;
        var text = entry.textInput.value.trim();
        entry.pendingText = null;
        entry.textEditor.classList.remove('show');
        entry.textInput.value = '';
        var drawing = entry.drawMgr && entry.drawMgr.get(id);
        if (!drawing) return;
        if (text) entry.drawMgr.update(Object.assign({}, drawing, { text: text }));
        else entry.drawMgr.remove(id);
    }

    function cancelDrawText(entry) {
        entry.pendingText = null;
        entry.textEditor.classList.remove('show');
        entry.textInput.value = '';
    }

    /* ── Table cell editor (lightweight-charts-drawing tables) ──────────── */

    function openDrawTableCellEditor(entry, drawing, cell, box) {
        if (!drawing || !cell) return;
        entry.pendingText = null;
        entry.tableEditRef = { id: drawing.id, cell: cell };
        var ed = entry.textEditor;
        var left = box && isFinite(box.left) ? box.left : 12;
        var top = box && isFinite(box.top) ? box.top : 40;
        ed.style.left = clamp(left, 4, Math.max(4, entry.body.clientWidth - 190)) + 'px';
        ed.style.top = clamp(top, 4, Math.max(4, entry.body.clientHeight - 40)) + 'px';
        ed.classList.add('show');
        entry.textInput.value = '';
        setTimeout(function () {
            if (!entry.tableEditRef) return;
            entry.textInput.focus({ preventScroll: true });
        }, 70);
    }

    function commitDrawTableCell(entry) {
        var ref = entry.tableEditRef;
        if (!ref) return;
        var text = entry.textInput.value;
        entry.tableEditRef = null;
        entry.textEditor.classList.remove('show');
        entry.textInput.value = '';
        if (!entry.drawMgr) return;
        entry.drawMgr.setTableCellText(ref.id, ref.cell, text);
        entry.drawMgr.endTableEdit();
    }

    function cancelDrawTableCell(entry) {
        if (!entry.tableEditRef) return;
        entry.tableEditRef = null;
        entry.textEditor.classList.remove('show');
        entry.textInput.value = '';
        if (entry.drawMgr) entry.drawMgr.endTableEdit();
    }

    /* ── Image / font-icon host pickers ─────────────────────────────────── */

    var DRAW_IMAGE_KEY = 'trade_panel.workspace.draw_images.v1';
    var MAX_DRAW_IMAGE_BYTES = 1_200_000;

    function drawImageStoreKey(entry) {
        return String(WS.activeId || 'ws') + '|' + String(entry.config.id || 'chart');
    }

    function readDrawImageStore() {
        try {
            var raw = localStorage.getItem(DRAW_IMAGE_KEY);
            var parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (err) {
            return {};
        }
    }

    function rememberDrawImage(entry, record) {
        var all = readDrawImageStore();
        var key = drawImageStoreKey(entry);
        var list = Array.isArray(all[key]) ? all[key] : [];
        list = list.filter(function (img) { return img && img.name !== record.name; });
        list.push(record);
        all[key] = list.slice(-8);
        try { localStorage.setItem(DRAW_IMAGE_KEY, JSON.stringify(all)); }
        catch (err) { toast('The drawing image could not be stored (storage is full)', true); }
    }

    function restoreDrawImages(entry) {
        var DW = window.LightweightChartsDrawing;
        if (!DW || !DW.cacheImage) return;
        var list = readDrawImageStore()[drawImageStoreKey(entry)];
        if (!Array.isArray(list)) return;
        list.forEach(function (img) {
            if (!img || !img.name || !img.url) return;
            try {
                DW.cacheImage(img.name, { url: img.url, width: img.width, height: img.height });
            } catch (err) { /* stale record */ }
        });
    }

    function pickDrawImage(entry) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp,image/gif';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            input.remove();
            if (!file || !entry.drawMgr) return;
            if (file.size > MAX_DRAW_IMAGE_BYTES) {
                toast('Image is too large — maximum 1.2 MB', true);
                return;
            }
            var reader = new FileReader();
            reader.onload = function () {
                var url = String(reader.result || '');
                var probe = new Image();
                probe.onload = function () {
                    var scale = Math.min(1, 360 / probe.naturalWidth, 240 / probe.naturalHeight);
                    var cssWidth = Math.max(24, Math.round(probe.naturalWidth * scale));
                    var cssHeight = Math.max(24, Math.round(probe.naturalHeight * scale));
                    var name = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
                    var DW = window.LightweightChartsDrawing;
                    var record = { name: name, url: url, width: probe.naturalWidth, height: probe.naturalHeight };
                    try { DW.cacheImage(name, record); } catch (err) { /* older build */ }
                    rememberDrawImage(entry, record);
                    var id = entry.drawMgr.addImage({ name: name, width: cssWidth, height: cssHeight });
                    if (!id) toast('Could not place the image', true);
                    else entry.drawMgr.select([id]);
                };
                probe.onerror = function () { toast('Unsupported image file', true); };
                probe.src = url;
            };
            reader.onerror = function () { toast('Could not read the image', true); };
            reader.readAsDataURL(file);
        });
        input.click();
    }

    function pickDrawGlyph(entry) {
        openPrompt('Font icon', '★', function (glyph) {
            if (!entry.drawMgr) return;
            setDrawTool(entry, 'font-icon', { glyph: glyph });
        });
    }

    function finishDrawing(entry) {
        var keepPosition = entry.selectedPosition;
        var keepMeasure = entry.selectedMeasure;
        setDrawTool(entry, null);
        // A just-created position/measure stays selected so its handles and
        // stats are immediately editable (TradingView behaviour).
        entry.selectedPosition = keepPosition;
        entry.selectedMeasure = keepMeasure;
        renderDrawings(entry);
    }
    /* ── Position projections + measure ─────────────────────────────────── */

    var POS_STORE_KEY = 'trade_panel.workspace.positions.v1';
    var POS_SETTINGS_KEY = 'trade_panel.workspace.position_settings.v1';

    function positionSymbolKey(entry) {
        return entry.config.exchange + '|' + entry.config.market + '|' + entry.config.symbol;
    }

    function readJsonStorage(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function loadPositions(entry) {
        var all = readJsonStorage(POS_STORE_KEY, {});
        var list = all[positionSymbolKey(entry)];
        if (!Array.isArray(list)) return [];
        return list.map(PositionTool.normalizePosition).filter(Boolean).slice(-200);
    }

    function savePositions(entry) {
        try {
            var all = readJsonStorage(POS_STORE_KEY, {});
            all[positionSymbolKey(entry)] = entry.positions.slice(-200);
            localStorage.setItem(POS_STORE_KEY, JSON.stringify(all));
        } catch (err) { /* storage unavailable */ }
    }

    function loadPositionSettings() {
        return PositionTool.normalizeSettings(readJsonStorage(POS_SETTINGS_KEY, {}));
    }

    function savePositionSettings(entry) {
        try {
            localStorage.setItem(POS_SETTINGS_KEY, JSON.stringify(entry.posSettings));
        } catch (err) { /* ignore */ }
    }

    function notifyPosition(entry, pos) {
        if (!pos) return;
        try {
            if (Bridge.obj && Bridge.obj.onPositionDrawingChanged) {
                Bridge.obj.onPositionDrawingChanged(pos.dir, pos.entry, pos.tp, pos.sl);
            }
        } catch (err) { /* ignore */ }
    }

    /** Close of the candle that contains `time` (0 when it is in the future). */
    function closeAtTime(entry, time) {
        var candles = entry.candles;
        if (!candles || !candles.length) return 0;
        var idx = lowerBound(candles, time);
        if (idx < candles.length && candles[idx].time === time) return candles[idx].close;
        idx -= 1;
        return idx >= 0 ? candles[idx].close : 0;
    }

    /**
     * Market inputs for the sizing engine. The box's right edge decides
     * between "open PnL at the last price" (future edge) and the close of the
     * edge candle (past edge), mirroring TradingView's PnL states.
     */
    function positionMarket(entry, pos) {
        var precision = entry.precision == null ? 2 : entry.precision;
        var tickSize = entry.minMove > 0 ? entry.minMove : Math.pow(10, -precision);
        var last = entry.candles && entry.candles.length
            ? entry.candles[entry.candles.length - 1]
            : null;
        var market = {
            precision: precision,
            tickSize: tickSize,
            lastPrice: last ? last.close : 0,
            closeAtEnd: 0
        };
        if (pos && last && isFinite(pos.endTime) && pos.endTime <= last.time) {
            market.closeAtEnd = closeAtTime(entry, pos.endTime);
        }
        return market;
    }

    function computePosition(entry, pos) {
        return PositionTool.compute(pos, entry.posSettings, positionMarket(entry, pos));
    }

    function openPositionSettings(entry) {
        var s = PositionTool.normalizeSettings(entry.posSettings);
        var pos = entry.selectedPosition
            ? entry.positions.filter(function (p) { return p.id === entry.selectedPosition; })[0] || null
            : null;
        var form = el('div', 'pos-form');
        var error = el('p', 'pos-error');
        error.setAttribute('role', 'alert');
        var fieldSeq = 0;

        function field(parent, label, value, step, hint) {
            var box = el('div', 'field');
            var input = el('input', 'input mono');
            fieldSeq += 1;
            var inputId = 'pos-field-' + fieldSeq;
            var labelNode = el('label', '', label);
            labelNode.htmlFor = inputId;
            input.id = inputId;
            box.appendChild(labelNode);
            input.type = 'number';
            input.step = step || '1';
            input.inputMode = 'decimal';
            input.value = value;
            box.appendChild(input);
            if (hint) box.appendChild(el('div', 'pos-hint', hint));
            parent.appendChild(box);
            return input;
        }

        function title(text, sub) {
            var row = el('div', 'pos-section-title');
            row.appendChild(el('span', '', text));
            if (sub) row.appendChild(el('span', 'sub', sub));
            return row;
        }

        function toggleRow(parent, label, desc, checked, onChange) {
            var row = el('div', 'pos-switch');
            var lbl = el('div', 'lbl');
            lbl.appendChild(el('b', '', label));
            lbl.appendChild(el('span', '', desc));
            var sw = el('button', 'switch');
            sw.type = 'button';
            sw.setAttribute('role', 'switch');
            sw.setAttribute('aria-checked', String(!!checked));
            sw.setAttribute('aria-label', label);
            sw.addEventListener('click', function () {
                var next = sw.getAttribute('aria-checked') !== 'true';
                sw.setAttribute('aria-checked', String(next));
                if (onChange) onChange(next);
            });
            row.appendChild(lbl);
            row.appendChild(sw);
            parent.appendChild(row);
            return sw;
        }

        /* ── Sizing ── */
        var sizing = el('div', 'pos-section');
        sizing.appendChild(title('Position sizing', 'Qty = min(risk qty, leverage qty)'));
        var sizingGrid = el('div', 'pos-grid');
        var acctInput = field(sizingGrid, 'Account size (USDT)', s.acct, '100');
        var levInput = field(sizingGrid, 'Leverage', s.lev, '1');
        var lotInput = field(sizingGrid, 'Lot size', s.lotSize, '0.1');
        var qtyPrecisionInput = field(sizingGrid, 'Quantity precision', s.qtyPrecision, '1', 'Decimals shown on tags (0–8)');
        sizing.appendChild(sizingGrid);

        var riskBox = el('div', 'field');
        var riskLabel = el('label', '', 'Risk per trade');
        riskLabel.htmlFor = 'pos-risk-input';
        riskBox.appendChild(riskLabel);
        var riskRow = el('div', 'pos-risk');
        var seg = el('div', 'seg');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Risk mode');
        var mode = s.riskMode;
        var riskDraft = { percent: s.riskPercent, amount: s.riskAmount };
        var modeButtons = {};
        ['percent', 'amount'].forEach(function (key) {
            var btn = el('button', '', key === 'percent' ? '%' : 'USDT');
            btn.type = 'button';
            btn.dataset.mode = key;
            btn.setAttribute('aria-pressed', String(mode === key));
            btn.title = key === 'percent' ? 'Risk as a percentage of the account' : 'Risk as a fixed amount';
            btn.addEventListener('click', function () {
                if (mode === key) return;
                var acct = Number(acctInput.value);
                var current = Number(riskInput.value);
                var nextValue = key === 'percent'
                    ? (isFinite(current) && acct > 0 ? current / acct * 100 : riskDraft.percent)
                    : (isFinite(current) ? current * acct / 100 : riskDraft.amount);
                nextValue = Number(nextValue.toFixed(4));
                mode = key;
                riskDraft[key] = nextValue;
                riskInput.value = nextValue;
                Object.keys(modeButtons).forEach(function (k) {
                    modeButtons[k].setAttribute('aria-pressed', String(k === mode));
                });
                renderPreview();
            });
            modeButtons[key] = btn;
            seg.appendChild(btn);
        });
        var riskInput = el('input', 'input mono');
        riskInput.id = 'pos-risk-input';
        riskInput.type = 'number';
        riskInput.step = mode === 'percent' ? '0.1' : '10';
        riskInput.inputMode = 'decimal';
        riskInput.value = mode === 'percent' ? s.riskPercent : s.riskAmount;
        riskRow.appendChild(seg);
        riskRow.appendChild(riskInput);
        riskBox.appendChild(riskRow);
        riskBox.appendChild(el('div', 'pos-hint', 'Balance at target / stop is derived from this budget.'));
        sizing.appendChild(riskBox);
        form.appendChild(sizing);

        /* ── Display ── */
        var display = el('div', 'pos-section');
        display.appendChild(title('Display'));
        var displayGrid = el('div', 'pos-grid');
        var widthInput = field(displayGrid, 'Default box width (px)', s.widthPx, '10', 'Used by new boxes and AI overlays');
        display.appendChild(displayGrid);
        var switches = el('div', 'pos-switches');
        var showSwitch = toggleRow(switches, 'Show stats panel',
            'Selected box shows quantity, risk, reward and balances', s.showStats, renderPreview);
        var compactSwitch = toggleRow(switches, 'Compact stats mode',
            'Collapse tags to a single summary strip on the box', s.compactStats, renderPreview);
        display.appendChild(switches);
        form.appendChild(display);

        /* ── Preview ── */
        var preview = el('div', 'pos-preview');
        form.appendChild(preview);

        /* ── Selected position ── */
        var selected = el('div', 'pos-section');
        selected.appendChild(title('Selected position', pos ? (pos.dir === 'long' ? 'Long' : 'Short') : 'None'));
        var entryInput = null;
        var tpInput = null;
        var slInput = null;
        if (pos) {
            var levelGrid = el('div', 'pos-grid three');
            entryInput = field(levelGrid, 'Entry', trimNumber(pos.entry, entry.precision), '0.01');
            tpInput = field(levelGrid, 'Take profit', trimNumber(pos.tp, entry.precision), '0.01');
            slInput = field(levelGrid, 'Stop loss', trimNumber(pos.sl, entry.precision), '0.01');
            selected.appendChild(levelGrid);
            var actions = el('div');
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '10px';
            var reset = el('button', 'btn-ghost', 'Reset stop to 1:1');
            reset.type = 'button';
            reset.addEventListener('click', function () {
                var entryPrice = Number(entryInput.value);
                var target = Number(tpInput.value);
                if (!(entryPrice > 0) || !(target > 0)) return;
                var stop = PositionTool.mirrorStop(pos.dir, entryPrice, target);
                slInput.value = trimNumber(stop, entry.precision);
                renderPreview();
            });
            actions.appendChild(reset);
            actions.appendChild(el('span', 'pos-hint', 'Dragging a level on the chart keeps levels independent.'));
            selected.appendChild(actions);
        } else {
            selected.appendChild(el('div', 'pos-empty',
                'Select a long or short box to edit its entry, target and stop here.'));
        }
        form.appendChild(selected);
        form.appendChild(error);

        function readSettings() {
            var acct = Number(acctInput.value);
            var riskValue = Number(riskInput.value);
            var percent = mode === 'percent' ? riskValue : (acct > 0 ? riskValue / acct * 100 : riskDraft.percent);
            var amount = mode === 'amount' ? riskValue : acct * riskValue / 100;
            return {
                acct: acct,
                riskMode: mode,
                riskPercent: percent,
                riskAmount: amount,
                lev: Number(levInput.value),
                lotSize: Number(lotInput.value),
                qtyPrecision: Number(qtyPrecisionInput.value),
                widthPx: Number(widthInput.value),
                showStats: showSwitch.getAttribute('aria-checked') === 'true',
                compactStats: compactSwitch.getAttribute('aria-checked') === 'true'
            };
        }

        function previewMetrics(settings) {
            var market = positionMarket(entry, pos);
            if (pos) {
                var live = {
                    dir: pos.dir,
                    entry: entryInput ? Number(entryInput.value) : pos.entry,
                    tp: tpInput ? Number(tpInput.value) : pos.tp,
                    sl: slInput ? Number(slInput.value) : pos.sl,
                    startTime: pos.startTime,
                    endTime: pos.endTime
                };
                return PositionTool.compute(live, settings, market);
            }
            var last = entry.candles && entry.candles.length
                ? entry.candles[entry.candles.length - 1].close
                : 100;
            if (!(last > 0)) last = 100;
            return PositionTool.compute({
                dir: 'long', entry: last, tp: last * 1.02, sl: last * 0.99,
                startTime: 1, endTime: 2
            }, settings, {
                precision: entry.precision,
                tickSize: entry.minMove,
                lastPrice: last,
                closeAtEnd: 0
            });
        }

        function renderPreview() {
            var settings = readSettings();
            var normalized = PositionTool.normalizeSettings(settings);
            var m = previewMetrics(normalized);
            preview.innerHTML = '';
            var head = el('div', 'pos-preview-head');
            var dirLabel = (m ? (m.dir === 'long' ? 'LONG' : 'SHORT') : (pos ? pos.dir.toUpperCase() : 'LONG'));
            var dirNode = el('b', 'dir ' + dirLabel.toLowerCase(), dirLabel);
            head.appendChild(dirNode);
            head.appendChild(el('span', '', entry.config.symbol + ' · ' + tfLabel(entry.config.timeframe)));
            head.appendChild(el('span', 'spacer', pos ? 'Live preview' : '2% / 1% template'));
            preview.appendChild(head);
            if (!m) {
                preview.appendChild(el('div', 'pos-hint', 'Enter a valid entry, target and stop to see sizing.'));
                return;
            }
            var rows = el('div', 'pos-preview-rows');
            PositionTool.statsRows(m).forEach(function (row) {
                var line = el('div', 'pos-preview-row');
                line.appendChild(el('span', '', row.label));
                var value = el('b', row.tone || '', row.value);
                line.appendChild(value);
                rows.appendChild(line);
            });
            preview.appendChild(rows);
            var warn = '';
            if (m.capped === 'leverage') warn = 'Quantity is capped by leverage, so the actual risk is below the budget.';
            else if (m.qty <= 0) warn = 'Quantity is zero — check the risk budget and stop distance.';
            if (warn) preview.appendChild(el('div', 'pos-hint', warn));
        }

        [acctInput, levInput, lotInput, qtyPrecisionInput, widthInput, riskInput,
            entryInput, tpInput, slInput].forEach(function (input) {
            if (input) input.addEventListener('input', renderPreview);
        });

        /* ── Footer ── */
        var foot = el('div');
        foot.style.marginLeft = 'auto';
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        var cancel = el('button', 'btn-ghost', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', closeModal);
        var apply = el('button', 'btn-ghost primary', 'Apply');
        apply.type = 'button';
        apply.addEventListener('click', function () {
            error.textContent = '';
            var settings = readSettings();
            if (!(settings.acct > 0)) { error.textContent = 'Account size must be greater than zero.'; return; }
            if (!(settings.riskPercent > 0) || !(settings.riskAmount > 0)) {
                error.textContent = 'Risk must be greater than zero.';
                return;
            }
            if (!(settings.lev >= 1)) { error.textContent = 'Leverage must be at least 1×.'; return; }
            if (!(settings.lotSize > 0)) { error.textContent = 'Lot size must be greater than zero.'; return; }
            if (!(settings.widthPx >= 40)) { error.textContent = 'Default box width must be at least 40 px.'; return; }
            if (pos) {
                var entryPrice = Number(entryInput.value);
                var target = Number(tpInput.value);
                var stop = Number(slInput.value);
                if (![entryPrice, target, stop].every(function (v) { return isFinite(v) && v > 0; })) {
                    error.textContent = 'Entry, target and stop must be positive prices.';
                    return;
                }
                var ordered = pos.dir === 'long'
                    ? stop < entryPrice && entryPrice < target
                    : target < entryPrice && entryPrice < stop;
                if (!ordered) {
                    error.textContent = pos.dir === 'long'
                        ? 'A long needs stop < entry < target.'
                        : 'A short needs target < entry < stop.';
                    return;
                }
                pos.entry = entryPrice;
                pos.tp = target;
                pos.sl = stop;
                savePositions(entry);
                notifyPosition(entry, pos);
            }
            entry.posSettings = PositionTool.normalizeSettings(settings);
            savePositionSettings(entry);
            syncStatsButtons(entry);
            closeModal();
            renderDrawings(entry);
        });
        foot.appendChild(cancel);
        foot.appendChild(apply);

        form.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && ev.target && ev.target.tagName === 'INPUT') {
                ev.preventDefault();
                apply.click();
            }
        });

        renderPreview();
        openModal({
            title: 'Position tool',
            sub: 'Sizing, risk, display and the selected box',
            body: form,
            foot: foot,
            onOpen: function () {
                var first = form.querySelector('input');
                if (first) first.focus();
            }
        });
    }

    /** Price without thousands separators, trimmed to the chart precision. */
    function trimNumber(value, precision) {
        if (!isFinite(value)) return '';
        var places = precision == null ? 2 : precision;
        return String(Number(Number(value).toFixed(places)));
    }

    function pinnedLevelY(entry, price, box) {
        var y = yForPrice(entry, price);
        if (y == null) return null;
        if (y < 10) return 10;
        if (y > box.h - 10) return box.h - 10;
        return y;
    }

    function roundedRect(ctx, x, y, w, h, r) {
        var radius = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function fitText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        var clipped = text;
        while (clipped.length > 1 && ctx.measureText(clipped + '\u2026').width > maxWidth) {
            clipped = clipped.slice(0, -1);
        }
        return clipped + '\u2026';
    }

    /**
     * Right/left aligned pill. `x` is the anchored edge, `y` the centre.
     * Returns the drawn width so callers can stack tags.
     */
    function drawTag(ctx, text, x, y, opts) {
        var font = opts.font || '9.5px "JetBrains Mono", monospace';
        ctx.font = font;
        var padX = opts.padX == null ? 5 : opts.padX;
        var height = opts.height || 16;
        var width = Math.min(opts.maxWidth || Infinity, ctx.measureText(text).width + padX * 2);
        var left = opts.align === 'left' ? x : x - width;
        left = Math.max(1, left);
        roundedRect(ctx, left, y - height / 2, width, height, 3);
        if (opts.fill) {
            ctx.fillStyle = opts.fill;
            ctx.fill();
        }
        if (opts.border) {
            ctx.strokeStyle = opts.border;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.fillStyle = opts.color || THEME.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = font;
        var clipped = fitText(ctx, text, width - padX * 2);
        ctx.fillText(clipped, left + padX, y + 0.5);
        ctx.textBaseline = 'alphabetic';
        return width;
    }

    /** Push stacked tags apart while keeping them inside the plot. */
    function stackTagCentres(tags, box) {
        var gap = 17;
        var min = 9, max = box.h - 9;
        if (tags.length * gap > max - min) gap = Math.max(11, (max - min) / tags.length);
        tags.sort(function (a, b) { return a.y - b.y; });
        tags.forEach(function (tag, i) {
            tag.y = clamp(tag.y, min, max);
            if (i > 0 && tag.y - tags[i - 1].y < gap) tag.y = tags[i - 1].y + gap;
        });
        for (var i = tags.length - 1; i >= 0; i--) {
            var limit = i === tags.length - 1 ? max : tags[i + 1].y - gap;
            if (tags[i].y > limit) tags[i].y = limit;
        }
    }

    function drawPositions(entry, ctx, box) {
        // Selected box last so its stats panel sits above neighbouring boxes.
        entry.positions.slice().sort(function (a, b) {
            return (a.id === entry.selectedPosition ? 1 : 0) - (b.id === entry.selectedPosition ? 1 : 0);
        }).forEach(function (pos) {
            var metrics = computePosition(entry, pos);
            if (!metrics) return;
            drawPositionBox(entry, ctx, box, pos, metrics, pos.id === entry.selectedPosition);
        });
    }

    function drawPositionBox(entry, ctx, box, pos, m, selected) {
        var x0 = xForTime(entry, pos.startTime);
        var x1 = xForTime(entry, pos.endTime);
        if (x0 == null) {
            if (x1 == null) return;
            x0 = Math.max(0, x1 - 80);
        }
        if (x1 == null) x1 = box.w - 2;
        if (x1 <= x0) return;
        if (x1 < -40 || x0 > box.w + 60) return;
        var yEntry = pinnedLevelY(entry, pos.entry, box);
        var yTp = pinnedLevelY(entry, pos.tp, box);
        var ySl = pinnedLevelY(entry, pos.sl, box);
        if (yEntry == null || yTp == null || ySl == null) return;

        var precision = entry.precision == null ? 2 : entry.precision;
        var long = m.long;
        var dirRgb = long ? 'upRgb' : 'downRgb';
        var dirColor = long ? THEME.up : THEME.down;
        var left = Math.max(1, x0);
        var right = Math.min(box.w - 1, x1);
        if (right - left < 1) right = left + 1;
        var boxW = right - left;
        var profitTop = Math.min(yEntry, yTp);
        var lossTop = Math.min(yEntry, ySl);
        var entryOff = Math.abs((yForPrice(entry, pos.entry) || 0) - yEntry) > 1;
        var tpOff = Math.abs((yForPrice(entry, pos.tp) || 0) - yTp) > 1;
        var slOff = Math.abs((yForPrice(entry, pos.sl) || 0) - ySl) > 1;

        // Profit zone (entry → TP) is green, risk zone (entry → SL) is red;
        // for shorts the zones simply swap sides.
        ctx.fillStyle = rgbaOf('upRgb', selected ? 0.17 : 0.11);
        ctx.fillRect(left, profitTop, boxW, Math.max(1, Math.abs(yTp - yEntry)));
        ctx.fillStyle = rgbaOf('downRgb', selected ? 0.17 : 0.11);
        ctx.fillRect(left, lossTop, boxW, Math.max(1, Math.abs(ySl - yEntry)));

        ctx.strokeStyle = rgbaOf(dirRgb, selected ? 0.85 : 0.5);
        ctx.lineWidth = 1;
        ctx.setLineDash(selected ? [] : [2, 2]);
        ctx.strokeRect(left + 0.5, Math.min(yEntry, yTp, ySl) + 0.5,
            Math.max(1, boxW - 1), Math.max(1, Math.abs(Math.max(yEntry, yTp, ySl) - Math.min(yEntry, yTp, ySl)) - 1));
        ctx.setLineDash([]);

        function levelLine(y, color, dashed) {
            ctx.strokeStyle = color;
            ctx.lineWidth = dashed ? 1.1 : 1.4;
            ctx.setLineDash(dashed ? [5, 3] : []);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        levelLine(yEntry, dirColor, false);
        levelLine(yTp, THEME.up, true);
        levelLine(ySl, THEME.down, true);

        if (selected) {
            [[yEntry, dirColor], [yTp, THEME.up], [ySl, THEME.down]].forEach(function (pair) {
                ctx.fillStyle = THEME.panel;
                ctx.strokeStyle = pair[1];
                ctx.lineWidth = 1.3;
                ctx.beginPath();
                ctx.rect(left - 3.5, pair[0] - 3.5, 7, 7);
                ctx.fill();
                ctx.stroke();
            });
            ctx.fillStyle = THEME.accent;
            roundedRect(ctx, right - 1.5, Math.min(yEntry, yTp, ySl), 3,
                Math.max(4, Math.abs(Math.max(yEntry, yTp, ySl) - Math.min(yEntry, yTp, ySl))), 1.5);
            ctx.fill();
        }

        // In-box quantity / balance tags: always on, hidden in compact mode.
        var compact = !!(entry.posSettings && entry.posSettings.compactStats);
        var showStats = !entry.posSettings || entry.posSettings.showStats !== false;
        if (!compact) {
            var entryText = 'Qty ' + PositionTool.formatQty(m.qty, m.qtyPrecision);
            ctx.font = '9px "JetBrains Mono", monospace';
            if (boxW > 84) {
                var above = long ? yEntry - 4 : yEntry + 11;
                drawTag(ctx, entryText, left + 5, above, {
                    font: '9px "JetBrains Mono", monospace',
                    align: 'left', height: 14,
                    color: dirColor, fill: rgbaOf(dirRgb, 0.14),
                    border: rgbaOf(dirRgb, 0.4),
                    maxWidth: boxW - 10
                });
            }
            if (boxW > 132) {
                var balance = function (y, value, color) {
                    var yText = (y + yEntry) / 2 + 3;
                    ctx.font = '9px "JetBrains Mono", monospace';
                    ctx.fillStyle = color;
                    ctx.textAlign = 'left';
                    ctx.fillText(fitText(ctx, 'Bal ' + PositionTool.formatMoney(value),
                        boxW - 62), left + 6, yText);
                };
                if (Math.abs(yTp - yEntry) >= 18) balance(yTp, m.balanceAtTp, THEME.up);
                if (Math.abs(ySl - yEntry) >= 18) balance(ySl, m.balanceAtSl, THEME.down);
            }
        } else if (boxW > 60) {
            var strip = PositionTool.compactSummary(m);
            var stripY = Math.min(yEntry, yTp, ySl) - 9;
            if (stripY < 8) stripY = Math.max(yEntry, yTp, ySl) + 9;
            if (stripY <= box.h - 8) {
                // Compact tags may extend past the box, like TradingView's
                // performance tags, so the numbers are never ellipsised.
                drawTag(ctx, strip, left + 5, stripY, {
                    font: '9px "JetBrains Mono", monospace',
                    align: 'left', height: 14,
                    color: dirColor, fill: THEME.panel,
                    border: rgbaOf(dirRgb, 0.4),
                    maxWidth: Math.max(80, box.w - left - 8)
                });
            }
        }

        // Right-edge level tags (TradingView style), stacked when compressed.
        if (boxW > 34) {
            var anchor = clamp(right, 34, box.w - 3);
            var tags = [
                {
                    y: yEntry, key: 'entry',
                    text: 'ENTRY ' + formatPrice(pos.entry, precision) + (entryOff ? ' \u25B2' : ''),
                    fill: dirColor, color: THEME.bg, border: null
                },
                {
                    y: yTp, key: 'tp',
                    text: 'TP ' + formatPrice(pos.tp, precision) + '  ' + PositionTool.formatPct(m.tpMovePct) + (tpOff ? ' \u25B2' : ''),
                    fill: THEME.panel, color: THEME.up, border: rgbaOf('upRgb', 0.7)
                },
                {
                    y: ySl, key: 'sl',
                    text: 'SL ' + formatPrice(pos.sl, precision) + '  ' + PositionTool.formatPct(m.slMovePct) + (slOff ? ' \u25B2' : ''),
                    fill: THEME.panel, color: THEME.down, border: rgbaOf('downRgb', 0.7)
                }
            ];
            stackTagCentres(tags, box);
            tags.forEach(function (tag) {
                drawTag(ctx, tag.text, anchor - 2, tag.y, {
                    align: 'right',
                    fill: tag.fill, color: tag.color, border: tag.border,
                    maxWidth: Math.max(64, Math.min(box.w - 4, anchor - 2))
                });
            });
        }

        if (selected && showStats) {
            drawPositionStatsCard(entry, ctx, box, pos, m, {
                left: left, right: right, yEntry: yEntry, yTp: yTp, ySl: ySl
            });
        }
    }

    /**
     * Dotted full-width guide at the price being edited. It exists only while
     * a level (or the whole box) is being dragged, so releasing the pointer
     * removes it automatically.
     */
    function drawPositionGuide(entry, ctx, box) {
        var drag = entry.positionDrag;
        if (!drag || !drag.pos) return;
        var pos = drag.pos;
        var spec;
        if (drag.type === 'tp') spec = { price: pos.tp, rgb: 'upRgb' };
        else if (drag.type === 'sl') spec = { price: pos.sl, rgb: 'downRgb' };
        else if (drag.type === 'entry' || drag.type === 'body') {
            spec = { price: pos.entry, rgb: pos.dir === 'long' ? 'upRgb' : 'downRgb' };
        } else return;
        var y = pinnedLevelY(entry, spec.price, box);
        if (y == null) return;
        ctx.save();
        ctx.strokeStyle = rgbaOf(spec.rgb, 0.85);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(box.w, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    function drawPositionStatsCard(entry, ctx, box, pos, m, geom) {
        var rows = PositionTool.statsRows(m);
        var tone = {
            up: THEME.up, down: THEME.down, dir: m.long ? THEME.up : THEME.down,
            muted: THEME.muted, text: THEME.ink
        };
        var labelFont = '9px "JetBrains Mono", monospace';
        var valueFont = '9.5px "JetBrains Mono", monospace';
        var labelW = 0, valueW = 0;
        ctx.font = labelFont;
        rows.forEach(function (row) { labelW = Math.max(labelW, ctx.measureText(row.label).width); });
        ctx.font = valueFont;
        rows.forEach(function (row) { valueW = Math.max(valueW, ctx.measureText(row.value).width); });
        var maxCardW = Math.max(176, Math.min(340, box.w - 20));
        var cardW = clamp(Math.ceil(labelW + valueW + 34), 176, maxCardW);
        var headerH = 24;
        var rowH = 13;
        var cardH = headerH + rows.length * rowH + 9;

        var x = geom.left - cardW - 10;
        if (x < 8) {
            if (geom.right + cardW + 10 < box.w - 8) x = geom.right + 10;
            else x = clamp(geom.left + 8, 8, box.w - cardW - 8);
        }
        x = clamp(x, 8, Math.max(8, box.w - cardW - 8));
        var y = clamp(geom.yEntry - cardH / 2, 8, Math.max(8, box.h - cardH - 8));

        roundedRect(ctx, x, y, cardW, cardH, 6);
        ctx.fillStyle = THEME.panel;
        ctx.fill();
        ctx.strokeStyle = rgbaOf(m.long ? 'upRgb' : 'downRgb', 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();

        var dirColor = m.long ? THEME.up : THEME.down;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = '9.5px "JetBrains Mono", monospace';
        ctx.fillStyle = dirColor;
        ctx.fillText(m.long ? 'LONG' : 'SHORT', x + 10, y + 15);
        var dirW = ctx.measureText(m.long ? 'LONG' : 'SHORT').width;
        ctx.fillStyle = THEME.muted;
        ctx.fillText('  ' + entry.config.symbol + '  ' + tfLabel(entry.config.timeframe), x + 10 + dirW, y + 15);
        var rr = PositionTool.rrLabel(m.rr);
        ctx.font = '9px "JetBrains Mono", monospace';
        var rrW = ctx.measureText(rr).width;
        ctx.fillStyle = THEME.ink;
        ctx.fillText(rr, x + cardW - 10 - rrW, y + 15);
        ctx.strokeStyle = THEME.border;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + headerH - 4.5);
        ctx.lineTo(x + cardW - 10, y + headerH - 4.5);
        ctx.stroke();

        rows.forEach(function (row, i) {
            var rowY = y + headerH + 9 + i * rowH;
            ctx.font = labelFont;
            ctx.fillStyle = THEME.muted;
            ctx.fillText(row.label, x + 10, rowY);
            ctx.font = valueFont;
            ctx.fillStyle = tone[row.tone] || THEME.ink;
            var value = fitText(ctx, row.value, Math.max(40, cardW - labelW - 24));
            var width = ctx.measureText(value).width;
            ctx.fillText(value, x + cardW - 10 - width, rowY);
        });
        ctx.font = valueFont;
    }

    function drawPositionDraft(entry, ctx, box) {
        var draft = entry.posDraft;
        if (!draft) return;
        var long = draft.dir === 'long';
        var target = draft.current;
        var sl = PositionTool.mirrorStop(draft.dir, draft.entry, target);
        var x0 = xForTime(entry, draft.time);
        var x1 = xForTime(entry, draft.currentTime || draft.time);
        var yEntry = yForPrice(entry, draft.entry);
        var yTp = yForPrice(entry, target);
        var ySl = yForPrice(entry, sl);
        if (x0 == null || yEntry == null || yTp == null || ySl == null) return;
        if (x1 == null || x1 <= x0) x1 = x0 + 80;
        var dirColor = long ? THEME.up : THEME.down;
        var dirRgb = long ? 'upRgb' : 'downRgb';
        var top = Math.min(yEntry, yTp, ySl);
        var bottom = Math.max(yEntry, yTp, ySl);
        ctx.fillStyle = rgbaOf('upRgb', 0.12);
        ctx.fillRect(x0, Math.min(yEntry, yTp), Math.max(1, x1 - x0), Math.max(1, Math.abs(yTp - yEntry)));
        ctx.fillStyle = rgbaOf('downRgb', 0.12);
        ctx.fillRect(x0, Math.min(yEntry, ySl), Math.max(1, x1 - x0), Math.max(1, Math.abs(ySl - yEntry)));
        ctx.strokeStyle = rgbaOf(dirRgb, 0.9);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, top);
        ctx.lineTo(x1, top);
        ctx.lineTo(x1, bottom);
        ctx.lineTo(x0, bottom);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = dirColor;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x0, yEntry);
        ctx.lineTo(x1, yEntry);
        ctx.stroke();

        var metrics = PositionTool.compute({
            dir: draft.dir,
            entry: draft.entry,
            tp: target,
            sl: sl,
            startTime: 1,
            endTime: 2
        }, entry.posSettings, {
            precision: entry.precision,
            tickSize: entry.minMove,
            lastPrice: target,
            closeAtEnd: 0
        });
        var label = (long ? 'LONG' : 'SHORT') +
            (metrics ? '  ·  ' + PositionTool.rrLabel(metrics.rr) + '  ·  Qty ' +
                PositionTool.formatQty(metrics.qty, metrics.qtyPrecision) : '') +
            '  ·  ENTRY ' + formatPrice(draft.entry, entry.precision);
        var chipY = clamp(yTp - 14, 12, box.h - 12);
        drawTag(ctx, label, x1 + 8, chipY, {
            align: 'left', height: 16,
            fill: THEME.panel, color: dirColor, border: rgbaOf(dirRgb, 0.5),
            maxWidth: Math.max(90, box.w - x1 - 12)
        });
        if (metrics) {
            drawTag(ctx, 'SL ' + formatPrice(sl, entry.precision), x1 + 8, clamp(ySl + 14, 12, box.h - 12), {
                align: 'left', height: 14,
                fill: THEME.panel, color: THEME.down, border: rgbaOf('downRgb', 0.45),
                font: '9px "JetBrains Mono", monospace',
                maxWidth: Math.max(80, box.w - x1 - 12)
            });
        }
    }

    function measureHandle(ctx, x, y, color, active) {
        ctx.fillStyle = THEME.panel;
        ctx.strokeStyle = color;
        ctx.lineWidth = active ? 1.7 : 1.2;
        ctx.beginPath();
        ctx.arc(x, y, active ? 4.6 : 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    function drawMeasure(entry, ctx, box) {
        var draft = entry.measureDraft;
        var measure = draft || entry.measure;
        if (!measure || !measure.start || !measure.end) return;
        var x0 = xForTime(entry, measure.start.time);
        var x1 = xForTime(entry, measure.end.time);
        var y0 = yForPrice(entry, measure.start.price);
        var y1 = yForPrice(entry, measure.end.price);
        if (x0 == null || x1 == null || y0 == null || y1 == null) return;
        var selected = !draft && !!entry.selectedMeasure;
        var up = measure.end.price >= measure.start.price;
        var color = up ? THEME.up : THEME.down;
        var rgb = up ? 'upRgb' : 'downRgb';
        ctx.fillStyle = rgbaOf(rgb, selected ? 0.15 : 0.10);
        ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        if (selected) {
            ctx.strokeStyle = rgbaOf(rgb, 0.55);
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5,
                Math.max(1, Math.abs(x1 - x0) - 1), Math.max(1, Math.abs(y1 - y0) - 1));
            ctx.setLineDash([]);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 1.8 : 1.4;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        measureHandle(ctx, x0, y0, color, selected);
        measureHandle(ctx, x1, y1, color, selected);
        var delta = measure.end.price - measure.start.price;
        var pct = measure.start.price ? delta / measure.start.price * 100 : 0;
        var bars = Math.round((measure.end.time - measure.start.time) / barSeconds(entry.config.timeframe));
        var text = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%  ' +
            (delta >= 0 ? '+' : '') + formatPrice(delta, entry.precision) + '  ' + bars + ' bars';
        var tx = clamp((x0 + x1) / 2 + 8, 4, box.w - 30);
        var ty = clamp((y0 + y1) / 2 - 10, 10, box.h - 14);
        drawTag(ctx, text, tx, ty + 8, {
            align: 'left', height: 16,
            fill: THEME.panel, color: color,
            border: rgbaOf(rgb, selected ? 0.75 : 0.45),
            font: '9.5px "JetBrains Mono", monospace',
            maxWidth: box.w - tx - 6
        });
    }

    function hitTestMeasure(entry, x, y) {
        var measure = entry.measure;
        if (!measure || !measure.start || !measure.end) return null;
        var x0 = xForTime(entry, measure.start.time);
        var x1 = xForTime(entry, measure.end.time);
        var y0 = yForPrice(entry, measure.start.price);
        var y1 = yForPrice(entry, measure.end.price);
        if (x0 == null || x1 == null || y0 == null || y1 == null) return null;
        if (Math.hypot(x - x0, y - y0) <= 9) return { type: 'start' };
        if (Math.hypot(x - x1, y - y1) <= 9) return { type: 'end' };
        if (distanceToSegment(x, y, x0, y0, x1, y1) <= 6) return { type: 'body' };
        return null;
    }

    function moveMeasureDrag(entry, x, y) {
        var drag = entry.measureDrag;
        var measure = entry.measure;
        if (!drag || !measure) return;
        var t2 = timeForX(entry, x);
        var p2 = priceForY(entry, y);
        if (t2 == null || p2 == null) return;
        var tick = entry.minMove > 0 ? entry.minMove : Math.max(1e-9, measure.start.price * 1e-9);
        if (drag.type === 'body') {
            var t1 = timeForX(entry, drag.startX);
            var p1 = priceForY(entry, drag.startY);
            if (t1 == null || p1 == null) return;
            var dt = t2 - t1;
            var dp = p2 - p1;
            var floor = Math.min(drag.orig.start.price, drag.orig.end.price);
            if (floor + dp < tick) dp = tick - floor;
            measure.start = { time: drag.orig.start.time + dt, price: drag.orig.start.price + dp };
            measure.end = { time: drag.orig.end.time + dt, price: drag.orig.end.price + dp };
        } else {
            var point = drag.type === 'start' ? measure.start : measure.end;
            point.time = t2;
            point.price = Math.max(tick, p2);
        }
        renderDrawings(entry);
    }

    function endMeasureDrag(entry) {
        if (!entry.measureDrag) return;
        entry.measureDrag = null;
        renderDrawings(entry);
    }

    /** Commit a dragged measure; a bare click keeps the previous one. */
    function commitMeasure(entry) {
        var draft = entry.measureDraft;
        entry.measureDraft = null;
        if (!draft) return;
        var x0 = xForTime(entry, draft.start.time);
        var x1 = xForTime(entry, draft.end.time);
        var y0 = yForPrice(entry, draft.start.price);
        var y1 = yForPrice(entry, draft.end.price);
        var moved = x0 != null && x1 != null && y0 != null && y1 != null &&
            (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2);
        if (moved) {
            var tick = entry.minMove > 0 ? entry.minMove
                : Math.max(1e-9, Math.min(draft.start.price, draft.end.price) * 1e-9);
            entry.measure = {
                start: { time: draft.start.time, price: Math.max(tick, draft.start.price) },
                end: { time: draft.end.time, price: Math.max(tick, draft.end.price) }
            };
            entry.selectedMeasure = true;
        }
        renderDrawings(entry);
    }

    function hitTestPosition(entry, x, y) {
        var box = plotBox(entry);
        for (var i = entry.positions.length - 1; i >= 0; i--) {
            var pos = entry.positions[i];
            var x0 = xForTime(entry, pos.startTime);
            var x1 = xForTime(entry, pos.endTime);
            if (x0 == null && x1 == null) continue;
            if (x0 == null) x0 = 0;
            if (x1 == null) x1 = box.w;
            if (x < x0 - 8 || x > x1 + 8) continue;
            if (Math.abs(x - x1) <= 7) return { pos: pos, type: 'end' };
            var levels = [['entry', pos.entry], ['tp', pos.tp], ['sl', pos.sl]];
            for (var j = 0; j < levels.length; j++) {
                var levelY = pinnedLevelY(entry, levels[j][1], box);
                if (levelY != null && Math.abs(y - levelY) <= 7) {
                    return { pos: pos, type: levels[j][0] };
                }
            }
            var yEntry = pinnedLevelY(entry, pos.entry, box);
            var yTp = pinnedLevelY(entry, pos.tp, box);
            var ySl = pinnedLevelY(entry, pos.sl, box);
            if (yEntry != null && yTp != null && ySl != null) {
                var top = Math.min(yEntry, yTp, ySl);
                var bottom = Math.max(yEntry, yTp, ySl);
                if (y >= top && y <= bottom) return { pos: pos, type: 'body' };
            }
        }
        return null;
    }

    function positionCursor(hit) {
        if (!hit) return '';
        if (hit.type === 'end') return 'ew-resize';
        if (hit.type === 'body') return 'move';
        return 'ns-resize';
    }

    function commitPosition(entry, draft) {
        var dir = draft.dir;
        var entryPrice = draft.entry;
        var target = draft.current;
        var valid = dir === 'long' ? target > entryPrice : target < entryPrice;
        var sl;
        if (!valid || Math.abs(target - entryPrice) < entryPrice * 1e-6) {
            // A click without a drag places a 2R template: 1% target, 0.5% stop.
            var riskPct = 0.005;
            target = dir === 'long' ? entryPrice * 1.01 : entryPrice * 0.99;
            sl = dir === 'long' ? entryPrice * (1 - riskPct) : entryPrice * (1 + riskPct);
        } else {
            sl = PositionTool.mirrorStop(dir, entryPrice, target);
        }
        if (!isFinite(sl) || sl <= 0) sl = entryPrice * 0.5;
        var barSec = barSeconds(entry.config.timeframe);
        var bars = 20;
        if (entry.candles.length >= 2) {
            var last = entry.candles[entry.candles.length - 1];
            var prev = entry.candles[entry.candles.length - 2];
            var px1 = xForTime(entry, last.time);
            var px0 = xForTime(entry, prev.time);
            if (px1 != null && px0 != null && Math.abs(px1 - px0) > 0.2) {
                bars = Math.max(6, Math.round((entry.posSettings.widthPx || 140) / Math.abs(px1 - px0)));
            }
        }
        var pos = PositionTool.normalizePosition({
            id: 'p-' + Math.random().toString(36).slice(2, 9),
            dir: dir,
            entry: entryPrice,
            tp: target,
            sl: sl,
            startTime: draft.time,
            endTime: draft.time + barSec * bars
        });
        if (!pos) return null;
        entry.positions.push(pos);
        entry.selectedPosition = pos.id;
        savePositions(entry);
        notifyPosition(entry, pos);
        renderDrawings(entry);
        return pos;
    }

    /* ── AI trade overlays ──────────────────────────────────────────────── */

    function reportTradeOverlay(result) {
        if (!result) return;
        try {
            if (Bridge.obj && Bridge.obj.onTradeOverlayResult) {
                Bridge.obj.onTradeOverlayResult(!!result.ok, result.message || '');
                return;
            }
        } catch (err) { /* fall back to the in-frame toast */ }
        toast(result.message || '', !result.ok);
    }

    function symbolKey(symbol) {
        return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function findTradeChart(trade) {
        var ids = Object.keys(WS.charts);
        var focused = WS.charts[WS.focused];
        var wanted = symbolKey(trade.symbol);
        var venueMatches = function (entry) {
            return (!trade.exchange || entry.config.exchange === trade.exchange) &&
                (!trade.market || entry.config.market === trade.market);
        };
        var exact = function (entry) {
            return venueMatches(entry) && symbolKey(entry.config.symbol) === wanted;
        };
        var sameSymbol = function (entry) {
            return symbolKey(entry.config.symbol) === wanted;
        };
        if (focused && !focused.destroyed && exact(focused)) return focused;
        for (var i = 0; i < ids.length; i++) {
            var entry = WS.charts[ids[i]];
            if (entry && !entry.destroyed && exact(entry)) return entry;
        }
        if (focused && !focused.destroyed && sameSymbol(focused)) return focused;
        for (var j = 0; j < ids.length; j++) {
            var other = WS.charts[ids[j]];
            if (other && !other.destroyed && sameSymbol(other)) return other;
        }
        return null;
    }

    function tradeChartVenue(trade) {
        var fallback = WS.charts[WS.focused] && !WS.charts[WS.focused].destroyed
            ? WS.charts[WS.focused] : null;
        var exchanges = (WS.meta && WS.meta.exchanges) || [];
        var exchange = trade.exchange || (fallback ? fallback.config.exchange : (exchanges[0] ? exchanges[0].id : 'binance'));
        var market = trade.market || (fallback ? fallback.config.market : 'spot');
        var ex = exchanges.filter(function (e) { return e.id === exchange; })[0];
        if (!ex) {
            exchange = fallback ? fallback.config.exchange : (exchanges[0] ? exchanges[0].id : 'binance');
            ex = exchanges.filter(function (e) { return e.id === exchange; })[0];
            market = fallback ? fallback.config.market : 'spot';
        }
        var markets = (ex && ex.markets) || [];
        if (!markets.some(function (m) { return m.id === market; })) {
            var preferred = markets.filter(function (m) { return m.id === 'spot'; })[0] || markets[0];
            market = preferred ? preferred.id : 'spot';
        }
        var supported = timeframesFor(exchange, market);
        if (!Array.isArray(supported) || !supported.length) supported = TIMEFRAMES;
        var timeframe = trade.timeframe;
        if (supported.indexOf(timeframe) < 0) {
            timeframe = fallback ? fallback.config.timeframe : null;
        }
        if (supported.indexOf(timeframe) < 0) {
            timeframe = supported.indexOf('5m') >= 0 ? '5m' : supported[0];
        }
        return { exchange: exchange, market: market, timeframe: timeframe || '5m' };
    }

    function openTradeChart(trade) {
        var venue = tradeChartVenue(trade);
        var cfg = addChart({
            exchange: venue.exchange,
            market: venue.market,
            symbol: trade.symbol,
            timeframe: venue.timeframe,
            groupId: null
        });
        return cfg ? WS.charts[cfg.id] || null : null;
    }

    var OVERLAY_BARS = 16;
    var OVERLAY_LEAD_BARS = 8;

    function findMatchingPosition(entry, trade) {
        var near = function (a, b) {
            return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
        };
        for (var i = entry.positions.length - 1; i >= 0; i--) {
            var pos = entry.positions[i];
            if (pos.dir === trade.dir && near(pos.entry, trade.entry) &&
                near(pos.tp, trade.tp) && near(pos.sl, trade.sl)) {
                return pos;
            }
        }
        return null;
    }

    function revealTradePosition(entry, pos) {
        if (!entry || !entry.chart || entry.destroyed) return;
        var barSec = barSeconds(entry.config.timeframe);
        var span = Math.max(6, Math.round((pos.endTime - pos.startTime) / barSec));
        var startIdx = lowerBound(entry.display, pos.startTime);
        if (startIdx >= entry.display.length) startIdx = Math.max(0, entry.display.length - 1);
        // Keep the plan in context: a full screen of history before the box
        // and a little future whitespace after it.
        try {
            entry.chart.timeScale().setVisibleLogicalRange({
                from: Math.max(0, startIdx - span),
                to: startIdx + span + 8
            });
        } catch (err) { /* keep the current viewport */ }
        // Drop a manual vertical pan so the plan levels are not left outside
        // the frozen window (absolute group scales are shared; leave those).
        if (entry.config.priceScaleMode !== 'absolute') resetPricePan(entry);
        // Widen the autoscale window to contain every level without freezing
        // the price axis; resetPricePan clears it on Center / instrument change.
        entry.focusRange = {
            min: transformValue(entry, Math.min(pos.entry, pos.tp, pos.sl)),
            max: transformValue(entry, Math.max(pos.entry, pos.tp, pos.sl))
        };
        refreshPriceOffset(entry, true);
        scheduleDraw(entry);
    }

    function placeTradeOverlay(entry, trade) {
        var existing = findMatchingPosition(entry, trade);
        if (existing) {
            entry.selectedPosition = existing.id;
                renderDrawings(entry);
            revealTradePosition(entry, existing);
            return { ok: true, message: 'That plan is already on the ' + trade.symbol + ' chart.' };
        }
        var barSec = barSeconds(entry.config.timeframe);
        var last = entry.candles.length ? entry.candles[entry.candles.length - 1] : null;
        var anchor = last && isFinite(last.time)
            ? last.time
            : Math.floor(Date.now() / 1000 / barSec) * barSec;
        var pos = PositionTool.normalizePosition({
            id: 'p-' + Math.random().toString(36).slice(2, 9),
            dir: trade.dir,
            entry: trade.entry,
            tp: trade.tp,
            sl: trade.sl,
            startTime: anchor - barSec * OVERLAY_LEAD_BARS,
            endTime: anchor + barSec * (OVERLAY_BARS - OVERLAY_LEAD_BARS)
        });
        if (!pos) return { ok: false, message: 'The plan has no usable price levels.' };
        entry.positions.push(pos);
        entry.selectedPosition = pos.id;
        entry.measure = null;
        savePositions(entry);
        renderDrawings(entry);
        revealTradePosition(entry, pos);
        return {
            ok: true,
            message: (trade.dir === 'long' ? 'Long' : 'Short') + ' ' + trade.symbol + ' drawn on the chart.'
        };
    }

    function applyPendingTradeOverlay(entry) {
        var trade = entry.pendingOverlay;
        if (!trade) return;
        entry.pendingOverlay = null;
        if (!entry.candles.length) return;
        reportTradeOverlay(placeTradeOverlay(entry, trade));
    }

    function revealTradePanel(entry) {
        if (!entry) return;
        // A maximized sibling would hide the target panel entirely.
        if (WS.maximized && WS.maximized !== entry.id) toggleMaximize(entry, true);
        focusChart(entry);
    }

    function overlayTrade(trade) {
        if (!trade || typeof trade !== 'object') {
            return { ok: false, message: 'No trade levels to overlay.' };
        }
        var dir = String(trade.direction || '').toLowerCase();
        if (dir !== 'long' && dir !== 'short') {
            return { ok: false, message: 'Only long or short plans can be drawn.' };
        }
        var entryPrice = Number(trade.entry);
        var tp = Number(trade.takeProfit);
        var sl = Number(trade.stopLoss);
        if (![entryPrice, tp, sl].every(function (v) { return isFinite(v) && v > 0; })) {
            return { ok: false, message: 'The plan has no usable entry, take-profit and stop-loss.' };
        }
        if (dir === 'long' ? !(sl < entryPrice && entryPrice < tp) : !(tp < entryPrice && entryPrice < sl)) {
            return { ok: false, message: 'The plan levels are inconsistent, so nothing was drawn.' };
        }
        var symbol = String(trade.symbol || '').trim().toUpperCase();
        if (!symbol) return { ok: false, message: 'The plan does not name an instrument.' };
        var normalized = {
            dir: dir,
            entry: entryPrice,
            tp: tp,
            sl: sl,
            symbol: symbol,
            exchange: String(trade.exchange || '').trim().toLowerCase(),
            market: String(trade.market || '').trim().toLowerCase(),
            timeframe: String(trade.timeframe || '').trim()
        };
        var target = findTradeChart(normalized);
        if (target) {
            revealTradePanel(target);
            if (!target.candles.length) {
                target.pendingOverlay = normalized;
                return { ok: true, message: 'Waiting for ' + symbol + ' candles…' };
            }
            return placeTradeOverlay(target, normalized);
        }
        var created = openTradeChart(normalized);
        if (!created) {
            return {
                ok: false,
                message: 'All 12 chart panels are in use; close one to overlay ' + symbol + '.'
            };
        }
        revealTradePanel(created);
        created.pendingOverlay = normalized;
        if (created.candles.length) {
            created.pendingOverlay = null;
            return placeTradeOverlay(created, normalized);
        }
        return { ok: true, message: 'Opening a ' + symbol + ' chart for the plan…' };
    }

    function updatePositionDrag(entry, x, y) {
        var drag = entry.positionDrag;
        if (!drag) return;
        var pos = drag.pos;
        var orig = drag.orig;
        var dragPrice = priceForY(entry, y);
        var tick = entry.minMove > 0 ? entry.minMove : Math.max(1e-9, orig.entry * 1e-9);
        var long = pos.dir === 'long';
        if (drag.type === 'body') {
            var oldTime = timeForX(entry, drag.startX);
            var newTime = timeForX(entry, x);
            var oldPrice = priceForY(entry, drag.startY);
            if (oldTime != null && newTime != null && oldPrice != null && dragPrice != null) {
                var dt = newTime - oldTime;
                var dp = dragPrice - oldPrice;
                // Never drag the lowest level through zero.
                var floor = Math.min(orig.entry, orig.tp, orig.sl);
                if (floor + dp < tick) dp = tick - floor;
                pos.startTime = orig.startTime + dt;
                pos.endTime = orig.endTime + dt;
                pos.entry = orig.entry + dp;
                pos.tp = orig.tp + dp;
                pos.sl = orig.sl + dp;
            }
        } else if (drag.type === 'end') {
            var endTime = timeForX(entry, x);
            if (endTime != null) pos.endTime = Math.max(pos.startTime + barSeconds(entry.config.timeframe), endTime);
        } else if (dragPrice != null) {
            // Keep the risk/reward sides intact while dragging a level.
            if (drag.type === 'entry') {
                pos.entry = long
                    ? clamp(dragPrice, pos.sl + tick, pos.tp - tick)
                    : clamp(dragPrice, pos.tp + tick, pos.sl - tick);
            } else if (drag.type === 'tp') {
                pos.tp = long ? Math.max(dragPrice, pos.entry + tick) : Math.min(dragPrice, pos.entry - tick);
            } else if (drag.type === 'sl') {
                pos.sl = long ? Math.min(dragPrice, pos.entry - tick) : Math.max(dragPrice, pos.entry + tick);
            }
        }
        renderDrawings(entry);
    }

    function endPositionDrag(entry) {
        if (!entry.positionDrag) return;
        var pos = entry.positionDrag.pos;
        entry.positionDrag = null;
        savePositions(entry);
        notifyPosition(entry, pos);
        renderDrawings(entry);
    }

    /**
     * True while a lightweight-charts-drawing gesture owns the pointer:
     * the manager holds the chart (savedScroll) or a drawing is hovered /
     * selected under the cursor. Used to keep the app's vertical price pan
     * from moving the chart when the user drags a drawing.
     */
    function drawingGestureActive(entry) {
        var manager = entry.drawMgr;
        if (!manager) return false;
        if (manager.savedScroll) return true;
        if (manager.hoveredId && manager.hoveredId()) return true;
        var cursor = manager.cursorAt && manager.cursorAt();
        return !!cursor && cursor !== 'crosshair';
    }

    function wireDrawingCanvas(entry) {
        var canvas = entry.drawCanvas;

        // The overlay only hosts the app-specific tools (position box, measure).
        // Library drawings are rendered and hit-tested by the chart primitive.
        canvas.addEventListener('pointerdown', function (ev) {
            if (!entry.drawTool) return;
            ev.preventDefault();
            try { canvas.setPointerCapture(ev.pointerId); } catch (err) { /* synthetic pointers */ }
            var rect = canvas.getBoundingClientRect();
            var x = ev.clientX - rect.left;
            var y = ev.clientY - rect.top;
            var time = timeForX(entry, x);
            var price = priceForY(entry, y);
            if (time == null || price == null) return;

            if (entry.drawTool === 'long' || entry.drawTool === 'short') {
                entry.posDraft = {
                    dir: entry.drawTool,
                    entry: price,
                    current: price,
                    time: time,
                    currentTime: time
                };
                renderDrawings(entry);
                return;
            }
            if (entry.drawTool === 'measure') {
                // Draft only: the committed measure is replaced on pointerup so
                // an abandoned gesture keeps the previous measurement.
                entry.measureDraft = {
                    start: { time: time, price: price },
                    end: { time: time, price: price }
                };
                entry.selectedMeasure = false;
                renderDrawings(entry);
                return;
            }
            if (entry.drawTool !== 'select') return;

            var measureHit = hitTestMeasure(entry, x, y);
            if (measureHit) {
                entry.selectedMeasure = true;
                entry.selectedPosition = null;
                entry.measureDrag = {
                    type: measureHit.type,
                    startX: x,
                    startY: y,
                    orig: clone(entry.measure)
                };
                renderDrawings(entry);
                return;
            }
            entry.selectedMeasure = false;
            var posHit = hitTestPosition(entry, x, y);
            if (posHit) {
                entry.selectedPosition = posHit.pos.id;
                entry.positionDrag = {
                    pos: posHit.pos,
                    type: posHit.type,
                    startX: x,
                    startY: y,
                    orig: clone(posHit.pos)
                };
                notifyPosition(entry, posHit.pos);
            } else {
                entry.selectedPosition = null;
            }
            renderDrawings(entry);
        });

        canvas.addEventListener('pointermove', function (ev) {
            if (!entry.drawTool) return;
            var rect = canvas.getBoundingClientRect();
            var x = ev.clientX - rect.left;
            var y = ev.clientY - rect.top;
            if (entry.posDraft) {
                var draftTime = timeForX(entry, x);
                var draftPrice = priceForY(entry, y);
                if (draftTime != null && draftPrice != null) {
                    entry.posDraft.current = draftPrice;
                    entry.posDraft.currentTime = draftTime;
                }
                renderDrawings(entry);
                return;
            }
            if (entry.measureDraft) {
                var measureTime = timeForX(entry, x);
                var measurePrice = priceForY(entry, y);
                if (measureTime != null && measurePrice != null) {
                    entry.measureDraft.end = { time: measureTime, price: measurePrice };
                }
                renderDrawings(entry);
                return;
            }
            if (entry.measureDrag) {
                moveMeasureDrag(entry, x, y);
                return;
            }
            if (entry.positionDrag) {
                updatePositionDrag(entry, x, y);
            }
        });

        canvas.addEventListener('pointerup', function () {
            if (!entry.drawTool) return;
            if (entry.posDraft) {
                commitPosition(entry, entry.posDraft);
                entry.posDraft = null;
                finishDrawing(entry);
                return;
            }
            if (entry.measureDraft) {
                commitMeasure(entry);
                finishDrawing(entry);
                return;
            }
            if (entry.measureDrag) {
                endMeasureDrag(entry);
                return;
            }
            if (entry.positionDrag) endPositionDrag(entry);
        });

        canvas.addEventListener('pointercancel', function () {
            entry.posDraft = null;
            entry.positionDrag = null;
            entry.measureDraft = null;
            entry.measureDrag = null;
            renderDrawings(entry);
        });

        var host = entry.host;
        var hostPoint = function (ev) {
            var rect = canvas.getBoundingClientRect();
            return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        };

        // Price-axis drags and wheel zoom have no LWC subscription; keep the
        // overlay in lockstep while the pointer is down or wheel is used.
        var onHostDown = function () { entry.allowBackfill = true; startDrawSync(entry); };
        var onDocUp = function () {
            stopDrawSync(entry);
            if (entry.drawDirty) {
                entry.drawDirty = false;
                commitDrawings(entry);
            }
        };
        var onWheel = function (ev) {
            entry.allowBackfill = true;
            var point = hostPoint(ev);
            var box = plotBox(entry);
            if (point.x >= box.w - 2 && point.y < box.h - 2) clearPanBase(entry);
            scheduleDraw(entry);
        };
        host.addEventListener('pointerdown', onHostDown, { passive: true, capture: true });
        document.addEventListener('pointerup', onDocUp, { passive: true, capture: true });
        document.addEventListener('pointercancel', onDocUp, { passive: true, capture: true });
        host.addEventListener('wheel', onWheel, { passive: true, capture: true });

        // In cursor mode the overlay is click-through, yet positions and the
        // measure must still be selectable/movable directly.  Intercept the
        // host pointerdown only when one of them is hit; otherwise the event
        // reaches Lightweight Charts for pan/zoom as usual.
        var directMove = null;
        var directUp = null;
        var clearDirect = function (finalize) {
            if (entry.directPointerId != null) {
                try { host.releasePointerCapture(entry.directPointerId); } catch (err) { /* ignore */ }
                entry.directPointerId = null;
            }
            if (directMove) document.removeEventListener('pointermove', directMove);
            if (directUp) {
                document.removeEventListener('pointerup', directUp);
                document.removeEventListener('pointercancel', directUp);
            }
            directMove = null;
            directUp = null;
            if (finalize !== false) {
                if (entry.positionDrag) endPositionDrag(entry);
                if (entry.measureDrag) endMeasureDrag(entry);
            }
            entry.positionDrag = null;
            entry.measureDrag = null;
            entry.drawCanvas.classList.remove('active');
            entry.panel.classList.remove('drawing');
            renderDrawings(entry);
        };
        var onHostSelect = function (ev) {
            if ((entry.drawTool && entry.drawTool !== 'select') || ev.button !== 0) return;
            if (entry.positions.length === 0 && !entry.measure) return;
            var point = hostPoint(ev);
            var measureHit = hitTestMeasure(entry, point.x, point.y);
            var posHit = measureHit ? null : hitTestPosition(entry, point.x, point.y);
            if (!measureHit && !posHit) return;
            ev.preventDefault();
            ev.stopPropagation();
            try { host.setPointerCapture(ev.pointerId); entry.directPointerId = ev.pointerId; }
            catch (err) { /* synthetic pointers */ }
            focusChart(entry);
            entry.drawCanvas.classList.add('active');
            entry.panel.classList.add('drawing');
            entry.selectedPosition = null;
            entry.selectedMeasure = false;
            if (measureHit) {
                entry.selectedMeasure = true;
                entry.measureDrag = {
                    type: measureHit.type,
                    startX: point.x,
                    startY: point.y,
                    orig: clone(entry.measure)
                };
            } else {
                entry.selectedPosition = posHit.pos.id;
                entry.positionDrag = {
                    pos: posHit.pos,
                    type: posHit.type,
                    startX: point.x,
                    startY: point.y,
                    orig: clone(posHit.pos)
                };
                notifyPosition(entry, posHit.pos);
            }
            renderDrawings(entry);
            directMove = function (moveEv) {
                moveEv.preventDefault();
                var p = hostPoint(moveEv);
                if (entry.measureDrag) moveMeasureDrag(entry, p.x, p.y);
                else if (entry.positionDrag) updatePositionDrag(entry, p.x, p.y);
            };
            directUp = function () {
                if (entry.measureDrag) endMeasureDrag(entry);
                if (entry.positionDrag) endPositionDrag(entry);
                clearDirect();
            };
            document.addEventListener('pointermove', directMove);
            document.addEventListener('pointerup', directUp);
            document.addEventListener('pointercancel', directUp);
        };
        var onHostHover = function (ev) {
            if (entry.drawTool && entry.drawTool !== 'select') return;
            if (entry.positions.length === 0 && !entry.measure) {
                entry.host.style.cursor = '';
                return;
            }
            var point = hostPoint(ev);
            if (hitTestMeasure(entry, point.x, point.y)) {
                entry.host.style.cursor = 'move';
                return;
            }
            var posHit = hitTestPosition(entry, point.x, point.y);
            entry.host.style.cursor = posHit ? positionCursor(posHit) : '';
        };
        host.addEventListener('pointerdown', onHostSelect, { capture: true });
        host.addEventListener('pointermove', onHostHover, { passive: true, capture: true });

        // Vertical price panning augments LWC's horizontal pane drag.  The
        // pointerdown is NOT prevented, so horizontal scroll stays native;
        // once the pointer travels 3px vertically we shift the price range.
        var pricePanMove = null;
        var pricePanUp = null;
        var endPricePan = function () {
            if (pricePanMove) document.removeEventListener('pointermove', pricePanMove);
            if (pricePanUp) {
                document.removeEventListener('pointerup', pricePanUp);
                document.removeEventListener('pointercancel', pricePanUp);
            }
            pricePanMove = null;
            pricePanUp = null;
            entry.pricePan = null;
        };
        var onHostPriceStart = function (ev) {
            if ((entry.drawTool && entry.drawTool !== 'select') || ev.button !== 0) return;
            // A drawing under the pointer owns the gesture: the manager moves
            // (or resizes) it, the chart must not price-pan underneath.
            if (drawingGestureActive(entry)) return;
            if (entry.pricePan) endPricePan();
            if (entry.positionDrag || entry.measureDrag || entry.directPointerId != null) return;
            var point = hostPoint(ev);
            var box = plotBox(entry);
            if (!box.w || box.h < 20 || !entry.mainSeries) return;
            // Leave the axes to LWC's own scale handling.  A price-axis
            // gesture switches to a manual scale, so drop the frozen window.
            if (point.x >= box.w - 2) { clearPanBase(entry); return; }
            if (point.y >= box.h - 2) return;
            entry.pricePan = {
                startX: point.x, startY: point.y, lastY: point.y, active: false,
                startOffset: Number(entry.priceOffset) || 0,
                cancel: function () {
                    entry.priceOffset = this.startOffset;
                    releasePanBase(entry);
                    endPricePan();
                }
            };
            pricePanMove = function (moveEv) {
                var pan = entry.pricePan;
                if (!pan) return;
                var p = hostPoint(moveEv);
                if (!pan.active) {
                    var dy = p.y - pan.startY;
                    var dx = p.x - pan.startX;
                    // Start on a mostly vertical gesture so a horizontal pan
                    // with a few pixels of jitter does not drift the price.
                    if (Math.abs(dy) < 3 || Math.abs(dy) < Math.abs(dx)) return;
                    // The press may not have produced a hover (touch / fast
                    // gesture); re-check once the manager has begun its drag.
                    if (drawingGestureActive(entry)) { endPricePan(); return; }
                    pan.active = true;
                }
                // coordinateToPrice is the display value (raw price,
                // percentage or indexed); the autoscale offset uses the same
                // units.  priceForY would convert back to raw prices and is
                // wrong for percentage/indexed modes.
                var priceAtLast = entry.mainSeries.coordinateToPrice(pan.lastY);
                var priceNow = entry.mainSeries.coordinateToPrice(p.y);
                if (priceAtLast != null && priceNow != null &&
                    isFinite(priceAtLast) && isFinite(priceNow)) {
                    applyVerticalPan(entry, priceAtLast - priceNow);
                }
                pan.lastY = p.y;
            };
            pricePanUp = function () { endPricePan(); };
            document.addEventListener('pointermove', pricePanMove);
            document.addEventListener('pointerup', pricePanUp, { capture: true });
            document.addEventListener('pointercancel', pricePanUp, { capture: true });
        };
        host.addEventListener('pointerdown', onHostPriceStart, { capture: true });
        var onPriceDblClick = function (ev) {
            var point = hostPoint(ev);
            if (point.x >= plotBox(entry).w - 2) { resetPricePan(entry); return; }
            if (entry.drawTool && entry.drawTool !== 'select') return;
            var posHit = hitTestPosition(entry, point.x, point.y);
            if (!posHit) return;
            ev.preventDefault();
            ev.stopPropagation();
            entry.selectedPosition = posHit.pos.id;
            notifyPosition(entry, posHit.pos);
            renderDrawings(entry);
            openPositionSettings(entry);
        };
        host.addEventListener('dblclick', onPriceDblClick, true);
        var onWindowBlur = function () {
            if (directMove) clearDirect();
            if (entry.pricePan) endPricePan();
        };
        window.addEventListener('blur', onWindowBlur);
        entry._drawDocCleanup = function () {
            window.removeEventListener('blur', onWindowBlur);
            endPricePan();
            host.removeEventListener('pointerdown', onHostDown, { capture: true });
            host.removeEventListener('pointerdown', onHostSelect, { capture: true });
            host.removeEventListener('pointerdown', onHostPriceStart, { capture: true });
            host.removeEventListener('pointermove', onHostHover, { capture: true });
            host.removeEventListener('dblclick', onPriceDblClick, true);
            document.removeEventListener('pointerup', onDocUp, { capture: true });
            document.removeEventListener('pointercancel', onDocUp, { capture: true });
            host.removeEventListener('wheel', onWheel, { capture: true });
            clearDirect();
        };
    }
    function startDrawSync(entry) {
        if (entry.drawSyncRaf) return;
        var step = function () {
            if (!entry.drawSyncRaf) return;
            scheduleDraw(entry);
            entry.drawSyncRaf = requestAnimationFrame(step);
        };
        entry.drawSyncRaf = requestAnimationFrame(step);
    }

    function stopDrawSync(entry) {
        if (entry.drawSyncRaf) {
            cancelAnimationFrame(entry.drawSyncRaf);
            entry.drawSyncRaf = null;
        }
        scheduleDraw(entry);
    }

    function distanceToSegment(px, py, x1, y1, x2, y2) {
        var dx = x2 - x1, dy = y2 - y1;
        if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
        var t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
        t = clamp(t, 0, 1);
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    function deleteSelectedDrawing() {
        var entry = WS.charts[WS.focused];
        if (!entry) return;
        if (entry.selectedMeasure) {
            entry.measure = null;
            entry.measureDraft = null;
            entry.measureDrag = null;
            entry.selectedMeasure = false;
            renderDrawings(entry);
            return;
        }
        if (entry.selectedPosition) {
            entry.positions = entry.positions.filter(function (p) { return p.id !== entry.selectedPosition; });
            entry.selectedPosition = null;
            savePositions(entry);
            renderDrawings(entry);
            return;
        }
        if (!entry.drawMgr) return;
        var ids = entry.drawMgr.selection().slice();
        ids.forEach(function (id) { entry.drawMgr.remove(id); });
        updateDrawStyleBar(entry);
    }

    /* ── Workspace persistence ───────────────────────────────────────────── */

    function captureViewStates() {
        var ws = activeWorkspace();
        if (!ws) return;
        Object.keys(WS.charts).forEach(function (id) {
            var entry = WS.charts[id];
            var cfg = ws.charts.filter(function (c) { return c.id === id; })[0];
            if (!cfg) return;
            try {
                var range = entry.chart.timeScale().getVisibleRange();
                if (range) cfg.view = { from: Math.round(range.from), to: Math.round(range.to) };
            } catch (err) { /* ignore */ }
        });
    }

    function serialize() {
        var ws = activeWorkspace();
        if (!ws) return null;
        captureViewStates();
        ws.updatedAt = Date.now();
        return { version: 1, active: WS.activeId, workspaces: WS.store.workspaces };
    }

    /**
     * Sessions are written only on an explicit Save / Save as. Every mutation
     * calls this to advertise unsaved work; nothing is flushed in the
     * background any more.
     */
    function scheduleSave() {
        if (WS.shuttingDown) return;
        markDirty();
    }

    function markDirty() {
        if (WS.dirty) return;
        WS.dirty = true;
        renderSaveState();
    }

    function clearDirty() {
        if (!WS.dirty && !WS.dirtyShown) return;
        WS.dirty = false;
        WS.dirtyShown = false;
        renderSaveState();
    }

    function renderSaveState() {
        var button = $('#btn-save');
        if (button) {
            button.classList.toggle('is-dirty', WS.dirty);
            button.title = WS.dirty
                ? 'Unsaved changes — save this session (Ctrl+S)'
                : 'Save this session (Ctrl+S)';
            button.setAttribute('aria-label', WS.dirty ? 'Save session — unsaved changes' : 'Save session');
        }
        renderWorkspaceSelect();
        if (WS.dirty) {
            WS.dirtyShown = true;
            setStatus('Unsaved changes', 'dirty');
        }
    }

    /** Prompt before leaving a session that has unwritten changes. */
    function guardUnsaved(intent) {
        var ws = activeWorkspace();
        if (!WS.dirty || !ws) { intent(); return; }
        // Snap the session picker back until the user decides, so the control
        // never shows a session that is not loaded.
        renderWorkspaceSelect();
        openChoice('Unsaved changes', '“' + ws.name + '” has changes that are not saved yet.', [
            {
                label: 'Save and continue',
                primary: true,
                action: function () {
                    saveNow(function (ok) { if (ok) intent(); });
                }
            },
            { label: 'Discard changes', action: intent },
            { label: 'Cancel', action: function () { renderWorkspaceSelect(); } }
        ]);
    }

    /** Total study count in a store payload (0 when the field is unusable). */
    function storedIndicatorCount(store) {
        var total = 0;
        if (!store || !Array.isArray(store.workspaces)) return total;
        store.workspaces.forEach(function (ws) {
            (ws.charts || []).forEach(function (cfg) {
                if (Array.isArray(cfg.indicators)) total += cfg.indicators.length;
            });
        });
        return total;
    }

    function saveNow(onDone) {
        var done = typeof onDone === 'function' ? onDone : function () {};
        if (!WS.store || WS.shuttingDown) { done(false); return; }
        var payload = serialize();
        if (!payload) { done(false); return; }
        if (WS.saving) { WS.saveQueued = true; WS.saveCallback = done; return; }
        WS.saving = true;
        setStatus('Saving…', 'saving');
        Bridge.call('saveStore', [JSON.stringify(payload)]).then(function (res) {
            // Keep the in-memory store as the source of truth: chart entries hold
            // references to its config objects, so replacing it would orphan them.
            if (res && res.ok !== false) {
                // A sidecar built before the current store schema accepts the
                // save but rewrites the study list: say so instead of losing
                // studies quietly on the next start.
                var stored = storedIndicatorCount(res.store);
                var sent = storedIndicatorCount(payload);
                if (res.store && stored < sent) {
                    setStatus('Saved', 'error');
                    if (!WS.staleBackendWarned) {
                        WS.staleBackendWarned = true;
                        toast('Saved, but the backend dropped ' + (sent - stored) +
                            ' chart indicator(s): the Python sidecar is out of date. ' +
                            'Rebuild it (./start.sh --rebuild-backend).', true);
                    }
                    // The session stays dirty: part of the payload did not land.
                    done(false);
                    return;
                }
                setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
                clearDirty();
                done(true);
            } else {
                setStatus('Save failed', 'error');
                toast((res && res.error) || 'Could not save workspace', true);
                done(false);
            }
        }).catch(function (err) {
            setStatus('Save failed', 'error');
            toast(err.message || 'Could not save workspace', true);
            done(false);
        }).finally(function () {
            WS.saving = false;
            if (WS.saveQueued) {
                WS.saveQueued = false;
                var queued = WS.saveCallback;
                WS.saveCallback = null;
                saveNow(queued);
            }
        });
    }

    /* ── Sessions (workspaces) ───────────────────────────────────────────── */

    function renderWorkspaceSelect() {
        var sel = $('#ws-select');
        sel.innerHTML = '';
        WS.store.workspaces.forEach(function (ws) {
            var active = ws.id === WS.activeId;
            var opt = el('option', '', ws.name + (active && WS.dirty ? ' •' : ''));
            opt.value = ws.id;
            sel.appendChild(opt);
        });
        sel.value = WS.activeId;
        sel.title = (WS.dirty ? 'Unsaved changes in this session' : 'Saved')
            + ' — pick a session to load';
    }

    function loadWorkspace(id) {
        WS.shuttingDown = true;   // suppress saves while tearing down
        destroyAllCharts();
        if (WS.sync) { WS.sync.destroy(); WS.sync = null; }
        WS.maximized = null;
        WS.focused = null;
        closeDrawer();
        closeMenu();
        $('#ws-grid').classList.remove('maximized');
        $('#ws-grid').innerHTML = '';
        $('#ws-gutters').innerHTML = '';
        WS.shuttingDown = false;

        WS.activeId = id;
        var ws = activeWorkspace();
        if (!ws) return;

        var layout = ws.layout && LAYOUTS[ws.layout] ? ws.layout : '4';
        ws.layout = layout;
        if (layout !== 'custom') {
            var spec = LAYOUTS[layout];
            while (ws.charts.length < spec.cols * spec.rows) {
                ws.charts.push(defaultChartConfig(ws.charts.length));
            }
            ws.columns = equalFractions(spec.cols);
            ws.rows = equalFractions(spec.rows);
        } else if (!ws.columns || !ws.rows) {
            var grid = customGridFor(ws.charts.length);
            ws.columns = grid.columns;
            ws.rows = grid.rows;
        }
        // Ensure every chart config has a concrete price mode and indicator set.
        ws.charts.forEach(function (cfg) {
            ensureIndicators(cfg);
            if (!cfg.priceScaleMode) cfg.priceScaleMode = ws.globalSettings.priceScale || 'independent';
            if (!Array.isArray(cfg.drawings)) cfg.drawings = [];
        });

        createSyncManager(ws);
        applyGridTemplate(ws);
        syncPanels(ws);
        updateLayoutButtons();
        renderGutters();
        renderGroupChips();
        renderDrawer();
        syncTopbar(ws);
        // The loaded session mirrors what is on disk (or the copy the user just
        // made); only later edits mark it dirty again.
        WS.dirty = false;
        WS.dirtyShown = false;
        renderSaveState();
        setStatus('Ready');
    }

    function syncTopbar(ws) {
        var settings = ws.globalSettings;
        ['crosshair', 'timeRange', 'horizontalScroll', 'zoom', 'timeframe'].forEach(function (key) {
            var btn = document.querySelector('.chip[data-sync="' + key + '"]');
            if (btn) btn.setAttribute('aria-pressed', String(!!settings[key]));
        });
        $('#price-mode').value = settings.priceScale || 'independent';
        $('#nearest-policy').value = settings.nearestPolicy || 'previous';
    }

    function newWorkspace() {
        guardUnsaved(function () {
            openPrompt('New session', 'Session ' + (WS.store.workspaces.length + 1), function (name) {
                var ws = blankWorkspace(name);
                WS.store.workspaces.push(ws);
                WS.activeId = ws.id;
                loadWorkspace(ws.id);
                markDirty();
            });
        });
    }

    /** Save the current layout under a new name — a second session, same shape. */
    function saveWorkspaceAs() {
        var source = activeWorkspace();
        if (!source) return;
        openPrompt('Save session as', source.name + ' copy', function (name) {
            var copy = clone(source);
            copy.id = 'ws-' + Math.random().toString(36).slice(2, 10);
            copy.name = name;
            copy.updatedAt = Date.now();
            WS.store.workspaces.push(copy);
            WS.activeId = copy.id;
            loadWorkspace(copy.id);
            saveNow(function (ok) {
                if (ok) toast('Saved session “' + name + '”');
                else markDirty();
            });
        });
    }

    function blankWorkspace(name) {
        var template = deepCloneTemplate();
        template.id = 'ws-' + Math.random().toString(36).slice(2, 10);
        template.name = name;
        template.charts = [];
        for (var i = 0; i < 4; i++) {
            var slot = DEFAULT_SLOTS[i];
            template.charts.push({
                id: 'c' + (i + 1),
                exchange: slot[0], market: 'spot', symbol: slot[1], timeframe: slot[2],
                chartType: 'candlestick',
                priceScaleMode: 'independent',
                referenceMode: 'first_visible',
                referenceTime: null,
                indicators: [],
                showVolume: true,
                groupId: template.syncGroups[i % template.syncGroups.length].id,
                drawings: [],
                view: null
            });
        }
        return template;
    }

    function deepCloneTemplate() {
        var base = WS.store.workspaces[0] || {};
        var baseSettings = clone(base.globalSettings || { crosshair: true });
        return {
            id: 'ws-new',
            name: 'Workspace',
            layout: '4',
            columns: [0.5, 0.5],
            rows: [0.5, 0.5],
            charts: [],
            syncGroups: [
                { id: 'g-red', name: 'Group A', color: '#e3b24f', enabled: true, settings: clone(baseSettings) },
                { id: 'g-blue', name: 'Group B', color: '#6aa2f0', enabled: true, settings: clone(baseSettings) }
            ],
            globalSettings: baseSettings,
            updatedAt: Date.now()
        };
    }

    function deleteWorkspace() {
        if (WS.store.workspaces.length <= 1) { toast('The last session cannot be deleted', true); return; }
        var ws = activeWorkspace();
        openPrompt('Delete “' + ws.name + '”? Type the name to confirm', '', function (value) {
            if (value !== ws.name) { toast('Name did not match', true); return; }
            WS.store.workspaces = WS.store.workspaces.filter(function (w) { return w.id !== ws.id; });
            WS.activeId = WS.store.workspaces[0].id;
            loadWorkspace(WS.activeId);
            markDirty();
            toast('“' + ws.name + '” deleted — press Save to keep this');
        });
    }

    /* ── Top-level UI wiring ─────────────────────────────────────────────── */

    function wireShell() {
        buildLayoutSwitch();
        $('#ws-select').addEventListener('change', function (ev) {
            var target = ev.target.value;
            if (target === WS.activeId) { renderWorkspaceSelect(); return; }
            guardUnsaved(function () { loadWorkspace(target); });
        });
        $('#ws-new').addEventListener('click', newWorkspace);
        var saveAsBtn = $('#ws-save-as');
        if (saveAsBtn) saveAsBtn.addEventListener('click', saveWorkspaceAs);
        $('#ws-rename').addEventListener('click', function () {
            var ws = activeWorkspace();
            openPrompt('Rename session', ws.name, function (name) {
                ws.name = name;
                renderWorkspaceSelect();
                markDirty();
            });
        });
        $('#ws-delete').addEventListener('click', deleteWorkspace);
        $('#btn-add-chart').addEventListener('click', function () { addChart(); });
        $('#btn-save').addEventListener('click', function () { saveNow(); });
        $('#btn-groups').addEventListener('click', openDrawer);
        $('#drawer-close').addEventListener('click', closeDrawer);
        var keysBtn = $('#drawer-keys');
        if (keysBtn) keysBtn.addEventListener('click', openCredentialsModal);
        var drawerBackdrop = $('#ws-drawer-backdrop');
        if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
        $('#modal-close').addEventListener('click', closeModal);

        document.querySelectorAll('.chip[data-sync]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var key = btn.dataset.sync;
                var ws = activeWorkspace();
                var value = !(ws.globalSettings[key]);
                ws.globalSettings[key] = value;
                ws.syncGroups.forEach(function (g) { g.settings[key] = value; });
                if (WS.sync) WS.sync.setSettings({ [key]: value });
                btn.setAttribute('aria-pressed', String(value));
                if (key === 'crosshair' && !value && WS.sync) WS.sync.clearAllCrosshairs();
                scheduleSave();
            });
        });

        $('#price-mode').addEventListener('change', function (ev) {
            applyPriceModeAll(ev.target.value);
        });
        $('#nearest-policy').addEventListener('change', function (ev) {
            var ws = activeWorkspace();
            ws.globalSettings.nearestPolicy = ev.target.value;
            ws.syncGroups.forEach(function (g) { g.settings.nearestPolicy = ev.target.value; });
            if (WS.sync) WS.sync.setSettings({ nearestPolicy: ev.target.value });
            scheduleSave();
        });

        $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
        $('#btn-trade').addEventListener('click', function () { Bridge.call('toggleTopBar'); });
        $('#btn-settings').addEventListener('click', function () { Bridge.call('openSettings'); });
        $('#btn-theme').addEventListener('click', function () { Bridge.call('toggleTheme'); });
        document.addEventListener('fullscreenchange', updateFullscreenIcon);
        window.addEventListener('resize', function () { renderGutters(); });

        document.addEventListener('pointerdown', function (ev) {
            if (WS.menu && !WS.menu.contains(ev.target) && ev.target !== WS.menuAnchor &&
                (!WS.menuAnchor || !WS.menuAnchor.contains(ev.target))) {
                closeMenu();
            }
            if ($('#ws-drawer').classList.contains('open') &&
                !$('#ws-drawer').contains(ev.target) && !ev.target.closest('#btn-groups') &&
                !ev.target.closest('.group-chip') && !ev.target.closest('#ws-modal-backdrop')) {
                closeDrawer();
            }
            Object.keys(WS.charts).forEach(function (id) {
                var chart = WS.charts[id];
                if (!chart.drawPalette) return;
                if (chart.drawPalette.contains(ev.target)) return;
                if (ev.target.closest && ev.target.closest('.draw-rail')) return;
                closeToolPalette(chart);
            });
        }, true);

        document.addEventListener('keydown', function (ev) {
            var inField = ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
            if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 's' || ev.key === 'S')) {
                ev.preventDefault();
                saveNow();
                return;
            }
            if (ev.key === 'Escape') {
                if (WS.modal) { closeModal(); return; }
                if (WS.menu) { closeMenu(); return; }
                if ($('#ws-drawer').classList.contains('open')) { closeDrawer(); return; }
                var focused = WS.charts[WS.focused];
                if (focused && focused.drawPalette) { closeToolPalette(focused); return; }
                if (focused && focused.drawTool) { setDrawTool(focused, null); return; }
                if (focused && focused.measureDrag) { endMeasureDrag(focused); return; }
                if (focused && focused.selectedMeasure) {
                    focused.selectedMeasure = false;
                    renderDrawings(focused);
                    return;
                }
                return;
            }
            if ((ev.key === 'Delete' || ev.key === 'Backspace') && !inField) {
                deleteSelectedDrawing();
            }
            if (ev.key === 'F11') {
                ev.preventDefault();
                toggleFullscreen();
            }
        });

        $('#ws-modal-backdrop').addEventListener('pointerdown', function (ev) {
            if (ev.target === $('#ws-modal-backdrop')) closeModal();
        });
    }

    function toggleFullscreen() {
        // Inside the Tauri shell, fullscreen the native window. HTML fullscreen
        // would put the iframe above the shell and hide the trade sidebar.
        if (Bridge.ready && Bridge.obj && typeof Bridge.obj.toggleFullscreen === 'function') {
            Bridge.call('toggleFullscreen').catch(function () { browserFullscreen(); });
            return;
        }
        browserFullscreen();
    }

    function browserFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(function () { /* ignore */ });
        } else if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(function (err) {
                toast('Fullscreen unavailable: ' + err.message, true);
            });
        }
    }

    WS.setFullscreenState = function (enabled) {
        WS.fullscreenOn = !!enabled;
        updateFullscreenIcon();
    };

    function updateFullscreenIcon() {
        var btn = $('#btn-fullscreen');
        if (!btn) return;
        var on = WS.fullscreenOn || !!document.fullscreenElement;
        btn.title = on ? 'Exit fullscreen' : 'Fullscreen (F11)';
        btn.setAttribute('aria-pressed', String(on));
    }

    /* ── Boot ────────────────────────────────────────────────────────────── */

    WS.boot = function () {
        hydrateIcons();
        loadPrefs();
        Bridge.connect(function (err) {
            if (err) {
                document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#F87171">' +
                    'Bridge unavailable — open this page from the Trade Panel workspace window.</div>';
                return;
            }
            Bridge.call('meta').then(function (meta) {
                WS.meta = meta;
                return Bridge.call('loadStore');
            }).then(function (store) {
                WS.store = store;
                if (!WS.store || !Array.isArray(WS.store.workspaces) || !WS.store.workspaces.length) {
                    setStatus('No workspace store', 'error');
                    return null;
                }
                return true;
            }).then(function (ready) {
                if (!ready) return;
                WS.activeId = WS.store.active || WS.store.workspaces[0].id;
                wireShell();
                loadWorkspace(WS.activeId);
                setStatus('Ready');
                window.addEventListener('beforeunload', function (event) {
                    if (!WS.dirty) return;
                    event.preventDefault();
                    event.returnValue = 'Unsaved session changes';
                    return event.returnValue;
                });
            }).catch(function (bootErr) {
                console.error('Workspace boot failed', bootErr);
                setStatus('Boot failed', 'error');
            });
        });
    };

    /** Called by the Qt shell when the embedded view is hidden/shown. */
    WS.setActive = function (active) {
        WS.active = !!active;
        if (!WS.active) {
            Object.keys(WS.charts).forEach(function (id) {
                var entry = WS.charts[id];
                if (entry) clearTimeout(entry.tickTimer);
            });
            // No background write: hiding the workspace keeps unsaved work in
            // memory and leaves the Save button marked.
            return;
        }
        Object.keys(WS.charts).forEach(function (id) {
            startPolling(WS.charts[id], 250);
        });
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
    };

    WS.shutdown = function () {
        // Sessions persist on an explicit Save only; unsaved work stays unsaved.
        if (WS.dirty) console.warn('TradePanel: closing with unsaved session changes');
        WS.shuttingDown = true;
        WS.active = false;
        Object.keys(WS.charts).forEach(function (id) {
            var entry = WS.charts[id];
            clearTimeout(entry.tickTimer);
            clearInterval(entry.tickTimer);
        });
        destroyAllCharts();
        if (WS.sync) WS.sync.destroy();
    };

    // Test/harness hooks (not used by production code paths).
    WS._internal = {
        nearestCandle: nearestCandle, detectPrecision: detectPrecision,
        applyGridTemplate: applyGridTemplate, customGridFor: customGridFor,
        layouts: LAYOUTS, timeframes: TIMEFRAMES
    };

    document.addEventListener('DOMContentLoaded', function () { WS.boot(); });
})();
