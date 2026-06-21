import React, { useEffect, useRef, useState } from 'react';
import { Card } from '../ui/Card';
import { useApiKey } from '../hooks/useApiKey';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { httpBase } from '../services/engineUrl';

interface Fill {
  trade_id: number;
  symbol: string;
  price: number;
  quantity: number;
  side: 'Buy' | 'Sell';
  ts: number;
}

interface MeFillsResponse {
  user_id: string;
  fills: Fill[];
}

const POLL_MS = 1500;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// The authenticated user's own executions, polled from the engine's
// key-gated GET /me/fills (fills across all of their bot sessions).
export const MyTrades: React.FC = () => {
  const { apiKey, isLoading: keyLoading } = useApiKey();
  const server = useCurrentServer();
  const [fills, setFills] = useState<Fill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seenServer = useRef(server);

  useEffect(() => {
    if (seenServer.current !== server) {
      seenServer.current = server;
      setFills([]);
    }
  }, [server]);

  useEffect(() => {
    if (!apiKey) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${httpBase(server)}/me/fills?limit=50`, {
          headers: { 'Api-Key': apiKey },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MeFillsResponse;
        if (!alive) return;
        setFills(data.fills ?? []);
        setError(null);
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (alive) timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [apiKey, server]);

  const status = !apiKey ? 'no key' : error ? 'offline' : 'live';
  const statusClass = !apiKey
    ? 'bg-slate-800 text-slate-400 border border-slate-700'
    : error
      ? 'bg-red-900/40 text-red-300 border border-red-800/60'
      : 'bg-emerald-900/40 text-emerald-300 border border-emerald-800/60';

  return (
    <Card
      title="My Trades"
      className="h-[350px]"
      action={
        <span className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wide ${statusClass}`}>
          {status}
        </span>
      }
    >
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="text-[10px] uppercase text-slate-400 bg-slate-800 sticky top-0">
              <tr>
                <th className="px-2 py-1.5">Time</th>
                <th className="px-2 py-1.5">Inst</th>
                <th className="px-2 py-1.5 text-right">Side</th>
                <th className="px-2 py-1.5 text-right">Price</th>
                <th className="px-2 py-1.5 text-right">Qty</th>
              </tr>
            </thead>
            <tbody className="text-xs font-mono divide-y divide-slate-800/50">
              {fills.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-slate-500 text-xs">
                    {keyLoading
                      ? 'Loading…'
                      : !apiKey
                        ? 'Generate an API key and connect a bot to see your fills.'
                        : error
                          ? `No engine at ${server}`
                          : 'No fills yet — your bots haven’t traded.'}
                  </td>
                </tr>
              )}
              {fills.map((f) => (
                <tr key={f.trade_id} className="hover:bg-slate-700/30">
                  <td className="px-2 py-1 text-slate-400">{fmtTime(f.ts)}</td>
                  <td className="px-2 py-1 text-blue-400">{f.symbol}</td>
                  <td className={`px-2 py-1 text-right ${f.side === 'Buy' ? 'text-green-400' : 'text-red-400'}`}>
                    {f.side}
                  </td>
                  <td className="px-2 py-1 text-right text-slate-300">{f.price.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-slate-300">{f.quantity.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
};
