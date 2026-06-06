import type {
  BacktestParams,
  BacktestPoint,
  BacktestResult,
  HistoricalTrade,
  Strategy,
} from './types';

// Replays a historical trade tape through a strategy. Each tick:
//   1. The strategy decides buy/sell/hold based on the tick's price.
//   2. Buy/sell gets filled at that exact price (taker assumption — same as
//      hitting the market with a market order). No slippage, no fees.
//   3. We record cash, position, and mark-to-market equity.
//
// Limitations worth knowing:
//   - No order book interaction; we assume infinite liquidity at the trade
//     price. Realistic for `positionSize` << observed `quantity`.
//   - Sells go negative (no short prevention) so a long-only strategy that
//     wants to enforce `position >= 0` should track that itself.
//   - No fees — toggle in the future via a `feesBps` param.
export function runBacktest(
  trades: HistoricalTrade[],
  strategy: Strategy,
  params: BacktestParams,
): BacktestResult {
  const initialCash = params.initialCash;
  const size = Math.max(0, params.positionSize);
  let cash = initialCash;
  let position = 0;
  let executed = 0;
  let peakEquity = initialCash;
  let maxDrawdown = 0;

  const points: BacktestPoint[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = strategy.init(params) as any;

  for (const trade of trades) {
    const signal = strategy.onTrade(state, trade, params);
    if (signal.action === 'buy' && size > 0) {
      cash -= trade.price * size;
      position += size;
      executed++;
    } else if (signal.action === 'sell' && size > 0) {
      cash += trade.price * size;
      position -= size;
      executed++;
    }
    const equity = cash + position * trade.price;
    points.push({ ts: trade.ts, equity, position, cash, price: trade.price });
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (equity - peakEquity) / peakEquity : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Per-tick log returns; Sharpe is annualization-agnostic (mean/std × √N).
  // For a real Sharpe you'd want returns aggregated to a known interval +
  // a risk-free rate, but this is fine for comparing strategies on the
  // same trade tape.
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].equity;
    if (prev !== 0) returns.push((points[i].equity - prev) / prev);
  }
  const meanRet = returns.length
    ? returns.reduce((a, b) => a + b, 0) / returns.length
    : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(
        returns.reduce((a, r) => a + (r - meanRet) ** 2, 0) / (returns.length - 1),
      )
    : 0;
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(returns.length) : 0;

  const finalEquity = points.length ? points[points.length - 1].equity : initialCash;

  return {
    points,
    trades: executed,
    finalEquity,
    finalPosition: position,
    finalCash: cash,
    totalReturn: initialCash !== 0 ? (finalEquity - initialCash) / initialCash : 0,
    maxDrawdown,
    sharpe,
  };
}

// Downsample an equity curve to ~`max` points by stride. Charts get sluggish
// past a few thousand points and most of the noise isn't visible anyway.
export function downsamplePoints(points: BacktestPoint[], max = 500): BacktestPoint[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out: BacktestPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  // Always keep the last point so the closing equity matches stats.
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}
