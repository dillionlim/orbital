import type { HistoricalTrade } from './types';

interface HistoricalTradesResponse {
  trades: HistoricalTrade[];
  count: number;
}

interface FetchArgs {
  symbol: string;
  range?: string;
  interval?: string;
  limit?: number;
}

export async function fetchHistoricalTrades({
  symbol,
  range = '1mo',
  interval = '30m',
  limit = 5000,
}: FetchArgs): Promise<HistoricalTrade[]> {
  const params = new URLSearchParams();
  params.set('symbol', symbol);
  params.set('range', range);
  params.set('interval', interval);

  const res = await fetch(
    `/api/backend/index-prices/candles?${params.toString()}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch historical data (HTTP ${res.status})`);
  }
  const data = (await res.json()) as HistoricalTradesResponse;
  const trades = data.trades ?? [];
  return trades.length > limit ? trades.slice(-limit) : trades;
}

interface FetchBacktestArgs {
  symbol: string;
  granularity: 'daily' | 'minute';
  range: string;
  limit?: number;
}

// Pull backtester trades from the generated L1 parquet datasets (served by the
// backend's /index-prices/backtest). Unlike the live Yahoo candles these carry a
// modeled top-of-book (bid/ask) so the runner can charge the spread on fills.
export async function fetchBacktestTrades({
  symbol,
  granularity,
  range,
  limit = 20000,
}: FetchBacktestArgs): Promise<HistoricalTrade[]> {
  const params = new URLSearchParams();
  params.set('symbol', symbol);
  params.set('granularity', granularity);
  params.set('range', range);

  const res = await fetch(
    `/api/backend/index-prices/backtest?${params.toString()}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch parquet data (HTTP ${res.status})`);
  }
  const data = (await res.json()) as HistoricalTradesResponse;
  const trades = data.trades ?? [];
  return trades.length > limit ? trades.slice(-limit) : trades;
}
