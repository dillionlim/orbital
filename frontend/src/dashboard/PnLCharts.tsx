import React, { useEffect, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Filter, ChevronDown, Check } from 'lucide-react';
import { useCurrentServer } from '../hooks/useCurrentServer';

interface EngineBot {
  user_id: string;
  client_id: string;
  name: string;
  is_internal: boolean;
  total_pnl: number;
  hourly_pnl: number;
}

const POLL_MS = 1500;
const MAX_POINTS = 120;            // 120 × 1.5s ≈ 3 min of history
const TOTAL_KEY = 'Total';

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#ec4899', '#22d3ee', '#84cc16', '#f97316'];

function colorFor(name: string, idx: number): string {
  if (name === TOTAL_KEY) return PALETTE[0];
  return PALETTE[(idx + 1) % PALETTE.length];
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

type Point = Record<string, number | string>;

export const PnLCharts: React.FC = () => {
  const [points, setPoints] = useState<Point[]>([]);
  const [hourlyPoints, setHourlyPoints] = useState<Point[]>([]);
  const [seriesNames, setSeriesNames] = useState<string[]>([TOTAL_KEY]);
  const [visibleSeries, setVisibleSeries] = useState<string[]>([TOTAL_KEY]);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const knownSeriesRef = useRef<Set<string>>(new Set([TOTAL_KEY]));
  const server = useCurrentServer();

  // Hard-reset all derived state when the user switches engines. Without this,
  // the chart keeps the previous server's history (and worse, accumulates new
  // points onto the same series), making a flat-line idle server look like
  // it's still trading.
  useEffect(() => {
    setPoints([]);
    setHourlyPoints([]);
    knownSeriesRef.current = new Set([TOTAL_KEY]);
    setSeriesNames([TOTAL_KEY]);
    setVisibleSeries([TOTAL_KEY]);
    setError(null);
  }, [server]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`http://${server}/bots`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { bots: EngineBot[] };
        if (!alive) return;
        setError(null);

        const now = Date.now();
        const time = fmtTime(now);
        const totalRow: Point = { time };
        const hourlyRow: Point = { time };
        let total = 0;
        let totalHourly = 0;

        for (const b of data.bots) {
          const key = b.name || b.user_id;
          totalRow[key] = b.total_pnl;
          hourlyRow[key] = b.hourly_pnl;
          total += b.total_pnl;
          totalHourly += b.hourly_pnl;
          if (!knownSeriesRef.current.has(key)) {
            knownSeriesRef.current.add(key);
          }
        }
        totalRow[TOTAL_KEY] = total;
        hourlyRow[TOTAL_KEY] = totalHourly;

        // Re-publish series names so a new bot becomes selectable.
        setSeriesNames(prev => {
          const next = Array.from(knownSeriesRef.current);
          if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
          return next;
        });
        setVisibleSeries(prev => {
          // Auto-add newly discovered series to the visible set.
          const next = new Set(prev);
          for (const k of knownSeriesRef.current) next.add(k);
          if (next.size === prev.length && prev.every(s => next.has(s))) return prev;
          return Array.from(next);
        });

        setPoints(prev => [...prev, totalRow].slice(-MAX_POINTS));
        setHourlyPoints(prev => [...prev, hourlyRow].slice(-MAX_POINTS));
      } catch (e: unknown) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
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

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const toggleSeries = (s: string) =>
    setVisibleSeries(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  const lastTotal = points.length > 0 ? Number(points[points.length - 1][TOTAL_KEY]) : 0;
  const firstTotal = points.length > 0 ? Number(points[0][TOTAL_KEY]) : 0;
  const totalDelta = lastTotal - firstTotal;
  const totalDeltaPct = firstTotal !== 0 ? (totalDelta / Math.abs(firstTotal)) * 100 : 0;

  return (
    // Plain div, not Card — Card's p-4 is on an inner element that className
    // can't reach, which used to indent the PnL content relative to every
    // other widget on the dashboard.
    <div className="w-full">
      <div className="flex justify-between items-center mb-4 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
        <div className="flex items-center gap-2 px-2 text-slate-400">
          <span className="text-xs font-medium uppercase tracking-wider">Performance Analytics</span>
          {error && <span className="text-[10px] text-red-400 font-mono">offline</span>}
        </div>

        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 hover:border-slate-500 rounded text-xs font-medium text-slate-200 transition-colors"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Series</span>
            <span className="bg-slate-700 text-slate-300 px-1.5 rounded-full text-[10px]">{visibleSeries.length}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${isFilterOpen ? 'rotate-180' : ''}`} />
          </button>

          {isFilterOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden">
              <div className="p-2 space-y-1 max-h-72 overflow-auto">
                {seriesNames.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSeries(s)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-md transition-colors ${
                      visibleSeries.includes(s) ? 'bg-slate-700/50 text-white' : 'text-slate-400 hover:bg-slate-700/30'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(s, i) }} />
                      <span className="truncate">{s}</span>
                    </div>
                    {visibleSeries.includes(s) && <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Total PnL */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-slate-200">Total PnL</h3>
            <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
              totalDelta >= 0 ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
            }`}>
              {totalDelta >= 0 ? '+' : ''}{totalDelta.toFixed(2)}
              {firstTotal !== 0 && ` (${totalDeltaPct >= 0 ? '+' : ''}${totalDeltaPct.toFixed(1)}%)`}
            </span>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveEnd" />
                <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={50}
                       tickFormatter={(v: number) => v.toFixed(0)} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
                         itemStyle={{ fontSize: 12, padding: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {seriesNames.filter(s => visibleSeries.includes(s)).map((s, i) => (
                  <Line key={s} type="monotone" dataKey={s} stroke={colorFor(s, i)}
                        strokeWidth={s === TOTAL_KEY ? 2 : 1.5} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hourly PnL */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold text-slate-200">1h Realized PnL</h3>
            <span className="text-xs text-slate-400">rolling 60min</span>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hourlyPoints} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveEnd" />
                <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={50} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
                         itemStyle={{ fontSize: 12, padding: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {seriesNames.filter(s => visibleSeries.includes(s)).map((s, i) => (
                  <Line key={`${s}_h`} type="step" dataKey={s} stroke={colorFor(s, i)}
                        strokeWidth={s === TOTAL_KEY ? 2 : 1.5} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
