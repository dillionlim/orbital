// Single source of truth for the markets the dashboard exposes. These names
// must match the trading engine's configured symbols (scripts/server.json) and
// the backend's /index-prices keys.

// --- Tradeable order-book markets (have a real instrument + matching book) ---

// Index futures (CME) — real-time, trade ~24h.
export const FUTURES_SYMBOLS = ['ES', 'NKD', 'NQ', 'YM', 'RTY'] as const;

// US-listed ETFs that track the same indices.
export const ETF_SYMBOLS = ['SPY', 'EWJ', 'EWH', 'EWY', 'FEZ'] as const;

// Everything tradeable — used by the order book, trade ticker, and backtester.
export const SYMBOLS: string[] = [...FUTURES_SYMBOLS, ...ETF_SYMBOLS];

export const DEFAULT_SYMBOL = 'ES';

// --- Display-only cash indices (NOT tradeable; shown in the Indices panel) ---
export const INDEX_SYMBOLS = ['NIKKEI', 'HSI', 'KOSPI', 'STOXX50'] as const;

// Human-friendly labels for the dropdowns and panels.
export const SYMBOL_LABELS: Record<string, string> = {
  // Futures
  ES: 'S&P 500 (ES)',
  NKD: 'Nikkei 225 (NKD)',
  NQ: 'Nasdaq-100 (NQ)',
  YM: 'Dow Jones (YM)',
  RTY: 'Russell 2000 (RTY)',
  // ETFs
  SPY: 'SPY · S&P 500 ETF',
  EWJ: 'EWJ · Japan ETF',
  EWH: 'EWH · Hong Kong ETF',
  EWY: 'EWY · Korea ETF',
  FEZ: 'FEZ · Euro Stoxx ETF',
  // Cash indices (display only)
  NIKKEI: 'Nikkei 225',
  HSI: 'Hang Seng',
  KOSPI: 'KOSPI',
  STOXX50: 'Euro Stoxx 50',
};
