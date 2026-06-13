import React, { useEffect, useRef, useState } from 'react';
import { Card } from '../ui/Card';
import { Trade } from '../types';
import { useEngineStream } from '../hooks/useEngineStream';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useSymbols } from '../services/symbols';
import type { EngineTradeMessage } from '../services/engineStream';

interface EngineTrade {
  trade_id: number;
  symbol: string;
  price: number;
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
}

const REST_FALLBACK_POLL_MS = 1000;
const MAX_TRADES = 50;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function toTrade(t: EngineTrade | EngineTradeMessage): Trade {
  return {
    id: String(t.trade_id),
    time: fmtTime(t.ts),
    instrument: t.symbol || '?',
    price: t.price,
    volume: t.quantity,
    aggressor: t.taker_side === 'Buy' ? 'Buyer' : 'Seller',
  };
}

export const GlobalTradeTicker: React.FC = () => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { stream, status: wsStatus } = useEngineStream();
  const server = useCurrentServer();
  const { names: symbolNames } = useSymbols();
  const seededRef = useRef(false);

  // Wipe the trade list whenever the user switches servers — old trades from
  // a different engine must not appear under the new one. Re-seed on next WS
  // open by clearing the seeded flag.
  useEffect(() => {
    setTrades([]);
    setError(null);
    seededRef.current = false;
  }, [server]);

  // ---- WS path: subscribe per symbol; prepend on each trade ----------------

  useEffect(() => {
    if (!stream) return;
    if (symbolNames.length === 0) return;   // wait for /symbols
    const offs = symbolNames.map((sym) =>
      stream.subscribe<EngineTradeMessage>('trades', sym, (msg) => {
        const t = toTrade(msg);
        setTrades((prev) => {
          // Drop dupes (engine may resend during reconnect window).
          if (prev.length > 0 && prev[0].id === t.id) return prev;
          return [t, ...prev].slice(0, MAX_TRADES);
        });
        setError(null);
      })
    );
    return () => { offs.forEach((off) => off()); };
  }, [stream, symbolNames]);

  // ---- One-shot REST seed when WS first opens (so we have history) ---------
  // Without this, the ticker is empty until the next trade lands. Run only
  // once per (server, page-load) so we don't repeatedly clobber WS-driven state.

  useEffect(() => {
    if (wsStatus !== 'open' || seededRef.current) return;
    seededRef.current = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    fetch(`http://${server}/trades?limit=${MAX_TRADES}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { trades: EngineTrade[] }) => {
        setTrades((prev) => {
          // If WS has already pushed something, prefer those (more recent).
          // Merge the seed below, dedupe by id, cap.
          const existingIds = new Set(prev.map((p) => p.id));
          const seeded = (data.trades || [])
            .map(toTrade)
            .filter((t) => !existingIds.has(t.id));
          return [...prev, ...seeded].slice(0, MAX_TRADES);
        });
      })
      .catch(() => { /* seed failure is non-fatal — WS will fill */ })
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [wsStatus, server]);

  // ---- REST fallback: poll only when WS is not open ------------------------

  useEffect(() => {
    if (wsStatus === 'open') return;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchTrades = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`http://${server}/trades?limit=${MAX_TRADES}`, {
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { trades: EngineTrade[] };
        if (!alive) return;
        setTrades((data.trades || []).map(toTrade));
        setError(null);
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (alive) timer = setTimeout(fetchTrades, REST_FALLBACK_POLL_MS);
      }
    };

    fetchTrades();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [wsStatus, server]);

  const filtered = trades.filter(t =>
    t.instrument.toLowerCase().includes(filter.toLowerCase())
  );

  const transportLabel =
    wsStatus === 'open' ? 'live' :
    wsStatus === 'connecting' ? 'connecting' :
    error ? 'offline' :
    trades.length > 0 ? 'polling' : 'idle';
  const transportClass =
    wsStatus === 'open'
      ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60'
      : wsStatus === 'connecting'
        ? 'bg-amber-900/40 text-amber-300 border border-amber-800/60'
        : error
          ? 'bg-red-900/40 text-red-300 border border-red-800/60'
          : 'bg-slate-800 text-slate-400 border border-slate-700';

  return (
    <Card title="Global Trade Ticker" className="h-[350px]">
      <div className="flex flex-col h-full">
        <div className="mb-3 flex gap-2 items-center">
          <input
            type="text"
            placeholder="Filter by instrument…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
          />
          <span
            className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wide ${transportClass}`}
            title={error ?? `${trades.length} trades`}
          >
            {transportLabel}
          </span>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="text-[10px] uppercase text-slate-400 bg-slate-800 sticky top-0">
              <tr>
                <th className="px-2 py-1.5">Time</th>
                <th className="px-2 py-1.5">Inst</th>
                <th className="px-2 py-1.5 text-right">Price</th>
                <th className="px-2 py-1.5 text-right">Vol</th>
                <th className="px-2 py-1.5 text-right">Aggressor</th>
              </tr>
            </thead>
            <tbody className="text-xs font-mono divide-y divide-slate-800/50">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-slate-500 text-xs">
                    {error
                      ? `No engine at ${server}`
                      : 'No trades yet — bots haven’t crossed the book.'}
                  </td>
                </tr>
              )}
              {filtered.map((trade) => (
                <tr key={trade.id} className="hover:bg-slate-700/30">
                  <td className="px-2 py-1 text-slate-400">{trade.time}</td>
                  <td className="px-2 py-1 text-blue-400">{trade.instrument}</td>
                  <td className={`px-2 py-1 text-right ${trade.aggressor === 'Buyer' ? 'text-green-500' : 'text-red-500'}`}>
                    {trade.price.toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-300">{trade.volume.toLocaleString()}</td>
                  <td className={`px-2 py-1 text-right ${trade.aggressor === 'Buyer' ? 'text-green-400' : 'text-red-400'}`}>
                    {trade.aggressor}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
};
