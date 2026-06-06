export interface HistoricalTrade {
  trade_id: number;
  symbol: string;
  price: number;
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
}

export interface BacktestParams {
  initialCash: number;
  positionSize: number;
  [key: string]: number;
}

export type BacktestAction = 'buy' | 'sell' | 'hold';

export interface BacktestSignal {
  action: BacktestAction;
}

// Param schema lives entirely in the UI now — the Python source no longer
// declares PARAMS. Just a key the strategy reads via params["key"] and a
// human label for the input.
export interface ParamSpec {
  key: string;
  label: string;
}

// Strategies are stateful: `init` allocates an opaque per-run state object
// and `onTrade` mutates it across the replay loop. Keeping state out of the
// runner means each strategy can use whatever data structure it wants
// (sliding windows, cooldown timers, RNG seeds, …).
export interface Strategy<S = unknown> {
  id: string;
  name: string;
  description: string;
  init(params: BacktestParams): S;
  onTrade(state: S, trade: HistoricalTrade, params: BacktestParams): BacktestSignal;
}

export interface BacktestPoint {
  ts: number;
  equity: number;        // cash + position × current price (mark-to-market)
  position: number;
  cash: number;
  price: number;
}

export interface BacktestResult {
  points: BacktestPoint[];
  trades: number;          // count of executed buy/sell signals
  finalEquity: number;
  totalReturn: number;     // fractional (0.10 = +10%)
  maxDrawdown: number;     // fractional, ≤ 0
  sharpe: number;          // crude per-tick Sharpe — mean/std × √N
  finalPosition: number;
  finalCash: number;
}
