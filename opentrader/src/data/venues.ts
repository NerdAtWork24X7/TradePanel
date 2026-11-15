/*
 * The crypto venues the bundled plugins serve: the eight market-data exchanges and Hyperliquid,
 * whose perpetual futures account is the crypto plugin's broker. The Exchanges tab under the
 * charts lists them; a venue moves from Market data to Brokers once a broker plugin for it is
 * installed (Hyperliquid always has one, in the crypto plugin). The cards take their marks
 * from exchange-logos.ts.
 */
import type { Manifest, PluginInfo } from "../bindings";

export type Venue = {
  /** The exchange code the chart's symbols carry ("BINANCE:BTC/USDT"). */
  code: string;
  /** The venue's name as its brand writes it (not translated). */
  name: string;
};

/** In the order the symbol search lists them. */
export const CRYPTO_VENUES: readonly Venue[] = [
  { code: "BINANCE", name: "Binance" },
  { code: "BYBIT", name: "Bybit" },
  { code: "OKX", name: "OKX" },
  { code: "COINBASE", name: "Coinbase" },
  { code: "KRAKEN", name: "Kraken" },
  { code: "KUCOIN", name: "KuCoin" },
  { code: "GATEIO", name: "Gate.io" },
  { code: "BITGET", name: "Bitget" },
  { code: "HYPERLIQUID", name: "Hyperliquid" },
];

const BY_CODE = new Map(CRYPTO_VENUES.map((v) => [v.code, v]));

/** A venue by the code a plugin or a symbol names, or undefined for another market. */
export function venueByCode(code: string | null | undefined): Venue | undefined {
  return code ? BY_CODE.get(code.trim().toUpperCase()) : undefined;
}

/** The exchanges a plugin declares: its list (a plugin serving several), or its one. */
export function venueCodesOf(manifest: Pick<Manifest, "exchange" | "exchanges">): string[] {
  if (manifest.exchanges?.length) return manifest.exchanges.map((c) => c.toUpperCase());
  return manifest.exchange ? [manifest.exchange.toUpperCase()] : [];
}

/** The venue a broker plugin serves: the `exchange` its manifest names. A data plugin that
 *  spans several exchanges still sets it to the one venue its broker trades. */
export function brokerVenueCode(plugin: Pick<PluginInfo, "manifest">): string | undefined {
  const code = plugin.manifest.exchange?.trim().toUpperCase();
  if (code) return code;
  // A plugin written before `exchange` was set: one exchange in its list, one venue it serves.
  return plugin.manifest.exchanges?.length === 1 ? plugin.manifest.exchanges[0]!.toUpperCase() : undefined;
}

/** A broker plugin and the venue it serves (undefined for a broker of another market, or one whose
 *  manifest names no venue: Interactive Brokers, MetaTrader 5). */
export type BrokerEntry = { plugin: PluginInfo; venue?: Venue };

/** The broker plugins among the installed ones — what Trade > Connect broker… offers. */
export function brokerPluginsOf(plugins: readonly PluginInfo[]): BrokerEntry[] {
  const cards = plugins
    .filter((p) => p.manifest.provides.includes("broker"))
    .map((plugin) => {
      const card = brokerCard(plugin.manifest);
      return { plugin, venue: venueByCode(brokerVenueCode(plugin)), name: card.name, exchange: card.code };
    });
  // The picker's cards take the same order.
  return sortBrokerCards(cards).map(({ plugin, venue }) => ({ plugin, venue }));
}

/** Where a venue's card goes: the crypto catalog's order, and after it for a broker of another
 *  market (whose name then decides). */
export function venueRank(code: string | null | undefined): number {
  const index = code ? CRYPTO_VENUES.findIndex((v) => v.code === code.trim().toUpperCase()) : -1;
  return index < 0 ? CRYPTO_VENUES.length : index;
}

/** Cards in that order — Binance … Hyperliquid — whatever order their ids arrive in. */
export function sortBrokerCards<T extends { name: string; exchange?: string | null }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => {
    const byVenue = venueRank(a.exchange) - venueRank(b.exchange);
    if (byVenue) return byVenue;
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** A broker's card from its manifest alone: the venue it names (the crypto plugin's broker is Hyperliquid,
 *  whatever the plugin is called), with its mark's code, else the plugin's own name and initials. */
export function brokerCard(plugin: {
  name: string;
  exchange?: string | null;
  exchanges?: readonly string[];
}): { name: string; code?: string } {
  const code = plugin.exchange?.trim() || (plugin.exchanges?.length === 1 ? plugin.exchanges[0] : undefined);
  const venue = venueByCode(code);
  return venue ? { name: venue.name, code: venue.code } : { name: plugin.name };
}

/** The venue plugin serving a code (the crypto markets): the one the Exchanges tab configures. */
export function venuePluginOf(plugins: readonly PluginInfo[], code: string): PluginInfo | undefined {
  const wanted = code.trim().toUpperCase();
  return plugins.find((p) => isVenuePlugin(p) && venueCodesOf(p.manifest).includes(wanted));
}

/** The crypto venues still listed under Market data: those without a broker plugin on this computer.
 *  A venue with one moves to Brokers, where its account and settings are. */
export function marketDataVenues(plugins: readonly PluginInfo[]): Venue[] {
  const brokered = new Set(brokerPluginsOf(plugins).flatMap((entry) => (entry.venue ? [entry.venue.code] : [])));
  return CRYPTO_VENUES.filter((venue) => !brokered.has(venue.code));
}

/** A plugin that serves a list of exchanges (the crypto markets): the Exchanges tab configures it, and
 *  Settings > Plugins leaves its card out. A single-venue plugin (MetaTrader 5) keeps its card there, where its
 *  installation steps are. */
export function isVenuePlugin(plugin: Pick<PluginInfo, "manifest">): boolean {
  return (plugin.manifest.exchanges?.length ?? 0) > 0;
}
