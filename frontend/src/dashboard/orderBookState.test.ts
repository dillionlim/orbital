import { describe, expect, it } from 'vitest';
import {
  DEPTH_LEVELS,
  applyDelta,
  applySnapshot,
  createBookState,
  takeDepth,
  toOrders,
} from './orderBookState';
import type { EngineBookMessage, EngineBookDeltaMessage } from '../services/engineStream';
import type { Order } from '../types';

function snapshot(
  seq: number,
  bids: Array<[number, number]>,
  asks: Array<[number, number]>,
): EngineBookMessage {
  return { t: 'book', symbol: 'BTC-USD', snapshot: true, seq, ts: seq, bids, asks };
}

function delta(
  seq: number,
  bids: Array<[number, number]>,
  asks: Array<[number, number]> = [],
): EngineBookDeltaMessage {
  return { t: 'book_delta', symbol: 'BTC-USD', seq, ts: seq, bids, asks };
}

function order(price: number, size: number): Order {
  return { price, size, total: price * size };
}

describe('applySnapshot', () => {
  // The snapshot is the baseline: it replaces the book wholesale and re-bases
  // seq, so nothing from the previous (possibly desynced) state survives.
  it('replaces the whole book and adopts the snapshot seq', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(4, [[100, 1]], [[101, 2]]));
    applySnapshot(state, snapshot(9, [[90, 5]], [[91, 6]]));

    expect([...state.bids]).toEqual([[90, 5]]);
    expect([...state.asks]).toEqual([[91, 6]]);
    expect(state.seq).toBe(9);
  });
});

describe('applyDelta', () => {
  // The normal path: the next seq in line updates levels on both sides.
  it('applies the in-sequence delta and advances seq', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(1, [[100, 1]], [[101, 2]]));

    expect(applyDelta(state, delta(2, [[100, 3], [99, 4]], [[101, 5]]))).toBe('applied');
    expect([...state.bids]).toEqual([[100, 3], [99, 4]]);
    expect([...state.asks]).toEqual([[101, 5]]);
    expect(state.seq).toBe(2);
  });

  // qty 0 is the engine's delete marker, not a zero-size resting level — leaving
  // it in the map would paint a phantom level at the touch.
  it('deletes a level when the delta carries qty 0', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(1, [[100, 1], [99, 2]], [[101, 3]]));

    expect(applyDelta(state, delta(2, [[100, 0]], [[101, 0]]))).toBe('applied');
    expect([...state.bids]).toEqual([[99, 2]]);
    expect([...state.asks]).toEqual([]);
  });

  // Regression: a delta at or behind our seq is already baked into the snapshot.
  // Treating it as a gap made every early/duplicate publish trigger a resync —
  // a subscribe frame plus a full L2 snapshot per delta.
  it('ignores a stale delta instead of asking for a resync', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(5, [[100, 1]], [[101, 2]]));

    expect(applyDelta(state, delta(5, [[100, 99]]))).toBe('stale');
    expect(applyDelta(state, delta(3, [[100, 99]]))).toBe('stale');

    // Untouched: a stale delta must not mutate the book or move seq.
    expect([...state.bids]).toEqual([[100, 1]]);
    expect(state.seq).toBe(5);
  });

  // A delta that arrives before any snapshot (seq still 0) is the same "we have
  // no baseline" case — resync rather than applying it to an empty book.
  it('reports a forward gap so the caller resyncs', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(5, [[100, 1]], []));

    expect(applyDelta(state, delta(7, [[100, 99]]))).toBe('gap');
    expect([...state.bids]).toEqual([[100, 1]]);
    expect(state.seq).toBe(5);

    const cold = createBookState();
    expect(applyDelta(cold, delta(42, [[100, 1]]))).toBe('gap');
    expect(cold.seq).toBe(0);
  });

  // The whole point of surviving a stale delta: the stream keeps flowing once
  // the sequence catches up, with no snapshot round-trip in between.
  it('resumes applying once the sequence catches up after a stale delta', () => {
    const state = createBookState();
    applySnapshot(state, snapshot(5, [[100, 1]], []));

    expect(applyDelta(state, delta(4, [[100, 99]]))).toBe('stale');
    expect(applyDelta(state, delta(6, [[100, 7]]))).toBe('applied');
    expect([...state.bids]).toEqual([[100, 7]]);
    expect(state.seq).toBe(6);
  });
});

describe('toOrders', () => {
  // Both sides must walk outward from the touch, so the first row rendered on
  // each side is the best price.
  it('sorts bids descending and asks ascending, with the notional total', () => {
    const bids = toOrders(new Map([[99, 1], [101, 2], [100, 3]]), true);
    const asks = toOrders(new Map([[103, 1], [101, 2], [102, 3]]), false);

    expect(bids).toEqual([order(101, 2), order(100, 3), order(99, 1)]);
    expect(asks).toEqual([order(101, 2), order(102, 3), order(103, 1)]);
  });

  it('returns an empty list for an empty book', () => {
    expect(toOrders(new Map(), true)).toEqual([]);
  });
});

describe('takeDepth', () => {
  // The far tail is stale far-from-touch orders; showing it pushes the levels
  // that matter off screen.
  it('keeps only the levels nearest the touch', () => {
    const levels = Array.from({ length: 20 }, (_, i) => order(100 - i, 1));

    expect(takeDepth(levels)).toHaveLength(DEPTH_LEVELS);
    expect(takeDepth(levels)[0]).toEqual(order(100, 1));
    expect(takeDepth(levels).at(-1)).toEqual(order(100 - (DEPTH_LEVELS - 1), 1));
    expect(takeDepth(levels, 2)).toEqual([order(100, 1), order(99, 1)]);
  });

  it('leaves a book shallower than the cap untouched', () => {
    const levels = [order(100, 1), order(99, 2)];
    expect(takeDepth(levels)).toEqual(levels);
  });
});
