import { describe, expect, it } from "vitest";
import type { Manifest, PluginInfo } from "../../bindings";
import { brokerCard, brokerPluginsOf, brokerVenueCode, CRYPTO_VENUES, isVenuePlugin, marketDataVenues, sortBrokerCards, venueByCode, venueCodesOf, venuePluginOf, venueRank } from "../venues";

const manifest = (extra: Partial<Manifest>): Manifest => ({
  id: "x",
  name: "X",
  version: "1.0.0",
  api: 2,
  provides: ["datafeed"],
  runtime: { type: "process", entry: "x", args: [] },
  ...extra,
});
const plugin = (m: Manifest): PluginInfo => ({
  manifest: m,
  verified: true,
  enabled: true,
  connected: false,
  running: false,
  connectedVersion: null,
  settings: {},
  secretKeys: [],
  copied: [],
  symbolMap: {},
  supported: true,
});

describe("the crypto venues", () => {
  it("names one venue per code", () => {
    const codes = CRYPTO_VENUES.map((v) => v.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(["BINANCE", "BYBIT", "OKX", "COINBASE", "KRAKEN", "KUCOIN", "GATEIO", "BITGET", "HYPERLIQUID"]);
  });

  it("finds a venue whatever the case and padding its code came with", () => {
    expect(venueByCode(" binance ")?.name).toBe("Binance");
    expect(venueByCode("gateio")?.name).toBe("Gate.io");
    expect(venueByCode("MT5")).toBeUndefined();
    expect(venueByCode(null)).toBeUndefined();
  });

  it("reads a plugin's exchanges, its one, or none", () => {
    expect(venueCodesOf({ exchanges: ["binance", "okx"] })).toEqual(["BINANCE", "OKX"]);
    expect(venueCodesOf({ exchange: "MT5" })).toEqual(["MT5"]);
    expect(venueCodesOf({})).toEqual([]);
  });

  it("finds the one venue a broker plugin serves", () => {
    expect(brokerVenueCode(plugin(manifest({ exchange: "binance" })))).toBe("BINANCE");
    // The crypto plugin spans nine exchanges but its broker is Hyperliquid's.
    expect(brokerVenueCode(plugin(manifest({ exchange: "HYPERLIQUID", exchanges: ["BINANCE", "HYPERLIQUID"] })))).toBe("HYPERLIQUID");
    expect(brokerVenueCode(plugin(manifest({})))).toBeUndefined();
  });

  it("tells a venue plugin (several exchanges) from a single-venue one", () => {
    expect(isVenuePlugin(plugin(manifest({ exchanges: ["BINANCE"] })))).toBe(true);
    expect(isVenuePlugin(plugin(manifest({ exchange: "MT5" })))).toBe(false);
    expect(isVenuePlugin(plugin(manifest({})))).toBe(false);
  });
});

describe("the Exchanges tab's two groups", () => {
  const brokerPlugin = (id: string, exchange: string | undefined, extra: Partial<Manifest> = {}) =>
    plugin(manifest({ id, name: id, provides: ["broker"], exchange, ...extra }));
  const venuePlugin = plugin(manifest({ id: "crypto", name: "Crypto", provides: ["datafeed", "broker"], exchange: "HYPERLIQUID", exchanges: ["BINANCE", "BYBIT", "HYPERLIQUID"] }));

  it("moves a venue to Brokers once its broker plugin is installed", () => {
    const plugins = [venuePlugin, brokerPlugin("binance", "BINANCE"), brokerPlugin("kraken", "KRAKEN")];
    const market = marketDataVenues(plugins).map((v) => v.code);
    expect(market).not.toContain("BINANCE");
    expect(market).not.toContain("KRAKEN");
    expect(market).not.toContain("HYPERLIQUID");
    expect(market).toContain("BYBIT");
    // The list reads the market catalog's order, not the plugin ids' (binance, crypto, kraken).
    expect(brokerPluginsOf(plugins).map((b) => b.venue?.code)).toEqual(["BINANCE", "KRAKEN", "HYPERLIQUID"]);
  });

  it("orders broker cards by the venue catalog, a broker of another market last", () => {
    const plugins = [brokerPlugin("mt5", "MT5"), venuePlugin, brokerPlugin("okx", "OKX"), brokerPlugin("ibkr", undefined)];
    expect(brokerPluginsOf(plugins).map((b) => b.plugin.manifest.id)).toEqual(["okx", "crypto", "ibkr", "mt5"]);
    expect(venueRank("gateio")).toBe(CRYPTO_VENUES.findIndex((v) => v.code === "GATEIO"));
    expect(venueRank(" mt5 ")).toBe(CRYPTO_VENUES.length);
    expect(venueRank(null)).toBe(CRYPTO_VENUES.length);
    // The picker's cards (id, name, exchange from the manifest) sort the same way.
    const cards = [
      { name: "Kraken", exchange: "KRAKEN" },
      { name: "Gate.io", exchange: "GATEIO" },
      { name: "Alpha", exchange: null },
      { name: "Binance", exchange: "BINANCE" },
    ];
    expect(sortBrokerCards(cards).map((c) => c.name)).toEqual(["Binance", "Kraken", "Gate.io", "Alpha"]);
  });

  it("keeps a broker of another market (MetaTrader 5, Interactive Brokers) without a crypto venue", () => {
    const mt5 = brokerPlugin("mt5", "MT5");
    expect(brokerPluginsOf([mt5])).toEqual([{ plugin: mt5, venue: undefined }]);
    expect(marketDataVenues([mt5]).map((v) => v.code)).toEqual(CRYPTO_VENUES.map((v) => v.code));
  });

  it("gives a broker the venue's card: Hyperliquid, not the crypto plugin's name", () => {
    expect(brokerCard({ name: "Crypto markets & Hyperliquid", exchange: "HYPERLIQUID" })).toEqual({ name: "Hyperliquid", code: "HYPERLIQUID" });
    expect(brokerCard({ name: "Binance", exchange: "binance " })).toEqual({ name: "Binance", code: "BINANCE" });
    // Another market keeps its own name and initials.
    expect(brokerCard({ name: "MetaTrader 5", exchange: "MT5" })).toEqual({ name: "MetaTrader 5" });
    // A broker written before `exchange` was set, served by its one exchange.
    expect(brokerCard({ name: "Gate.io", exchanges: ["gateio"] })).toEqual({ name: "Gate.io", code: "GATEIO" });
    expect(brokerCard({ name: "Interactive Brokers" })).toEqual({ name: "Interactive Brokers" });
  });

  it("reads a one-exchange broker plugin written before `exchange` was set", () => {
    expect(brokerVenueCode(brokerPlugin("gate", undefined, { exchanges: ["gateio"] }))).toBe("GATEIO");
    expect(brokerVenueCode(brokerPlugin("old", undefined, { exchanges: ["BINANCE", "OKX"] }))).toBeUndefined();
  });

  it("lists every crypto venue under Market data while no broker plugin is installed", () => {
    expect(marketDataVenues([]).map((v) => v.code)).toEqual(CRYPTO_VENUES.map((v) => v.code));
    expect(venuePluginOf([venuePlugin], "bybit")?.manifest.id).toBe("crypto");
    expect(venuePluginOf([venuePlugin], "nope")).toBeUndefined();
  });
});
