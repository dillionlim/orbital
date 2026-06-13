import type {
  BacktestParams,
  BacktestPoint,
  BacktestResult,
  HistoricalTrade,
  Strategy,
} from './types';

// Replays a historical trade tape through a strategy. Each tick:
//   1. Fill any resting limit orders the market has now reached.
//   2. The strategy emits an order: action (buy/sell/hold) + type
//      (market/limit/ioc) + optional limit price.
//   3. Execute against top-of-book:
//        market    — fill now: buys lift the `ask`, sells hit the `bid`.
//        ioc @L    — fill now iff marketable (buy: ask≤L, sell: bid≥L) at the
//                    touch; otherwise cancel (counted, never rests).
//        limit @L  — if marketable now, fill at the touch; else REST. A resting
//                    order fills on the first later tick whose mark price crosses
//                    L (buy: price≤L, sell: price≥L), filled at L (maker price).
//      With no book (live Yahoo feed) bid/ask are absent and fall back to `price`.
//   4. Equity is marked to `price` (mid/close), so the spread shows up as the gap
//      between fill price and mark — a real drag, like live trading.
//
// Limitations worth knowing:
//   - No depth/queue: the full `size` fills at top-of-book (resting limits at L).
//     Resting limits are GTC; any still open at the end are counted as canceled.
//   - Sells go negative (no short prevention) so a long-only strategy that
//     wants to enforce `position >= 0` should track that itself.
//   - No commissions/fees — toggle in the future via a `feesBps` param.
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
  let canceled = 0;
  let peakEquity = initialCash;
  let maxDrawdown = 0;

  // Resting limit orders (GTC): each fills on a later tick when the mark price
  // crosses its limit. side/size/limit are captured at submit time.
  const resting: { side: 'buy' | 'sell'; size: number; limit: number }[] = [];

  const points: BacktestPoint[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = strategy.init(params) as any;

  for (const trade of trades) {
    const mark = trade.price;
    const ask = trade.ask ?? mark;
    const bid = trade.bid ?? mark;

    // (1) Fill resting limit orders the market has now crossed (at the limit).
    for (let k = resting.length - 1; k >= 0; k--) {
      const o = resting[k];
      const crossed = o.side === 'buy' ? mark <= o.limit : mark >= o.limit;
      if (!crossed) continue;
      if (o.side === 'buy') {
        cash -= o.limit * o.size;
        position += o.size;
      } else {
        cash += o.limit * o.size;
        position -= o.size;
      }
      executed++;
      resting.splice(k, 1);
    }

    // (2) New order from the strategy this tick.
    const signal = strategy.onTrade(state, trade, params);
    const act = signal.action;
    if ((act === 'buy' || act === 'sell') && size > 0) {
      const type = signal.type ?? 'market';
      const touch = act === 'buy' ? ask : bid; // aggressive fill price
      let fillNow = false;
      if (type === 'market') {
        fillNow = true;
      } else {
        const lim = signal.limit;
        if (lim == null || !Number.isFinite(lim)) {
          canceled++; // limit/ioc with no usable price
        } else {
          const marketable = act === 'buy' ? ask <= lim : bid >= lim;
          if (marketable) fillNow = true;
          else if (type === 'ioc') canceled++;
          else resting.push({ side: act, size, limit: lim });
        }
      }
      if (fillNow) {
        if (act === 'buy') {
          cash -= touch * size;
          position += size;
        } else {
          cash += touch * size;
          position -= size;
        }
        executed++;
      }
    }

    // (3) Mark to market.
    const equity = cash + position * mark;
    points.push({ ts: trade.ts, equity, position, cash, price: mark });
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (equity - peakEquity) / peakEquity : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Limit orders still resting at the end never filled — count them as canceled.
  canceled += resting.length;

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
    canceled,
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
