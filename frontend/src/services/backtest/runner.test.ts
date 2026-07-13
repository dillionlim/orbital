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
