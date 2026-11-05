/**
 * Tauri compatibility adapter for the chart workspace.
 *
 * Loaded before workspace.js in every host. When the page is embedded in the
 * TradePanel shell's iframe (Tauri WebView) it exposes a QWebChannel-shaped
 * stub on `window.__WS_STUB__`, so `workspace.js` runs unmodified. In the
 * legacy Qt app (parent === window) it does nothing and QWebChannel is used.
 *
 * Transport: same-origin postMessage envelopes understood by
 * `frontend/src/workspace-host.ts`. No QWebChannel or Tauri API is required
 * inside the workspace frame.
 */
(function () {
    'use strict';

    var parentFrame = window.parent;
    if (!parentFrame || parentFrame === window) return;
    if (window.__WS_STUB__) return;
    if (typeof window.postMessage !== 'function') return;

    var ORIGIN = window.location.origin && window.location.origin !== 'null'
        ? window.location.origin
        : '*';
    var REQUEST_TIMEOUT_MS = 30000;
    var seq = 0;
    var pending = Object.create(null);
    var dataHandlers = [];
    var hostQueue = [];
    var readySent = false;
    var booting = true;

    function post(message) {
        try {
            parentFrame.postMessage(message, ORIGIN);
        } catch (err) {
            console.error('Tauri bridge post failed', err);
        }
    }

    function emit(event, payload) {
        post({ __ws: 1, type: 'event', event: event, payload: payload });
    }

    function stringify(value) {
        try { return JSON.stringify(value); }
        catch (err) { return JSON.stringify({ ok: false, error: 'Unserialisable bridge payload' }); }
    }

    function settle(id, ok, result, error) {
        var entry = pending[id];
        if (!entry) return;
        delete pending[id];
        clearTimeout(entry.timer);
        var payload = ok ? result : { ok: false, error: error || 'Request failed' };
        if (entry.reqId !== null && entry.reqId !== undefined && dataHandlers.length) {
            var text = stringify(payload);
            dataHandlers.slice().forEach(function (handler) {
                try { handler(entry.reqId, text); }
                catch (err) { console.error('dataReady handler failed', err); }
            });
            return;
        }
        if (entry.callback) {
            try { entry.callback(stringify(payload)); }
            catch (err) { console.error('bridge callback failed', err); }
        }
    }

    function call(method, args, callback, reqId) {
        var id = ++seq;
        var timer = setTimeout(function () {
            settle(id, false, null, 'Request timed out');
        }, REQUEST_TIMEOUT_MS);
        pending[id] = {
            callback: callback,
            reqId: reqId === undefined ? null : reqId,
            timer: timer
        };
        post({ __ws: 1, type: 'rpc', id: id, method: method, args: args || [] });
    }

    function wsCall(name, args) {
        if (window.WS && typeof window.WS[name] === 'function') {
            try { window.WS[name].apply(window.WS, args || []); }
            catch (err) { console.error('WS.' + name + ' failed', err); }
            return;
        }
        hostQueue.push([name, args || []]);
    }

    var stub = {
        on: function (event, handler) {
            if (event === 'dataReady' && typeof handler === 'function') {
                dataHandlers.push(handler);
            }
        },

        /* QWebChannel-style synchronous methods (callback last). */
        meta: function (cb) { call('meta', [], cb); },
        loadStore: function (cb) { call('loadStore', [], cb); },
        saveStore: function (payload, cb) { call('saveStore', [payload], cb); },
        indicatorConfig: function (cb) { call('indicatorConfig', [], cb); },
        credentialStatus: function (cb) { call('credentialStatus', [], cb); },
        saveCredentials: function (payload, cb) { call('saveCredentials', [payload], cb); },

        /* Async requests correlated through the synthetic dataReady signal. */
        requestCandles: function (reqId, exchange, market, symbol, timeframe, limit, endTime) {
            call('requestCandles', [exchange, market, symbol, timeframe, limit, endTime], null, reqId);
        },
        requestTick: function (reqId, exchange, market, symbol, timeframe) {
            call('requestTick', [exchange, market, symbol, timeframe], null, reqId);
        },
        requestIndicators: function (reqId, exchange, market, symbol, timeframe, flagsJson) {
            call('requestIndicators', [exchange, market, symbol, timeframe, flagsJson], null, reqId);
        },
        searchSymbols: function (reqId, exchange, market, query) {
            call('searchSymbols', [exchange, market, query], null, reqId);
        },

        /* JS → host signals. */
        onPositionDrawingChanged: function (direction, entry, tp, sl) {
            emit('positionDrawing', [direction, entry, tp, sl]);
        },
        onFocusedChartChanged: function (symbol, exchange, market, timeframe) {
            emit('focusedChart', [symbol, exchange, market, timeframe]);
        },
        onConfigRequested: function () {
            emit('configRequested', []);
        },
        toggleTopBar: function (cb) {
            emit('toggleTopBar', []);
            if (typeof cb === 'function') cb(stringify({ ok: true }));
        },
        toggleFullscreen: function (cb) {
            emit('toggleFullscreen', []);
            if (typeof cb === 'function') cb(stringify({ ok: true }));
        },
        debug: function (message) {
            emit('log', [String(message)]);
        }
    };

    window.__WS_STUB__ = stub;

    window.addEventListener('message', function (event) {
        if (event.source !== parentFrame) return;
        var data = event.data;
        if (!data || data.__ws !== 1) return;

        if (data.type === 'rpc-result') {
            settle(data.id, !!data.ok, data.result, data.error);
            return;
        }

        if (data.type === 'host') {
            var payload = data.payload === undefined ? [] : data.payload;
            var args = Array.isArray(payload) ? payload : [payload];
            if (data.cmd === 'setActive' && booting && args[0] === false) return;
            wsCall(data.cmd, args);
        }
    });

    document.addEventListener('fullscreenchange', function () {
        emit('fullscreen', [!!document.fullscreenElement]);
    });

    window.addEventListener('error', function (event) {
        emit('log', ['Unhandled workspace error: ' + (event.message || 'unknown')]);
    });
    window.addEventListener('unhandledrejection', function (event) {
        emit('log', ['Unhandled workspace rejection: ' + String(event.reason)]);
    });

    function announce() {
        if (readySent) return;
        if (window.WS && window.WS.store) {
            readySent = true;
            booting = false;
            emit('ready', []);
            while (hostQueue.length) {
                var item = hostQueue.shift();
                wsCall(item[0], item[1]);
            }
            return;
        }
        if (window.WS && window.WS.__bootFailed) {
            booting = false;
            emit('error', ['workspace boot failed']);
            return;
        }
        setTimeout(announce, 120);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(announce, 0); });
    } else {
        setTimeout(announce, 0);
    }
})();
