import type { HistoricalTrade } from './types';

interface HistoricalTradesResponse {
  trades: HistoricalTrade[];
  count: number;
}

interface FetchArgs {
  server: string;
  symbol: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export async function fetchHistoricalTrades({
  server,
  symbol,
  fromMs,
  toMs,
  limit = 5000,
}: FetchArgs): Promise<HistoricalTrade[]> {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (fromMs && fromMs > 0) params.set('from', String(fromMs));
  if (toMs && toMs > 0) params.set('to', String(toMs));
  params.set('limit', String(limit));

  const res = await fetch(`http://${server}/trades/historical?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch historical trades (HTTP ${res.status})`);
  }
  const data = await res.json() as HistoricalTradesResponse;
  return data.trades ?? [];
}
