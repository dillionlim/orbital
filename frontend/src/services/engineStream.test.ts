import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStream,
  releaseStream,
  type EngineBookDeltaMessage,
  type EngineBookMessage,
  type EngineTradeMessage,
} from './engineStream';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  closeAndNotify(): void {
    this.close();
    this.onclose?.(new Event('close'));
  }
}

const acquired: Array<{ server: string; apiKey: string }> = [];

function acquireTracked(server: string, apiKey: string) {
  acquired.push({ server, apiKey });
  return acquireStream(server, apiKey);
}

function sentFrames(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe('engineStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    for (const { server, apiKey } of acquired.splice(0)) releaseStream(server, apiKey);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Covers socket auth and parser routing for the frames dashboard widgets consume.
  it('authenticates with the API-key subprotocol and dispatches parsed book/trade messages', () => {
    const stream = acquireTracked('engine.test:9090', 'sk_live_stream_key');
    const onBook = vi.fn();
    const onTrades = vi.fn();

    const offBook = stream.subscribe('book', 'BTC-USD', onBook);
    const offTrades = stream.subscribe('trades', 'BTC-USD', onTrades);
    const ws = FakeWebSocket.instances[0];

    expect(ws.url).toBe('ws://engine.test:9090/ws');
    expect(ws.protocols).toEqual(['engine.bearer', 'sk_live_stream_key']);
    expect(ws.sent).toEqual([]);

    ws.open();
    expect(sentFrames(ws)).toEqual([
      { t: 'subscribe', channel: 'book', symbol: 'BTC-USD' },
      { t: 'subscribe', channel: 'trades', symbol: 'BTC-USD' },
    ]);

    const snapshot: EngineBookMessage = {
      t: 'book',
      symbol: 'BTC-USD',
      snapshot: true,
      seq: 1,
      ts: 1000,
      bids: [[99, 2]],
      asks: [[101, 3]],
    };
    const delta: EngineBookDeltaMessage = {
      t: 'book_delta',
      symbol: 'BTC-USD',
      seq: 2,
      ts: 1001,
      bids: [[100, 1]],
      asks: [],
    };
    const trade: EngineTradeMessage = {
      t: 'trade',
      symbol: 'BTC-USD',
      trade_id: 42,
      price: 100,
      quantity: 0.5,
      taker_side: 'Buy',
      ts: 1002,
    };

    ws.receive('{bad json');
    ws.receive({ t: 'welcome' });
    ws.receive({ ...snapshot, symbol: 'ETH-USD' });
    ws.receive(snapshot);
    ws.receive(delta);
    ws.receive(trade);

    expect(onBook).toHaveBeenNthCalledWith(1, snapshot);
    expect(onBook).toHaveBeenNthCalledWith(2, delta);
    expect(onTrades).toHaveBeenCalledWith(trade);

    offBook();
    offTrades();
    expect(sentFrames(ws).slice(-2)).toEqual([
      { t: 'unsubscribe', channel: 'book', symbol: 'BTC-USD' },
      { t: 'unsubscribe', channel: 'trades', symbol: 'BTC-USD' },
    ]);
  });

  // Ensures reconnect restores active subscriptions without help from consumers.
  it('resubscribes existing listeners after a reconnect', async () => {
    vi.useFakeTimers();
    const stream = acquireTracked('reconnect.test:9090', 'sk_live_reconnect_key');
    stream.subscribe('trades', 'BTC-USD', vi.fn());

    const first = FakeWebSocket.instances[0];
    first.open();
    first.closeAndNotify();

    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeWebSocket.instances[1];
    second.open();

    expect(sentFrames(second)).toEqual([
      { t: 'subscribe', channel: 'trades', symbol: 'BTC-USD' },
    ]);
  });

  // The registry's whole point: N widgets on one server share one socket, so a
  // dashboard with a book + a tape + a chart still opens exactly one connection.
  it('shares a single socket across consumers of the same server and key', () => {
    const first = acquireTracked('shared.test:9090', 'sk_live_shared_key');
    const second = acquireTracked('shared.test:9090', 'sk_live_shared_key');

    expect(second).toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // A different key is a different identity (a re-keyed user must not inherit
    // the old socket's auth), so it gets its own connection.
    acquireTracked('shared.test:9090', 'sk_live_other_key');
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  // Refcounting must survive an unbalanced-looking unmount order: the socket only
  // dies at zero refs, and a later acquire after that opens a fresh one.
  it('only tears the socket down when the last reference is released', () => {
    acquireStream('refcount.test:9090', 'sk_live_refcount_key');
    acquireStream('refcount.test:9090', 'sk_live_refcount_key');
    const ws = FakeWebSocket.instances[0];
    ws.open();

    // One consumer unmounts — the other is still watching, so the socket lives.
    releaseStream('refcount.test:9090', 'sk_live_refcount_key');
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);

    releaseStream('refcount.test:9090', 'sk_live_refcount_key');
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    // Over-releasing is a no-op, and the next acquire reconnects from scratch.
    releaseStream('refcount.test:9090', 'sk_live_refcount_key');
    acquireTracked('refcount.test:9090', 'sk_live_refcount_key');
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  // Backoff doubles per failed attempt and saturates at MAX_BACKOFF_MS (30s) so a
  // dead engine can't be hammered forever at 1/s by every open browser tab.
  it('doubles the reconnect backoff up to the 30s cap', async () => {
    vi.useFakeTimers();
    acquireTracked('backoff.test:9090', 'sk_live_backoff_key');

    // Each failed attempt closes without ever opening, so the delay keeps growing:
    // 1s, 2s, 4s, 8s, 16s, then the 30s cap (not 32s) twice over.
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const attempts = FakeWebSocket.instances.length;
      FakeWebSocket.instances[attempts - 1].closeAndNotify();

      // Nothing should reconnect a tick early…
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(attempts);
      // …and exactly one new socket lands on the scheduled tick.
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(attempts + 1);
    }

    // A successful open resets the ladder, so the next drop retries after 1s again.
    const revived = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    revived.open();
    revived.closeAndNotify();
    const attempts = FakeWebSocket.instances.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(attempts + 1);
  });

  // Unmounting while a reconnect is queued must cancel the timer — otherwise the
  // socket resurrects itself after the last consumer is gone.
  it('cancels a pending reconnect when the stream is destroyed', async () => {
    vi.useFakeTimers();
    const stream = acquireStream('destroy.test:9090', 'sk_live_destroy_key');
    const onTrade = vi.fn();
    stream.subscribe('trades', 'BTC-USD', onTrade);

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.closeAndNotify(); // reconnect now scheduled for +1000ms

    releaseStream('destroy.test:9090', 'sk_live_destroy_key');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(stream.getStatus()).toBe('closed');

    // Listeners are dropped too, so a late frame on the dead socket goes nowhere.
    ws.receive({ t: 'trade', symbol: 'BTC-USD', trade_id: 1, price: 100, quantity: 1, taker_side: 'Buy', ts: 1 });
    expect(onTrade).not.toHaveBeenCalled();
  });
});
