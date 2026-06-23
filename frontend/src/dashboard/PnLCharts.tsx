import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Filter, ChevronDown, Check, Info } from 'lucide-react';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useEngineUserId } from '../hooks/useEngineUserId';
import { useApiKey } from '../hooks/useApiKey';
import { httpBase } from '../services/engineUrl';

interface EngineBot {
  user_id: string;
  client_id: string;
  name: string;
  is_internal: boolean;
  total_pnl: number;
  hourly_pnl: number;
  windowed_pnl: number;
  window_ms: number;
}

const POLL_MS = 1500;
// Single chart-data array (`points`) holds cumulative total_pnl per series
// since the dashboard opened. The realized chart is computed from it on the
// fly (delta over the selected window), so changing the window doesn't
// throw away history.
// "Total" sums only the signed-in user's bots — summing everyone (including
// the engine MM, which sits opposite the takers) just produces noise that
// roughly cancels out, and a positive other-user PnL isn't your money.
const TOTAL_KEY = 'Yours';

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#ec4899', '#22d3ee', '#84cc16', '#f97316'];

// Realized-PnL window presets. Custom lets the user type a minute count.
// Engine clamps server-side to 1s..24h, so anything in [1, 1440] minutes works.
interface WindowPreset { label: string; ms: number; }
const WINDOW_PRESETS: WindowPreset[] = [
  { label: '5m',  ms:   5 * 60 * 1000 },
  { label: '15m', ms:  15 * 60 * 1000 },
  { label: '30m', ms:  30 * 60 * 1000 },
  { label: '1h',  ms:  60 * 60 * 1000 },
  { label: '6h',  ms: 360 * 60 * 1000 },
  { label: '24h', ms: 1440 * 60 * 1000 },
];

function colorFor(name: string, idx: number): string {
  if (name === TOTAL_KEY) return PALETTE[0];
  return PALETTE[(idx + 1) % PALETTE.length];
}

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

// Each point holds the formatted clock label (`time`) used by Recharts'
// XAxis, the numeric timestamp (`tsMs`) used to compute window deltas
// client-side, and one numeric column per series.
type Point = { time: string; tsMs: number; [series: string]: number | string };

