import { rpc } from "./backend";
import type { OpenOrder, Position } from "../types";

export function getPosition(coin: string): Promise<Position> {
  return rpc<Position>("account.position", { coin });
}

export async function getOpenOrders(coin: string): Promise<OpenOrder[]> {
  const result = await rpc<{ orders: OpenOrder[] }>("account.open_orders", { coin });
  return result.orders ?? [];
}
