/*
 * Exchanges — the bottom panel's tab for the venues and brokers. It lists every market-data exchange the crypto
 * plugin serves and every broker plugin on this computer, with the place to configure them: the venue plugin's
 * settings (Hyperliquid's network, wallet key, slippage and refresh) and its account manager live here, not in
 * Settings > Plugins, which leaves the venue plugin out (the account manager tab it had is gone).
 *
 * A venue whose broker plugin (its manifest `exchange`) is installed moves from Market data to Brokers: Hyperliquid
 * is there through the crypto plugin, and the ccxt broker plugins add Binance, Bybit, OKX, Gate.io, Bitget, KuCoin,
 * Coinbase and Kraken, one broker each. The cards' marks are the bundled exchange logos
 * (data/exchange-logos.ts); a broker without one (Interactive Brokers, MetaTrader 5) shows its initials. Selecting
 * a card fills the detail pane beside the list — below it in a narrow panel (styles/exchanges.css).
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PluginInfo, PluginsStatus } from "../../bindings";
import { CheckField } from "../../components/form";
import { exchangeLogoSrc } from "../../data/exchange-logos";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { brokerPluginsOf, marketDataVenues, venuePluginOf, type Venue } from "../../data/venues";
import { translate } from "../../i18n/translator";
import { openLink, plugins, type Result } from "../header/app-settings/io";
import { ConfirmButton } from "../header/app-settings/parts";
import { PluginSettings, SymbolMap } from "../header/app-settings/PluginsTab";
import { isTauri } from "../shell/window-bridge";
import { AccountManager } from "./AccountManager";

type Tone = "on" | "warn" | "off";
type State = { text: string; tone: Tone };
type Take = (what: string, p: Promise<Result<PluginsStatus>>) => Promise<boolean>;
type View = "list" | "account";

type VenueRow = { kind: "venue"; key: string; venue: Venue; plugin?: PluginInfo };
type BrokerRow = { kind: "broker"; key: string; venue?: Venue; plugin: PluginInfo };
type Row = VenueRow | BrokerRow;

/** What a venue's card says of it. */
function venueState(row: VenueRow): State {
  if (!isTauri()) return { text: translate("Desktop app only"), tone: "off" };
  const p = row.plugin;
  if (!p) return { text: translate("Not installed"), tone: "off" };
  if (!p.supported) return { text: translate("Does not run on this computer"), tone: "off" };
  if (!p.enabled) return { text: translate("Disabled"), tone: "off" };
  return p.connected ? { text: translate("Live"), tone: "on" } : { text: translate("Starting…"), tone: "warn" };
}

/** What a broker's card says: its account's state once connected, else how ready its plugin is. */
function brokerState(row: BrokerRow): State {
  if (!isTauri()) return { text: translate("Desktop app only"), tone: "off" };
  const p = row.plugin;
  if (!p.supported) return { text: translate("Does not run on this computer"), tone: "off" };
  if (!p.enabled) return { text: translate("Enable to trade"), tone: "off" };
  const id = p.manifest.id;
  const status = pluginBroker.status();
  if (status?.active === id) {
    return pluginBroker.connected()
      ? { text: translate("Connected"), tone: "on" }
      : { text: translate("Waiting for the plugin to connect"), tone: "warn" };
  }
  return p.connected ? { text: translate("Ready"), tone: "on" } : { text: translate("Starting…"), tone: "warn" };
}

/** A broker's venue name (Hyperliquid for the crypto plugin), its mark's code, or its own name. */
const rowName = (row: Row) => (row.kind === "broker" ? row.venue?.name ?? row.plugin.manifest.name : row.venue.name);

/** What a broker's card says of its market: the saved `market` setting, the manifest's default, else perpetuals. */
function brokerSub(row: BrokerRow): string {
  if (!row.venue) return translate("Broker plugin");
  const market =
    row.plugin.settings?.market ?? row.plugin.manifest.settings?.find((field) => field.key === "market")?.default;
  return market === "spot" ? translate("Spot") : translate("Perpetual futures");
}