// Small "i" icon with a hover tooltip. Pure CSS via Tailwind's `group` /
// `group-hover` — no extra state, no dependencies. Tooltip is anchored to
// the LEFT of the icon (rather than centered) because the section header
// lives on the left edge of the page; centering would clip it off-screen.
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
  // Latest engine-authoritative windowed_pnl total for "your" bots, refreshed
  // on every poll. Used for the headline when chart history is shorter than
  // the selected window (the engine has 24h of fills and knows the true
  // value; the chart line can only show what's been polled this session).
  const [latestWindowedYours, setLatestWindowedYours] = useState<number>(0);
  const [seriesNames, setSeriesNames] = useState<string[]>([TOTAL_KEY]);
  const [visibleSeries, setVisibleSeries] = useState<string[]>([TOTAL_KEY]);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isWindowOpen, setIsWindowOpen] = useState(false);
  const [windowMs, setWindowMs] = useState<number>(60 * 60 * 1000);   // default 1h
  const [customMinsInput, setCustomMinsInput] = useState<string>('');
  const filterRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const knownSeriesRef = useRef<Set<string>>(new Set([TOTAL_KEY]));
  // Live window value so the polling closure always sees the latest selection
  // without restarting the effect (which would reset both charts' history).
  const windowMsRef = useRef<number>(windowMs);
  useEffect(() => { windowMsRef.current = windowMs; }, [windowMs]);
  const server = useCurrentServer();
  const { apiKey } = useApiKey();
  const apiKeyRef = useRef(apiKey);
  useEffect(() => { apiKeyRef.current = apiKey; }, [apiKey]);
  const engineUserId = useEngineUserId();
  // Live engineUserId reference, same trick — `/me` can briefly resolve to
  // null between polls (cache TTL expiry, transient backend blip), and we
  // don't want every flicker to nuke the chart or restart the polling timer.
  const engineUserIdRef = useRef<string | null>(engineUserId);
  useEffect(() => { engineUserIdRef.current = engineUserId; }, [engineUserId]);

  // Server changes invalidate the chart (a different engine has its own
  // bots and PnL history). Identity flicker does NOT reset — the realized
  // chart is derived from `points` and the polling closure reads
  // engineUserId via ref, so transient `/me` failures don't visibly nuke
  // the chart or refire effects.
  useEffect(() => {
    setPoints([]);
    setLatestWindowedYours(0);
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
        const res = await fetch(
          `${httpBase(server)}/bots?window_ms=${windowMsRef.current}`,
          { signal: ctrl.signal, headers: apiKeyRef.current ? { 'Api-Key': apiKeyRef.current } : undefined },
        );
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { bots: EngineBot[] };
        if (!alive) return;
        setError(null);

        const now = Date.now();
        const time = fmtTime(now);
        const totalRow: Point = { time, tsMs: now };
        let total = 0;

        const meId = engineUserIdRef.current;
        let yoursWindowed = 0;

        // Collapse all news-bot series into one. Without this, count > 1
        // per persona explodes the legend with N indistinguishable lines.
        // Aggregated series uses the fixed key NEWS_AGGREGATE_KEY so it
        // shows up as a single legend entry that the user can toggle.
        let newsTotal = 0;
        let newsCount = 0;
        for (const b of data.bots) {
          if (b.user_id.startsWith('internal:news_')) {
            newsTotal += b.total_pnl;
            ++newsCount;
            continue;
          }
          const key = b.name || b.user_id;
          totalRow[key] = b.total_pnl;
          if (meId && b.user_id === meId && !b.is_internal) {
            total += b.total_pnl;
            // Engine's authoritative "realized over current window" — used as
            // the headline value when local chart history is too short.
            yoursWindowed += b.windowed_pnl ?? b.hourly_pnl ?? 0;
          }
          if (!knownSeriesRef.current.has(key)) {
            knownSeriesRef.current.add(key);
          }
        }
        if (newsCount > 0) {
          const aggKey = `News bots (${newsCount})`;
          totalRow[aggKey] = newsTotal;
          // Re-key on count changes so old aggregate series doesn't linger
          // when the user adds/removes bots (the previous key stays in
          // knownSeriesRef but won't be updated again — Recharts just
          // drops it after a few empty points).
          if (!knownSeriesRef.current.has(aggKey)) {
            knownSeriesRef.current.add(aggKey);
          }
        }
        totalRow[TOTAL_KEY] = total;
        setLatestWindowedYours(yoursWindowed);

        // Re-publish series names so a new bot becomes selectable.
        setSeriesNames(prev => {
          const next = Array.from(knownSeriesRef.current);
          if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
          return next;
        });
        setVisibleSeries(prev => {
          const next = new Set(prev);
          for (const k of knownSeriesRef.current) next.add(k);
          if (next.size === prev.length && prev.every(s => next.has(s))) return prev;
          return Array.from(next);
        });

        // Single source of truth: cumulative total_pnl per series over time.
        // The realized-PnL chart is DERIVED from this same array (memoized
        // by windowMs below) so changing the window doesn't lose history.
        setPoints(prev => [...prev, totalRow]);
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
    // engineUserId & windowMs are read via refs above so transient flicker
    // doesn't restart the polling timer or reset state.
  }, [server]);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
      if (windowRef.current && !windowRef.current.contains(e.target as Node)) {
        setIsWindowOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const toggleSeries = (s: string) =>
    setVisibleSeries(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  const applyCustomMins = () => {
    const mins = Number(customMinsInput);
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) return;
    setWindowMs(Math.round(mins * 60 * 1000));
    setIsWindowOpen(false);
  };

  // For both charts: headline = the CURRENT cumulative/windowed value (sign
  // tells you "made money" vs "lost money"). Subtext = chart-history delta
  // (sign tells you "trending up" vs "trending down" over the visible chart).
  // Splitting them avoids the confusing case where the value is positive but
  // the delta % is negative — they aren't the same thing.
  const lastTotal = points.length > 0 ? Number(points[points.length - 1][TOTAL_KEY]) : 0;
  const firstTotal = points.length > 0 ? Number(points[0][TOTAL_KEY]) : 0;
  const totalDelta = lastTotal - firstTotal;
  // Percent = chart-history delta scaled by the larger of |first| and |last|.
  // Using max instead of just |first| keeps the % meaningful when the chart
  // started near zero (cumulative PnL often does) — without it Total PnL's %
  // is almost always suppressed because firstTotal is small.
  const totalDenom = Math.max(Math.abs(firstTotal), Math.abs(lastTotal));
  const totalDeltaPct = totalDenom > 0.01 ? (totalDelta / totalDenom) * 100 : null;

  // Realized chart, derived from `points` on the fly. At each point T the
  // value for series S is cumulative[T][S] − cumulative[base][S], where
  // `base` is the LAST snapshot with tsMs ≤ (T − windowMs) — i.e. the
  // snapshot just before the window started. The cursor advances
  // monotonically (sliding-window invariant: as T grows, base only moves
  // forward), so total cost across all points is O(N).
  //
  // For windows longer than the chart's age, base stays at points[0] and
  // the line collapses to "change since chart loaded" — the most we can
  // compute from local data. The headline number falls back to the
  // engine's `windowed_pnl` (which has 24h of real fill history) so the
  // big number stays accurate even when the chart line can't.
  const hourlyPoints = useMemo<Point[]>(() => {
    if (points.length === 0) return [];
    const out: Point[] = [];
    let baseIdx = 0;
    for (let i = 0; i < points.length; ++i) {
      const cur = points[i];
      const cutoff = cur.tsMs - windowMs;
      // Advance baseIdx while the NEXT point is still ≤ cutoff. baseIdx
      // ends up at the LAST out-of-window snapshot (or 0 if none exists).
      while (baseIdx + 1 < i && points[baseIdx + 1].tsMs <= cutoff) ++baseIdx;
      const base = points[baseIdx];
      const row: Point = { time: cur.time, tsMs: cur.tsMs };
      for (const k of Object.keys(cur)) {
        if (k === 'time' || k === 'tsMs') continue;
        const a = Number(cur[k]);
        const b = Number(base[k] ?? 0);
        row[k] = a - b;
      }
      out.push(row);
    }
    // Clip the visible X axis to the most recent windowMs of polled history.
    // For "1m", the user expects to see the last minute, not 5 minutes of
    // "rolling 1m" values. Polls older than this are kept in `points`
    // (needed as `base` references for the recent chart values) but not shown.
    if (out.length === 0) return out;
    const visibleFrom = out[out.length - 1].tsMs - windowMs;
    let firstVisible = 0;
    while (firstVisible < out.length && out[firstVisible].tsMs < visibleFrom) ++firstVisible;
    return firstVisible === 0 ? out : out.slice(firstVisible);
  }, [points, windowMs]);

  // Whether the chart has enough history to honour the selected window. If
  // not, the line is showing "change since chart loaded" for all windows
  // that exceed history (and the big number falls back to engine value).
  const chartHistoryMs = points.length > 1
    ? points[points.length - 1].tsMs - points[0].tsMs
    : 0;
  const historyShorterThanWindow = chartHistoryMs < windowMs && points.length > 1;

  // Headline value: prefer the engine's authoritative number whenever the
  // chart can't span the whole window (otherwise every X-min view collapses
  // to "change since chart loaded" and switching the dropdown looks like a
  // no-op). When chart history fully covers the window, fall back to the
  // chart-derived value so headline and chart stay in lockstep.
  const chartTailWindowed = hourlyPoints.length > 0
    ? Number(hourlyPoints[hourlyPoints.length - 1][TOTAL_KEY]) : 0;
  const lastWindowed = historyShorterThanWindow ? latestWindowedYours : chartTailWindowed;
  const firstWindowed = hourlyPoints.length > 0 ? Number(hourlyPoints[0][TOTAL_KEY]) : 0;
  const windowedDelta = chartTailWindowed - firstWindowed;
  const windowedDenom = Math.max(Math.abs(firstWindowed), Math.abs(chartTailWindowed));
  const windowedDeltaPct = windowedDenom > 0.01 ? (windowedDelta / windowedDenom) * 100 : null;

  // Match a preset by ms; null means "Custom".
  const matchedPreset = WINDOW_PRESETS.find(p => p.ms === windowMs) ?? null;
  const windowLabel = matchedPreset ? matchedPreset.label : fmtWindow(windowMs);

  return (
    // Plain div, not Card — Card's p-4 is on an inner element that className
    // can't reach, which used to indent the PnL content relative to every
    // other widget on the dashboard.
    <div className="w-full">
      <div className="flex justify-between items-center mb-4 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
        <div className="flex items-center gap-2 px-2 text-slate-400">
          <span className="text-xs font-medium uppercase tracking-wider">Performance Analytics</span>
          <InfoTip>
            <div className="space-y-2.5">
              <div>
                <span className="text-slate-100 font-semibold">Total PnL</span> — cumulative
                since the bot&apos;s first fill. Cash from all fills + mark-to-market on open
                inventory.
              </div>
              <div>
                <span className="text-slate-100 font-semibold">Realized PnL</span> — same
                formula but only over fills inside the selected window. Older fills age
                out as the window slides (5m / 15m / 1h / 24h / Custom).
              </div>

              <div className="pt-1 border-t border-slate-700/60">
                <div className="text-slate-400 text-[10px] uppercase tracking-wider mb-2">
                  Anatomy of the badge
                </div>
                {/* Sample badge with callouts. Two rows: badge column on the left,
                    short connector + label on the right. The connector is a thin
                    gradient line so the eye is led from label → badge. */}
                <div className="flex items-stretch gap-2">
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="text-xs font-bold px-2 py-0.5 rounded font-mono text-green-400 bg-green-900/30">
                      +1500.00 (+3.4%)
                    </span>
                    <span className="text-[10px] font-mono text-green-500/70">
                      Δ +50.00 (chart)
                    </span>
                  </div>
                  <div className="flex flex-col justify-between py-0.5 text-[10px] text-slate-400 leading-tight">
                    <div className="flex items-center gap-1">
                      <span className="block w-3 border-t border-slate-600" />
                      <span><span className="text-slate-200">current value</span>
                        {' '}<span className="text-slate-500">(% = chart change)</span></span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="block w-3 border-t border-slate-600" />
                      <span><span className="text-slate-200">absolute change</span> over chart
                        {' '}<span className="text-slate-500">(session for Total, ~3 min for Realized)</span></span>
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-slate-400 leading-snug">
                  Signs are colored independently, so a profitable position
                  <span className="text-green-400 font-mono"> (+) </span>
                  trending down
                  <span className="text-red-400 font-mono"> (Δ−) </span>
                  is not a bug.
                </div>
              </div>

              <div className="pt-1 border-t border-slate-700/60 text-[10px] text-slate-400">
                Only your own bots count toward &quot;Yours&quot;. The internal MM and other users&apos;
                bots are still shown as separate lines for context.
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
        {/* Your Total PnL */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-start mb-4 gap-2">
            <h3 className="text-sm font-semibold text-slate-200">
              Your Total PnL
              {!engineUserId && <span className="ml-2 text-[10px] text-slate-500 font-normal">(no API key)</span>}
            </h3>
            <div className="flex flex-col items-end shrink-0">
              <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
                lastTotal >= 0 ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
              }`}>
                {lastTotal >= 0 ? '+' : ''}{lastTotal.toFixed(2)}
                {totalDeltaPct !== null &&
                  ` (${totalDeltaPct >= 0 ? '+' : ''}${totalDeltaPct.toFixed(1)}%)`}
              </span>
              {points.length > 1 && (
                <span className={`text-[10px] mt-0.5 font-mono ${
                  totalDelta >= 0 ? 'text-green-500/70' : 'text-red-500/70'
                }`}>
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

        {/* Your Realized PnL — sliding window selectable */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex flex-col h-[300px]">
          <div className="flex justify-between items-start mb-4 gap-2">
            <h3 className="text-sm font-semibold text-slate-200 truncate">
              Your {windowLabel} Realized PnL
              {historyShorterThanWindow && (
                <span className="ml-2 text-[10px] text-slate-500 font-normal" title="Chart line shows the most we can plot from the polled history. Headline reflects the engine's full window.">
                  (chart partial)
                </span>
              )}
            </h3>
            <div className="flex items-start gap-2 shrink-0">
              <div className="flex flex-col items-end">
                <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
                  lastWindowed >= 0 ? 'text-green-400 bg-green-900/30' : 'text-red-400 bg-red-900/30'
                }`}>
                  {lastWindowed >= 0 ? '+' : ''}{lastWindowed.toFixed(2)}
                  {windowedDeltaPct !== null &&
                    ` (${windowedDeltaPct >= 0 ? '+' : ''}${windowedDeltaPct.toFixed(1)}%)`}
                </span>
                {hourlyPoints.length > 1 && (
                  <span className={`text-[10px] mt-0.5 font-mono ${
                    windowedDelta >= 0 ? 'text-green-500/70' : 'text-red-500/70'
                  }`}>
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
                      {WINDOW_PRESETS.map(p => (
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
                            onChange={e => setCustomMinsInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') applyCustomMins(); }}
                            placeholder={String(Math.round(windowMs / 60000))}
                            className="flex-1 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={applyCustomMins}
                            className="px-2 py-1 bg-blue-700 hover:bg-blue-600 rounded text-xs text-white transition-colors"
                          >
                            Set
                          </button>
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
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
                         itemStyle={{ fontSize: 12, padding: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {seriesNames.filter(s => visibleSeries.includes(s)).map((s, i) => (
                  // type="monotone" → cubic interpolation that still passes
                  // through every data point (no spurious overshoots), so the
                  // line looks smooth without making up values. The Total PnL
                  // chart already uses this; "step" was leftover from when
                  // the realized series came in as discrete bucket samples.
                  <Line key={`${s}_h`} type="monotone" dataKey={s} stroke={colorFor(s, i)}
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
