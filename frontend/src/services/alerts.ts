import { rpc } from "./backend";

export interface AlertLevels {
  coin: string;
  high: number | null;
  low: number | null;
}

export function getAlert(coin: string): Promise<AlertLevels> {
  return rpc<AlertLevels>("alerts.get", { coin });
}

export function setAlert(coin: string, high: number, low: number): Promise<void> {
  return rpc<{ ok: boolean }>("alerts.set", { coin, high, low }).then(() => undefined);
}
