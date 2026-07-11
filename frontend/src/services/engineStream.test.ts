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
});
