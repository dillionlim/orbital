'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';
import { Card } from '../ui/Card';

interface RetPoint {
  t: number;
  r: number;
}

interface RetInstrument {
  symbol: string;
  kind: string;
  price: number | null;
  returnDay: number | null;
  return10m: number | null;
  seriesDay: RetPoint[];
  series10m: RetPoint[];
}

interface ReturnsResponse {
  instruments?: RetInstrument[];
}

type Window = 'day' | '10m';

const POLL_MS = 3000;
const DEFAULT_VISIBLE = new Set(['ES', 'NIKKEI', 'HSI', 'KOSPI', 'STOXX50']);
const PALETTE = [
  '#facc15',
  '#ef4444',
  '#38bdf8',
  '#a78bfa',
  '#34d399',
  '#fb923c',
  '#f472b6',
  '#22d3ee',
  '#84cc16',
  '#e2e8f0',
  '#60a5fa',
  '#c084fc',
  '#4ade80',
  '#fca5a5',
];

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDateTime(t: number): string {
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function mergeSeries(
  byKey: Map<string, RetPoint[]>,
  keys: string[],
): Record<string, number>[] {
  const times = new Set<number>();
  for (const k of keys) for (const p of byKey.get(k) ?? []) times.add(p.t);
  const sorted = [...times].sort((a, b) => a - b);

  const idx = new Map<string, number>();
  const last = new Map<string, number>();
  keys.forEach((k) => idx.set(k, 0));

  return sorted.map((t) => {
    const row: Record<string, number> = { t };
    for (const k of keys) {
      const arr = byKey.get(k) ?? [];
      let i = idx.get(k) ?? 0;
      while (i < arr.length && arr[i].t <= t) {
        last.set(k, arr[i].r);
        i++;
      }
      idx.set(k, i);
      const v = last.get(k);
      if (v !== undefined) row[k] = v;
    }
    return row;
  });
}

function ReturnsPanel({
  title,
  windowMode,
  instruments,
  colorOf,
  error,
  now,
}: {
  title: string;
  windowMode: Window;
  instruments: RetInstrument[];
  colorOf: Map<string, string>;
  error: string | null;
  now: number;
}) {
  const [visible, setVisible] = useState<Set<string>>(DEFAULT_VISIBLE);

  const onToggle = (sym: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      return next;
    });
  };

  const visibleSymbols = useMemo(
    () => instruments.filter((i) => visible.has(i.symbol)).map((i) => i.symbol),
    [instruments, visible],
  );

  const data = useMemo(() => {
    const byKey = new Map<string, RetPoint[]>();
    for (const ins of instruments) {
      byKey.set(ins.symbol, windowMode === 'day' ? ins.seriesDay : ins.series10m);
    }
    const rows = mergeSeries(byKey, visibleSymbols);
    // Extend each line flat to "now" using the current live return, so the chart
    // reaches the present even when the market is closed (no newer bars). The gap
    // is filled with evenly-spaced points so every time stays hoverable.
    if (now > 0 && rows.length && now > rows[rows.length - 1].t) {
      const lastT = rows[rows.length - 1].t;
      const live: Record<string, number> = {};
      for (const ins of instruments) {
        if (!visible.has(ins.symbol)) continue;
        const v = windowMode === 'day' ? ins.returnDay : ins.return10m;
        if (v != null) live[ins.symbol] = v;
      }
      const span = now - lastT;
      const steps = Math.min(120, Math.max(1, Math.floor(span / 60000)));
      for (let i = 1; i <= steps; i++) {
        rows.push({ t: lastT + (span * i) / steps, ...live });
      }
    }
    return rows;
  }, [instruments, visibleSymbols, windowMode, visible, now]);

  const latest = (ins: RetInstrument) =>
    windowMode === 'day' ? ins.returnDay : ins.return10m;

  // Drag-to-zoom on the time axis.
  const [selStart, setSelStart] = useState<number | null>(null);
  const [selEnd, setSelEnd] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  const finishZoom = () => {
    if (selStart != null && selEnd != null && selStart !== selEnd) {
      setZoom([Math.min(selStart, selEnd), Math.max(selStart, selEnd)]);
    }
    setSelStart(null);
    setSelEnd(null);
  };

  // Rescale Y to whatever's inside the zoomed time window so the zoom is useful.
  const yDomain = useMemo<[number, number] | ['auto', 'auto']>(() => {
    if (!zoom) return ['auto', 'auto'];
    const [lo, hi] = zoom;
    let min = Infinity;
    let max = -Infinity;
    for (const row of data) {
      const t = row.t;
      if (t < lo || t > hi) continue;
      for (const s of visibleSymbols) {
        const v = row[s];
        if (typeof v === 'number') {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (!isFinite(min) || !isFinite(max)) return ['auto', 'auto'];
    const pad = (max - min) * 0.1 || 0.1;
    return [min - pad, max + pad];
  }, [zoom, data, visibleSymbols]);

  return (
    <Card
      title={title}
      action={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">{LOCAL_TZ}</span>
          {zoom && (
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-200 hover:bg-slate-600"
            >
              Reset zoom
            </button>
          )}
        </div>
      }
    >
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}

      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3">
        {instruments.map((ins) => {
          const on = visible.has(ins.symbol);
          const ret = latest(ins);
          return (
            <button
              key={ins.symbol}
              type="button"
              onClick={() => onToggle(ins.symbol)}
              className={`flex items-center gap-1.5 text-[11px] ${on ? 'text-slate-200' : 'text-slate-500'}`}
            >
              <span
                className="w-3 h-0.5 rounded"
                style={{
                  backgroundColor: on ? colorOf.get(ins.symbol) : '#475569',
                }}
              />
              <span>{ins.symbol}</span>
              <span className={ret == null ? 'text-slate-600' : ret >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {pct(ret)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="h-64">
        {data.length < 2 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500">
            Collecting data…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 5, right: 12, bottom: 5, left: 0 }}
              onMouseDown={(e) => {
                if (e?.activeLabel != null) {
                  setSelStart(Number(e.activeLabel));
                  setSelEnd(null);
                }
              }}
              onMouseMove={(e) => {
                if (selStart != null && e?.activeLabel != null) {
                  setSelEnd(Number(e.activeLabel));
                }
              }}
              onMouseUp={finishZoom}
              onDoubleClick={() => setZoom(null)}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={
                  zoom ?? [
                    windowMode === '10m' && now > 0 ? now - 10 * 60 * 1000 : 'dataMin',
                    now > 0 ? now : 'dataMax',
                  ]
                }
                allowDataOverflow
                stroke="#64748b"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(t) => fmtTime(Number(t))}
                minTickGap={40}
              />
              <YAxis
                stroke="#64748b"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={48}
                domain={yDomain}
                allowDataOverflow
                tickFormatter={(v) => `${Number(v).toFixed(2)}%`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: 4,
                  fontSize: 12,
                }}
                labelFormatter={(t) => fmtDateTime(Number(t))}
                formatter={(value, name) => [`${Number(value).toFixed(2)}%`, name]}
              />
              {visibleSymbols.map((s) => (
                <Line
                  key={s}
                  type="monotone"
                  dataKey={s}
                  stroke={colorOf.get(s)}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {selStart != null && selEnd != null && (
                <ReferenceArea
                  x1={selStart}
                  x2={selEnd}
                  strokeOpacity={0.3}
                  fill="#94a3b8"
                  fillOpacity={0.15}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function ReturnsChart() {
  const [instruments, setInstruments] = useState<RetInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch('/api/backend/index-prices/returns', {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ReturnsResponse;
        if (active) {
          setInstruments(data.instruments ?? []);
          setNow(Date.now());
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

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    instruments.forEach((ins, i) => m.set(ins.symbol, PALETTE[i % PALETTE.length]));
    return m;
  }, [instruments]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <ReturnsPanel
        title="10-min Returns"
        windowMode="10m"
        instruments={instruments}
        colorOf={colorOf}
        error={error}
        now={now}
      />
      <ReturnsPanel
        title="Daily Returns"
        windowMode="day"
        instruments={instruments}
        colorOf={colorOf}
        error={error}
        now={now}
      />
    </div>
  );
}
