import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Card } from '../ui/Card';
import { PlayCircle, Loader2, AlertCircle, Code, Upload, FileCode, Plus, Trash2 } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useSymbols } from '../services/symbols';
import { runBacktest, downsamplePoints } from '../services/backtest/runner';
import { fetchHistoricalTrades } from '../services/backtest/historical';
import { compilePythonStrategy, EXAMPLE_PY, EXAMPLE_PARAMS } from '../services/backtest/pythonStrategy';
import type { BacktestParams, BacktestResult, Strategy } from '../services/backtest/types';

// CodeMirror + the Python language pack add ~200KB. Lazy-load so the rest
// of the dashboard isn't dragged behind it. SSR off because CodeMirror
// touches the DOM at module-eval time.
const PythonCodeEditor = dynamic(
  () => import('./PythonCodeEditor').then((m) => m.PythonCodeEditor),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-72 bg-slate-950 border border-slate-700 rounded flex items-center justify-center text-xs text-slate-500">
        Loading editor…
      </div>
    ),
  },
);

const TRADE_LIMIT = 5000;

// User-defined param: spec (key + label) plus current value. Stored together
// because the value is what the strategy actually consumes — splitting them
// into "schema" + "values" was just bookkeeping with no benefit.
interface UserParam {
  key: string;
  label: string;
  value: number;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toFixed(2);
}

function fmtAxisTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const Backtester: React.FC = () => {
  const server = useCurrentServer();
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [pythonSource, setPythonSource] = useState<string>(EXAMPLE_PY);
  const [pythonStatus, setPythonStatus] = useState<'idle' | 'compiling' | 'ready' | 'error'>('idle');
  const [pythonError, setPythonError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { names: symbolNames } = useSymbols();
  const [symbol, setSymbol] = useState<string>('');

  // Initial selection comes from the engine — pick the first symbol once
  // /symbols resolves. Snap back to a known symbol if a server switch
  // dropped the previously-selected one.
  useEffect(() => {
    if (symbolNames.length === 0) return;
    if (!symbol || !symbolNames.includes(symbol)) setSymbol(symbolNames[0]);
  }, [symbolNames, symbol]);
  const [initialCash, setInitialCash] = useState<number>(100_000);
  const [positionSize, setPositionSize] = useState<number>(1);
  const [userParams, setUserParams] = useState<UserParam[]>(EXAMPLE_PARAMS);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tradeCount, setTradeCount] = useState<number>(0);

  // ---- Param editor handlers ----------------------------------------------

  const addParam = () => {
    // Auto-generate a unique placeholder key.
    let n = userParams.length + 1;
    while (userParams.some((p) => p.key === `param${n}`)) n++;
    setUserParams((prev) => [...prev, { key: `param${n}`, label: `Parameter ${n}`, value: 0 }]);
  };

  const removeParam = (idx: number) => {
    setUserParams((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateParam = (idx: number, patch: Partial<UserParam>) => {
    setUserParams((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  // ---- Python compile / upload --------------------------------------------

  const handleCompile = async () => {
    setPythonStatus('compiling');
    setPythonError(null);
    try {
      const compiled = await compilePythonStrategy(pythonSource);
      setStrategy(compiled);
      setPythonStatus('ready');
      setResult(null);
      setError(null);
    } catch (e) {
      setStrategy(null);
      setPythonError(e instanceof Error ? e.message : String(e));
      setPythonStatus('error');
    }
  };

  const handleFileUpload = (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.py')) {
      setPythonError('Please upload a .py file');
      setPythonStatus('error');
      return;
    }
    file.text().then((source) => {
      setPythonSource(source);
      setPythonStatus('idle');
      setPythonError(null);
    }).catch((e) => {
      setPythonError(`Failed to read file: ${e instanceof Error ? e.message : String(e)}`);
      setPythonStatus('error');
    });
  };

  const loadExample = () => {
    setPythonSource(EXAMPLE_PY);
    setUserParams(EXAMPLE_PARAMS);
    setPythonStatus('idle');
    setPythonError(null);
  };

  // ---- Run -----------------------------------------------------------------

  const handleRun = async () => {
    if (!strategy) {
      setError('Compile your strategy first.');
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const trades = await fetchHistoricalTrades({ server, symbol, limit: TRADE_LIMIT });
      setTradeCount(trades.length);
      if (trades.length === 0) {
        setError(`No historical trades for ${symbol} on ${server}. Run some bots first.`);
        return;
      }
      // Build the params dict from the editor: shared (cash/size) + user keys.
      // Later keys win on collision so user values can override the shared ones
      // if they really want to (probably never, but defensible).
      const params: BacktestParams = { initialCash, positionSize };
      for (const p of userParams) {
        if (!p.key) continue;
        params[p.key] = p.value;
      }
      // Synchronous runner; for 5k ticks even through Pyodide the FFI overhead
      // stays in the tens-of-ms range. Past ~50k ticks we'd want a Web Worker.
      const r = runBacktest(trades, strategy, params);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setRunning(false);
    }
  };

  // Dense charts hurt — sample down to ~500 points for rendering.
  const chartData = useMemo(
    () => (result ? downsamplePoints(result.points, 500) : []),
    [result],
  );

  return (
    <Card title="Backtester">
      <div className="flex flex-col h-full gap-4">
        <div className="text-xs text-slate-400 px-1">
          Upload a <span className="font-mono text-slate-300">.py</span> file or paste source below,
          then Compile. Required functions:{' '}
          <span className="font-mono text-slate-300">init(params)</span> and{' '}
          <span className="font-mono text-slate-300">on_trade(state, trade, params)</span>. Define
          the parameters your code needs in the Parameters editor below.
        </div>

        {/* Python editor */}
        <div className="flex flex-col gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[10px] uppercase text-slate-500 font-bold">
              <FileCode className="w-3.5 h-3.5" />
              Python source
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".py,text/x-python"
                title="Upload .py file"
                onChange={(e) => handleFileUpload(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-white px-2 py-1 rounded bg-slate-800 border border-slate-700"
              >
                <Upload className="w-3 h-3" />
                Upload .py
              </button>
              <button
                type="button"
                onClick={loadExample}
                className="text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded bg-slate-800 border border-slate-700"
              >
                Load example
              </button>
              <button
                type="button"
                onClick={handleCompile}
                disabled={pythonStatus === 'compiling'}
                className="flex items-center gap-1 text-[11px] font-semibold text-white px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:cursor-not-allowed"
              >
                {pythonStatus === 'compiling' ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Compiling…</>
                ) : (
                  <><Code className="w-3 h-3" /> Compile</>
                )}
              </button>
            </div>
          </div>
          <PythonCodeEditor
            value={pythonSource}
            onChange={(next) => { setPythonSource(next); setPythonStatus('idle'); }}
            status={pythonStatus}
          />
          {pythonStatus === 'ready' && <div className="text-[11px] text-emerald-400">Compiled.</div>}
          {pythonStatus === 'error' && pythonError && (
            <div className="text-[11px] text-red-400 font-mono whitespace-pre-wrap">{pythonError}</div>
          )}
          {pythonStatus === 'compiling' && (
            <div className="text-[11px] text-slate-400">Loading Pyodide runtime (one-time ~10MB download)…</div>
          )}
        </div>

        {/* Parameters editor */}
        <div className="flex flex-col gap-2 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase text-slate-500 font-bold">Parameters</div>
            <button
              type="button"
              onClick={addParam}
              className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-white px-2 py-1 rounded bg-slate-800 border border-slate-700"
            >
              <Plus className="w-3 h-3" />
              Add parameter
            </button>
          </div>

          {/* Shared params — always present; not removable. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <SharedParamRow
              label="Initial cash"
              value={initialCash}
              onChange={setInitialCash}
              min={1}
              step={1}
            />
            <SharedParamRow
              label="Position size"
              value={positionSize}
              onChange={setPositionSize}
              min={0.001}
              step={0.001}
            />
          </div>

          {/* User-defined params: key + label + value + delete. */}
          {userParams.length === 0 && (
            <div className="text-[11px] text-slate-500 italic px-1 py-2">
              No custom parameters. Click <span className="text-slate-400">Add parameter</span> to expose values to your strategy.
            </div>
          )}
          {userParams.map((p, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.5fr_1fr_auto] gap-2 items-center">
              <input
                type="text"
                title="Parameter key (used in params['key'])"
                value={p.key}
                onChange={(e) => updateParam(i, { key: e.target.value })}
                placeholder="key"
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 font-mono outline-none focus:border-blue-500"
              />
              <input
                type="text"
                title="Display label"
                value={p.label}
                onChange={(e) => updateParam(i, { label: e.target.value })}
                placeholder="Display label"
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500"
              />
              <input
                type="number"
                title="Value"
                value={p.value}
                onChange={(e) => updateParam(i, { value: Number(e.target.value) })}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => removeParam(i)}
                title="Remove parameter"
                className="text-slate-500 hover:text-red-400 p-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Run controls — only meaningful once compiled */}
        {strategy && (
          <div className="flex flex-wrap items-end gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
            <div className="flex-1 min-w-[140px]">
              <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">Symbol</label>
              <select
                title="Select symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={symbolNames.length === 0}
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500 disabled:opacity-50"
              >
                {symbolNames.length === 0
                  ? <option value="">(loading…)</option>
                  : symbolNames.map((s) => (<option key={s} value={s}>{s}</option>))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleRun}
              disabled={running}
              className="flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded px-4 py-1.5 text-xs font-bold transition-colors h-[34px]"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <PlayCircle className="w-3.5 h-3.5 mr-1.5" />
              )}
              {running ? 'Running…' : 'Run backtest'}
            </button>
          </div>
        )}

        {/* Results / error / empty */}
        {error && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-800/60 text-red-300 text-xs rounded">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        )}

        {!strategy && !error && (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-700 rounded p-4 text-center">
            Compile a strategy to enable the backtest.
            <br />
            Replays the last {TRADE_LIMIT.toLocaleString()} trades from {server}.
          </div>
        )}

        {strategy && !result && !error && !running && (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-700 rounded p-4 text-center">
            Tune params and hit Run.
          </div>
        )}

        {result && (
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 min-h-0">
            <div className="md:col-span-2 bg-slate-900/30 rounded border border-slate-700/30 p-3 flex flex-col min-h-[260px]">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-slate-400 font-mono">Equity Curve</span>
                <span className="text-[10px] text-slate-500 font-mono">
                  {tradeCount.toLocaleString()} ticks · {result.trades} actions
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                    <defs>
                      <linearGradient id="bt-equity" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"  stopColor="#6366f1" stopOpacity={0.4} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="ts"
                      tickFormatter={fmtAxisTime}
                      stroke="#64748b"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={40}
                    />
                    <YAxis
                      stroke="#64748b"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                      tickFormatter={(v: number) => v.toFixed(0)}
                      domain={['dataMin', 'dataMax']}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 4, fontSize: 12 }}
                      labelFormatter={(ts: number) => new Date(ts).toLocaleString()}
                      formatter={(v: number | string | undefined) => Number(v ?? 0).toFixed(2)}
                    />
                    <ReferenceLine y={initialCash} stroke="#475569" strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="equity" stroke="#6366f1" fill="url(#bt-equity)" strokeWidth={2} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Stat label="Total return" value={fmtPct(result.totalReturn)}
                    tone={result.totalReturn >= 0 ? 'pos' : 'neg'} />
              <Stat label="Final equity" value={fmtNum(result.finalEquity)} />
              <Stat label="Max drawdown" value={fmtPct(result.maxDrawdown)} tone="neg" />
              <Stat label="Sharpe (per-tick × √N)" value={result.sharpe.toFixed(2)} />
              <Stat label="Trades executed" value={String(result.trades)} />
              <Stat label="Final position" value={fmtNum(result.finalPosition)} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

const SharedParamRow: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}> = ({ label, value, onChange, min, step }) => (
  <div>
    <label className="block text-[10px] uppercase text-slate-500 font-bold mb-1">{label}</label>
    <input
      type="number"
      title={label}
      value={value}
      min={min}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-blue-500 font-mono"
    />
  </div>
);

const Stat: React.FC<{ label: string; value: string; tone?: 'pos' | 'neg' }> = ({ label, value, tone }) => {
  const colorClass = tone === 'pos' ? 'text-green-400' : tone === 'neg' ? 'text-red-400' : 'text-white';
  return (
    <div className="bg-slate-800 p-3 rounded border border-slate-700">
      <div className="text-[10px] text-slate-400 uppercase">{label}</div>
      <div className={`text-lg font-mono ${colorClass}`}>{value}</div>
    </div>
  );
};
