import { describe, expect, it } from 'vitest';
import { downsamplePoints, runBacktest } from './runner';
import type {
  BacktestPoint,
  BacktestSignal,
  HistoricalTrade,
  Strategy,
} from './types';

function trade(overrides: Partial<HistoricalTrade> & { price: number; ts: number }): HistoricalTrade {
  return {
    trade_id: overrides.ts,
    symbol: 'BTC-USD',
    quantity: 1,
    taker_side: 'Buy',
    ...overrides,
  };
}

function scriptedStrategy(signals: BacktestSignal[]): Strategy<{ cursor: number }> {
  return {
    id: 'scripted',
    name: 'Scripted',
    description: 'Emits a fixed signal sequence for runner tests.',
    init: () => ({ cursor: 0 }),
    onTrade: (state) => signals[state.cursor++] ?? { action: 'hold' },
  };
}

describe('runBacktest', () => {
  // Verifies aggressive buys pay the ask while equity is still marked at mid.
  it('fills market buys at the ask price', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100, bid: 99, ask: 101 })],
      scriptedStrategy([{ action: 'buy' }]),
      { initialCash: 1000, positionSize: 2 },
    );

    expect(result.trades).toBe(1);
    expect(result.finalCash).toBe(798);
    expect(result.finalPosition).toBe(2);
    expect(result.finalEquity).toBe(998);
  });

  // Guards the GTC limit path: a non-marketable order rests, then fills at limit.
  it('fills resting limit orders when a later mark crosses the limit', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 2, price: 94, bid: 93, ask: 95 }),
      ],
      scriptedStrategy([{ action: 'buy', type: 'limit', limit: 95 }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(1);
    expect(result.canceled).toBe(0);
    expect(result.finalCash).toBe(905);
    expect(result.finalEquity).toBe(999);
  });

  // Keeps IOC behavior honest: an unmarketable order cancels instead of resting.
  it('cancels unmarketable IOC orders', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100, bid: 99, ask: 101 })],
      scriptedStrategy([{ action: 'buy', type: 'ioc', limit: 100 }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(0);
    expect(result.canceled).toBe(1);
    expect(result.finalCash).toBe(1000);
    expect(result.finalPosition).toBe(0);
  });

  // Mirror of the market-buy case: aggressive sells hit the bid, and a sell from
  // flat is allowed to go short (the runner has no short prevention by design).
  it('fills market sells at the bid price and goes short from flat', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100, bid: 99, ask: 101 })],
      scriptedStrategy([{ action: 'sell' }]),
      { initialCash: 1000, positionSize: 2 },
    );

    expect(result.trades).toBe(1);
    expect(result.finalCash).toBe(1198);
    expect(result.finalPosition).toBe(-2);
    expect(result.finalEquity).toBe(998);
  });

  // A sell limit below the bid is marketable right away — it fills at the touch
  // (the bid), not at the limit, so the strategy never sells cheaper than asked.
  it('fills marketable sell limits at the bid immediately', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100, bid: 99, ask: 101 })],
      scriptedStrategy([{ action: 'sell', type: 'limit', limit: 95 }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(1);
    expect(result.canceled).toBe(0);
    expect(result.finalCash).toBe(1099);
    expect(result.finalPosition).toBe(-1);
    expect(result.finalEquity).toBe(999);
  });

  // The sell-side GTC path: an above-the-bid limit rests, then fills at the limit
  // on the first later tick whose mark price rises through it.
  it('fills resting sell limits when a later mark rises through the limit', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 2, price: 106, bid: 105, ask: 107 }),
      ],
      scriptedStrategy([{ action: 'sell', type: 'limit', limit: 105 }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(1);
    expect(result.canceled).toBe(0);
    expect(result.finalCash).toBe(1105);
    expect(result.finalPosition).toBe(-1);
    expect(result.finalEquity).toBe(999);
  });

  // Sell IOC splits both ways on the same tape: marketable at the bid fills,
  // above the bid cancels outright rather than resting.
  it('fills marketable sell IOCs and cancels the rest', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 2, price: 100, bid: 99, ask: 101 }),
      ],
      scriptedStrategy([
        { action: 'sell', type: 'ioc', limit: 98 },
        { action: 'sell', type: 'ioc', limit: 100 },
      ]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(1);
    expect(result.canceled).toBe(1);
    expect(result.finalCash).toBe(1099);
    expect(result.finalPosition).toBe(-1);
  });

  // GTC limits are never force-filled: one the market never reached is still open
  // at the end of the tape and is reported as canceled, not as a trade.
  it('counts limit orders still resting at end of tape as canceled', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 2, price: 100, bid: 99, ask: 101 }),
      ],
      scriptedStrategy([{ action: 'buy', type: 'limit', limit: 50 }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(0);
    expect(result.canceled).toBe(1);
    expect(result.finalCash).toBe(1000);
    expect(result.finalPosition).toBe(0);
    expect(result.finalEquity).toBe(1000);
  });

  // A strategy that emits a limit/ioc without a usable price (NaN from a divide
  // by zero, or a missing field) must cancel — never fill at an accidental price.
  it('cancels limit and IOC orders with a non-finite or missing limit price', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 2, price: 100, bid: 99, ask: 101 }),
        trade({ ts: 3, price: 100, bid: 99, ask: 101 }),
      ],
      scriptedStrategy([
        { action: 'buy', type: 'limit', limit: Number.NaN },
        { action: 'sell', type: 'ioc' },
        { action: 'buy', type: 'ioc', limit: Number.POSITIVE_INFINITY },
      ]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.trades).toBe(0);
    expect(result.canceled).toBe(3);
    expect(result.finalCash).toBe(1000);
    expect(result.finalPosition).toBe(0);
  });

  // Headline stat #1: Sharpe is mean/std of per-tick equity returns × √N. The tape
  // below holds one unit through equities 1000 → 1100 → 1100, i.e. returns
  // [0.1, 0]: mean 0.05, sample std 0.05√2, so Sharpe = (0.05 / 0.05√2) × √2 = 1.
  it('computes a per-tick Sharpe from the equity curve', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100 }),
        trade({ ts: 2, price: 200 }),
        trade({ ts: 3, price: 200 }),
      ],
      scriptedStrategy([{ action: 'buy' }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.points.map((point) => point.equity)).toEqual([1000, 1100, 1100]);
    expect(result.sharpe).toBeCloseTo(1, 10);
    expect(result.totalReturn).toBeCloseTo(0.1, 10);
  });

  // A flat equity curve has zero return variance; the std > 0 guard must return 0
  // rather than dividing by zero and rendering NaN in the stats panel.
  it('reports a zero Sharpe when equity never moves', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100 }), trade({ ts: 2, price: 120 })],
      scriptedStrategy([]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.sharpe).toBe(0);
    expect(result.maxDrawdown).toBe(0);
    expect(result.totalReturn).toBe(0);
    expect(result.finalEquity).toBe(1000);
  });

  // Headline stat #2: max drawdown is the worst peak-to-trough dip, kept even
  // after the curve recovers to a new high (1100 → 950 is -13.63%).
  it('tracks the worst peak-to-trough drawdown across the run', () => {
    const result = runBacktest(
      [
        trade({ ts: 1, price: 100 }),
        trade({ ts: 2, price: 200 }),
        trade({ ts: 3, price: 50 }),
        trade({ ts: 4, price: 300 }),
      ],
      scriptedStrategy([{ action: 'buy' }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.points.map((point) => point.equity)).toEqual([1000, 1100, 950, 1200]);
    expect(result.maxDrawdown).toBeCloseTo(-150 / 1100, 10);
    expect(result.finalEquity).toBe(1200);
    expect(result.totalReturn).toBeCloseTo(0.2, 10);
  });

  // Headline stat #3: total return is signed off final equity, so a losing run
  // reports a negative number instead of clamping at zero.
  it('reports a negative total return for a losing run', () => {
    const result = runBacktest(
      [trade({ ts: 1, price: 100 }), trade({ ts: 2, price: 60 })],
      scriptedStrategy([{ action: 'buy' }]),
      { initialCash: 1000, positionSize: 1 },
    );

    expect(result.finalEquity).toBe(960);
    expect(result.totalReturn).toBeCloseTo(-0.04, 10);
    expect(result.maxDrawdown).toBeCloseTo(-0.04, 10);
  });

  // Degenerate input: no trades means no marks, so equity falls back to the
  // starting cash instead of reading past the end of an empty points array.
  it('returns the initial cash as final equity for an empty tape', () => {
    const result = runBacktest([], scriptedStrategy([{ action: 'buy' }]), {
      initialCash: 1000,
      positionSize: 1,
    });

    expect(result.points).toEqual([]);
    expect(result.trades).toBe(0);
    expect(result.canceled).toBe(0);
    expect(result.finalEquity).toBe(1000);
    expect(result.finalCash).toBe(1000);
    expect(result.finalPosition).toBe(0);
    expect(result.totalReturn).toBe(0);
    expect(result.maxDrawdown).toBe(0);
    expect(result.sharpe).toBe(0);
  });
});

describe('downsamplePoints', () => {
  // Checks chart thinning keeps the closing point even when stride skips over it.
  it('always keeps the final point', () => {
    const points: BacktestPoint[] = Array.from({ length: 6 }, (_, index) => ({
      ts: index + 1,
      equity: 1000 + index,
      position: 0,
      cash: 1000 + index,
      price: 100,
    }));

    expect(downsamplePoints(points, 2).map((point) => point.ts)).toEqual([1, 4, 6]);
  });
});
