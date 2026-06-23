import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Filter, ChevronDown, Check, Info } from 'lucide-react';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useEngineUserId } from '../hooks/useEngineUserId';
import { supabase } from '../lib/supabase';
import { httpBase } from '../services/engineUrl';

interface LeaderRow {
  user_id: string;
  total_pnl: number;
  fills: number;
  volume: number;
  bots: number;
}

const POLL_MS = 1500;
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#ec4899', '#22d3ee', '#84cc16', '#f97316'];

interface WindowPreset { label: string; ms: number; }
const WINDOW_PRESETS: WindowPreset[] = [
  { label: '5m',  ms:   5 * 60 * 1000 },
  { label: '15m', ms:  15 * 60 * 1000 },
  { label: '30m', ms:  30 * 60 * 1000 },
  { label: '1h',  ms:  60 * 60 * 1000 },
  { label: '6h',  ms: 360 * 60 * 1000 },
  { label: '24h', ms: 1440 * 60 * 1000 },
];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtWindow(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h`;
}

// Each point holds the clock label, the numeric timestamp (for window deltas),
// and one numeric column per player (keyed by user_id; the legend shows the
// username via each Line's `name` prop).
type Point = { time: string; tsMs: number; [series: string]: number | string };

const InfoTip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="relative inline-flex group align-middle ml-1">
    <Info className="w-3.5 h-3.5 text-slate-500 hover:text-slate-300 transition-colors cursor-help" />
    <span
      role="tooltip"
      className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity
                 absolute left-0 top-full mt-2 z-30 w-96
                 bg-slate-900 border border-slate-700 rounded-md p-3 shadow-xl
                 text-[11px] leading-snug text-slate-300 font-normal normal-case
                 pointer-events-none"
    >
      {children}
    </span>
  </span>
);

export const PnLCharts: React.FC = () => {
  const [points, setPoints] = useState<Point[]>([]);
  const [seriesIds, setSeriesIds] = useState<string[]>([]);
  const [visibleSeries, setVisibleSeries] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isWindowOpen, setIsWindowOpen] = useState(false);
  const [windowMs, setWindowMs] = useState<number>(60 * 60 * 1000);   // default 1h
  const [customMinsInput, setCustomMinsInput] = useState<string>('');
  const filterRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const knownSeriesRef = useRef<Set<string>>(new Set());
  const namesRef = useRef<Record<string, string>>({});
  useEffect(() => { namesRef.current = names; }, [names]);

  const server = useCurrentServer();
  const engineUserId = useEngineUserId();
  const engineUserIdRef = useRef<string | null>(engineUserId);
  useEffect(() => { engineUserIdRef.current = engineUserId; }, [engineUserId]);

  // Server change resets the comparison (different engine, different players).
  useEffect(() => {
    setPoints([]);
    knownSeriesRef.current = new Set();
    setSeriesIds([]);
    setVisibleSeries([]);
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
        const data = await res.json() as { leaderboard: LeaderRow[] };
        if (!alive) return;
        setError(null);
        const lb = data.leaderboard || [];

        // Resolve usernames for any players we haven't named yet (best-effort).
        const me = engineUserIdRef.current;
        const unknown = lb
          .map((r) => r.user_id)
          .filter((id) => id !== me && !(id in namesRef.current));
        if (unknown.length) {
          try {
            const { data: sess } = await supabase.auth.getSession();
            const token = sess.session?.access_token;
            const nr = await fetch('/api/backend/users/names', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ ids: lb.map((r) => r.user_id) }),
            });
            if (nr.ok && alive) {
              const map = (await nr.json()) as Record<string, string>;
              setNames((prev) => ({ ...prev, ...map }));
            }
          } catch {
            // names are cosmetic — fall back to a short id
          }
        }

        const now = Date.now();
        const row: Point = { time: fmtTime(now), tsMs: now };
        for (const r of lb) {
          row[r.user_id] = r.total_pnl;
          knownSeriesRef.current.add(r.user_id);
        }

        setSeriesIds((prev) => {
          const next = Array.from(knownSeriesRef.current);
          if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
          return next;
        });
        setVisibleSeries((prev) => {
          const next = new Set(prev);
          for (const k of knownSeriesRef.current) next.add(k);
          if (next.size === prev.length && prev.every((s) => next.has(s))) return prev;
          return Array.from(next);
        });
        setPoints((prev) => [...prev, row]);
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
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setIsFilterOpen(false);
      if (windowRef.current && !windowRef.current.contains(e.target as Node)) setIsWindowOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const toggleSeries = (s: string) =>
    setVisibleSeries((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const applyCustomMins = () => {
    const mins = Number(customMinsInput);
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) return;
    setWindowMs(Math.round(mins * 60 * 1000));
    setIsWindowOpen(false);
  };

  const youId = engineUserId;
  const isYou = (uid: string) => !!youId && uid === youId;
  const label = (uid: string) => (isYou(uid) ? 'Yours' : names[uid] || `${uid.slice(0, 8)}…`);
  const colorFor = (uid: string, idx: number) => (isYou(uid) ? PALETTE[0] : PALETTE[(idx + 1) % PALETTE.length]);

  // Your headline value (keyed by your user id).
  const yourKey = youId ?? '__none__';
  const lastTotal = points.length > 0 ? Number(points[points.length - 1][yourKey] ?? 0) : 0;
  const firstTotal = points.length > 0 ? Number(points[0][yourKey] ?? 0) : 0;
  const totalDelta = lastTotal - firstTotal;
  const totalDenom = Math.max(Math.abs(firstTotal), Math.abs(lastTotal));
  const totalDeltaPct = totalDenom > 0.01 ? (totalDelta / totalDenom) * 100 : null;

  // Realized (windowed) chart derived from the cumulative `points` on the fly.
  const hourlyPoints = useMemo<Point[]>(() => {
    if (points.length === 0) return [];
    const out: Point[] = [];
    let baseIdx = 0;
    for (let i = 0; i < points.length; ++i) {
      const cur = points[i];
      const cutoff = cur.tsMs - windowMs;
      while (baseIdx + 1 < i && points[baseIdx + 1].tsMs <= cutoff) ++baseIdx;
      const base = points[baseIdx];
      const r: Point = { time: cur.time, tsMs: cur.tsMs };
      for (const k of Object.keys(cur)) {
        if (k === 'time' || k === 'tsMs') continue;
        r[k] = Number(cur[k]) - Number(base[k] ?? 0);
      }
      out.push(r);
    }
    if (out.length === 0) return out;
    const visibleFrom = out[out.length - 1].tsMs - windowMs;
    let firstVisible = 0;
    while (firstVisible < out.length && out[firstVisible].tsMs < visibleFrom) ++firstVisible;
    return firstVisible === 0 ? out : out.slice(firstVisible);
  }, [points, windowMs]);

  const lastWindowed = hourlyPoints.length > 0 ? Number(hourlyPoints[hourlyPoints.length - 1][yourKey] ?? 0) : 0;
  const firstWindowed = hourlyPoints.length > 0 ? Number(hourlyPoints[0][yourKey] ?? 0) : 0;
  const windowedDelta = lastWindowed - firstWindowed;
  const windowedDenom = Math.max(Math.abs(firstWindowed), Math.abs(lastWindowed));
  const windowedDeltaPct = windowedDenom > 0.01 ? (windowedDelta / windowedDenom) * 100 : null;

  const matchedPreset = WINDOW_PRESETS.find((p) => p.ms === windowMs) ?? null;
  const windowLabel = matchedPreset ? matchedPreset.label : fmtWindow(windowMs);

  const renderLines = (suffix: string) =>
    seriesIds
      .filter((s) => visibleSeries.includes(s))
      .map((s, i) => (
        <Line
          key={`${s}_${suffix}`}
          type="monotone"
          dataKey={s}
          name={label(s)}
          stroke={colorFor(s, i)}
          strokeWidth={isYou(s) ? 2.5 : 1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
      ));

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-4 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
        <div className="flex items-center gap-2 px-2 text-slate-400">
          <span className="text-xs font-medium uppercase tracking-wider">PnL Comparison</span>
          <InfoTip>
            <div className="space-y-2.5">
              <div>
                Each line is one <span className="text-slate-100 font-semibold">player&apos;s
                aggregate PnL</span> (all of their bots summed). Your own line is highlighted
                as <span className="text-blue-300 font-semibold">Yours</span>.
              </div>
              <div>
                <span className="text-slate-100 font-semibold">Total</span> — cumulative since
                the dashboard opened. <span className="text-slate-100 font-semibold">Realized</span>
                {' '}— change over the selected sliding window.
              </div>
              <div className="pt-1 border-t border-slate-700/60 text-[10px] text-slate-400">
                Individual bot details stay private — only per-player totals are shared.
              </div>
            </div>
          </InfoTip>
          {error && <span className="text-[10px] text-red-400 font-mono">offline</span>}
        </div>

        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 hover:border-slate-500 rounded text-xs font-medium text-slate-200 transition-colors"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Players</span>
            <span className="bg-slate-700 text-slate-300 px-1.5 rounded-full text-[10px]">{visibleSeries.length}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${isFilterOpen ? 'rotate-180' : ''}`} />
          </button>

          {isFilterOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden">
              <div className="p-2 space-y-1 max-h-72 overflow-auto">
                {seriesIds.map((s, i) => (
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
                      <span className="truncate">{label(s)}</span>
                    </div>
                    {visibleSeries.includes(s) && <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                  </button>
                ))}
                {seriesIds.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-500">No players yet.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Total PnL — all players */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-start mb-4 gap-2">
            <h3 className="text-sm font-semibold text-slate-200">
              Total PnL
              {!engineUserId && <span className="ml-2 text-[10px] text-slate-500 font-normal">(no API key)</span>}
            </h3>
            <div className="flex flex-col items-end shrink-0">
              <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
                lastTotal >= 0 ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
              }`}>
                Yours {lastTotal >= 0 ? '+' : ''}{lastTotal.toFixed(2)}
                {totalDeltaPct !== null && ` (${totalDeltaPct >= 0 ? '+' : ''}${totalDeltaPct.toFixed(1)}%)`}
              </span>
              {points.length > 1 && (
                <span className={`text-[10px] mt-0.5 font-mono ${totalDelta >= 0 ? 'text-green-500/70' : 'text-red-500/70'}`}>
                  Δ {totalDelta >= 0 ? '+' : ''}{totalDelta.toFixed(2)} (chart)
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveEnd" />
                <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={50} tickFormatter={(v: number) => v.toFixed(0)} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }} itemStyle={{ fontSize: 12, padding: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {renderLines('t')}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Realized PnL — sliding window, all players */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-start mb-4 gap-2">
            <h3 className="text-sm font-semibold text-slate-200 truncate">{windowLabel} Realized PnL</h3>
            <div className="flex items-start gap-2 shrink-0">
              <div className="flex flex-col items-end">
                <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
                  lastWindowed >= 0 ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
                }`}>
                  Yours {lastWindowed >= 0 ? '+' : ''}{lastWindowed.toFixed(2)}
                  {windowedDeltaPct !== null && ` (${windowedDeltaPct >= 0 ? '+' : ''}${windowedDeltaPct.toFixed(1)}%)`}
                </span>
                {hourlyPoints.length > 1 && (
                  <span className={`text-[10px] mt-0.5 font-mono ${windowedDelta >= 0 ? 'text-green-500/70' : 'text-red-500/70'}`}>
                    Δ {windowedDelta >= 0 ? '+' : ''}{windowedDelta.toFixed(2)} (chart)
                  </span>
                )}
              </div>
              <div className="relative" ref={windowRef}>
                <button
                  type="button"
                  onClick={() => setIsWindowOpen(!isWindowOpen)}
                  className="flex items-center gap-1 px-2 py-1 bg-slate-900 border border-slate-700 hover:border-slate-500 rounded text-[11px] font-mono text-slate-200 transition-colors"
                >
                  <span>{windowLabel}</span>
                  <ChevronDown className={`w-3 h-3 text-slate-500 transition-transform ${isWindowOpen ? 'rotate-180' : ''}`} />
                </button>

                {isWindowOpen && (
                  <div className="absolute right-0 top-full mt-2 w-44 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden">
                    <div className="p-2 space-y-1">
                      {WINDOW_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => { setWindowMs(p.ms); setIsWindowOpen(false); }}
                          className={`w-full flex items-center justify-between px-3 py-1.5 text-xs rounded-md transition-colors ${
                            windowMs === p.ms ? 'bg-slate-700/50 text-white' : 'text-slate-400 hover:bg-slate-700/30'
                          }`}
                        >
                          <span>{p.label}</span>
                          {windowMs === p.ms && <Check className="w-3 h-3 text-blue-400" />}
                        </button>
                      ))}
                      <div className="pt-1 mt-1 border-t border-slate-700">
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">Custom (min)</div>
                        <div className="px-3 pb-2 flex gap-1">
                          <input
                            type="number"
                            min={1}
                            max={1440}
                            value={customMinsInput}
                            onChange={(e) => setCustomMinsInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') applyCustomMins(); }}
                            placeholder={String(Math.round(windowMs / 60000))}
                            className="flex-1 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
                          />
                          <button type="button" onClick={applyCustomMins} className="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-xs text-white transition-colors">Set</button>
                        </div>
                        <div className="px-3 pb-1 text-[9px] text-slate-500">1–1440 min (24h max)</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex-1 w-full min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hourlyPoints} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveEnd" />
                <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={50} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }} itemStyle={{ fontSize: 12, padding: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {renderLines('h')}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};
