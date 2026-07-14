import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WRAPPER_PY, toSignal } from './pythonStrategy';
import { runBacktest } from './runner';
import type { HistoricalTrade, Strategy } from './types';

// The wrapper is plain CPython (json + math only), so the real source can be
// exercised under the system python3 — Pyodide is a browser-only runtime and
// would need a ~10MB CDN download to test what is otherwise the same code.
const PY = 'python3';
const hasPython = (() => {
  try {
    execFileSync(PY, ['-c', ''], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Run `_BacktestStrategy._order(<expr>)` in real Python and return the JSON the
// wrapper would hand across the FFI, exactly as `step()` serializes it.
function order(expr: string): string {
  const script = `${WRAPPER_PY}
import json
print(json.dumps(_BacktestStrategy._order(${expr})))
`;
  return execFileSync(PY, ['-c', script], { encoding: 'utf8' }).trim();
}

describe.runIf(hasPython)('WRAPPER_PY _order', () => {
  // Regression: `float('nan')` used to sail through, and json.dumps emits a bare
  // `NaN` token, which JSON.parse rejects — one bad tick killed the whole run.
  // The limit is dropped instead, which the runner treats as a cancel.
  it.each(["float('nan')", "float('inf')", "float('-inf')"])(
    'drops a non-finite limit (%s) instead of emitting invalid JSON',
    (lim) => {
      const raw = order(`{'action': 'buy', 'type': 'limit', 'limit': ${lim}}`);

      expect(raw).not.toMatch(/NaN|Infinity/);
      expect(JSON.parse(raw)).toEqual({ action: 'buy', type: 'limit' });
      expect(toSignal(raw)).toEqual({ action: 'buy', type: 'limit', limit: undefined });
    },
  );

  // A limit at or below zero is unfillable, so it degrades to a cancel rather
  // than resting an order that can never trade.
  it.each(['0', '-5'])('drops a non-positive limit (%s)', (lim) => {
    const raw = order(`{'action': 'sell', 'type': 'ioc', 'limit': ${lim}}`);
    expect(JSON.parse(raw)).toEqual({ action: 'sell', type: 'ioc' });
  });

  // The happy path still has to survive the guard.
  it('keeps a normal limit price', () => {
    const raw = order("{'action': 'buy', 'type': 'limit', 'limit': 101.5}");
    expect(JSON.parse(raw)).toEqual({ action: 'buy', type: 'limit', limit: 101.5 });
  });

  // A missing limit is a user bug worth reporting, unlike a NaN that arithmetic
  // produced silently.
  it('still rejects a limit order with no limit at all', () => {
    expect(() => order("{'action': 'buy', 'type': 'limit'}")).toThrow();
  });

  it('passes a bare action string through as a market order', () => {
    expect(JSON.parse(order("'buy'"))).toEqual({ action: 'buy' });
    expect(JSON.parse(order('None'))).toEqual({ action: 'hold' });
  });
});

describe('toSignal', () => {
  // `1e999` is valid JSON but parses to Infinity, so the JS side needs the same
  // guard as the Python side — this is the one non-finite path Python can't stop.
  it('drops a limit that overflows to Infinity on parse', () => {
    expect(toSignal('{"action":"buy","type":"limit","limit":1e999}')).toEqual({
      action: 'buy',
      type: 'limit',
      limit: undefined,
    });
  });

  it('drops a non-positive limit', () => {
    expect(toSignal('{"action":"sell","type":"ioc","limit":0}').limit).toBeUndefined();
    expect(toSignal('{"action":"sell","type":"ioc","limit":-3}').limit).toBeUndefined();
  });

  it('keeps a usable limit and defaults action/type', () => {
    expect(toSignal('{"action":"buy","type":"limit","limit":99.5}')).toEqual({
      action: 'buy',
      type: 'limit',
      limit: 99.5,
    });
    expect(toSignal('{}')).toEqual({ action: 'hold', type: 'market', limit: undefined });
    expect(toSignal('{"action":"nonsense","type":"nonsense"}')).toEqual({
      action: 'hold',
      type: 'market',
      limit: undefined,
    });
  });
});

describe('runner contract for a dropped limit', () => {
  // The end of the chain: a limit-less limit order must be counted as a cancel
  // and leave the book flat, not crash or fill at an undefined price.
  it('cancels a limit order whose price was dropped', () => {
    const trades: HistoricalTrade[] = [
      { trade_id: 1, symbol: 'ES', price: 100, quantity: 1, taker_side: 'Buy', ts: 1 },
      { trade_id: 2, symbol: 'ES', price: 101, quantity: 1, taker_side: 'Buy', ts: 2 },
    ];
    const strategy: Strategy = {
      id: 'dropped-limit',
      name: 'Dropped limit',
      description: 'Emits the signal the Python wrapper produces for a NaN limit.',
      init: () => null,
      onTrade: () => toSignal('{"action":"buy","type":"limit","limit":1e999}'),
    };

    const result = runBacktest(trades, strategy, { initialCash: 1000, positionSize: 1 });

    expect(result.trades).toBe(0);
    expect(result.canceled).toBe(2);
    expect(result.finalPosition).toBe(0);
    expect(result.finalCash).toBe(1000);
  });
});
