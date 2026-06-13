'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { INDEX_SYMBOLS, SYMBOL_LABELS } from './symbols';

interface IdxRow {
  symbol: string;
  price: number | null;
  open: boolean;
  return10m: number | null;
  returnDay: number | null;
}

interface IndicesResponse {
  indices?: IdxRow[];
}

const POLL_MS = 3000;

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
}

function color(v: number | null): string {
  if (v == null) return 'text-slate-400';
  return v >= 0 ? 'text-emerald-400' : 'text-red-400';
}

// Read-only list of cash indices (not tradeable — no order book). The time-series
// return graphs live in the separate Returns chart.
export function IndicesPanel() {
  const [rows, setRows] = useState<IdxRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch('/api/backend/index-prices/indices', {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as IndicesResponse;
        if (active) {
          setRows(data.indices ?? []);
          setError(null);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <Card
      title="Indices"
      action={
        <span className="text-[10px] text-slate-500 uppercase tracking-wide">
          reference · not tradeable
        </span>
      }
    >
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}

      <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-slate-500 pb-2 border-b border-slate-700/60">
        <div className="col-span-5">Index</div>
        <div className="col-span-3 text-right">Price</div>
        <div className="col-span-2 text-right">10-min</div>
        <div className="col-span-2 text-right">Daily</div>
      </div>

      <div className="flex flex-col divide-y divide-slate-700/40">
        {rows.map((r) => (
          <div key={r.symbol} className="grid grid-cols-12 gap-2 items-center py-2">
            <div className="col-span-5">
              <div className="text-sm font-medium text-slate-200">
                {SYMBOL_LABELS[r.symbol] ?? r.symbol}
              </div>
              <div className="text-[10px] text-slate-500">
                {r.open ? 'open' : 'closed'}
              </div>
            </div>
            <div className="col-span-3 text-right font-mono text-sm text-slate-200">
              {r.price != null
                ? r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : '—'}
            </div>
            <div className={`col-span-2 text-right font-mono text-xs ${color(r.return10m)}`}>
              {pct(r.return10m)}
            </div>
            <div className={`col-span-2 text-right font-mono text-xs ${color(r.returnDay)}`}>
              {pct(r.returnDay)}
            </div>
          </div>
        ))}

        {!rows.length && !error && (
          <div className="text-xs text-slate-500 py-4">Loading indices…</div>
        )}
        {!rows.length && (
          <div className="text-[10px] text-slate-600 pt-2">
            Tracking: {INDEX_SYMBOLS.join(', ')}
          </div>
        )}
      </div>
    </Card>
  );
}
