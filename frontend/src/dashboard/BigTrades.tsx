import React, { useEffect, useRef, useState } from 'react';
import { Card } from '../ui/Card';
import { Trade } from '../types';
import { useEngineStream } from '../hooks/useEngineStream';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useSymbols } from '../services/symbols';
import type { EngineTradeMessage } from '../services/engineStream';
import { httpBase } from '../services/engineUrl';

interface EngineTrade {
  trade_id: number;
  symbol: string;
  price: number;
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
}

const REST_FALLBACK_POLL_MS = 1000;
const BUFFER = 400; // keep a deep buffer so the size filter still has matches
const MAX_ROWS = 50;
const DEFAULT_MIN_SIZE = 20;

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

// Like the Global Trade Ticker, but surfaces only large prints (volume >= a
// user-set threshold) — the block trades that move the book.
export const BigTrades: React.FC = () => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [minSize, setMinSize] = useState<number>(DEFAULT_MIN_SIZE);
  const [error, setError] = useState<string | null>(null);

  const { stream, status: wsStatus } = useEngineStream();
  const server = useCurrentServer();
  const { names: symbolNames } = useSymbols();
  const seededRef = useRef(false);

  useEffect(() => {
    setTrades([]);
    setError(null);
    seededRef.current = false;
  }, [server]);

  // WS: subscribe per symbol; keep a deep rolling buffer of all trades.
  useEffect(() => {
    if (!stream) return;
    if (symbolNames.length === 0) return;
    const offs = symbolNames.map((sym) =>
      stream.subscribe<EngineTradeMessage>('trades', sym, (msg) => {
        const t = toTrade(msg);
        setTrades((prev) => {
          if (prev.length > 0 && prev[0].id === t.id) return prev;
          return [t, ...prev].slice(0, BUFFER);
        });
        setError(null);
      }),
    );
    return () => { offs.forEach((off) => off()); };
  }, [stream, symbolNames]);

  // One-shot REST seed when WS opens.
  useEffect(() => {
    if (wsStatus !== 'open' || seededRef.current) return;
    seededRef.current = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    fetch(`${httpBase(server)}/trades?limit=${BUFFER}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { trades: EngineTrade[] }) => {
        setTrades((prev) => {
          const ids = new Set(prev.map((p) => p.id));
          const seeded = (data.trades || []).map(toTrade).filter((x) => !ids.has(x.id));
          return [...prev, ...seeded].slice(0, BUFFER);
        });
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [wsStatus, server]);

  // REST fallback poll when WS is down.
  useEffect(() => {
    if (wsStatus === 'open') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${httpBase(server)}/trades?limit=${BUFFER}`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { trades: EngineTrade[] };
        if (!alive) return;
        setTrades((data.trades || []).map(toTrade));
        setError(null);
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (alive) timer = setTimeout(poll, REST_FALLBACK_POLL_MS);
      }
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [wsStatus, server]);

  const big = trades.filter((t) => t.volume >= minSize).slice(0, MAX_ROWS);

  return (
    <Card title="Big Trades" className="h-[350px]">
      <div className="flex flex-col h-full">
        <div className="mb-3 flex gap-2 items-center">
          <label className="text-[10px] uppercase text-slate-500">Min size</label>
          <input
            type="number"
            min={1}
            value={minSize}
            onChange={(e) => setMinSize(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:border-blue-500 outline-none"
          />
          <span className="text-[10px] text-slate-500">{big.length} shown</span>
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
              {big.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-slate-500 text-xs">
                    {error ? `No engine at ${server}` : `No trades ≥ ${minSize} yet.`}
                  </td>
                </tr>
              )}
              {big.map((trade) => (
                <tr key={trade.id} className="hover:bg-slate-700/30">
                  <td className="px-2 py-1 text-slate-400">{trade.time}</td>
                  <td className="px-2 py-1 text-blue-400">{trade.instrument}</td>
                  <td className={`px-2 py-1 text-right ${trade.aggressor === 'Buyer' ? 'text-green-500' : 'text-red-500'}`}>
                    {trade.price.toFixed(2)}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-200 font-semibold">{trade.volume.toLocaleString()}</td>
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
