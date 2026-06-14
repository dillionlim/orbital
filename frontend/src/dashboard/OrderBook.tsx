import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Card } from '../ui/Card';
import { Order } from '../types';
import { useApiKey } from '../hooks/useApiKey';
import { useEngineStream } from '../hooks/useEngineStream';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useSymbols } from '../services/symbols';
import type { EngineBookMessage, EngineBookDeltaMessage } from '../services/engineStream';

const REST_FALLBACK_POLL_MS = 1000;

interface OrderBookData {
  bids: Order[];
  asks: Order[];
  symbol: string;
  timestamp: string;
}

export const OrderBook: React.FC = () => {
  const [bids, setBids] = useState<Order[]>([]);
  const [asks, setAsks] = useState<Order[]>([]);
  const [filter, setFilter] = useState('');
  const [symbol, setSymbol] = useState('BTC-USD');
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { isLoading: isApiKeyLoading } = useApiKey();
  const { stream, status: wsStatus } = useEngineStream();
  const server = useCurrentServer();
  const { names: symbolNames } = useSymbols();

  // If the engine doesn't know the currently-selected symbol (server switch
  // to a config that doesn't define BTC-USD, for example), snap to the
  // first symbol the server *does* offer. Skip when the list is still
  // loading so we don't churn on first mount.
  useEffect(() => {
    if (symbolNames.length === 0) return;
    if (!symbolNames.includes(symbol)) setSymbol(symbolNames[0]);
  }, [symbolNames, symbol]);

  // Wipe accumulated state whenever the user switches trading servers — the
  // old server's bids/asks must NOT leak into a view that's now pointed
  // somewhere else. The WS subscribe effect below also runs on (server,
  // symbol), but it only re-keys after stream reconnects; this clears the
  // visible state immediately.
  useEffect(() => {
    setBids([]);
    setAsks([]);
    setLastUpdate('');
    setError(null);
    setIsLoading(true);
  }, [server]);

  // ---- WebSocket subscription (preferred path) -----------------------------
  //
  // We maintain price → qty maps locally and apply deltas as they arrive. seq
  // is monotonic per symbol; on a gap we ask the server for a fresh snapshot
  // (re-subscribe). Maps live in refs because we need the previous state when
  // applying a delta — using setBids/setAsks directly would race with React
  // batching under high-frequency updates.

  const bidsMapRef = useRef<Map<number, number>>(new Map());
  const asksMapRef = useRef<Map<number, number>>(new Map());
  const seqRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) return;

    // Reset state when (re)subscribing to a different symbol.
    bidsMapRef.current = new Map();
    asksMapRef.current = new Map();
    seqRef.current = 0;

    const renderFromMaps = () => {
      // bids descending (highest price first), asks ascending.
      const toOrders = (m: Map<number, number>, desc: boolean): Order[] => {
        const arr = Array.from(m.entries(), ([price, size]) => ({
          price, size, total: price * size,
        }));
        arr.sort((a, b) => desc ? b.price - a.price : a.price - b.price);
        return arr;
      };
      setBids(toOrders(bidsMapRef.current, true));
      setAsks(toOrders(asksMapRef.current, false));
    };

    const applyChanges = (m: Map<number, number>, changes: Array<[number, number]>) => {
      for (const [price, qty] of changes) {
        if (qty === 0) m.delete(price);
        else m.set(price, qty);
      }
    };

    const off = stream.subscribe<EngineBookMessage | EngineBookDeltaMessage>(
      'book',
      symbol,
      (msg) => {
        if (msg.t === 'book') {
          // Snapshot — replace entire state.
          bidsMapRef.current = new Map(msg.bids);
          asksMapRef.current = new Map(msg.asks);
          seqRef.current = msg.seq;
        } else {
          // Delta. seq must be exactly seq+1 — anything else is a gap and
          // means we missed a publish; recover by asking for a snapshot.
          const expected = seqRef.current + 1;
          if (msg.seq !== expected) {
            // The very first message after subscribe should be `book`, so a
            // delta arriving with seqRef=0 is the same gap case (expected=1
            // but the seq is whatever the engine is at currently).
            stream.resync('book', symbol);
            return;  // wait for the snapshot reply; don't apply this delta
          }
          applyChanges(bidsMapRef.current, msg.bids);
          applyChanges(asksMapRef.current, msg.asks);
          seqRef.current = msg.seq;
        }
        renderFromMaps();
        setLastUpdate(String(msg.ts));
        setError(null);
        setIsLoading(false);
      },
    );
    return off;
  }, [stream, symbol]);

  // ---- REST fallback (used only when WS is not open) -----------------------

  const fetchOrderBook = useCallback(async () => {
    const [host, port] = server.split(':');
    const symbolParam = symbol.split('-')[0].toLowerCase();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      // /orderbook is anonymous-friendly on the engine. Sending a key would
      // make the engine validate it on every poll, and any transient
      // validation failure (auth-cache miss + backend blip, stale binary)
      // would 401 us — which used to nuke the user's API key and pop a
      // "Re-authenticating…" flash on the dashboard. Skip the auth entirely;
      // there's nothing the key would unlock for this endpoint.
      const response = await fetch(`http://${host}:${port}/orderbook?symbol=${symbolParam}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data: OrderBookData = await response.json();
      setBids(data.bids || []);
      setAsks(data.asks || []);
      setLastUpdate(data.timestamp || new Date().toISOString());
      setError(null);
    } catch (e: unknown) {
      // Surface the failure honestly — never fall back to fake data.
      setBids([]);
      setAsks([]);
      const msg = e instanceof Error ? e.message : 'fetch failed';
      setError(`${msg} — engine at ${server}`);
    } finally {
      setIsLoading(false);
    }
  }, [symbol, server]);

  useEffect(() => {
    if (isApiKeyLoading) return;
    if (wsStatus === 'open') return;  // WS is feeding state; REST not needed
    setIsLoading(true);
    fetchOrderBook();
    const interval = setInterval(fetchOrderBook, REST_FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchOrderBook, isApiKeyLoading, wsStatus]);

  const maxTotal = Math.max(
    bids.reduce((acc, curr) => acc + curr.size * curr.price, 0),
    asks.reduce((acc, curr) => acc + curr.size * curr.price, 0)
  );

  const filteredBids = bids.filter(bid =>
    !filter || (bid.price.toString().includes(filter) || bid.size.toString().includes(filter))
  );

  const filteredAsks = asks.filter(ask =>
    !filter || (ask.price.toString().includes(filter) || ask.size.toString().includes(filter))
  );

  const transportLabel = wsStatus === 'open' ? 'live' : wsStatus === 'connecting' ? 'connecting' : 'polling';
  const transportClass =
    wsStatus === 'open'
      ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60'
      : wsStatus === 'connecting'
        ? 'bg-amber-900/40 text-amber-300 border border-amber-800/60'
        : 'bg-slate-800 text-slate-400 border border-slate-700';

  return (
    <Card
      title="Order Book"
      action={
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wide ${transportClass}`}>
            {transportLabel}
          </span>
          <select
            title="Select Market"
            className="bg-slate-700 text-xs text-white border-none rounded px-2 py-1 outline-none"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            disabled={symbolNames.length === 0}
          >
            {symbolNames.length === 0 ? (
              <option value={symbol}>{symbol}</option>
            ) : (
              symbolNames.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))
            )}
          </select>
        </div>
      }
    >
      <div className="flex flex-col h-full">
        {isApiKeyLoading ? (
          <div className="text-xs text-slate-500 mb-2 px-2">Initializing authentication...</div>
        ) : error ? (
          <div className="text-xs text-red-400 mb-2 px-2 font-mono">
            {error}
          </div>
        ) : null}
        {!isLoading && lastUpdate && (
          <div className="text-xs text-slate-500 mb-2 px-2">
            Last update: {new Date(parseInt(lastUpdate) || Date.now()).toLocaleTimeString()}
          </div>
        )}
        <div className="mb-3">
          <input
            type="text"
            placeholder="Filter orders..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
          />
        </div>

        {/* Headers */}
        <div className="flex border-b border-slate-800 text-[10px] uppercase text-slate-400 font-semibold mb-1">
          <div className="w-1/2 grid grid-cols-[0.8fr_1fr_1fr] gap-1 px-2 py-1 border-r border-slate-800">
            <span className="text-right">Size</span>
            <span className="text-right">Price</span>
            <span className="text-right">Total</span>
          </div>
          <div className="w-1/2 grid grid-cols-[1fr_0.8fr_1fr] gap-1 px-2 py-1">
            <span className="text-left">Price</span>
            <span className="text-left">Size</span>
            <span className="text-left">Total</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto flex text-[10px] font-mono tabular-nums tracking-tight">
          {/* Bids */}
          <div className="w-1/2 border-r border-slate-800">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                Loading...
              </div>
            ) : filteredBids.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                No bids
              </div>
            ) : (
              filteredBids.map((bid, i) => (
                <div key={`bid-${i}`} className="grid grid-cols-[0.8fr_1fr_1fr] gap-1 px-1 py-0.5 hover:bg-green-900/20 cursor-pointer relative">
                  <div className="absolute top-0 right-0 h-full bg-green-900/20" style={{ width: `${maxTotal > 0 ? ((bid.size * bid.price) / maxTotal) * 100 : 0}%` }} />
                  <span className="text-right text-slate-300 truncate relative z-10">{bid.size.toFixed(3)}</span>
                  <span className="text-right text-green-500 font-bold relative z-10">{bid.price.toFixed(1)}</span>
                  <span className="text-right text-slate-500 relative z-10">{(bid.size * bid.price / 1000).toFixed(1)}k</span>
                </div>
              ))
            )}
          </div>

          {/* Asks */}
          <div className="w-1/2">
            {isLoading ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                Loading...
              </div>
            ) : filteredAsks.length === 0 ? (
              <div className="flex items-center justify-center h-full text-slate-500">
                No asks
              </div>
            ) : (
              filteredAsks.map((ask, i) => (
                <div key={`ask-${i}`} className="grid grid-cols-[1fr_0.8fr_1fr] gap-1 px-1 py-0.5 hover:bg-red-900/20 cursor-pointer relative">
                  <div className="absolute top-0 left-0 h-full bg-red-900/20" style={{ width: `${maxTotal > 0 ? ((ask.size * ask.price) / maxTotal) * 100 : 0}%` }} />
                  <span className="text-left text-red-500 font-bold relative z-10">{ask.price.toFixed(1)}</span>
                  <span className="text-left text-slate-300 truncate relative z-10">{ask.size.toFixed(3)}</span>
                  <span className="text-left text-slate-500 relative z-10">{(ask.size * ask.price / 1000).toFixed(1)}k</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};
