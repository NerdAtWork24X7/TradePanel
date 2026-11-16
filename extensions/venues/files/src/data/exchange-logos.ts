/*
 * Venue brand marks for search rows. The crypto data plugin names a venue
 * (BINANCE, BYBIT, …); the search's right column shows that venue's mark so
 * the same ticker on nine exchanges reads apart at a glance.
 *
 * The SVGs are bundled by Vite (assets/exchanges, see NOTICE.md there): no
 * network request at search time, and the desktop build keeps them offline.
 */
const URLS = import.meta.glob("../assets/exchanges/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
}) as Record<string, string>;

const BY_NAME = new Map(
  Object.entries(URLS).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1).replace(/\.svg$/i, "").toUpperCase(),
    url,
  ]),
);

/** Venue codes that differ from the asset's file name. */
const ALIASES: Record<string, string> = {
  GATE: "GATEIO",
  "GATE.IO": "GATEIO",
};

/** Brand mark of an exchange code or display name, or undefined when there is
 *  no bundled mark (a stock exchange keeps its existing listing icon). */
export function exchangeLogoSrc(exchange: string | null | undefined): string | undefined {
  if (!exchange) return undefined;
  const key = exchange.trim().toUpperCase().replace(/\s+/g, "");
  return BY_NAME.get(ALIASES[key] ?? key);
}
