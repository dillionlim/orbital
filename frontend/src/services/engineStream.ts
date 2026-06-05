// Shared WebSocket connection to a trading engine. One physical socket per
// (server, apiKey); components subscribe to (channel, symbol) tuples. The
// engine accepts the API key via `?api_key=` query param (browsers can't set
// custom headers on WebSocket upgrades).
//
// Lifecycle:
//   - acquireStream() bumps a refcount and connects on first acquire.
//   - subscribe(channel, symbol, cb) sends a `subscribe` frame the first time
//     a (channel, symbol) pair is requested; the unsubscribe cb removes the
//     callback and sends `unsubscribe` when the last listener for that pair
//     drops.
//   - releaseStream() decrements the refcount; the socket is torn down when
//     it hits zero.
//   - On disconnect, every outstanding subscription is re-sent on reconnect
//     so consumers see continuous data without re-subscribing.

export type StreamStatus = 'connecting' | 'open' | 'closed';

// Full L2 snapshot — sent on subscribe + at engine startup. Establishes the
// baseline state and the starting `seq` for the delta stream that follows.
export interface EngineBookMessage {
  t: 'book';
  symbol: string;
  snapshot: true;
  seq: number;
  ts: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

// Incremental top-N changes. qty=0 removes a level, qty>0 sets/updates it.
// `seq` is monotonic per (server, symbol); a gap means we missed a delta and
// should resync.
export interface EngineBookDeltaMessage {
  t: 'book_delta';
  symbol: string;
  seq: number;
  ts: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface EngineTradeMessage {
  t: 'trade';
  symbol: string;
  trade_id: number;
  price: number;
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
}

export type EngineMessage =
  | EngineBookMessage
  | EngineBookDeltaMessage
  | EngineTradeMessage
  | { t: string; [k: string]: unknown };

type Listener<T extends EngineMessage = EngineMessage> = (msg: T) => void;
type StatusListener = (status: StreamStatus) => void;

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

class EngineStream {
  private ws: WebSocket | null = null;
  private status: StreamStatus = 'closed';
  // Key: `${channel}:${symbol}` (e.g. "book:BTC-USD").
  private subscribers = new Map<string, Set<Listener>>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_BACKOFF_MS;
  private destroyed = false;
  private url: string;

  constructor(server: string, apiKey: string) {
    this.url = `ws://${server}/ws?api_key=${encodeURIComponent(apiKey)}`;
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.subscribers.clear();
    this.statusListeners.clear();
  }

  getStatus(): StreamStatus {
    return this.status;
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    // Push current value immediately so consumers don't have to handle the
    // "haven't been notified yet" gap.
    fn(this.status);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  // Force the server to resend a fresh snapshot for (channel, symbol) by
  // re-issuing `subscribe`. The dispatcher always replies with the current
  // SnapshotStore state on subscribe — handy when a delta-stream gap is
  // detected and the consumer wants to recover without dropping the socket.
  resync(channel: 'book' | 'trades', symbol: string): void {
    this.sendSubscribe(channel, symbol);
  }

  subscribe<T extends EngineMessage>(
    channel: 'book' | 'trades',
    symbol: string,
    cb: Listener<T>,
  ): () => void {
    const key = `${channel}:${symbol}`;
    let set = this.subscribers.get(key);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(cb as Listener);
    if (isFirst) this.sendSubscribe(channel, symbol);
    return () => {
      const s = this.subscribers.get(key);
      if (!s) return;
      s.delete(cb as Listener);
      if (s.size === 0) {
        this.subscribers.delete(key);
        this.sendUnsubscribe(channel, symbol);
      }
    };
  }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private sendSubscribe(channel: string, symbol: string): void {
    this.send({ t: 'subscribe', channel, symbol });
  }

  private sendUnsubscribe(channel: string, symbol: string): void {
    this.send({ t: 'unsubscribe', channel, symbol });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = INITIAL_BACKOFF_MS;
      // Deliberately no `hello` here. The dashboard is a read-only consumer
      // (book/trade subscriptions only — never places orders), and any
      // `hello` with a client_id would register the session as a bot in
      // BotTracker, polluting /bots with a "frontend" row per browser tab.
      for (const key of this.subscribers.keys()) {
        const [channel, symbol] = key.split(':');
        this.sendSubscribe(channel, symbol);
      }
      this.setStatus('open');
    };

    ws.onmessage = (ev) => {
      let msg: EngineMessage;
      try {
        msg = JSON.parse(ev.data) as EngineMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      // Both `book` (snapshot) and `book_delta` (incremental) route to the
      // same `book:<symbol>` listeners — the consumer disambiguates by `t`.
      if ((msg.t === 'book' || msg.t === 'book_delta') && typeof msg.symbol === 'string') {
        this.dispatch(`book:${msg.symbol}`, msg);
      } else if (msg.t === 'trade' && typeof msg.symbol === 'string') {
        this.dispatch(`trades:${msg.symbol}`, msg);
      }
      // welcome / pong / error / order_* go unrouted (no subscribers care).
    };

    ws.onerror = () => {
      // Will be followed by onclose; backoff happens there.
    };

    ws.onclose = () => {
      this.ws = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  private dispatch(key: string, msg: EngineMessage): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const cb of set) cb(msg);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_BACKOFF_MS);
  }
}

// ---- Refcounted singleton registry ----------------------------------------

const streams = new Map<string, EngineStream>();
const refCounts = new Map<string, number>();

function streamKey(server: string, apiKey: string): string {
  return `${server}|${apiKey}`;
}

export function acquireStream(server: string, apiKey: string): EngineStream {
  const key = streamKey(server, apiKey);
  let s = streams.get(key);
  if (!s) {
    s = new EngineStream(server, apiKey);
    streams.set(key, s);
  }
  refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
  return s;
}

export function releaseStream(server: string, apiKey: string): void {
  const key = streamKey(server, apiKey);
  const c = refCounts.get(key) ?? 0;
  if (c <= 1) {
    refCounts.delete(key);
    const s = streams.get(key);
    if (s) {
      s.destroy();
      streams.delete(key);
    }
  } else {
    refCounts.set(key, c - 1);
  }
}

export type { EngineStream };
