import { rpc } from "./backend";
import type { OpenOrder, Position } from "../types";
import { DEFAULT_VENUE, type Venue } from "./trading";

export function getPosition(coin: string, venue: Venue = DEFAULT_VENUE): Promise<Position> {
  return rpc<Position>("account.position", { coin, ...venue });
}

export async function getOpenOrders(
  coin: string,
  venue: Venue = DEFAULT_VENUE,
): Promise<OpenOrder[]> {
  const result = await rpc<{ orders: OpenOrder[] }>("account.open_orders", { coin, ...venue });
  return result.orders ?? [];
}