function Logo(props: { code?: string; name: string; large?: boolean }) {
  const src = () => exchangeLogoSrc(props.code);
  const initials = () =>
    props.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  return (
    <Show
      when={src()}
      fallback={
        <span class={`ex-logo ex-logo-mark${props.large ? " is-large" : ""}`} aria-hidden="true">
          {initials()}
        </span>
      }
    >
      {(url) => <img class={`ex-logo${props.large ? " is-large" : ""}`} src={url()} alt="" loading="lazy" />}
    </Show>
  );
}

export function ExchangesPanel(props: { onSymbol: (symbol: string) => void; height: number; view: View; onView: (view: View) => void }) {
  const [status, setStatus] = createSignal<PluginsStatus | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [picked, setPicked] = createSignal<string | null>(null);

  const refresh = () => {
    if (!isTauri()) return;
    void plugins
      .status()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  };
  refresh();
  let unlisten: (() => void) | undefined;
  let disposed = false;
  if (isTauri()) void plugins.onChange(refresh).then((u) => (disposed ? u() : (unlisten = u)));
  onCleanup(() => {
    disposed = true;
    unlisten?.();
  });

  /** Runs a call that answers the new status; `what` marks the button busy meanwhile. */
  const take: Take = async (what, call) => {
    setBusy(what);
    setError(null);
    const r = await call;
    setBusy(null);
    if (r.status === "ok") setStatus(r.data);
    else setError(r.error);
    return r.status === "ok";
  };

  const installed = () => status()?.plugins ?? [];
  /** The plugins are known (the desktop app answers): no "not installed" flash while the call is out. */
  const loaded = () => !isTauri() || status() !== null || error() !== null;

  /** The venues still without a broker plugin here, under Market data. */
  const venueRows = createMemo<VenueRow[]>(() =>
    marketDataVenues(installed()).map((venue) => ({
      kind: "venue",
      key: `venue:${venue.code}`,
      venue,
      plugin: venuePluginOf(installed(), venue.code),
    })),
  );

  /** Every broker plugin installed: Hyperliquid (in the crypto plugin) and one per ccxt venue. */
  const brokerRows = createMemo<BrokerRow[]>(() =>
    brokerPluginsOf(installed()).map(({ plugin, venue }) => ({
      kind: "broker",
      key: `broker:${plugin.manifest.id}`,
      venue,
      plugin,
    })),
  );

  const rows = createMemo<Row[]>(() => [...venueRows(), ...brokerRows()]);
  const activeId = () => pluginBroker.status()?.active ?? null;
  /** The row the detail shows: the picked one, else the broker being traded, else the first enabled broker
   *  (what the tab is for), else any broker, else a venue. */
  const selection = createMemo<Row | null>(
    () =>
      rows().find((r) => r.key === picked()) ??
      rows().find((r) => r.kind === "broker" && r.plugin.manifest.id === activeId()) ??
      rows().find((r) => r.kind === "broker" && r.plugin.enabled) ??
      rows().find((r) => r.kind === "broker") ??
      rows()[0] ??
      null,
  );
  const venueRow = () => {
    const s = selection();
    return s?.kind === "venue" ? s : undefined;
  };
  const brokerRow = () => {
    const s = selection();
    return s?.kind === "broker" ? s : undefined;
  };

  const activeRow = () => brokerRows().find((r) => r.plugin.manifest.id === activeId());
  const activeName = () => activeRow()?.venue?.name ?? pluginBroker.status()?.activeName ?? "";
  const account = () => (activeId() ? pluginBroker.account()?.account ?? null : null);

  // A broker that left while its account showed: back to the list.
  createEffect(() => {
    if (!activeId() && props.view === "account") props.onView("list");
  });

  return (
    <div class="ex-panel" style={{ height: Number.isFinite(props.height) ? `${props.height}px` : "100%" }} data-name="exchanges-panel">
      <Show
        when={props.view === "account" && activeId()}
        fallback={
          <>
            <div class="ex-head">
              <div class="ex-head-text">
                <span class="ex-head-title">Exchanges and brokers</span>
                <span class="ex-head-sub">Market data is public. Trading goes through a broker.</span>
              </div>
              <Show when={activeId()}>
                <div class="ex-head-account">
                  <span class="ex-account-name" data-no-translate>{activeName()}</span>
                  <Show when={account()}>
                    {(acc) => (
                      <span class="trd-account-kind" classList={{ "is-live": !acc().isDemo }}>
                        {acc().isDemo ? "DEMO" : "LIVE"}
                      </span>
                    )}
                  </Show>
                  <button type="button" class="ex-btn" onClick={() => props.onView("account")}>
                    Account
                  </button>
                </div>
              </Show>
            </div>
            <div class="ex-body">
              <Show when={loaded()} fallback={<div class="ex-loading">Loading…</div>}>
                <div class="ex-groups">
                  <section class="ex-group">
                    <div class="ex-group-title">Brokers</div>
                    <div class="ex-cards">
                      <For
                        each={brokerRows()}
                        fallback={
                          <div class="ex-note">
                            {isTauri() ? translate("No broker plugin is installed.") : translate("Broker plugins run in the desktop app.")}
                          </div>
                        }
                      >
                        {(row) => {
                          const state = () => brokerState(row);
                          return (
                            <button
                              type="button"
                              class="ex-card"
                              classList={{ "is-selected": selection()?.key === row.key }}
                              aria-pressed={selection()?.key === row.key}
                              onClick={() => setPicked(row.key)}
                            >
                              <Logo code={row.venue?.code} name={rowName(row)} />
                              <span class="ex-card-text">
                                <span class="ex-card-name" data-no-translate>{rowName(row)}</span>
                                <span class="ex-card-sub">{brokerSub(row)}</span>
                                <span class={`ex-card-state is-${state().tone}`}>
                                  <span class={`ex-dot is-${state().tone}`} />
                                  {state().text}
                                </span>
                              </span>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </section>
                  <Show when={venueRows().length > 0}>
                    <section class="ex-group">
                      <div class="ex-group-title">Market data</div>
                      <div class="ex-cards">
                        <For each={venueRows()}>
                          {(row) => {
                            const state = () => venueState(row);
                            return (
                              <button
                                type="button"
                                class="ex-card"
                                classList={{ "is-selected": selection()?.key === row.key }}
                                aria-pressed={selection()?.key === row.key}
                                onClick={() => setPicked(row.key)}
                              >
                                <Logo code={row.venue.code} name={row.venue.name} />
                                <span class="ex-card-text">
                                  <span class="ex-card-name" data-no-translate>{row.venue.name}</span>
                                  <span class="ex-card-sub">Spot &amp; perpetuals</span>
                                  <span class={`ex-card-state is-${state().tone}`}>
                                    <span class={`ex-dot is-${state().tone}`} />
                                    {state().text}
                                  </span>
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </section>
                  </Show>
                  <Show when={error()}>{(e) => <div class="ex-error">{e()}</div>}</Show>
                </div>
                <aside class="ex-detail">
                  <Show when={venueRow()}>
                    {(row) => <VenueDetail row={row()} state={() => venueState(row())} busy={busy} take={take} />}
                  </Show>
                  <Show when={brokerRow()}>
                    {(row) => <BrokerDetail row={row()} busy={busy} take={take} />}
                  </Show>
                </aside>
              </Show>
            </div>
          </>
        }
      >
        <div class="ex-account">
          <div class="ex-account-bar">
            <button type="button" class="ex-back" onClick={() => props.onView("list")}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Exchanges
            </button>
            <span class="ex-account-name" data-no-translate>{activeName()}</span>
            <Show when={account()}>
              {(acc) => (
                <span class="trd-account-kind" classList={{ "is-live": !acc().isDemo }}>
                  {acc().isDemo ? "DEMO" : "LIVE"}
                </span>
              )}
            </Show>
          </div>
          <AccountManager onSymbol={props.onSymbol} height={props.height} fill />
        </div>
      </Show>
    </div>
  );
}

/** A market-data venue: its mark, its symbol prefix, and the plugin that serves it. Data needs no key. */
function VenueDetail(props: { row: VenueRow; state: () => State; busy: () => string | null; take: Take }) {
  const plugin = () => props.row.plugin;
  return (
    <div class="ex-detail-inner">
      <div class="ex-detail-head">
        <Logo code={props.row.venue.code} name={props.row.venue.name} large />
        <div class="ex-detail-id">
          <span class="ex-detail-name" data-no-translate>{props.row.venue.name}</span>
          <span class="ex-detail-code" data-no-translate>{props.row.venue.code}</span>
        </div>
      </div>
      <div class="ex-chips">
        <span class="ex-chip">Market data</span>
        <span class="ex-chip is-quiet">No key needed</span>
      </div>
      <p class="ex-detail-text">Public market data: spot and perpetual futures. No API key is needed.</p>
      <div class="ex-symbol">{`${props.row.venue.code}:BTC/USDT`}</div>
      <div class="ex-status">
        <span class={`ex-dot is-${props.state().tone}`} />
        {props.state().text}
        <Show when={plugin()}>
          {(p) => (
            <span class="ex-plugin-name" data-no-translate>
              {p().manifest.name} {p().manifest.version}
            </span>
          )}
        </Show>
      </div>
      <Show when={plugin()}>
        {(p) => (
          <Show when={!p().enabled && p().supported}>
            <div class="ex-actions">
              <button
                type="button"
                class="ex-primary"
                disabled={!!props.busy()}
                onClick={() => void props.take(`enable:${p().manifest.id}`, plugins.setEnabled(p().manifest.id, true))}
              >
                Enable
              </button>
            </div>
          </Show>
        )}
      </Show>
      <Show when={isTauri() && !plugin()}>
        <p class="ex-detail-text is-warn">The plugin serving this venue is not installed.</p>
      </Show>
    </div>
  );
}

/** A broker: its account (connect, disconnect, trading) and its plugin (settings, log, symbol mapping). */
function BrokerDetail(props: { row: BrokerRow; busy: () => string | null; take: Take }) {
  const plugin = () => props.row.plugin;
  const manifest = () => plugin().manifest;
  const active = () => pluginBroker.status()?.active === manifest().id;
  const [connecting, setConnecting] = createSignal(false);
  const [mapOpen, setMapOpen] = createSignal(false);
  const [logOpen, setLogOpen] = createSignal(false);
  const [logs, setLogs] = createSignal<string[]>([]);
  let logTimer: number | undefined;

  // The plugin's log, read again while it shows.
  createEffect(() => {
    window.clearInterval(logTimer);
    if (!logOpen() || !isTauri()) return;
    const load = () => void plugins.logs(manifest().id).then(setLogs).catch(() => {});
    load();
    logTimer = window.setInterval(load, 2000);
  });
  onCleanup(() => window.clearInterval(logTimer));

  const connect = async () => {
    setConnecting(true);
    // A broker plugin installed but left off: its program starts here, then the account arrives.
    const enabled = plugin().enabled || (await props.take(`enable:${manifest().id}`, plugins.setEnabled(manifest().id, true)));
    if (enabled) await pluginBroker.setActive(manifest().id);
    setConnecting(false);
    if (pluginBroker.status()?.active) tradingUi.showAccountManager();
  };
  const account = () => (active() ? pluginBroker.account()?.account ?? null : null);
  const state = () => brokerState(props.row);

  return (
    <div class="ex-detail-inner">
      <div class="ex-detail-head">
        <Logo code={props.row.venue?.code} name={rowName(props.row)} large />
        <div class="ex-detail-id">
          <span class="ex-detail-name" data-no-translate>{rowName(props.row)}</span>
          <span class="ex-detail-code">Broker</span>
        </div>
      </div>
      <div class="ex-status">
        <span class={`ex-dot is-${state().tone}`} />
        {state().text}
        <Show when={account()}>
          {(acc) => (
            <span class="trd-account-kind" classList={{ "is-live": !acc().isDemo }}>
              {acc().isDemo ? "DEMO" : "LIVE"}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.row.venue && !plugin().enabled}>
        <p class="ex-detail-text">
          Market data for this venue comes from the crypto plugin and needs no key: this broker being off stops
          trading only.
        </p>
      </Show>
      <Show
        when={active()}
        fallback={
          <div class="ex-actions">
            <button
              type="button"
              class="ex-primary"
              disabled={!plugin().supported || connecting()}
              onClick={() => void connect()}
            >
              {plugin().enabled ? "Connect" : "Enable & connect"}
            </button>
          </div>
        }
      >
        <div class="ex-actions">
          <button type="button" class="ex-primary" onClick={() => tradingUi.showAccountManager()}>
            Account manager
          </button>
          <button type="button" class="ex-btn" onClick={() => void pluginBroker.setActive(null)}>
            Disconnect the broker
          </button>
        </div>
        <div class="ex-trading">
          <CheckField
            variant="settings"
            label={translate("Trading")}
            checked={!!pluginBroker.status()?.tradingEnabled}
            onChange={(on) => void pluginBroker.setTradingEnabled(on)}
          />
          <Show when={!pluginBroker.status()?.tradingEnabled}>
            <span class="ex-note">Orders can't be placed until trading is on.</span>
          </Show>
        </div>
      </Show>
      <Show when={manifest().setup}>
        {(setup) => <div class="ex-setup" data-no-translate>{setup()}</div>}
      </Show>
      <Show when={(manifest().settings ?? []).length > 0}>
        <div class="ex-section-title">Settings</div>
        <PluginSettings plugin={plugin()} take={props.take} />
      </Show>
      <div class="ex-section-title">Plugin</div>
      <CheckField
        variant="settings"
        label={translate("Enabled")}
        disabled={!plugin().supported}
        checked={plugin().enabled}
        onChange={(on) => void props.take(`enable:${manifest().id}`, plugins.setEnabled(manifest().id, on))}
      />
      <div class="ex-links">
        <button type="button" class="ex-link" onClick={() => setLogOpen(!logOpen())}>
          {logOpen() ? "Hide log" : "Show log"}
        </button>
        <Show when={manifest().provides.includes("broker")}>
          <button type="button" class="ex-link" onClick={() => setMapOpen(!mapOpen())}>
            Symbols
          </button>
        </Show>
        <Show when={manifest().homepage}>
          {(url) => (
            <button type="button" class="ex-link" onClick={() => openLink(url(), "plugin homepage")}>
              Website
            </button>
          )}
        </Show>
        <ConfirmButton
          label={translate("New token")}
          confirmLabel={translate("The plugin connects again")}
          onConfirm={() => void props.take(`token:${manifest().id}`, plugins.newToken(manifest().id))}
        />
        <ConfirmButton
          label={translate("Remove")}
          confirmLabel={translate("Remove the plugin")}
          onConfirm={() => void props.take(`remove:${manifest().id}`, plugins.remove(manifest().id))}
        />
      </div>
      <Show when={logOpen()}>
        <pre class="ex-log" data-no-translate>{logs().join("\n") || "—"}</pre>
      </Show>
      <Show when={mapOpen()}>
        <SymbolMap plugin={plugin()} take={props.take} />
      </Show>
    </div>
  );
}
