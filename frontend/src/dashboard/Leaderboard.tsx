'use client';

import React, { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useEngineUserId } from '../hooks/useEngineUserId';
import { httpBase } from '../services/engineUrl';
import { supabase } from '../lib/supabase';

interface Row {
  user_id: string;
  total_pnl: number;
  fills: number;
  volume: number;
  bots: number;
}

const POLL_MS = 5000;

export const Leaderboard: React.FC = () => {
  const server = useCurrentServer();
  const engineUserId = useEngineUserId();
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows([]);
    setNames({});
    setError(null);
  }, [server]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${httpBase(server)}/leaderboard`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { leaderboard: Row[] };
        if (!alive) return;
        const lb = data.leaderboard || [];
        setRows(lb);
        setError(null);

        // Resolve usernames (best-effort) via the backend.
        const ids = lb.map((r) => r.user_id);
        if (ids.length) {
          try {
            const { data: sess } = await supabase.auth.getSession();
            const token = sess.session?.access_token;
            const nr = await fetch('/api/backend/users/names', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ ids }),
            });
            if (nr.ok && alive) {
              setNames((await nr.json()) as Record<string, string>);
            }
          } catch {
            // names are cosmetic; fall back to short id
          }
        }
      } catch (e: unknown) {
        if (alive) setError(e instanceof Error ? e.message : 'fetch failed');
      } finally {
        if (alive) timer = setTimeout(tick, POLL_MS);
      }
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [server]);

  const label = (id: string) => names[id] || `${id.slice(0, 8)}…`;
  const fmt = (n: number) =>
    (n >= 0 ? '+' : '') + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-yellow-400" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
          Leaderboard
        </h2>
      </div>

      {error && rows.length === 0 ? (
        <p className="text-xs text-slate-500 py-6 text-center">No engine at {server}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500 py-6 text-center">No traders yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-700">
              <th className="text-left font-medium py-1.5 w-8">#</th>
              <th className="text-left font-medium py-1.5">Trader</th>
              <th className="text-right font-medium py-1.5">Total PnL</th>
              <th className="text-right font-medium py-1.5 hidden sm:table-cell">Fills</th>
              <th className="text-right font-medium py-1.5 hidden sm:table-cell">Bots</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isYou = !!engineUserId && r.user_id === engineUserId;
              return (
                <tr
                  key={r.user_id}
                  className={`border-b border-slate-800/60 ${isYou ? 'bg-blue-500/10' : ''}`}
                >
                  <td className="py-1.5 text-slate-500">{i + 1}</td>
                  <td className="py-1.5">
                    <span className={isYou ? 'text-blue-300 font-medium' : 'text-slate-200'}>
                      {label(r.user_id)}
                    </span>
                    {isYou && <span className="ml-1 text-[10px] text-blue-400">(you)</span>}
                  </td>
                  <td
                    className={`py-1.5 text-right font-mono ${
                      r.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {fmt(r.total_pnl)}
                  </td>
                  <td className="py-1.5 text-right text-slate-400 hidden sm:table-cell">{r.fills}</td>
                  <td className="py-1.5 text-right text-slate-400 hidden sm:table-cell">{r.bots}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};
