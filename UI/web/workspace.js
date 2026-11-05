/* ═══════════════════════════════════════════════════════════════════════════
 * Multi-Chart Workspace
 *
 * Vanilla JS (the project has no front-end framework). One Lightweight Charts
 * instance per panel; ChartSyncManager (chart_sync.js) owns synchronization.
 * All exchange I/O is delegated to Python through QWebChannel.
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
    var GROUP_COLORS = ['#FF5A3C', '#2962FF', '#F5C400', '#10B981', '#A855F7', '#06B6D4'];
    var DEFAULT_SLOTS = [
        ['binance', 'BTC/USDT', '5m'], ['bybit', 'BTC/USDT', '5m'],
        ['binance', 'ETH/USDT', '15m'], ['okx', 'SOL/USDT', '1h'],
        ['kraken', 'BTC/USDT', '1h'], ['coinbase', 'ETH/USDT', '5m'],
        ['kucoin', 'SOL/USDT', '15m'], ['gate', 'BTC/USDT', '4h'],
        ['bitget', 'ETH/USDT', '1h'], ['binance', 'XRP/USDT', '5m'],
        ['bybit', 'SOL/USDT', '5m'], ['okx', 'BTC/USDT', '15m']
    ];
    var PREFS_KEY = 'trade_panel.workspace.prefs.v1';
    var IND_DEFS = {
        sma: { label: 'SMA', desc: 'Simple moving average', color: '#60A5FA', overlay: true, params: { length: 20 } },
        ema: { label: 'EMA', desc: 'Exponential moving average', color: '#F59E0B', overlay: true, params: { length: 50 } },
        bb: { label: 'Bollinger Bands', desc: 'SMA ± N standard deviations', color: '#A78BFA', overlay: true, params: { length: 20, mult: 2 } },
        vwap: { label: 'VWAP', desc: 'Anchored VWAP (D/W configurable)', color: '#7B68EE', overlay: true, params: {} },
        volume: { label: 'Volume', desc: 'Base volume histogram', color: '#10B981', overlay: false, params: {} },
        rsi: { label: 'RSI', desc: 'Relative strength index', color: '#06B6D4', pane: true, params: { length: 14 } },
        macd: { label: 'MACD', desc: '12 / 26 / 9 momentum', color: '#F472B6', pane: true, params: { fast: 12, slow: 26, signal: 9 } },
        atr: { label: 'ATR', desc: 'Average true range', color: '#FB923C', pane: true, params: { length: 14 } }
    };
    var LEGACY_DEFS = {
        session_asian: { label: 'Asian session', group: 'Sessions', color: '#FFD700' },
        session_london: { label: 'London session', group: 'Sessions', color: '#7B68EE' },
        session_ny_am: { label: 'NY AM session', group: 'Sessions', color: '#FF6347' },
        session_ny_pm: { label: 'NY PM session', group: 'Sessions', color: '#00CED1' },
        fvg: { label: 'Fair Value Gap', group: 'Advanced', color: '#F5C400' },
        ribbon: { label: 'MA Ribbon', group: 'Advanced', color: '#2196F3' },
        vp: { label: 'Volume Profile', group: 'Advanced', color: '#60A5FA' },
        daily_vp: { label: 'Daily VP', group: 'Advanced', color: '#38BDF8' },
        session_vp: { label: 'Session VP', group: 'Advanced', color: '#22D3EE' },
        hl_ema: { label: 'High/Low EMA', group: 'Advanced', color: '#66BB6A' },
        adx: { label: 'ADX', group: 'Advanced', color: '#FB923C' }
    };

    var DRAW_TOOLS = [
        { id: 'select', label: 'Select / move drawings' },
        { id: 'long', label: 'Long position' },
        { id: 'short', label: 'Short position' },
        { id: 'measure', label: 'Measure' },
        { id: 'hline', label: 'Horizontal line' },
        { id: 'vline', label: 'Vertical line' },
        { id: 'trend', label: 'Trend line' },
        { id: 'rect', label: 'Rectangle' },
        { id: 'fib', label: 'Fibonacci retracement' },
        { id: 'text', label: 'Text annotation' }
    ];

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
        saveTimer: null,
        saving: false,
        saveQueued: false,
        shuttingDown: false,
        active: true,
        prefs: { favorites: [], recent: [] },
        indicatorConfig: {},
        modal: null,
        menu: null,
        menuAnchor: null,
        dragChartId: null,
        drawDrag: null,
        statusTimer: null
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
                if (parsed && Array.isArray(parsed.favorites)) WS.prefs.favorites = parsed.favorites.slice(0, 40);
                if (parsed && Array.isArray(parsed.recent)) WS.prefs.recent = parsed.recent.slice(0, 12);
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

    function toggleFavorite(key) {
        var idx = WS.prefs.favorites.indexOf(key);
        if (idx >= 0) WS.prefs.favorites.splice(idx, 1);
        else WS.prefs.favorites.unshift(key);
        WS.prefs.favorites = WS.prefs.favorites.slice(0, 40);
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
        $('#ws-modal-backdrop').classList.remove('open');
        $('#modal-body').innerHTML = '';
        $('#modal-foot').innerHTML = '';
        WS.modal = null;
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

    function panelIcon(paths) {
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

    function buildPanel(entry) {
        var cfg = entry.config;
        var panel = el('section', 'panel');
        panel.dataset.chartId = cfg.id;

        var head = el('header', 'panel-head');

        var grip = el('span', 'drag-grip', '⠿');
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

        var tfBtn = el('button', 'head-btn', tfLabel(cfg.timeframe));
        tfBtn.type = 'button';
        tfBtn.title = 'Timeframe';
        head.appendChild(tfBtn);

        var typeBtn = el('button', 'head-btn type-btn', '');
        typeBtn.type = 'button';
        typeBtn.title = 'Chart type';
        head.appendChild(typeBtn);

        var priceSpan = el('span', 'head-price', '—');
        var chgSpan = el('span', 'head-chg flat', '—');
        head.appendChild(priceSpan);
        head.appendChild(chgSpan);

        var tools = el('div', 'panel-tools');
        var indBtn = el('button', 'icon-btn');
        indBtn.type = 'button';
        indBtn.title = 'Indicators';
        indBtn.setAttribute('aria-label', 'Indicators');
        indBtn.appendChild(panelIcon(['M4 18V9M9 18V5M14 18v-6M19 18v-9']));
        var refBtn = el('button', 'icon-btn');
        refBtn.type = 'button';
        refBtn.title = 'Price-scale reference point';
        refBtn.setAttribute('aria-label', 'Price-scale reference point');
        refBtn.appendChild(panelIcon(['M12 3v18', 'M6 7h12', 'M8 17h8']));
        refBtn.style.display = 'none';
        var drawBtn = el('button', 'icon-btn');
        drawBtn.type = 'button';
        drawBtn.title = 'Drawing tools';
        drawBtn.setAttribute('aria-label', 'Drawing tools');
        drawBtn.appendChild(panelIcon(['M4 20l5-1 9-9-3-3-9 9-2 4z', 'M14.5 5.5l3 3']));
        var maxBtn = el('button', 'icon-btn');
        maxBtn.type = 'button';
        maxBtn.title = 'Maximize / restore';
        maxBtn.setAttribute('aria-label', 'Maximize or restore');
        maxBtn.appendChild(panelIcon(['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5']));
        var closeBtn = el('button', 'icon-btn');
        closeBtn.type = 'button';
        closeBtn.title = 'Remove chart';
        closeBtn.setAttribute('aria-label', 'Remove chart');
        closeBtn.appendChild(panelIcon(['M6 6l12 12M18 6L6 18']));
        tools.appendChild(indBtn);
        tools.appendChild(refBtn);
        tools.appendChild(drawBtn);
        tools.appendChild(maxBtn);
        tools.appendChild(closeBtn);
        head.appendChild(tools);

        var body = el('div', 'panel-body');
        var host = el('div', 'chart-host');
        var hostInner = el('div');
        host.appendChild(hostInner);
        body.appendChild(host);

        var pane = el('div', 'osc-pane');
        var paneCanvas = el('canvas', 'osc-layer');
        pane.appendChild(paneCanvas);
        body.appendChild(pane);

        var legend = el('div', 'ind-legend');
        // Legend lives in the footer so the plot stays unobstructed.
        legend.classList.add('in-foot');

        var strip = el('div', 'ohlc-strip');
        body.appendChild(strip);

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

        var indCanvas = el('canvas', 'ind-layer');
        body.appendChild(indCanvas);

        var drawCanvas = el('canvas', 'draw-layer');
        body.appendChild(drawCanvas);

        var foot = el('footer', 'panel-foot');
        var live = el('span', 'live', 'live');
        var bars = el('span', 'bars', '—');
        var ms = el('span', 'ms', '');
        foot.appendChild(live);
        foot.appendChild(bars);
        foot.appendChild(legend);
        foot.appendChild(ms);

        panel.appendChild(head);
        panel.appendChild(body);
        panel.appendChild(foot);

        entry.panel = panel;
        entry.head = head;
        entry.host = hostInner;
        entry.body = body;
        entry.ohlcStrip = strip;
        entry.aggNote = agg;
        entry.overlay = overlay;
        entry.indCanvas = indCanvas;
        entry.drawCanvas = drawCanvas;
        entry.pane = pane;
        entry.paneCanvas = paneCanvas;
        entry.legend = legend;
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

    function buildDrawRail(entry) {
        var rail = el('div', 'draw-rail');
        var icons = {
            select: ['M6 3l12 9-6.2 1.3L9.4 20 6 3z'],
            long: ['M12 20V5', 'M6.5 10.5L12 5l5.5 5.5'],
            short: ['M12 4v15', 'M6.5 13.5L12 19l5.5-5.5'],
            measure: ['M4 17L20 7', 'M7 14l2 3', 'M11 12l2 3', 'M15 10l2 3'],
            hline: ['M3 12h18'],
            vline: ['M12 3v18'],
            trend: ['M4 19L20 5', 'M4 19h.01', 'M20 5h.01'],
            rect: ['M4 5h16v14H4z'],
            fib: ['M3 6h18M3 10h18M3 14h18M3 18h18'],
            text: ['M5 6h14', 'M12 6v13', 'M9 19h6']
        };
        DRAW_TOOLS.forEach(function (tool, index) {
            if (index === 1 || index === 4) rail.appendChild(el('div', 'sep'));
            var btn = el('button');
            btn.type = 'button';
            btn.dataset.tool = tool.id;
            btn.title = tool.label;
            btn.setAttribute('aria-label', tool.label);
            btn.setAttribute('aria-pressed', 'false');
            btn.appendChild(panelIcon(icons[tool.id] || ['M4 12h16']));
            btn.addEventListener('click', function () { setDrawTool(entry, tool.id); });
            rail.appendChild(btn);
        });
        rail.appendChild(el('div', 'sep'));
        var gear = el('button');
        gear.type = 'button';
        gear.title = 'Position settings — account, risk, leverage';
        gear.setAttribute('aria-label', 'Position settings');
        gear.appendChild(panelIcon(['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
            'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.54 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.54a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.46 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z']));
        gear.addEventListener('click', function () { openPositionSettings(entry); });
        rail.appendChild(gear);
        var clear = el('button');
        clear.type = 'button';
        clear.title = 'Clear all drawings on this chart';
        clear.setAttribute('aria-label', 'Clear all drawings');
        clear.appendChild(panelIcon(['M4 7h16', 'M9 7V5h6v2', 'M6.5 7l.8 12h9.4l.8-12']));
        clear.addEventListener('click', function () {
            entry.config.drawings.length = 0;
            entry.positions.length = 0;
            entry.measure = null;
            entry.selectedDrawing = null;
            entry.selectedPosition = null;
            savePositions(entry);
            renderDrawings(entry);
            scheduleSave();
        });
        rail.appendChild(clear);
        return rail;
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

        entry.head.querySelectorAll('.panel-tools .icon-btn').forEach(function (btn, idx) {
            btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (idx === 0) openIndicatorModal(entry);
                else if (idx === 1) openReferenceMenu(entry, btn);
                else if (idx === 2) toggleRail(entry);
                else if (idx === 3) toggleMaximize(entry);
                else removeChart(entry);
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
            if (ev.key === 'Enter') commitTextDrawing(entry);
            else if (ev.key === 'Escape') cancelTextDrawing(entry);
        });
        entry.textInput.addEventListener('blur', function () {
            setTimeout(function () { if (entry.pendingText) cancelTextDrawing(entry); }, 120);
        });

        wireDrawingCanvas(entry);
    }

    /* ── Chart lifecycle ──────────────────────────────────────────────────── */

    // Right-scale padding; temporarily zeroed while a vertical price drag is
    // active so the frozen range maps 1:1 to the pane (see capturePanBase).
    var PRICE_SCALE_MARGINS = { top: 0.08, bottom: 0.22 };

    function chartOptions() {
        return {
            layout: {
                background: { type: 'solid', color: '#0A0A0A' },
                textColor: '#A1A1AA',
                fontSize: 11,
                fontFamily: 'JetBrains Mono, Satoshi, ui-monospace, monospace'
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.035)' },
                horzLines: { color: 'rgba(255,255,255,0.035)' }
            },
            crosshair: {
                mode: window.LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: '#52525B', width: 1, style: window.LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#F5C400' },
                horzLine: { color: '#52525B', width: 1, style: window.LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#F5C400' }
            },
            rightPriceScale: {
                borderColor: '#2A2A2A',
                scaleMargins: { top: PRICE_SCALE_MARGINS.top, bottom: PRICE_SCALE_MARGINS.bottom },
                minimumWidth: 72
            },
            timeScale: {
                borderColor: '#2A2A2A',
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 6,
                barSpacing: 7
            },
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
        };
    }

    function makeEntry(cfg) {
        var entry = {
            id: cfg.id,
            config: cfg,
            candles: [],
            display: [],
            rawByTime: new Map(),
            ind: {},
            overlays: {},
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
            selectedDrawing: null,
            drawingDrag: null,
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
            measure: null,
            legacy: {},
            legacySeq: 0,
            legacyRaf: null,
            legacyRequestedAt: 0,
            drawDrag: null,
            pendingText: null,
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
        entry.volumeSeries = chart.addHistogramSeries({
            priceScaleId: 'volume',
            priceFormat: { type: 'volume' }
        });
        entry.volumeSeries.applyOptions({
            title: '',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            visible: !!(entry.config.indicators.volume && entry.config.indicators.volume.enabled)
        });
        chart.priceScale('volume').applyOptions({
            visible: false,
            borderVisible: false,
            scaleMargins: { top: 0.84, bottom: 0 }
        });
        installAutoscaleProvider(entry);

        wireChartUI(entry);

        entry.resizeObserver = new ResizeObserver(function () {
            if (entry.destroyed) return;
            var w = entry.host.clientWidth, h = entry.host.clientHeight;
            if (w > 0 && h > 0) chart.applyOptions({ width: w, height: h });
            resizeDrawCanvas(entry);
            drawOscillators(entry);
            drawIndicatorOverlay(entry);
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
        var cfg = entry.config;
        var opts = {
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: true
        };
        var series;
        if (type === 'hollow') {
            series = chart.addCandlestickSeries(Object.assign({}, opts, {
                upColor: '#0A0A0A', downColor: '#DC2626',
                borderUpColor: '#10B981', borderDownColor: '#DC2626',
                wickUpColor: '#10B981', wickDownColor: '#DC2626',
                borderVisible: true
            }));
        } else if (type === 'bar') {
            series = chart.addBarSeries(Object.assign({}, opts, {
                upColor: '#10B981', downColor: '#DC2626', thinBars: false
            }));
        } else if (type === 'line') {
            series = chart.addLineSeries(Object.assign({}, opts, {
                color: '#F5C400', lineWidth: 2
            }));
        } else if (type === 'area') {
            series = chart.addAreaSeries(Object.assign({}, opts, {
                lineColor: '#F5C400', lineWidth: 2,
                topColor: 'rgba(245,196,0,0.24)', bottomColor: 'rgba(245,196,0,0.02)'
            }));
        } else if (type === 'baseline') {
            series = chart.addBaselineSeries(Object.assign({}, opts, {
                topLineColor: '#10B981', bottomLineColor: '#DC2626',
                topFillColor1: 'rgba(16,185,129,0.22)', topFillColor2: 'rgba(16,185,129,0.02)',
                bottomFillColor1: 'rgba(220,38,38,0.02)', bottomFillColor2: 'rgba(220,38,38,0.22)'
            }));
        } else {
            series = chart.addCandlestickSeries(Object.assign({}, opts, {
                upColor: '#10B981', downColor: '#DC2626',
                borderUpColor: '#10B981', borderDownColor: '#DC2626',
                wickUpColor: '#10B981', wickDownColor: '#DC2626'
            }));
        }
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
            if (!info || !info.priceRange || !offset) return info;
            return {
                priceRange: {
                    minValue: info.priceRange.minValue + offset,
                    maxValue: info.priceRange.maxValue + offset
                },
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
        try { if (entry._drawDocCleanup) entry._drawDocCleanup(); } catch (err) { /* ignore */ }
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
        drawOscillators(entry);
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
        requestLegacy(entry);
        startPolling(entry);
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
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
                color: c.close >= c.open ? 'rgba(16,185,129,0.32)' : 'rgba(220,38,38,0.32)'
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
        drawOscillators(entry);
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
    }

    function showStrip(entry, candle) {
        var div = entry.ohlcStrip;
        div.innerHTML = '';
        var fields = [
            ['O', candle.open], ['H', candle.high], ['L', candle.low], ['C', candle.close],
            ['V', candle.volume]
        ];
        fields.forEach(function (pair) {
            var span = el('span');
            span.appendChild(document.createTextNode(pair[0] + ' '));
            var b = el('b', '', pair[0] === 'V' ? compactNumber(pair[1]) : formatPrice(pair[1], entry.precision));
            if (pair[0] !== 'V') b.style.color = candle.close >= candle.open ? '#10B981' : '#DC2626';
            span.appendChild(b);
            div.appendChild(span);
        });
        div.classList.add('show');
    }

    function hideStrip(entry) { entry.ohlcStrip.classList.remove('show'); }

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
        entry.tfBtn.textContent = tfLabel(entry.config.timeframe);
    }

    function updateTypeLabel(entry) {
        var found = CHART_TYPES.filter(function (t) { return t.id === entry.config.chartType; })[0];
        entry.typeBtn.textContent = found ? found.label : 'Candles';
    }

    function notifyFocused(entry) {
        try {
            if (Bridge.obj && Bridge.obj.onFocusedChartChanged) {
                Bridge.obj.onFocusedChartChanged(
                    entry.config.symbol, entry.config.exchange,
                    entry.config.market, entry.config.timeframe
                );
            }
        } catch (err) { /* bridge not ready */ }
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
            if (newBar) {
                refreshIndicators(entry);
                if (Date.now() - entry.legacyRequestedAt > 1500) requestLegacy(entry);
                maybeFinalizePrevious(entry);
            }
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
                color: rawLast.close >= rawLast.open ? 'rgba(16,185,129,0.32)' : 'rgba(220,38,38,0.32)'
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
        if (newBar) refreshOverlayValues(entry);
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

    /* ── Indicators ──────────────────────────────────────────────────────── */

    function sma(values, length) {
        var out = [], sum = 0;
        for (var i = 0; i < values.length; i++) {
            sum += values[i];
            if (i >= length) sum -= values[i - length];
            if (i >= length - 1) out.push(sum / length);
        }
        return out;
    }

    function ema(values, length) {
        var out = [], k = 2 / (length + 1), prev = null, sum = 0;
        for (var i = 0; i < values.length; i++) {
            if (i < length) {
                sum += values[i];
                if (i === length - 1) { prev = sum / length; out.push(prev); }
                else out.push(null);
            } else {
                prev = values[i] * k + prev * (1 - k);
                out.push(prev);
            }
        }
        return out;
    }

    function stdev(values, length) {
        var out = [];
        for (var i = 0; i < values.length; i++) {
            if (i < length - 1) { out.push(null); continue; }
            var slice = values.slice(i - length + 1, i + 1);
            var mean = slice.reduce(function (a, b) { return a + b; }, 0) / length;
            var variance = slice.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / length;
            out.push(Math.sqrt(variance));
        }
        return out;
    }

    function rsiSeries(values, length) {
        var out = new Array(values.length).fill(null);
        if (values.length <= length) return out;
        var gain = 0, loss = 0;
        for (var i = 1; i <= length; i++) {
            var diff = values[i] - values[i - 1];
            if (diff >= 0) gain += diff; else loss -= diff;
        }
        var avgGain = gain / length, avgLoss = loss / length;
        out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        for (var j = length + 1; j < values.length; j++) {
            var d = values[j] - values[j - 1];
            avgGain = (avgGain * (length - 1) + Math.max(d, 0)) / length;
            avgLoss = (avgLoss * (length - 1) + Math.max(-d, 0)) / length;
            out[j] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
        return out;
    }

    function macdSeries(values, fast, slow, signal) {
        var emaFast = ema(values, fast);
        var emaSlow = ema(values, slow);
        var line = values.map(function (_, i) {
            if (emaFast[i] == null || emaSlow[i] == null) return null;
            return emaFast[i] - emaSlow[i];
        });
        var compact = line.filter(function (v) { return v != null; });
        var sigCompact = ema(compact, signal);
        var sig = new Array(values.length).fill(null);
        var offset = values.length - sigCompact.length;
        for (var i = 0; i < sigCompact.length; i++) sig[offset + i] = sigCompact[i];
        var hist = line.map(function (v, i) {
            if (v == null || sig[i] == null) return null;
            return v - sig[i];
        });
        return { line: line, signal: sig, hist: hist };
    }

    function atrSeries(candles, length) {
        var trs = candles.map(function (c, i) {
            if (i === 0) return c.high - c.low;
            var pc = candles[i - 1].close;
            return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
        });
        var out = new Array(candles.length).fill(null);
        if (candles.length < length) return out;
        var sum = 0;
        for (var i = 0; i < length; i++) sum += trs[i];
        out[length - 1] = sum / length;
        for (var j = length; j < candles.length; j++) {
            out[j] = (out[j - 1] * (length - 1) + trs[j]) / length;
        }
        return out;
    }

    function vwapSeries(entry) {
        var candles = entry.candles;
        var cfg = (WS.indicatorConfig && WS.indicatorConfig.vwap) || {};
        var intraday = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h'].indexOf(entry.config.timeframe) >= 0;
        var anchor = intraday ? (cfg.anchor_intraday || 'D') : (cfg.anchor_daily || 'W');
        var out = new Array(candles.length).fill(null);
        var cumPV = 0, cumV = 0, bucket = null;
        for (var i = 0; i < candles.length; i++) {
            var c = candles[i];
            var key = anchor === 'W'
                ? Math.floor((c.time - 345600) / 604800)
                : Math.floor(c.time / 86400);
            if (bucket === null || key !== bucket) { bucket = key; cumPV = 0; cumV = 0; }
            var typical = (c.high + c.low + c.close) / 3;
            cumPV += typical * c.volume;
            cumV += c.volume;
            out[i] = cumV > 0 ? cumPV / cumV : null;
        }
        return out;
    }

    function indicatorConfig(entry) {
        return entry.config.indicators || {};
    }

    function computeIndicatorSets(entry) {
        var cfg = indicatorConfig(entry);
        var closes = entry.candles.map(function (c) { return c.close; });
        var times = entry.candles.map(function (c) { return c.time; });
        var out = {};

        function toSeries(values) {
            var arr = [];
            for (var i = 0; i < values.length; i++) {
                if (values[i] == null) continue;
                arr.push({ time: times[i], value: transformValue(entry, values[i]) });
            }
            return arr;
        }

        if (cfg.sma && cfg.sma.enabled) out.sma = toSeries(sma(closes, cfg.sma.length || 20));
        if (cfg.ema && cfg.ema.enabled) out.ema = toSeries(ema(closes, cfg.ema.length || 50));
        if (cfg.bb && cfg.bb.enabled) {
            var len = cfg.bb.length || 20;
            var mult = cfg.bb.mult || 2;
            var mid = sma(closes, len);
            var sd = stdev(closes, len);
            var upper = [], lower = [];
            for (var i = 0; i < closes.length; i++) {
                upper.push(mid[i] == null || sd[i] == null ? null : mid[i] + sd[i] * mult);
                lower.push(mid[i] == null || sd[i] == null ? null : mid[i] - sd[i] * mult);
            }
            out.bb = { mid: toSeries(mid), upper: toSeries(upper), lower: toSeries(lower) };
        }
        if (cfg.vwap && cfg.vwap.enabled) out.vwap = toSeries(vwapSeries(entry));
        if (cfg.rsi && cfg.rsi.enabled) {
            out.rsi = { values: rsiSeries(closes, cfg.rsi.length || 14), color: IND_DEFS.rsi.color };
        }
        if (cfg.macd && cfg.macd.enabled) {
            out.macd = macdSeries(closes, cfg.macd.fast || 12, cfg.macd.slow || 26, cfg.macd.signal || 9);
        }
        if (cfg.atr && cfg.atr.enabled) {
            out.atr = { values: atrSeries(entry.candles, cfg.atr.length || 14), color: IND_DEFS.atr.color };
        }
        entry.ind = out;
        entry.rawSeries = { closes: closes, times: times };
    }

    function ensureOverlaySeries(entry, key, color, width, dashed) {
        if (entry.overlays[key]) {
            entry.overlays[key].applyOptions({ color: color, visible: true, lineWidth: width || 1, lineStyle: dashed ? 2 : 0 });
            return entry.overlays[key];
        }
        var series = entry.chart.addLineSeries({
            color: color,
            lineWidth: width || 1,
            lineStyle: dashed ? window.LightweightCharts.LineStyle.Dashed : window.LightweightCharts.LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        });
        attachPriceScaleProvider(entry, series);
        entry.overlays[key] = series;
        return series;
    }

    function clearOverlay(entry, key) {
        var series = entry.overlays[key];
        if (series && series.applyOptions) series.applyOptions({ visible: false });
    }

    function refreshIndicators(entry) {
        computeIndicatorSets(entry);
        var ind = entry.ind;
        var cfg = indicatorConfig(entry);

        if (ind.sma) { ensureOverlaySeries(entry, 'sma', IND_DEFS.sma.color, 2).setData(ind.sma); } else clearOverlay(entry, 'sma');
        if (ind.ema) { ensureOverlaySeries(entry, 'ema', IND_DEFS.ema.color, 2).setData(ind.ema); } else clearOverlay(entry, 'ema');
        if (ind.vwap) { ensureOverlaySeries(entry, 'vwap', IND_DEFS.vwap.color, 2).setData(ind.vwap); } else clearOverlay(entry, 'vwap');
        if (ind.bb) {
            ensureOverlaySeries(entry, 'bb_up', 'rgba(167,139,250,0.85)', 1).setData(ind.bb.upper);
            ensureOverlaySeries(entry, 'bb_mid', 'rgba(167,139,250,0.55)', 1, true).setData(ind.bb.mid);
            ensureOverlaySeries(entry, 'bb_low', 'rgba(167,139,250,0.85)', 1).setData(ind.bb.lower);
        } else {
            clearOverlay(entry, 'bb_up'); clearOverlay(entry, 'bb_mid'); clearOverlay(entry, 'bb_low');
        }
        var volOn = !!(cfg.volume && cfg.volume.enabled);
        entry.volumeSeries.applyOptions({ visible: volOn });
        if (volOn) entry.volumeSeries.setData(volumeData(entry));

        renderLegend(entry);
        refreshLegacyLines(entry);
        drawIndicatorOverlay(entry);
        drawOscillators(entry);
    }

    function refreshOverlayValues(entry) {
        var ind = entry.ind;
        if (!ind) return;
        if (ind.sma && entry.overlays.sma) entry.overlays.sma.setData(ind.sma);
        if (ind.ema && entry.overlays.ema) entry.overlays.ema.setData(ind.ema);
        if (ind.vwap && entry.overlays.vwap) entry.overlays.vwap.setData(ind.vwap);
        if (ind.bb) {
            if (entry.overlays.bb_up) entry.overlays.bb_up.setData(ind.bb.upper);
            if (entry.overlays.bb_mid) entry.overlays.bb_mid.setData(ind.bb.mid);
            if (entry.overlays.bb_low) entry.overlays.bb_low.setData(ind.bb.lower);
        }
        drawOscillators(entry);
    }

    function renderLegend(entry) {
        var cfg = indicatorConfig(entry);
        entry.legend.innerHTML = '';
        Object.keys(IND_DEFS).forEach(function (key) {
            if (key === 'volume') return;
            var conf = cfg[key];
            if (!conf || !conf.enabled) return;
            var span = el('span');
            span.style.setProperty('--lite', IND_DEFS[key].color);
            span.style.borderColor = 'rgba(255,255,255,0.08)';
            span.appendChild(document.createTextNode(IND_DEFS[key].label));
            if (conf.length) span.appendChild(el('b', '', ' ' + conf.length));
            else if (key === 'macd') span.appendChild(el('b', '', ' ' + (conf.fast || 12) + '/' + (conf.slow || 26)));
            entry.legend.appendChild(span);
        });
        if (cfg.volume && cfg.volume.enabled) {
            var vol = el('span');
            vol.style.setProperty('--lite', IND_DEFS.volume.color);
            vol.appendChild(document.createTextNode('Vol'));
            entry.legend.appendChild(vol);
        }
        Object.keys(LEGACY_DEFS).forEach(function (key) {
            if (!indicatorEnabled(entry, key)) return;
            var chip = el('span');
            chip.style.setProperty('--lite', LEGACY_DEFS[key].color);
            chip.appendChild(document.createTextNode(LEGACY_DEFS[key].label));
            entry.legend.appendChild(chip);
        });
    }

    function paneKeys(entry) {
        var cfg = indicatorConfig(entry);
        var keys = ['rsi', 'macd', 'atr'].filter(function (k) { return cfg[k] && cfg[k].enabled && entry.ind[k]; });
        if (cfg.adx && cfg.adx.enabled && entry.legacy && entry.legacy.adx) keys.push('adx');
        return keys;
    }

    function drawOscillators(entry) {
        var keys = paneKeys(entry);
        var pane = entry.pane;
        if (!keys.length) {
            pane.classList.remove('show');
            pane.style.height = '0px';
            return;
        }
        var bodyH = entry.body.clientHeight || 400;
        var heights = keys.map(function (key) {
            if (key === 'adx') {
                var configured = Number(entry.legacy && entry.legacy.adx && entry.legacy.adx.pane_height);
                return clamp(isFinite(configured) ? configured : 140, 80, 280);
            }
            return 64;
        });
        var total = heights.reduce(function (a, b) { return a + b; }, 8);
        var maxHeight = Math.max(90, Math.floor(bodyH * 0.5));
        var scale = total > maxHeight ? maxHeight / total : 1;
        var height = Math.round(total * scale);
        pane.classList.add('show');
        pane.style.height = height + 'px';
        var canvas = entry.paneCanvas;
        var dpr = window.devicePixelRatio || 1;
        var w = pane.clientWidth, h = height;
        if (!w || !h) return;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textBaseline = 'middle';
        var plotW = entry.chart.timeScale().width();
        var times = entry.rawSeries ? entry.rawSeries.times : [];
        var top = 0;
        keys.forEach(function (key, idx) {
            var paneHeight = heights[idx] * scale;
            drawPane(entry, key, ctx, top, paneHeight, plotW, times);
            top += paneHeight;
        });
    }

    function drawPane(entry, key, ctx, top, height, plotW, times) {
        var ind = entry.ind[key];
        var ts = entry.chart.timeScale();
        var pad = 6;
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(plotW, top + 0.5); ctx.stroke();
        ctx.fillStyle = '#52525B';
        ctx.fillText(key.toUpperCase(), 6, top + 9);

        function xs(time) { var x = ts.timeToCoordinate(time); return x == null ? null : x; }

        if (key === 'rsi') {
            var vals = ind.values;
            var yFor = function (v) { return top + pad + (1 - v / 100) * (height - pad * 2); };
            ctx.strokeStyle = 'rgba(6,182,212,0.85)';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            var started = false;
            for (var i = 0; i < vals.length; i++) {
                if (vals[i] == null) continue;
                var x = xs(times[i]);
                if (x == null) continue;
                if (x < -20) continue;
                if (x > plotW + 20) break;
                if (!started) { ctx.moveTo(x, yFor(vals[i])); started = true; }
                else ctx.lineTo(x, yFor(vals[i]));
            }
            ctx.stroke();
            [30, 70].forEach(function (level) {
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                ctx.setLineDash([3, 4]);
                ctx.beginPath(); ctx.moveTo(0, yFor(level)); ctx.lineTo(plotW, yFor(level)); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#3F3F46';
                ctx.fillText(String(level), plotW + 4, yFor(level));
            });
        } else if (key === 'macd') {
            var data = ind;
            var nums = [];
            data.line.concat(data.signal, data.hist).forEach(function (v) { if (v != null) nums.push(v); });
            var max = Math.max.apply(null, nums.concat([0.0001]));
            var min = Math.min.apply(null, nums.concat([-0.0001]));
            var y = function (v) { return top + pad + (1 - (v - min) / (max - min || 1)) * (height - pad * 2); };
            var zero = y(0);
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(plotW, zero); ctx.stroke();
            for (var j = 0; j < data.hist.length; j++) {
                if (data.hist[j] == null) continue;
                var hx = xs(times[j]);
                if (hx == null || hx < -5 || hx > plotW + 5) continue;
                ctx.fillStyle = data.hist[j] >= 0 ? 'rgba(16,185,129,0.35)' : 'rgba(220,38,38,0.35)';
                var yTop = data.hist[j] >= 0 ? y(data.hist[j]) : zero;
                ctx.fillRect(hx - 1.5, yTop, 3, Math.abs(y(data.hist[j]) - zero));
            }
            [['line', '#F472B6'], ['signal', '#FBBF24']].forEach(function (pair) {
                var values = data[pair[0]];
                ctx.strokeStyle = pair[1];
                ctx.lineWidth = 1.3;
                ctx.beginPath();
                var started = false;
                for (var k = 0; k < values.length; k++) {
                    if (values[k] == null) continue;
                    var x = xs(times[k]);
                    if (x == null || x < -20) continue;
                    if (x > plotW + 20) break;
                    if (!started) { ctx.moveTo(x, y(values[k])); started = true; }
                    else ctx.lineTo(x, y(values[k]));
                }
                ctx.stroke();
            });
        } else if (key === 'adx') {
            var adxData = entry.legacy.adx;
            var levels = adxData.levels || [25];
            var val = function (v) { return top + pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2); };
            levels.forEach(function (level) {
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                ctx.setLineDash([3, 4]);
                ctx.beginPath(); ctx.moveTo(0, val(level)); ctx.lineTo(plotW, val(level)); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#3F3F46';
                ctx.fillText(String(level), plotW + 4, val(level));
            });
            function drawAdxLine(points, color, width) {
                ctx.strokeStyle = color;
                ctx.lineWidth = width || 1.4;
                ctx.beginPath();
                var started = false;
                for (var ai = 0; ai < points.length; ai++) {
                    var ax = xs(points[ai].time);
                    if (ax == null || ax < -20) continue;
                    if (ax > plotW + 20) break;
                    if (!started) { ctx.moveTo(ax, val(points[ai].value)); started = true; }
                    else ctx.lineTo(ax, val(points[ai].value));
                }
                ctx.stroke();
            }
            if (adxData.show_di_lines) {
                drawAdxLine(adxData.plus_di || [], 'rgba(34,197,94,0.8)', 1.1);
                drawAdxLine(adxData.minus_di || [], 'rgba(239,68,68,0.8)', 1.1);
            }
            drawAdxLine(adxData.adx || [], '#FB923C', 1.5);
        } else if (key === 'atr') {
            var values = ind.values;
            var maxA = 0;
            values.forEach(function (v) { if (v != null && v > maxA) maxA = v; });
            var yA = function (v) { return top + pad + (1 - v / (maxA || 1)) * (height - pad * 2); };
            ctx.strokeStyle = ind.color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            var startedA = false;
            for (var k = 0; k < values.length; k++) {
                if (values[k] == null) continue;
                var xa = xs(times[k]);
                if (xa == null || xa < -20) continue;
                if (xa > plotW + 20) break;
                if (!startedA) { ctx.moveTo(xa, yA(values[k])); startedA = true; }
                else ctx.lineTo(xa, yA(values[k]));
            }
            ctx.stroke();
            if (maxA) {
                ctx.fillStyle = '#3F3F46';
                ctx.fillText(maxA.toFixed(2), plotW + 4, top + 10);
            }
        }
    }


    /* ── Legacy chart indicators (computed in Python) ────────────────────── */

    function indicatorEnabled(entry, key) {
        var conf = entry.config.indicators && entry.config.indicators[key];
        return !!(conf && conf.enabled);
    }

    function legacyFlags(entry) {
        var flags = {};
        Object.keys(LEGACY_DEFS).forEach(function (key) {
            if (indicatorEnabled(entry, key)) flags[key] = true;
        });
        return flags;
    }

    function requestLegacy(entry) {
        if (!Bridge.ready || entry.destroyed) return;
        var flags = legacyFlags(entry);
        if (!Object.keys(flags).length) {
            entry.legacy = {};
            refreshLegacyLines(entry);
            drawIndicatorOverlay(entry);
            drawOscillators(entry);
            return;
        }
        entry.legacyRequestedAt = Date.now();
        var seq = ++entry.legacySeq;
        Bridge.request('requestIndicators', [
            entry.config.exchange, entry.config.market, entry.config.symbol,
            entry.config.timeframe, JSON.stringify(flags)
        ]).then(function (payload) {
            if (entry.destroyed || seq !== entry.legacySeq) return;
            entry.legacy = payload || {};
            refreshLegacyLines(entry);
            drawIndicatorOverlay(entry);
            drawOscillators(entry);
        }).catch(function (err) {
            console.warn('Legacy indicators unavailable for', entry.config.symbol, err);
        });
    }

    function transformPoints(entry, points) {
        return (points || []).map(function (p) {
            return { time: p.time, value: transformValue(entry, p.value) };
        });
    }

    function refreshLegacyLines(entry) {
        var data = entry.legacy || {};
        var ribbon = [
            ['ribbon1', '#2196F3'], ['ribbon2', '#FF9800'], ['ribbon3', '#E91E63']
        ];
        ribbon.forEach(function (pair, index) {
            var points = data.ribbon && data.ribbon['line' + (index + 1)];
            if (indicatorEnabled(entry, 'ribbon') && points && points.length) {
                ensureOverlaySeries(entry, pair[0], pair[1], 1.4).setData(transformPoints(entry, points));
            } else {
                clearOverlay(entry, pair[0]);
            }
        });
        var hlHigh = data.hl_ema && data.hl_ema.ema_high;
        var hlLow = data.hl_ema && data.hl_ema.ema_low;
        if (indicatorEnabled(entry, 'hl_ema') && hlHigh) {
            ensureOverlaySeries(entry, 'hl_high', '#26A69A', 1.4).setData(transformPoints(entry, hlHigh));
            ensureOverlaySeries(entry, 'hl_low', '#EF5350', 1.4).setData(transformPoints(entry, hlLow || []));
        } else {
            clearOverlay(entry, 'hl_high');
            clearOverlay(entry, 'hl_low');
        }
    }

    function withAlpha(hex, alpha) {
        if (typeof hex !== 'string' || hex.charAt(0) !== '#' || (hex.length !== 7 && hex.length !== 4)) {
            return 'rgba(161,161,170,' + alpha + ')';
        }
        var value = hex;
        if (hex.length === 4) {
            value = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        }
        var num = parseInt(value.slice(1), 16);
        return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')';
    }

    function resizeIndCanvas(entry) {
        var canvas = entry.indCanvas;
        if (!canvas) return;
        var dpr = window.devicePixelRatio || 1;
        var w = entry.host.clientWidth, h = entry.host.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
    }

    function drawIndicatorOverlay(entry) {
        if (!entry || !entry.chart || entry.destroyed || !entry.indCanvas) return;
        resizeIndCanvas(entry);
        var canvas = entry.indCanvas;
        var ctx = canvas.getContext('2d');
        var dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var w = canvas.width / dpr, h = canvas.height / dpr;
        ctx.clearRect(0, 0, w, h);
        var data = entry.legacy || {};
        var box = plotBox(entry);
        var priceSpan = Math.abs(entry.display.length ? entry.display[entry.display.length - 1].close : 1);

        function rectFor(t0, t1, high, low, fill, stroke, label) {
            var x0 = xForTime(entry, t0);
            var x1 = xForTime(entry, t1);
            var yHigh = yForPrice(entry, high);
            var yLow = yForPrice(entry, low);
            if (x0 == null || yHigh == null || yLow == null) return;
            if (x1 == null) x1 = box.w;
            if (x1 < -20 || x0 > box.w + 20) return;
            ctx.fillStyle = fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1;
            ctx.fillRect(x0, Math.min(yHigh, yLow), Math.max(1, x1 - x0), Math.max(1, Math.abs(yLow - yHigh)));
            ctx.strokeRect(x0 + 0.5, Math.min(yHigh, yLow) + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, Math.abs(yLow - yHigh) - 1));
            if (label) {
                ctx.fillStyle = stroke;
                ctx.font = '8.5px "JetBrains Mono", monospace';
                ctx.fillText(label, x0 + 4, Math.min(yHigh, yLow) + 10);
            }
        }

        if (data.sessions) {
            Object.keys(LEGACY_DEFS).forEach(function (key) {
                if (key.indexOf('session_') !== 0 || !indicatorEnabled(entry, key)) return;
                var sessionKey = key.slice('session_'.length);
                (data.sessions[sessionKey] || []).forEach(function (boxData) {
                    var color = boxData.color || LEGACY_DEFS[key].color;
                    rectFor(boxData.time, boxData.end_time, boxData.high, boxData.low,
                        withAlpha(color, 0.09), withAlpha(color, 0.65), boxData.name);
                });
            });
        }

        if (indicatorEnabled(entry, 'fvg') && data.fvg) {
            (data.fvg.bullish || []).forEach(function (gap) {
                rectFor(gap.time, gap.end_time >= 2147483647 ? box.w : gap.end_time,
                    gap.high, gap.low, 'rgba(34,197,94,0.10)', 'rgba(34,197,94,0.45)');
            });
            (data.fvg.bearish || []).forEach(function (gap) {
                rectFor(gap.time, gap.end_time >= 2147483647 ? box.w : gap.end_time,
                    gap.high, gap.low, 'rgba(239,68,68,0.10)', 'rgba(239,68,68,0.45)');
            });
        }

        function drawProfile(profile, startTime, endTime) {
            if (!profile || !profile.rows || !profile.rows.length) return;
            var x0 = xForTime(entry, startTime);
            var x1 = xForTime(entry, endTime);
            if (x0 == null) return;
            if (x1 == null) x1 = box.w;
            var span = Math.max(14, x1 - x0);
            var max = profile.max_volume || 1;
            profile.rows.forEach(function (row) {
                var yTop = yForPrice(entry, row.price_high);
                var yBot = yForPrice(entry, row.price_low);
                if (yTop == null || yBot == null) return;
                var height = Math.max(1, Math.abs(yBot - yTop));
                var width = Math.max(1, span * (row.volume / max));
                var isPoc = profile.poc_price != null &&
                    profile.poc_price >= row.price_low && profile.poc_price <= row.price_high;
                ctx.fillStyle = isPoc ? 'rgba(244,67,54,0.28)' : 'rgba(33,150,243,0.18)';
                ctx.fillRect(x0, Math.min(yTop, yBot), width, height);
            });
            var pocY = yForPrice(entry, profile.poc_price);
            if (pocY != null) {
                ctx.strokeStyle = 'rgba(244,67,54,0.65)';
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(x0, pocY);
                ctx.lineTo(x1, pocY);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // 70% value area (VAH / VAL) from the same bins.
            var totalVolume = profile.rows.reduce(function (sum, row) { return sum + (row.volume || 0); }, 0);
            if (totalVolume > 0) {
                var sorted = profile.rows.slice().sort(function (a, b) { return (b.volume || 0) - (a.volume || 0); });
                var accumulated = 0, vah = -Infinity, val = Infinity;
                for (var si = 0; si < sorted.length; si++) {
                    accumulated += sorted[si].volume || 0;
                    vah = Math.max(vah, sorted[si].price_high);
                    val = Math.min(val, sorted[si].price_low);
                    if (accumulated >= totalVolume * 0.7) break;
                }
                [[vah, 'rgba(33,150,243,0.65)'], [val, 'rgba(33,150,243,0.65)']].forEach(function (pair) {
                    var y = yForPrice(entry, pair[0]);
                    if (y == null) return;
                    ctx.strokeStyle = pair[1];
                    ctx.setLineDash([2, 4]);
                    ctx.beginPath();
                    ctx.moveTo(x0, y);
                    ctx.lineTo(x1, y);
                    ctx.stroke();
                    ctx.setLineDash([]);
                });
            }
        }

        if (indicatorEnabled(entry, 'vp') && data.vp) {
            var length = (WS.indicatorConfig.volume_profile && WS.indicatorConfig.volume_profile.length) || 100;
            var first = entry.candles[Math.max(0, entry.candles.length - length)];
            if (first) drawProfile(data.vp, first.time, entry.candles[entry.candles.length - 1].time);
        }
        if (indicatorEnabled(entry, 'daily_vp') && data.daily_vp) {
            data.daily_vp.forEach(function (profile) {
                drawProfile(profile, profile.start_time, profile.end_time);
            });
        }
        if (indicatorEnabled(entry, 'session_vp') && data.session_vp) {
            drawProfile(data.session_vp, data.session_vp.start_time, data.session_vp.end_time);
        }

        void priceSpan;
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
        refreshIndicators(entry);
        drawIndicatorOverlay(entry);
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
        refreshIndicators(entry);
        scheduleSave();
    }

    /* ── Chart type / timeframe / symbol menus ───────────────────────────── */

    function openChartTypeMenu(entry) {
        openMenu(entry.typeBtn, CHART_TYPES.map(function (type) {
            return {
                label: type.label,
                checked: entry.config.chartType === type.id,
                onClick: function () { setChartType(entry, type.id); }
            };
        }), 'Chart type');
    }

    function setChartType(entry, type) {
        if (entry.config.chartType === type) return;
        var range = entry.chart.timeScale().getVisibleLogicalRange();
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
        updateTypeLabel(entry);
        if (WS.sync) WS.sync.updateRegistration(entry.id, { mainSeries: entry.mainSeries });
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
        entry.tfBtn.textContent = tfLabel(tf);
        resetPricePan(entry);
        entry.loadSeq++;
        loadData(entry, { resetView: true, view: view });
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
        entry.legacy = {};
        resetPricePan(entry);
        entry.selectedPosition = null;
        entry.measure = null;
        entry.positions = loadPositions(entry);
        updateTypicalHeading(entry);
        forceRefetch(entry);
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
                var key = prefKey(state.exchange, state.market, item.symbol);
                var row = el('button', 'sym-row');
                row.type = 'button';
                row.setAttribute('aria-selected', String(state.selected === item.symbol));
                row.appendChild(el('span', '', item.symbol));
                row.appendChild(el('span', '', item.native));
                var star = el('span', 'fav' + (WS.prefs.favorites.indexOf(key) >= 0 ? ' on' : ''), '★');
                star.title = 'Toggle favourite';
                star.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    toggleFavorite(key);
                    renderChips();
                    renderResults();
                });
                row.appendChild(star);
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
            var recent = WS.prefs.recent.slice(0, 6);
            var favs = WS.prefs.favorites.slice(0, 8);
            var shown = [];
            recent.forEach(function (key) {
                var parts = key.split('|');
                shown.push({ key: key, label: parts[0] + ' · ' + parts[2], fav: false });
            });
            favs.forEach(function (key) {
                if (shown.some(function (s) { return s.key === key; })) return;
                var parts = key.split('|');
                shown.push({ key: key, label: '★ ' + parts[2], fav: true });
            });
            if (!shown.length) return;
            var label = el('div', 'modal-sub', 'Recent / favourites');
            label.style.width = '100%';
            chips.appendChild(label);
            shown.forEach(function (item) {
                var btn = el('button', 'mini-chip' + (item.fav ? ' fav' : ''), item.label);
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

    /* ── Indicators modal ────────────────────────────────────────────────── */

    function openIndicatorModal(entry) {
        var wrap = el('div');
        Object.keys(IND_DEFS).forEach(function (key) {
            var def = IND_DEFS[key];
            var conf = entry.config.indicators[key];
            var row = el('div', 'ind-row');
            var dot = el('span', 'dot');
            dot.style.setProperty('--c', def.color);
            row.appendChild(dot);
            var nameWrap = el('div');
            nameWrap.appendChild(el('div', 'ind-name', def.label));
            nameWrap.appendChild(el('div', 'ind-desc', def.desc));
            row.appendChild(nameWrap);

            var right = el('div', 'ind-params');
            Object.keys(def.params).forEach(function (param) {
                var input = el('input');
                input.type = 'number';
                input.value = conf[param] != null ? conf[param] : def.params[param];
                input.min = param === 'mult' ? '0.5' : '1';
                input.max = '500';
                input.step = param === 'mult' ? '0.1' : '1';
                input.title = param;
                input.disabled = !conf.enabled;
                input.addEventListener('change', function () {
                    conf[param] = Number(input.value) || def.params[param];
                    refreshIndicators(entry);
                    scheduleSave();
                });
                right.appendChild(input);
            });
            var sw = el('button', 'switch');
            sw.type = 'button';
            sw.setAttribute('role', 'switch');
            sw.setAttribute('aria-checked', String(!!conf.enabled));
            sw.title = 'Toggle ' + def.label;
            sw.addEventListener('click', function () {
                conf.enabled = !conf.enabled;
                sw.setAttribute('aria-checked', String(conf.enabled));
                right.querySelectorAll('input').forEach(function (i) { i.disabled = !conf.enabled; });
                refreshIndicators(entry);
                scheduleSave();
            });
            right.appendChild(sw);
            row.appendChild(right);
            wrap.appendChild(row);
        });

        wrap.appendChild(el('div', 'ind-section', 'Chart studies'));
        Object.keys(LEGACY_DEFS).forEach(function (key) {
            var def = LEGACY_DEFS[key];
            var conf = entry.config.indicators[key] || { enabled: false };
            var row = el('div', 'ind-row');
            var dot = el('span', 'dot');
            dot.style.setProperty('--c', def.color);
            row.appendChild(dot);
            var nameWrap = el('div');
            nameWrap.appendChild(el('div', 'ind-name', def.label));
            nameWrap.appendChild(el('div', 'ind-desc',
                def.group === 'Sessions' ? 'Session range box' : 'Computed from this panel\'s candles'));
            row.appendChild(nameWrap);
            var right = el('div', 'ind-params');
            var sw = el('button', 'switch');
            sw.type = 'button';
            sw.setAttribute('role', 'switch');
            sw.setAttribute('aria-checked', String(!!conf.enabled));
            sw.title = 'Toggle ' + def.label;
            sw.addEventListener('click', function () {
                conf.enabled = !conf.enabled;
                sw.setAttribute('aria-checked', String(conf.enabled));
                refreshIndicators(entry);
                requestLegacy(entry);
                scheduleSave();
            });
            right.appendChild(sw);
            row.appendChild(right);
            wrap.appendChild(row);
        });
        openModal({
            title: 'Indicators',
            sub: entry.config.symbol + ' · ' + entry.config.timeframe,
            body: wrap,
            foot: (function () {
                var foot = el('div');
                foot.style.marginLeft = 'auto';
                foot.style.display = 'flex';
                foot.style.gap = '8px';
                var configure = el('button', 'btn-ghost', '⚙ Configure…');
                configure.addEventListener('click', function () {
                    if (Bridge.obj && Bridge.obj.onConfigRequested) {
                        Bridge.obj.onConfigRequested();
                    }
                });
                var done = el('button', 'btn-ghost primary', 'Done');
                done.addEventListener('click', closeModal);
                foot.appendChild(configure);
                foot.appendChild(done);
                return foot;
            })()
        });
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
        var note = el('span', 'cred-foot-note', 'keys/.env');
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
                toast(count ? 'Credentials saved to keys/.env' : 'No credential changes');
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
            sub: 'Hyperliquid trading wallet · stored in keys/.env',
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

    WS.setIndicatorConfig = function (cfg) {
        WS.indicatorConfig = cfg || {};
        Object.keys(WS.charts).forEach(function (id) {
            var entry = WS.charts[id];
            if (!entry || entry.destroyed) return;
            refreshIndicators(entry);
            requestLegacy(entry);
        });
        toast('Indicator settings updated');
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
        Object.keys(LAYOUTS).forEach(function (key) {
            var spec = LAYOUTS[key];
            var btn = el('button', 'layout-btn');
            btn.type = 'button';
            btn.title = spec.label;
            btn.setAttribute('aria-label', spec.label);
            btn.dataset.layout = key;
            var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.2');
            if (key === 'custom') {
                var r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                r.setAttribute('x', '1.5'); r.setAttribute('y', '1.5');
                r.setAttribute('width', '13'); r.setAttribute('height', '13'); r.setAttribute('rx', '1');
                svg.appendChild(r);
                var line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', 'M8 1.5v13M1.5 8h13');
                svg.appendChild(line);
            } else {
                var cols = spec.cols, rows = spec.rows;
                var cellW = 13 / cols, cellH = 13 / rows;
                for (var yy = 0; yy < rows; yy++) {
                    for (var xx = 0; xx < cols; xx++) {
                        var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                        rect.setAttribute('x', String(1.5 + xx * cellW + 0.6));
                        rect.setAttribute('y', String(1.5 + yy * cellH + 0.6));
                        rect.setAttribute('width', String(cellW - 1.2));
                        rect.setAttribute('height', String(cellH - 1.2));
                        rect.setAttribute('rx', '0.6');
                        svg.appendChild(rect);
                    }
                }
            }
            btn.appendChild(svg);
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
            indicators: cloneIndicatorDefaults(),
            groupId: group ? group.id : null,
            drawings: [],
            view: null
        };
    }

    function cloneIndicatorDefaults() {
        var out = {};
        Object.keys(IND_DEFS).forEach(function (key) {
            out[key] = { enabled: key === 'volume' };
            Object.keys(IND_DEFS[key].params).forEach(function (param) {
                out[key][param] = IND_DEFS[key].params[param];
            });
        });
        Object.keys(LEGACY_DEFS).forEach(function (key) {
            out[key] = { enabled: false };
        });
        return out;
    }

    function ensureIndicators(config) {
        if (!config.indicators || typeof config.indicators !== 'object') {
            config.indicators = cloneIndicatorDefaults();
            return;
        }
        var defaults = cloneIndicatorDefaults();
        Object.keys(defaults).forEach(function (key) {
            if (!config.indicators[key] || typeof config.indicators[key] !== 'object') {
                config.indicators[key] = defaults[key];
            } else if (typeof config.indicators[key].enabled !== 'boolean') {
                config.indicators[key].enabled = defaults[key].enabled;
            }
        });
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
            cell.addEventListener('click', addChart);
            grid.appendChild(cell);
        }
    }

    function addChart() {
        var ws = activeWorkspace();
        if (ws.charts.length >= 12) { toast('Maximum 12 charts', true); return; }
        var cap = capacity(ws);
        if (ws.layout !== 'custom' && ws.charts.length < cap) {
            ws.charts.push(defaultChartConfig(ws.charts.length));
            syncPanels(ws);
        } else if (ws.layout !== 'custom' && cap < 8) {
            var next = cap === 1 ? '2h' : cap === 2 ? '4' : cap === 4 ? '6' : '8';
            ws.layout = next;
            var spec = LAYOUTS[next];
            ws.columns = equalFractions(spec.cols);
            ws.rows = equalFractions(spec.rows);
            ws.charts.push(defaultChartConfig(ws.charts.length));
            applyGridTemplate(ws);
            syncPanels(ws);
            updateLayoutButtons();
            renderGutters();
        } else {
            ws.layout = 'custom';
            ws.charts.push(defaultChartConfig(ws.charts.length));
            var grid = customGridFor(ws.charts.length);
            ws.columns = grid.columns;
            ws.rows = grid.rows;
            applyGridTemplate(ws);
            syncPanels(ws);
            updateLayoutButtons();
            renderGutters();
        }
        scheduleSave();
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
                drawOscillators(e);
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

    /* ── Drawing tools ───────────────────────────────────────────────────── */

    function setDrawTool(entry, tool) {
        if (entry.drawTool === tool) tool = null;
        entry.drawTool = tool;
        entry.rail.querySelectorAll('button[data-tool]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
        });
        // Select behaves like TradingView's cursor: it must not disable chart
        // panning.  Only shape tools capture the overlay and pause the chart.
        var interactive = !!tool && tool !== 'select';
        entry.drawCanvas.classList.toggle('active', interactive);
        entry.panel.classList.toggle('drawing', interactive);
        try {
            entry.chart.applyOptions(interactive
                ? { handleScroll: false, handleScale: false }
                : { handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true } });
        } catch (err) { /* ignore */ }
        if (interactive) {
            resizeDrawCanvas(entry);
            renderDrawings(entry);
            entry.drawCanvas.focus && entry.drawCanvas.focus();
        }
        entry.selectedDrawing = null;
        entry.selectedPosition = null;
        if (tool === 'measure') entry.measure = null;
        renderDrawings(entry);
    }

    function toggleRail(entry) {
        if (entry.rail.classList.contains('open')) {
            entry.rail.classList.remove('open');
            setDrawTool(entry, null);
        } else {
            entry.rail.classList.add('open');
            setDrawTool(entry, 'select');
        }
    }

    function resizeDrawCanvas(entry) {
        var canvas = entry.drawCanvas;
        var dpr = window.devicePixelRatio || 1;
        var w = entry.host.clientWidth, h = entry.host.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
    }

    function scheduledDraw(entry) {
        if (entry.rafId) return;
        entry.rafId = requestAnimationFrame(function () {
            entry.rafId = null;
            renderDrawings(entry);
            drawIndicatorOverlay(entry);
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
        // v4 timeScale.height() is the time-axis strip, not the plot.  The
        // overlay canvas spans the whole host, so subtract the axis.
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
        var drawings = entry.config.drawings || [];
        drawings.forEach(function (d) {
            drawShape(entry, ctx, d, box, d.id === entry.selectedDrawing);
        });
        if (entry.drawPreview) drawShape(entry, ctx, entry.drawPreview, box, true);
        drawPositions(entry, ctx, box);
        drawPositionDraft(entry, ctx, box);
        drawMeasure(entry, ctx, box);
    }

    function drawShape(entry, ctx, d, box, selected) {
        var color = selected ? '#F5C400' : (d.color || '#A1A1AA');
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = selected ? 1.6 : 1.1;
        ctx.setLineDash([]);
        var p0 = d.points && d.points[0];
        if (!p0) return;
        var x0 = d.tool === 'hline' ? null : xForTime(entry, p0.time);
        var y0 = d.tool === 'vline' ? null : yForPrice(entry, p0.price);
        if (d.tool === 'hline') {
            if (y0 == null) return;
            ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(box.w, y0); ctx.stroke();
            ctx.font = '9.5px "JetBrains Mono", monospace';
            ctx.fillText(formatPrice(p0.price, entry.precision), 6, y0 - 4);
            if (selected) handleDot(ctx, box.w - 4, y0);
            return;
        }
        if (d.tool === 'vline') {
            if (x0 == null) return;
            ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, box.h); ctx.stroke();
            if (selected) handleDot(ctx, x0, 6);
            return;
        }
        if (d.tool === 'text') {
            if (x0 == null || y0 == null) return;
            ctx.font = '11px "JetBrains Mono", monospace';
            ctx.fillStyle = selected ? '#F5C400' : '#FFFFFF';
            ctx.fillText(d.text || 'Text', x0 + 4, y0 - 4);
            if (selected) {
                var m = ctx.measureText(d.text || 'Text');
                ctx.strokeStyle = '#F5C400';
                ctx.strokeRect(x0 + 1, y0 - 15, m.width + 6, 16);
                handleDot(ctx, x0, y0);
            }
            return;
        }
        var p1 = d.points[1];
        if (!p1) return;
        var x1 = xForTime(entry, p1.time);
        var y1 = yForPrice(entry, p1.price);
        if (x0 == null || y0 == null || x1 == null || y1 == null) return;
        if (d.tool === 'trend') {
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
            handleDot(ctx, x0, y0); handleDot(ctx, x1, y1);
            ctx.font = '9.5px "JetBrains Mono", monospace';
            var pct = p0.price ? ((p1.price / p0.price - 1) * 100).toFixed(2) : '0.00';
            ctx.fillText((pct > 0 ? '+' : '') + pct + '%', x1 + 5, y1 - 5);
        } else if (d.tool === 'rect') {
            var left = Math.min(x0, x1), top = Math.min(y0, y1);
            var rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
            ctx.globalAlpha = 0.10;
            ctx.fillRect(left, top, rw, rh);
            ctx.globalAlpha = 1;
            ctx.strokeRect(left, top, rw, rh);
            if (selected) { handleDot(ctx, x0, y0); handleDot(ctx, x1, y1); }
        } else if (d.tool === 'fib') {
            var levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            ctx.font = '9px "JetBrains Mono", monospace';
            var lastLabelY = null;
            levels.forEach(function (level) {
                var y = y0 + (y1 - y0) * level;
                ctx.strokeStyle = level === 0 || level === 1 ? color : 'rgba(161,161,170,0.55)';
                ctx.setLineDash(level === 0 || level === 1 ? [] : [3, 3]);
                ctx.beginPath(); ctx.moveTo(Math.min(x0, x1), y); ctx.lineTo(Math.max(x0, x1), y); ctx.stroke();
                ctx.setLineDash([]);
                var price = p0.price + (p1.price - p0.price) * level;
                // Avoid label pile-up on shallow ranges.
                if (lastLabelY == null || Math.abs(y - lastLabelY) >= 11) {
                    lastLabelY = y;
                    ctx.fillStyle = selected ? '#F5C400' : '#A1A1AA';
                    ctx.fillText(level + ' (' + formatPrice(price, entry.precision) + ')', Math.min(x0, x1) + 3, y - 3);
                }
            });
            if (selected) { handleDot(ctx, x0, y0); handleDot(ctx, x1, y1); }
        }
    }

    function handleDot(ctx, x, y) {
        ctx.fillStyle = '#0A0A0A';
        ctx.strokeStyle = '#F5C400';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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
        return Array.isArray(list) ? list : [];
    }

    function savePositions(entry) {
        try {
            var all = readJsonStorage(POS_STORE_KEY, {});
            all[positionSymbolKey(entry)] = entry.positions.slice(-200);
            localStorage.setItem(POS_STORE_KEY, JSON.stringify(all));
        } catch (err) { /* storage unavailable */ }
    }

    function loadPositionSettings() {
        var saved = readJsonStorage(POS_SETTINGS_KEY, {});
        return {
            acct: Number(saved.acct) || 10000,
            risk: Number(saved.risk) || 1,
            lev: Number(saved.lev) || 10,
            widthPx: Number(saved.widthPx) || Number(saved.widthBars) * 6 || 140
        };
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

    function positionStats(entry, pos) {
        var risk = Math.abs(pos.entry - pos.sl);
        var reward = Math.abs(pos.tp - pos.entry);
        var settings = entry.posSettings;
        var riskAmount = settings.acct * (settings.risk / 100);
        var qty = risk > 0 ? riskAmount / risk : 0;
        return {
            rr: risk > 0 ? reward / risk : 0,
            qty: qty,
            margin: qty * pos.entry / (settings.lev || 1),
            risk: riskAmount,
            reward: qty * reward
        };
    }

    function openPositionSettings(entry) {
        var s = entry.posSettings;
        var wrap = el('div');
        wrap.style.display = 'grid';
        wrap.style.gridTemplateColumns = '1fr 1fr';
        wrap.style.gap = '10px';
        function field(label, key, value, step) {
            var box = el('div', 'field');
            box.appendChild(el('label', '', label));
            var input = el('input', 'input mono');
            input.type = 'number';
            input.step = step || '1';
            input.value = value;
            input.dataset.key = key;
            box.appendChild(input);
            wrap.appendChild(box);
        }
        field('Account (USDT)', 'acct', s.acct, '100');
        field('Risk per trade (%)', 'risk', s.risk, '0.1');
        field('Leverage', 'lev', s.lev, '1');
        field('Default box width (px)', 'widthPx', s.widthPx, '10');
        var foot = el('div');
        foot.style.marginLeft = 'auto';
        foot.style.display = 'flex';
        foot.style.gap = '8px';
        var cancel = el('button', 'btn-ghost', 'Cancel');
        cancel.addEventListener('click', closeModal);
        var apply = el('button', 'btn-ghost primary', 'Apply');
        apply.addEventListener('click', function () {
            wrap.querySelectorAll('input').forEach(function (input) {
                var value = Number(input.value);
                if (isFinite(value) && value > 0) {
                    entry.posSettings[input.dataset.key] = value;
                }
            });
            savePositionSettings(entry);
            closeModal();
            renderDrawings(entry);
        });
        foot.appendChild(cancel);
        foot.appendChild(apply);
        openModal({ title: 'Position tool settings', sub: 'Sizing, risk and default box width', body: wrap, foot: foot });
    }

    function pinnedLevelY(entry, price, box) {
        var y = yForPrice(entry, price);
        if (y == null) return null;
        if (y < 10) return 10;
        if (y > box.h - 10) return box.h - 10;
        return y;
    }

    function drawPositions(entry, ctx, box) {
        entry.positions.forEach(function (pos) {
            var x0 = xForTime(entry, pos.startTime);
            var x1 = xForTime(entry, pos.endTime);
            var yEntry = pinnedLevelY(entry, pos.entry, box);
            var yTp = pinnedLevelY(entry, pos.tp, box);
            var ySl = pinnedLevelY(entry, pos.sl, box);
            var entryOff = Math.abs((yForPrice(entry, pos.entry) || 0) - yEntry) > 1;
            var tpOff = Math.abs((yForPrice(entry, pos.tp) || 0) - yTp) > 1;
            var slOff = Math.abs((yForPrice(entry, pos.sl) || 0) - ySl) > 1;
            if (x0 == null || yEntry == null || yTp == null || ySl == null) return;
            if (x1 == null) x1 = box.w;
            if (x1 < -20 || x0 > box.w + 20) return;
            var selected = pos.id === entry.selectedPosition;
            var long = pos.dir === 'long';
            var color = long ? '#22C55E' : '#EF4444';
            var top = Math.min(yEntry, yTp, ySl);
            var bottom = Math.max(yEntry, yTp, ySl);
            ctx.fillStyle = long ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)';
            ctx.fillRect(x0, top, Math.max(1, x1 - x0), Math.max(1, bottom - top));
            if (selected) {
                ctx.strokeStyle = 'rgba(245,196,0,0.65)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, bottom - top - 1));
            }
            function level(y, price, colorValue, dashed, label, offscreen) {
                if (y == null) return;
                ctx.strokeStyle = colorValue;
                ctx.lineWidth = 1.2;
                ctx.setLineDash(dashed ? [4, 3] : []);
                ctx.beginPath();
                ctx.moveTo(x0, y);
                ctx.lineTo(x1, y);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = '8.5px "JetBrains Mono", monospace';
                var text = label + ' ' + formatPrice(price, entry.precision) + (offscreen ? ' \u25B2' : '');
                var width = ctx.measureText(text).width + 8;
                var tx = Math.min(x1 + 4, box.w - width);
                ctx.fillStyle = 'rgba(9,11,14,0.9)';
                ctx.fillRect(tx, y - 7, width, 12);
                ctx.fillStyle = colorValue;
                ctx.fillText(text, tx + 4, y + 2);
                if (selected) handleDot(ctx, x0, y);
            }
            level(yEntry, pos.entry, '#F5C400', false, 'ENTRY', entryOff);
            level(yTp, pos.tp, '#22C55E', true, 'TP', tpOff);
            level(ySl, pos.sl, '#EF4444', true, 'SL', slOff);
            if (selected) {
                ctx.fillStyle = '#F5C400';
                ctx.fillRect(x1 - 1, top, 3, Math.max(2, bottom - top));
            }
            if (selected) {
                var stats = positionStats(entry, pos);
                var lines = [
                    (long ? 'LONG' : 'SHORT') + '  ' + pos.entry.toFixed(entry.precision),
                    'R/R ' + stats.rr.toFixed(2),
                    'Qty ' + compactNumber(stats.qty),
                    'Margin ' + compactNumber(stats.margin),
                    'Risk ' + compactNumber(stats.risk),
                    'Reward ' + compactNumber(stats.reward)
                ];
                var cardW = 132, cardH = lines.length * 13 + 12;
                var cardX = Math.min(Math.max(x0 + 8, 8), box.w - cardW - 8);
                var cardY = Math.max(8, Math.min(yEntry - cardH - 10, box.h - cardH - 10));
                ctx.fillStyle = 'rgba(14,17,22,0.95)';
                ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                ctx.fillRect(cardX, cardY, cardW, cardH);
                ctx.strokeRect(cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1);
                ctx.font = '9px "JetBrains Mono", monospace';
                ctx.fillStyle = color;
                ctx.fillText(lines[0], cardX + 8, cardY + 13);
                ctx.fillStyle = '#A6ADB8';
                for (var i = 1; i < lines.length; i++) {
                    ctx.fillText(lines[i], cardX + 8, cardY + 13 + i * 13);
                }
            }
        });
    }

    function drawPositionDraft(entry, ctx, box) {
        var draft = entry.posDraft;
        if (!draft) return;
        var long = draft.dir === 'long';
        var target = draft.current;
        var sl = long ? draft.entry - (target - draft.entry) : draft.entry + (draft.entry - target);
        var x0 = xForTime(entry, draft.time);
        var x1 = xForTime(entry, draft.currentTime || draft.time);
        var yEntry = yForPrice(entry, draft.entry);
        var yTp = yForPrice(entry, target);
        var ySl = yForPrice(entry, sl);
        if (x0 == null || yEntry == null || yTp == null || ySl == null) return;
        if (x1 == null || x1 < x0) x1 = x0 + 80;
        var color = long ? '#22C55E' : '#EF4444';
        ctx.fillStyle = long ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        ctx.fillRect(x0, Math.min(yEntry, yTp, ySl), Math.max(1, x1 - x0),
            Math.max(1, Math.abs(ySl - yTp)));
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 3]);
        [yEntry, yTp, ySl].forEach(function (y) {
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        });
        ctx.setLineDash([]);
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillStyle = color;
        ctx.fillText(long ? 'LONG' : 'SHORT', x0 + 5, Math.min(yEntry, yTp) - 6);
        ctx.fillStyle = '#F5C400';
        ctx.fillText('ENTRY ' + formatPrice(draft.entry, entry.precision), x0 + 5, yEntry - 3);
    }

    function drawMeasure(entry, ctx, box) {
        var measure = entry.measure;
        if (!measure || !measure.start || !measure.end) return;
        var x0 = xForTime(entry, measure.start.time);
        var x1 = xForTime(entry, measure.end.time);
        var y0 = yForPrice(entry, measure.start.price);
        var y1 = yForPrice(entry, measure.end.price);
        if (x0 == null || x1 == null || y0 == null || y1 == null) return;
        var up = measure.end.price >= measure.start.price;
        var color = up ? '#22C55E' : '#EF4444';
        ctx.fillStyle = up ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)';
        ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        handleDot(ctx, x0, y0);
        handleDot(ctx, x1, y1);
        var delta = measure.end.price - measure.start.price;
        var pct = measure.start.price ? delta / measure.start.price * 100 : 0;
        var bars = Math.round((measure.end.time - measure.start.time) / barSeconds(entry.config.timeframe));
        var text = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%  ' +
            (delta >= 0 ? '+' : '') + formatPrice(delta, entry.precision) + '  ' + bars + ' bars';
        ctx.font = '9.5px "JetBrains Mono", monospace';
        var width = ctx.measureText(text).width + 12;
        var tx = Math.min((x0 + x1) / 2 + 8, box.w - width - 8);
        var ty = Math.max(10, Math.min((y0 + y1) / 2 - 10, box.h - 14));
        ctx.fillStyle = 'rgba(14,17,22,0.94)';
        ctx.fillRect(tx, ty - 10, width, 16);
        ctx.fillStyle = color;
        ctx.fillText(text, tx + 6, ty + 1);
    }

    function hitTestPosition(entry, x, y) {
        for (var i = entry.positions.length - 1; i >= 0; i--) {
            var pos = entry.positions[i];
            var x0 = xForTime(entry, pos.startTime);
            var x1 = xForTime(entry, pos.endTime);
            if (x0 == null) continue;
            if (x1 == null) x1 = plotBox(entry).w;
            if (x < x0 - 6 || x > x1 + 8) continue;
            if (Math.abs(x - x1) <= 7) return { pos: pos, type: 'end' };
            var levels = [['entry', pos.entry], ['tp', pos.tp], ['sl', pos.sl]];
            for (var j = 0; j < levels.length; j++) {
                var levelY = pinnedLevelY(entry, levels[j][1], plotBox(entry));
                if (levelY != null && Math.abs(y - levelY) <= 6) {
                    return { pos: pos, type: levels[j][0] };
                }
            }
            var yEntry = pinnedLevelY(entry, pos.entry, plotBox(entry));
            var yTp = pinnedLevelY(entry, pos.tp, plotBox(entry));
            var ySl = pinnedLevelY(entry, pos.sl, plotBox(entry));
            if (yEntry != null && yTp != null && ySl != null) {
                var top = Math.min(yEntry, yTp, ySl);
                var bottom = Math.max(yEntry, yTp, ySl);
                if (y >= top && y <= bottom) return { pos: pos, type: 'body' };
            }
        }
        return null;
    }

    function commitPosition(entry, draft) {
        var dir = draft.dir;
        var entryPrice = draft.entry;
        var target = draft.current;
        var valid = dir === 'long' ? target > entryPrice : target < entryPrice;
        var sl;
        if (!valid || Math.abs(target - entryPrice) < entryPrice * 1e-6) {
            var riskPct = 0.005;
            target = dir === 'long' ? entryPrice * 1.01 : entryPrice * 0.99;
            sl = dir === 'long' ? entryPrice * (1 - riskPct) : entryPrice * (1 + riskPct);
        } else {
            sl = dir === 'long' ? entryPrice - (target - entryPrice) : entryPrice + (entryPrice - target);
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
        var pos = {
            id: 'p-' + Math.random().toString(36).slice(2, 9),
            dir: dir,
            entry: entryPrice,
            tp: target,
            sl: sl,
            startTime: draft.time,
            endTime: draft.time + barSec * bars
        };
        entry.positions.push(pos);
        entry.selectedPosition = pos.id;
        entry.selectedDrawing = null;
        savePositions(entry);
        notifyPosition(entry, pos);
        renderDrawings(entry);
        return pos;
    }

    /**
     * Move an existing drawing by the pointer delta.  Time/price origins are
     * kept in data space, so the shape stays anchored while the chart pans or
     * zooms.  hline/vline only move along their own axis.
     */
    function moveDrawingDrag(entry, x, y) {
        var drag = entry.drawingDrag;
        if (!drag) return;
        var t1 = timeForX(entry, drag.startX);
        var t2 = timeForX(entry, x);
        var p1 = priceForY(entry, drag.startY);
        var p2 = priceForY(entry, y);
        var dt = (t1 != null && t2 != null) ? t2 - t1 : 0;
        var dp = (p1 != null && p2 != null) ? p2 - p1 : 0;
        var d = drag.drawing;
        d.points.forEach(function (point, idx) {
            var origin = drag.points[idx] || point;
            if (d.tool === 'hline') {
                point.price = origin.price + dp;
            } else if (d.tool === 'vline') {
                point.time = origin.time + dt;
            } else {
                point.time = origin.time + dt;
                point.price = origin.price + dp;
            }
        });
        renderDrawings(entry);
    }

    function updatePositionDrag(entry, x, y) {
        var drag = entry.positionDrag;
        if (!drag) return;
        var pos = drag.pos;
        var orig = drag.orig;
        var dragPrice = priceForY(entry, y);
        if (drag.type === 'body') {
            var oldTime = timeForX(entry, drag.startX);
            var newTime = timeForX(entry, x);
            var oldPrice = priceForY(entry, drag.startY);
            if (oldTime != null && newTime != null && oldPrice != null && dragPrice != null) {
                var dt = newTime - oldTime;
                var dp = dragPrice - oldPrice;
                pos.startTime = orig.startTime + dt;
                pos.endTime = orig.endTime + dt;
                pos.entry = Math.max(1e-9, orig.entry + dp);
                pos.tp = Math.max(1e-9, orig.tp + dp);
                pos.sl = Math.max(1e-9, orig.sl + dp);
            }
        } else if (drag.type === 'end') {
            var endTime = timeForX(entry, x);
            if (endTime != null) pos.endTime = Math.max(pos.startTime + barSeconds(entry.config.timeframe), endTime);
        } else if (dragPrice != null) {
            if (drag.type === 'entry') pos.entry = dragPrice;
            else if (drag.type === 'tp') pos.tp = dragPrice;
            else if (drag.type === 'sl') pos.sl = dragPrice;
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

    function endDrawingDrag(entry) {
        if (!entry.drawingDrag) return;
        entry.drawingDrag = null;
        scheduleSave();
        renderDrawings(entry);
    }

    function wireDrawingCanvas(entry) {
        var canvas = entry.drawCanvas;
        var dragging = null;

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
                entry.measure = { start: { time: time, price: price }, end: { time: time, price: price } };
                renderDrawings(entry);
                return;
            }
            if (entry.drawTool === 'select') {
                var posHit = hitTestPosition(entry, x, y);
                if (posHit) {
                    entry.selectedPosition = posHit.pos.id;
                    entry.selectedDrawing = null;
                    entry.positionDrag = {
                        pos: posHit.pos,
                        type: posHit.type,
                        startX: x,
                        startY: y,
                        orig: clone(posHit.pos)
                    };
                    notifyPosition(entry, posHit.pos);
                    renderDrawings(entry);
                    return;
                }
                entry.selectedPosition = null;
                var hit = hitTest(entry, x, y);
                entry.selectedDrawing = hit ? hit.id : null;
                if (hit) {
                    entry.drawingDrag = {
                        drawing: hit,
                        startX: x,
                        startY: y,
                        points: clone(hit.points)
                    };
                }
                renderDrawings(entry);
                return;
            }
            if (entry.drawTool === 'hline') {
                addDrawing(entry, { tool: 'hline', points: [{ time: 0, price: price }] });
                finishDrawing(entry);
                return;
            }
            if (entry.drawTool === 'vline') {
                addDrawing(entry, { tool: 'vline', points: [{ time: time, price: 0 }] });
                finishDrawing(entry);
                return;
            }
            if (entry.drawTool === 'text') {
                openTextEditor(entry, x, y, time, price);
                return;
            }
            dragging = {
                tool: entry.drawTool,
                start: { time: time, price: price },
                current: { time: time, price: price }
            };
            entry.drawPreview = { id: 'preview', tool: entry.drawTool, points: [dragging.start, dragging.current], color: '#F5C400' };
            renderDrawings(entry);
            void dragging;
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
            if (entry.measure) {
                var measureTime = timeForX(entry, x);
                var measurePrice = priceForY(entry, y);
                if (measureTime != null && measurePrice != null) {
                    entry.measure.end = { time: measureTime, price: measurePrice };
                }
                renderDrawings(entry);
                return;
            }
            if (entry.positionDrag) {
                updatePositionDrag(entry, x, y);
                return;
            }
            if (entry.drawingDrag) {
                moveDrawingDrag(entry, x, y);
                return;
            }
            if (dragging && dragging.tool) {
                var t2 = timeForX(entry, x);
                var p2 = priceForY(entry, y);
                if (t2 == null || p2 == null) return;
                dragging.current = { time: t2, price: p2 };
                entry.drawPreview = {
                    id: 'preview', tool: dragging.tool,
                    points: [dragging.start, dragging.current], color: '#F5C400'
                };
                renderDrawings(entry);
            }
        });

        canvas.addEventListener('pointerup', function (ev) {
            if (!entry.drawTool) return;
            if (entry.posDraft) {
                commitPosition(entry, entry.posDraft);
                entry.posDraft = null;
                finishDrawing(entry);
                return;
            }
            if (entry.measure) {
                finishDrawing(entry);
                return;
            }
            if (entry.positionDrag) {
                endPositionDrag(entry);
                return;
            }
            if (entry.drawingDrag) {
                endDrawingDrag(entry);
                return;
            }
            if (dragging && dragging.tool) {
                var rect = canvas.getBoundingClientRect();
                var x = ev.clientX - rect.left;
                var y = ev.clientY - rect.top;
                var p2 = priceForY(entry, y);
                var t2 = timeForX(entry, x);
                if (p2 != null && t2 != null && (Math.abs(x - (xForTime(entry, dragging.start.time) || 0)) > 3 || Math.abs(y - (yForPrice(entry, dragging.start.price) || 0)) > 3)) {
                    addDrawing(entry, {
                        tool: dragging.tool,
                        points: [dragging.start, { time: t2, price: p2 }]
                    });
                }
                entry.drawPreview = null;
                dragging = null;
                finishDrawing(entry);
                return;
            }
            dragging = null;
        });

        canvas.addEventListener('pointercancel', function () {
            dragging = null;
            entry.drawPreview = null;
            entry.posDraft = null;
            entry.positionDrag = null;
            entry.drawingDrag = null;
            renderDrawings(entry);
        });

        // Price-axis drags and wheel zoom have no LWC subscription; keep the
        // overlay in lockstep while the pointer is down or wheel is used.
        var host = entry.host;
        var onHostDown = function () { entry.allowBackfill = true; startDrawSync(entry); };
        var onDocUp = function () { stopDrawSync(entry); };
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

        // In cursor mode the overlay is click-through, yet drawings and
        // positions must still be selectable/movable directly.  Intercept the
        // host pointerdown only when something is actually hit; otherwise the
        // event reaches Lightweight Charts for pan/zoom as usual.
        var directMove = null;
        var directUp = null;
        var hostPoint = function (ev) {
            var rect = canvas.getBoundingClientRect();
            return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        };
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
                if (entry.drawingDrag) endDrawingDrag(entry);
            }
            entry.positionDrag = null;
            entry.drawingDrag = null;
            entry.drawCanvas.classList.remove('active');
            entry.panel.classList.remove('drawing');
            renderDrawings(entry);
        };
        var onHostSelect = function (ev) {
            if ((entry.drawTool && entry.drawTool !== 'select') || ev.button !== 0) return;
            if (entry.config.drawings.length === 0 && entry.positions.length === 0) return;
            var point = hostPoint(ev);
            var posHit = hitTestPosition(entry, point.x, point.y);
            var shapeHit = posHit ? null : hitTest(entry, point.x, point.y);
            if (!posHit && !shapeHit) return;
            ev.preventDefault();
            ev.stopPropagation();
            try { host.setPointerCapture(ev.pointerId); entry.directPointerId = ev.pointerId; }
            catch (err) { /* synthetic pointers */ }
            focusChart(entry);
            entry.drawCanvas.classList.add('active');
            entry.panel.classList.add('drawing');
            entry.selectedDrawing = null;
            entry.selectedPosition = null;
            if (posHit) {
                entry.selectedPosition = posHit.pos.id;
                entry.positionDrag = {
                    pos: posHit.pos,
                    type: posHit.type,
                    startX: point.x,
                    startY: point.y,
                    orig: clone(posHit.pos)
                };
                notifyPosition(entry, posHit.pos);
            } else {
                entry.selectedDrawing = shapeHit.id;
                entry.drawingDrag = {
                    drawing: shapeHit,
                    startX: point.x,
                    startY: point.y,
                    points: clone(shapeHit.points)
                };
            }
            renderDrawings(entry);
            directMove = function (moveEv) {
                moveEv.preventDefault();
                var p = hostPoint(moveEv);
                if (entry.positionDrag) updatePositionDrag(entry, p.x, p.y);
                else if (entry.drawingDrag) moveDrawingDrag(entry, p.x, p.y);
            };
            directUp = function () {
                if (entry.positionDrag) endPositionDrag(entry);
                if (entry.drawingDrag) endDrawingDrag(entry);
                clearDirect();
            };
            document.addEventListener('pointermove', directMove);
            document.addEventListener('pointerup', directUp);
            document.addEventListener('pointercancel', directUp);
        };
        var onHostHover = function (ev) {
            if (entry.drawTool && entry.drawTool !== 'select') return;
            if (entry.config.drawings.length === 0 && entry.positions.length === 0) {
                entry.host.style.cursor = '';
                return;
            }
            var point = hostPoint(ev);
            var hit = hitTestPosition(entry, point.x, point.y) || hitTest(entry, point.x, point.y);
            entry.host.style.cursor = hit ? 'move' : '';
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
            if (entry.pricePan) endPricePan();
            if (entry.positionDrag || entry.drawingDrag || entry.directPointerId != null) return;
            var point = hostPoint(ev);
            var box = plotBox(entry);
            if (!box.w || box.h < 20 || !entry.mainSeries) return;
            // Leave the axes to LWC's own scale handling.  A price-axis
            // gesture switches to a manual scale, so drop the frozen window.
            if (point.x >= box.w - 2) { clearPanBase(entry); return; }
            if (point.y >= box.h - 2) return;
            entry.pricePan = { startX: point.x, startY: point.y, lastY: point.y, active: false };
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
            if (point.x >= plotBox(entry).w - 2) resetPricePan(entry);
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

    function addDrawing(entry, drawing) {
        var id = 'd-' + Math.random().toString(36).slice(2, 9);
        var record = {
            id: id,
            tool: drawing.tool,
            points: drawing.points,
            color: '#A1A1AA',
            text: drawing.text || ''
        };
        entry.config.drawings.push(record);
        entry.selectedDrawing = id;
        renderDrawings(entry);
        scheduleSave();
        return record;
    }

    function finishDrawing(entry) {
        entry.drawPreview = null;
        var keepPosition = entry.selectedPosition;
        var keepDrawing = entry.selectedDrawing;
        setDrawTool(entry, null);
        // A just-created position/drawing stays selected so its stats and
        // handles are immediately editable (TradingView behaviour).
        entry.selectedPosition = keepPosition;
        entry.selectedDrawing = keepDrawing;
        renderDrawings(entry);
    }

    function openTextEditor(entry, x, y, time, price) {
        entry.pendingText = { time: time, price: price };
        var ed = entry.textEditor;
        ed.style.left = Math.max(4, x) + 'px';
        ed.style.top = Math.max(4, y - 28) + 'px';
        ed.classList.add('show');
        entry.textInput.value = '';
        entry.textInput.focus();
    }

    function commitTextDrawing(entry) {
        if (!entry.pendingText) return;
        var text = entry.textInput.value.trim();
        if (text) {
            addDrawing(entry, {
                tool: 'text',
                points: [{ time: entry.pendingText.time, price: entry.pendingText.price }],
                text: text
            });
        }
        cancelTextDrawing(entry);
        finishDrawing(entry);
    }

    function cancelTextDrawing(entry) {
        entry.pendingText = null;
        entry.textEditor.classList.remove('show');
        entry.textInput.value = '';
    }

    function hitTest(entry, x, y) {
        var drawings = entry.config.drawings || [];
        for (var i = drawings.length - 1; i >= 0; i--) {
            var d = drawings[i];
            if (hitShape(entry, d, x, y)) return d;
        }
        return null;
    }

    function hitShape(entry, d, x, y) {
        var p0 = d.points && d.points[0];
        if (!p0) return false;
        if (d.tool === 'hline') {
            var y0 = yForPrice(entry, p0.price);
            return y0 != null && Math.abs(y - y0) < 6;
        }
        if (d.tool === 'vline') {
            var x0 = xForTime(entry, p0.time);
            return x0 != null && Math.abs(x - x0) < 6;
        }
        if (d.tool === 'text') {
            var tx = xForTime(entry, p0.time);
            var ty = yForPrice(entry, p0.price);
            return tx != null && ty != null && x >= tx - 2 && x <= tx + 130 && y >= ty - 16 && y <= ty + 4;
        }
        var p1 = d.points[1];
        if (!p1) return false;
        var x1 = xForTime(entry, p0.time), y1 = yForPrice(entry, p0.price);
        var x2 = xForTime(entry, p1.time), y2 = yForPrice(entry, p1.price);
        if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
        if (d.tool === 'trend') return distanceToSegment(x, y, x1, y1, x2, y2) < 6;
        if (d.tool === 'rect') {
            var left = Math.min(x1, x2), right = Math.max(x1, x2);
            var top = Math.min(y1, y2), bottom = Math.max(y1, y2);
            return (x >= left && x <= right && y >= top && y <= bottom);
        }
        if (d.tool === 'fib') {
            if (x < Math.min(x1, x2) - 4 || x > Math.max(x1, x2) + 40) return false;
            var levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            return levels.some(function (level) {
                var ly = y1 + (y2 - y1) * level;
                return Math.abs(y - ly) < 5;
            });
        }
        return false;
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
        if (entry.selectedPosition) {
            entry.positions = entry.positions.filter(function (p) { return p.id !== entry.selectedPosition; });
            entry.selectedPosition = null;
            savePositions(entry);
            renderDrawings(entry);
            return;
        }
        if (!entry.selectedDrawing) return;
        entry.config.drawings = entry.config.drawings.filter(function (d) { return d.id !== entry.selectedDrawing; });
        entry.selectedDrawing = null;
        renderDrawings(entry);
        scheduleSave();
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

    function scheduleSave() {
        clearTimeout(WS.saveTimer);
        WS.saveTimer = setTimeout(saveNow, 650);
    }

    function saveNow() {
        if (!WS.store || WS.shuttingDown) return;
        var payload = serialize();
        if (!payload) return;
        if (WS.saving) { WS.saveQueued = true; return; }
        WS.saving = true;
        setStatus('Saving…', 'saving');
        Bridge.call('saveStore', [JSON.stringify(payload)]).then(function (res) {
            // Keep the in-memory store as the source of truth: chart entries hold
            // references to its config objects, so replacing it would orphan them.
            if (res && res.ok !== false) {
                setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            } else {
                setStatus('Save failed', 'error');
                toast((res && res.error) || 'Could not save workspace', true);
            }
        }).catch(function (err) {
            setStatus('Save failed', 'error');
            toast(err.message || 'Could not save workspace', true);
        }).finally(function () {
            WS.saving = false;
            if (WS.saveQueued) { WS.saveQueued = false; saveNow(); }
        });
    }

    /* ── Workspace switching ─────────────────────────────────────────────── */

    function renderWorkspaceSelect() {
        var sel = $('#ws-select');
        sel.innerHTML = '';
        WS.store.workspaces.forEach(function (ws) {
            var opt = el('option', '', ws.name);
            opt.value = ws.id;
            sel.appendChild(opt);
        });
        sel.value = WS.activeId;
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
        renderWorkspaceSelect();
        renderGroupChips();
        renderDrawer();
        syncTopbar(ws);
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
        openPrompt('New workspace', 'Workspace ' + (WS.store.workspaces.length + 1), function (name) {
            var ws = blankWorkspace(name);
            WS.store.workspaces.push(ws);
            WS.activeId = ws.id;
            loadWorkspace(ws.id);
            saveNow();
        });
    }

    function blankWorkspace(name) {
        var template = deepCloneTemplate();
        template.id = 'ws-' + Math.random().toString(36).slice(2, 10);
        template.name = name;
        template.charts = [];
        var defaults = cloneIndicatorDefaults();
        for (var i = 0; i < 4; i++) {
            var slot = DEFAULT_SLOTS[i];
            template.charts.push({
                id: 'c' + (i + 1),
                exchange: slot[0], market: 'spot', symbol: slot[1], timeframe: slot[2],
                chartType: 'candlestick',
                priceScaleMode: 'independent',
                referenceMode: 'first_visible',
                referenceTime: null,
                indicators: clone(defaults),
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
                { id: 'g-red', name: 'Group A', color: '#FF5A3C', enabled: true, settings: clone(baseSettings) },
                { id: 'g-blue', name: 'Group B', color: '#2962FF', enabled: true, settings: clone(baseSettings) }
            ],
            globalSettings: baseSettings,
            updatedAt: Date.now()
        };
    }

    function deleteWorkspace() {
        if (WS.store.workspaces.length <= 1) { toast('The last workspace cannot be deleted', true); return; }
        var ws = activeWorkspace();
        openPrompt('Delete “' + ws.name + '”? Type the name to confirm', '', function (value) {
            if (value !== ws.name) { toast('Name did not match', true); return; }
            WS.store.workspaces = WS.store.workspaces.filter(function (w) { return w.id !== ws.id; });
            WS.activeId = WS.store.workspaces[0].id;
            loadWorkspace(WS.activeId);
            saveNow();
        });
    }

    /* ── Top-level UI wiring ─────────────────────────────────────────────── */

    function wireShell() {
        buildLayoutSwitch();
        $('#ws-select').addEventListener('change', function (ev) {
            saveNow();
            loadWorkspace(ev.target.value);
        });
        $('#ws-new').addEventListener('click', newWorkspace);
        $('#ws-rename').addEventListener('click', function () {
            var ws = activeWorkspace();
            openPrompt('Rename workspace', ws.name, function (name) {
                ws.name = name;
                renderWorkspaceSelect();
                saveNow();
            });
        });
        $('#ws-delete').addEventListener('click', deleteWorkspace);
        $('#btn-add-chart').addEventListener('click', addChart);
        $('#btn-save').addEventListener('click', saveNow);
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
        }, true);

        document.addEventListener('keydown', function (ev) {
            var inField = ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA');
            if (ev.key === 'Escape') {
                if (WS.modal) { closeModal(); return; }
                if (WS.menu) { closeMenu(); return; }
                if ($('#ws-drawer').classList.contains('open')) { closeDrawer(); return; }
                var focused = WS.charts[WS.focused];
                if (focused && focused.drawTool) setDrawTool(focused, null);
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
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(function () { /* ignore */ });
        } else if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(function (err) {
                toast('Fullscreen unavailable: ' + err.message, true);
            });
        }
    }

    function updateFullscreenIcon() {
        var btn = $('#btn-fullscreen');
        if (!btn) return;
        btn.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen (F11)';
        btn.setAttribute('aria-pressed', String(!!document.fullscreenElement));
    }

    /* ── Boot ────────────────────────────────────────────────────────────── */

    WS.boot = function () {
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
                return Bridge.call('indicatorConfig').then(function (res) {
                    WS.indicatorConfig = (res && res.config) || {};
                    return true;
                }).catch(function () { return true; });
            }).then(function (ready) {
                if (!ready) return;
                WS.activeId = WS.store.active || WS.store.workspaces[0].id;
                wireShell();
                loadWorkspace(WS.activeId);
                setStatus('Ready');
                window.addEventListener('beforeunload', function () { try { saveNow(); } catch (e) { } });
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
            try { saveNow(); } catch (err) { /* ignore */ }
            return;
        }
        Object.keys(WS.charts).forEach(function (id) {
            startPolling(WS.charts[id], 250);
        });
        if (WS.sync) WS.sync.schedulePriceScaleRefresh();
    };

    WS.shutdown = function () {
        try { saveNow(); } catch (err) { /* ignore */ }
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
        sma: sma, ema: ema, rsi: rsiSeries, macd: macdSeries, atr: atrSeries,
        vwap: vwapSeries, nearestCandle: nearestCandle, detectPrecision: detectPrecision,
        applyGridTemplate: applyGridTemplate, customGridFor: customGridFor,
        layouts: LAYOUTS, timeframes: TIMEFRAMES
    };

    document.addEventListener('DOMContentLoaded', function () { WS.boot(); });
})();
