export interface HistoricalTrade {
  trade_id: number;
  symbol: string;
  price: number;        // close / mark price (mid)
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
  // Top-of-book from the L1 parquet datasets (absent for the live Yahoo feed).
  // When present the runner fills buys at `ask` and sells at `bid`.
  bid?: number;
  ask?: number;
}

export interface BacktestParams {
  initialCash: number;
  positionSize: number;
  [key: string]: number;
}

export type BacktestAction = 'buy' | 'sell' | 'hold';

// Order types the runner understands:
//   market — fill now at top-of-book (buy@ask / sell@bid)
//   limit  — if marketable now, fill now; else rest and fill on a later tick
//            when the mark price crosses `limit` (filled at `limit`)
//   ioc    — fill now if marketable at `limit`, otherwise cancel (no rest)
export type OrderType = 'market' | 'limit' | 'ioc';

// What a strategy emits per tick. `type` defaults to 'market'. `limit` is the
// limit price — required for 'limit'/'ioc', ignored for 'market'.
export interface BacktestSignal {
  action: BacktestAction;
  type?: OrderType;
  limit?: number;
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
  trades: number;          // count of executed (filled) orders
  canceled: number;        // IOC orders that weren't marketable + limits never filled
  finalEquity: number;
  totalReturn: number;     // fractional (0.10 = +10%)
  maxDrawdown: number;     // fractional, ≤ 0
  sharpe: number;          // crude per-tick Sharpe — mean/std × √N
  finalPosition: number;
  finalCash: number;
}
