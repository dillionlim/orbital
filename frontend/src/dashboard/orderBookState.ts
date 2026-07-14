// Book state the OrderBook widget maintains from the engine's WS stream: a full
// L2 snapshot establishes the baseline seq, and deltas (qty=0 deletes a level)
// are applied on top of it. Pure + framework-free so the seq/gap rules — the
// part that decides when we throw the book away and resync — are unit-testable.

import type { Order } from '../types';
import type { EngineBookMessage, EngineBookDeltaMessage } from '../services/engineStream';

// Only the top of the book is worth showing. The engine publishes every resting
// level, and the tail is mostly stale far-from-touch orders that push the
// interesting levels out of view.
export const DEPTH_LEVELS = 8;

export interface BookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  seq: number;
}

// 'applied' — state advanced. 'stale' — already covered by the snapshot, ignore.
// 'gap'    — we missed a publish; the caller must ask for a fresh snapshot.
export type DeltaOutcome = 'applied' | 'stale' | 'gap';

export function createBookState(): BookState {
  return { bids: new Map(), asks: new Map(), seq: 0 };
}

export function applySnapshot(state: BookState, msg: EngineBookMessage): void {
  state.bids = new Map(msg.bids);
  state.asks = new Map(msg.asks);
  state.seq = msg.seq;
}

export function applyDelta(state: BookState, msg: EngineBookDeltaMessage): DeltaOutcome {
  // A delta at or behind our seq is already baked into the snapshot we hold.
  // Resyncing on those turns one early/duplicate publish into a resync storm.
  if (msg.seq <= state.seq) return 'stale';
  if (msg.seq !== state.seq + 1) return 'gap';

  applyChanges(state.bids, msg.bids);
  applyChanges(state.asks, msg.asks);
  state.seq = msg.seq;
  return 'applied';
}

function applyChanges(m: Map<number, number>, changes: Array<[number, number]>): void {
  for (const [price, qty] of changes) {
    if (qty === 0) m.delete(price);
    else m.set(price, qty);
  }
}

// bids descending (highest price first), asks ascending — both walk out from the touch.
export function toOrders(m: Map<number, number>, desc: boolean): Order[] {
  const arr = Array.from(m.entries(), ([price, size]) => ({
    price, size, total: price * size,
  }));
  arr.sort((a, b) => desc ? b.price - a.price : a.price - b.price);
  return arr;
}

export function takeDepth(orders: Order[], depth: number = DEPTH_LEVELS): Order[] {
  return orders.slice(0, depth);
}
