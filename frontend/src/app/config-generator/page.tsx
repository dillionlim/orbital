'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Copy, Download, Plus, Trash2, Check } from 'lucide-react';
import { Card } from '../../ui/Card';
import BubblesIcon from '@/src/ui/BubblesIcon';

// Single source of truth for the engine's `server.json` shape. Mirrors
// trading_engine/scripts/server.json.example — keep in sync if that file
// gains new fields.

// 'none' = no cap, 'symmetric' = single ±N (max_position), 'separate' = max_long + max_short.
type LimitMode = 'none' | 'symmetric' | 'separate';

interface SymbolEntry {
  name: string;
  id: number;
  mid: number;
  // Position-limit fields. We keep all three numeric fields populated even
  // when the mode doesn't use them so toggling the mode preserves prior
  // values (a small QoL — switching back doesn't wipe what they typed).
  limitMode: LimitMode;
  maxPosition: number;
  maxLong: number;
  maxShort: number;
}

type Persona = 'momentum' | 'contrarian' | 'scalper';

interface NewsBotEntry {
  count: number;                       // 0 disables; N spawns N instances
  persona: Persona;
  size_per_signal: number;
  confidence_threshold: number;
  size_jitter_pct: number;             // ± this % around size_per_signal
  price_offset_jitter_bps: number;     // ± bps around persona's base offset
  noise_interval_seconds: number;      // 0 disables; N = noise trade ~every N s
}

interface ServerConfig {
  server: {
    port: number;
    backend_url: string;
    db_path: string;
    auth_cache_ttl_seconds: number;
  };
  symbols: SymbolEntry[];
  market_maker: {
    enabled: boolean;
    spread_bps: number;
    size: number;
    refresh_ms: number;
    track_trades: boolean;
  };
  news: {
    poll_seconds: number;
    gemini_model: string;
    gemini_api_key: string;
    bots: NewsBotEntry[];
  };
}

const PERSONA_BLURBS: Record<Persona, string> = {
  momentum:
    'Buys on bullish news, sells on bearish. Aggressive limit (50 bps cross) so the order takes liquidity from the MM book.',
  contrarian:
    'Inverts the headline reaction — fades over-eager moves. Same execution profile as momentum, opposite side.',
  scalper:
    'Same direction as momentum but passive (10 bps inside the spread) and half-size — sits on the book hoping to scalp a small revert.',
};

const DEFAULT_CONFIG: ServerConfig = {
  server: {
    port: 9090,
    backend_url: 'http://localhost:3010',
    db_path: './engine.db',
    auth_cache_ttl_seconds: 300,
  },
  symbols: [
    { name: 'BTC-USD', id: 1, mid: 50000, limitMode: 'none', maxPosition: 100, maxLong: 100, maxShort: 100 },
    { name: 'ETH-USD', id: 2, mid: 3000, limitMode: 'none', maxPosition: 100, maxLong: 100, maxShort: 100 },
    { name: 'LTC-USD', id: 3, mid: 100, limitMode: 'none', maxPosition: 100, maxLong: 100, maxShort: 100 },
  ],
  market_maker: {
    enabled: true,
    spread_bps: 20,
    size: 10,
    refresh_ms: 5000,
    track_trades: true,
  },
  news: {
    poll_seconds: 30,
    gemini_model: 'gemini-2.5-flash',
    gemini_api_key: '',
    bots: [
      { count: 0, persona: 'momentum',   size_per_signal: 5, confidence_threshold: 0.6,  size_jitter_pct: 25, price_offset_jitter_bps: 15, noise_interval_seconds: 0 },
      { count: 0, persona: 'contrarian', size_per_signal: 3, confidence_threshold: 0.7,  size_jitter_pct: 25, price_offset_jitter_bps: 15, noise_interval_seconds: 0 },
      { count: 0, persona: 'scalper',    size_per_signal: 4, confidence_threshold: 0.65, size_jitter_pct: 30, price_offset_jitter_bps: 8,  noise_interval_seconds: 0 },
    ],
  },
};

const inputCls =
  'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white ' +
  'focus:border-blue-500 outline-none w-full font-mono';
const labelCls = 'text-xs uppercase tracking-wide text-slate-400 mb-1';
const sectionCls = 'space-y-3';

// Lightweight JSON syntax highlighter. Tokenises with one regex, renders
// React nodes (no HTML injection — safe even though our input never
// originates outside the form). Avoids pulling a 50 KB highlight.js dep
// for what's a 30-line component.
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const HighlightedJson: React.FC<{ value: string }> = ({ value }) => {
  const nodes = useMemo(() => {
    const out: React.ReactNode[] = [];
    let last = 0;
    let i = 0;
    for (const m of value.matchAll(JSON_TOKEN_RE)) {
      const start = m.index ?? 0;
      if (start > last) out.push(value.slice(last, start));
      const [whole, key, str, kw, num] = m;
      let cls = '';
      if (key) cls = 'text-sky-300';
      else if (str) cls = 'text-emerald-300';
      else if (kw) cls = kw === 'null' ? 'text-slate-400 italic' : 'text-violet-400';
      else if (num) cls = 'text-amber-300';
      out.push(
        <span key={i++} className={cls}>
          {whole}
        </span>,
      );
      last = start + whole.length;
    }
    if (last < value.length) out.push(value.slice(last));
    return out;
  }, [value]);

  return (
    <pre className="font-code text-xs text-slate-400 bg-slate-950 border border-slate-800 rounded p-3 overflow-x-auto whitespace-pre leading-relaxed">
      {nodes}
    </pre>
  );
};

export default function ConfigGeneratorPage() {
  const [cfg, setCfg] = useState<ServerConfig>(DEFAULT_CONFIG);
  const [copied, setCopied] = useState(false);

  // Map our richer in-state representation onto the wire shape the engine
  // actually parses (drops the `limitMode` helper field, conditionally
  // emits `max_position` / `max_long` / `max_short`).
  const json = useMemo(() => {
    const wireSymbols = cfg.symbols.map((s) => {
      const base: Record<string, unknown> = { name: s.name, id: s.id, mid: s.mid };
      if (s.limitMode === 'symmetric') {
        base.max_position = s.maxPosition;
      } else if (s.limitMode === 'separate') {
        base.max_long = s.maxLong;
        base.max_short = s.maxShort;
      }
      return base;
    });
    return JSON.stringify(
      {
        server: cfg.server,
        symbols: wireSymbols,
        market_maker: cfg.market_maker,
        news: cfg.news,
      },
      null,
      2,
    );
  }, [cfg]);

  // Validate inputs locally — bad config = silent runtime crash on the engine
  // side, which is the worst possible UX for a copy-paste tool.
  const errors = useMemo(() => {
    const errs: string[] = [];
    if (cfg.server.port < 1 || cfg.server.port > 65535) {
      errs.push('Port must be between 1 and 65535');
    }
    if (!cfg.server.backend_url.match(/^https?:\/\/.+/)) {
      errs.push('backend_url must start with http:// or https://');
    }
    if (cfg.server.auth_cache_ttl_seconds < 0) {
      errs.push('auth_cache_ttl_seconds cannot be negative');
    }
    if (cfg.symbols.length === 0) {
      errs.push('Need at least one symbol');
    }
    const ids = new Set<number>();
    const names = new Set<string>();
    for (const s of cfg.symbols) {
      if (!s.name.trim()) errs.push('Symbol name cannot be blank');
      if (s.id < 1) errs.push(`Symbol "${s.name}" id must be ≥ 1`);
      if (s.mid <= 0) errs.push(`Symbol "${s.name}" mid must be > 0`);
      if (ids.has(s.id)) errs.push(`Duplicate symbol id ${s.id}`);
      if (names.has(s.name)) errs.push(`Duplicate symbol name "${s.name}"`);
      // Position-cap validation. 0 IS a meaningful cap ("can't go long"),
      // so we only reject negatives.
      if (s.limitMode === 'symmetric' && s.maxPosition < 0) {
        errs.push(`Symbol "${s.name}" max_position must be ≥ 0`);
      }
      if (s.limitMode === 'separate') {
        if (s.maxLong < 0) errs.push(`Symbol "${s.name}" max_long must be ≥ 0`);
        if (s.maxShort < 0) errs.push(`Symbol "${s.name}" max_short must be ≥ 0`);
      }
      ids.add(s.id);
      names.add(s.name);
    }
    if (cfg.market_maker.enabled) {
      if (cfg.market_maker.spread_bps < 1) errs.push('MM spread_bps must be ≥ 1');
      if (cfg.market_maker.size < 1) errs.push('MM size must be ≥ 1');
      if (cfg.market_maker.refresh_ms < 100) errs.push('MM refresh_ms must be ≥ 100');
    }
    if (cfg.news.poll_seconds < 5) {
      errs.push('news.poll_seconds must be ≥ 5');
    }
    for (const b of cfg.news.bots) {
      if (b.count < 0) errs.push(`News ${b.persona}: count must be ≥ 0`);
      if (b.count === 0) continue;
      if (b.size_per_signal < 1) errs.push(`News ${b.persona}: size_per_signal must be ≥ 1`);
      if (b.confidence_threshold < 0 || b.confidence_threshold > 1) {
        errs.push(`News ${b.persona}: confidence_threshold must be in [0, 1]`);
      }
      if (b.size_jitter_pct < 0 || b.size_jitter_pct > 90) {
        errs.push(`News ${b.persona}: size_jitter_pct must be in [0, 90]`);
      }
      if (b.price_offset_jitter_bps < 0 || b.price_offset_jitter_bps > 500) {
        errs.push(`News ${b.persona}: price_offset_jitter_bps must be in [0, 500]`);
      }
      if (b.noise_interval_seconds < 0) {
        errs.push(`News ${b.persona}: noise_interval_seconds must be ≥ 0`);
      }
    }
    return errs;
  }, [cfg]);

  const updateServer = <K extends keyof ServerConfig['server']>(
    k: K,
    v: ServerConfig['server'][K],
  ) => setCfg((c) => ({ ...c, server: { ...c.server, [k]: v } }));

  const updateMM = <K extends keyof ServerConfig['market_maker']>(
    k: K,
    v: ServerConfig['market_maker'][K],
  ) => setCfg((c) => ({ ...c, market_maker: { ...c.market_maker, [k]: v } }));

  const updateNews = <K extends 'poll_seconds' | 'gemini_model' | 'gemini_api_key'>(
    k: K,
    v: ServerConfig['news'][K],
  ) => setCfg((c) => ({ ...c, news: { ...c.news, [k]: v } }));

  const updateNewsBot = (i: number, patch: Partial<NewsBotEntry>) =>
    setCfg((c) => ({
      ...c,
      news: {
        ...c.news,
        bots: c.news.bots.map((b, idx) => (idx === i ? { ...b, ...patch } : b)),
      },
    }));

  const updateSymbol = (idx: number, patch: Partial<SymbolEntry>) =>
    setCfg((c) => ({
      ...c,
      symbols: c.symbols.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));

  const addSymbol = () => {
    // Pick the next free id automatically so the user can't trip the
    // "duplicate id" error just by clicking +.
    const nextId = cfg.symbols.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    setCfg((c) => ({
      ...c,
      symbols: [
        ...c.symbols,
        {
          name: '',
          id: nextId,
          mid: 100,
          limitMode: 'none',
          maxPosition: 100,
          maxLong: 100,
          maxShort: 100,
        },
      ],
    }));
  };

  const removeSymbol = (idx: number) =>
    setCfg((c) => ({ ...c, symbols: c.symbols.filter((_, i) => i !== idx) }));

  const resetDefaults = () => setCfg(DEFAULT_CONFIG);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for non-secure contexts (http://): create a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'server.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
             <BubblesIcon className="text-white w-5 h-5" />
           </div>
          <span className="font-bold text-xl tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-sky-300 via-blue-500 to-indigo-600">
            Bubbles
          </span>
        </Link>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-slate-400 hover:text-white transition-colors flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Link>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-white mb-2">
            Server Config Generator
          </h1>
          <p className="text-slate-400 text-sm">
            Fill in the form to generate <code className="text-blue-400">server.json</code> for your
            local trading engine. Save the output as{' '}
            <code className="text-blue-400">scripts/server.json</code> (or mount it into the
            Docker container at <code className="text-blue-400">/cfg/server.json</code>).
          </p>
        </header>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* ---------------- LEFT: form ---------------- */}
          <div className="space-y-6">
            <Card title="Server">
              <div className={sectionCls}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className={labelCls}>Port</div>
                    <input
                      type="number"
                      title="Engine listen port"
                      className={inputCls}
                      value={cfg.server.port}
                      min={1}
                      max={65535}
                      onChange={(e) => updateServer('port', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <div className={labelCls}>Auth cache TTL (s)</div>
                    <input
                      type="number"
                      title="How long the engine caches a validated API key before re-asking the backend"
                      className={inputCls}
                      value={cfg.server.auth_cache_ttl_seconds}
                      min={0}
                      onChange={(e) =>
                        updateServer('auth_cache_ttl_seconds', Number(e.target.value))
                      }
                    />
                  </div>
                </div>
                <div>
                  <div className={labelCls}>Backend URL (NestJS API)</div>
                  <input
                    type="text"
                    className={inputCls}
                    value={cfg.server.backend_url}
                    onChange={(e) => updateServer('backend_url', e.target.value)}
                    placeholder="http://localhost:3010"
                  />
                </div>
                <div>
                  <div className={labelCls}>SQLite DB path</div>
                  <input
                    type="text"
                    className={inputCls}
                    value={cfg.server.db_path}
                    onChange={(e) => updateServer('db_path', e.target.value)}
                    placeholder="./engine.db"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    For Docker, use <code>/data/engine.db</code> and mount{' '}
                    <code>-v engine-data:/data</code>.
                  </p>
                </div>
              </div>
            </Card>

            <Card
              title="Symbols"
              action={
                <button
                  type="button"
                  onClick={addSymbol}
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2 py-1 rounded flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" /> Add
                </button>
              }
            >
              <div className="space-y-2">
                <div className="grid grid-cols-[1.4fr_0.6fr_1fr_auto] gap-2 text-[10px] uppercase tracking-wide text-slate-500 px-1">
                  <span>Name</span>
                  <span>ID</span>
                  <span>Mid price</span>
                  <span></span>
                </div>
                {cfg.symbols.map((s, i) => (
                  <div
                    key={i}
                    className="border border-slate-800 rounded-md p-2 space-y-2 bg-slate-900/40"
                  >
                    <div className="grid grid-cols-[1.4fr_0.6fr_1fr_auto] gap-2 items-center">
                      <input
                        type="text"
                        className={inputCls}
                        value={s.name}
                        placeholder="BTC-USD"
                        onChange={(e) => updateSymbol(i, { name: e.target.value })}
                      />
                      <input
                        type="number"
                        title="Internal symbol id (must be unique)"
                        className={inputCls}
                        value={s.id}
                        min={1}
                        onChange={(e) => updateSymbol(i, { id: Number(e.target.value) })}
                      />
                      <input
                        type="number"
                        title="Reference mid price the market maker quotes around"
                        className={inputCls}
                        value={s.mid}
                        step="0.01"
                        min={0}
                        onChange={(e) => updateSymbol(i, { mid: Number(e.target.value) })}
                      />
                      <button
                        type="button"
                        onClick={() => removeSymbol(i)}
                        className="text-slate-500 hover:text-red-400 transition-colors p-1"
                        aria-label={`Remove ${s.name || 'symbol'}`}
                        disabled={cfg.symbols.length === 1}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Position-cap row. Sits visually under each symbol so caps stay
                        attached to the symbol they apply to. The mode select is
                        always visible; the numeric inputs only appear in the modes
                        that need them. */}
                    <div className="flex items-center gap-2 text-[10px] pl-1 flex-wrap">
                      <span className="uppercase tracking-wide text-slate-500">
                        Position cap
                      </span>
                      <select
                        title="Position-limit mode for this symbol"
                        value={s.limitMode ?? 'none'}
                        onChange={(e) =>
                          updateSymbol(i, { limitMode: e.target.value as LimitMode })
                        }
                        className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 outline-none"
                      >
                        <option value="none">None</option>
                        <option value="symmetric">Symmetric ±</option>
                        <option value="separate">Long / Short</option>
                      </select>

                      {s.limitMode === 'symmetric' && (
                        <>
                          <span className="text-slate-500">±</span>
                          <input
                            type="number"
                            title="Maximum |position + open-order qty| allowed for this symbol"
                            value={s.maxPosition ?? 100}
                            min={0}
                            onChange={(e) =>
                              updateSymbol(i, { maxPosition: Number(e.target.value) })
                            }
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 outline-none w-20 font-mono"
                          />
                        </>
                      )}

                      {s.limitMode === 'separate' && (
                        <>
                          <span className="text-slate-500">long ≤</span>
                          <input
                            type="number"
                            title="Max long exposure (position + open buys)"
                            value={s.maxLong ?? 100}
                            min={0}
                            onChange={(e) =>
                              updateSymbol(i, { maxLong: Number(e.target.value) })
                            }
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 outline-none w-16 font-mono"
                          />
                          <span className="text-slate-500">short ≤</span>
                          <input
                            type="number"
                            title="Max short exposure (|position - open sells|)"
                            value={s.maxShort ?? 100}
                            min={0}
                            onChange={(e) =>
                              updateSymbol(i, { maxShort: Number(e.target.value) })
                            }
                            className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-slate-200 outline-none w-16 font-mono"
                          />
                        </>
                      )}
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-slate-500 px-1 pt-1">
                  IDs are internal — they must be unique positive integers. The engine
                  spins up one matching shard per symbol. Position caps reject any
                  external order whose worst-case fill would push the user past the
                  configured limit; the in-process market maker is exempt.
                </p>
              </div>
            </Card>

            <Card
              title="In-process Market Maker"
              action={
                <label className="text-xs flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-blue-500"
                    checked={cfg.market_maker.enabled}
                    onChange={(e) => updateMM('enabled', e.target.checked)}
                  />
                  <span className="text-slate-300">Enabled</span>
                </label>
              }
            >
              <div className={sectionCls}>
                <p className="text-xs text-slate-500">
                  Posts symmetric Buy/Sell quotes around the configured mid for every
                  symbol so the book has liquidity before any external bot connects.
                </p>
                <div
                  className={`grid grid-cols-2 gap-3 ${
                    cfg.market_maker.enabled ? '' : 'opacity-40 pointer-events-none'
                  }`}
                >
                  <div>
                    <div className={labelCls}>Spread (bps)</div>
                    <input
                      type="number"
                      title="Half-spread in basis points (20 = ±0.10% around mid)"
                      className={inputCls}
                      value={cfg.market_maker.spread_bps}
                      min={1}
                      onChange={(e) => updateMM('spread_bps', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <div className={labelCls}>Quote size</div>
                    <input
                      type="number"
                      title="Quote size posted on each side"
                      className={inputCls}
                      value={cfg.market_maker.size}
                      min={1}
                      onChange={(e) => updateMM('size', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <div className={labelCls}>Refresh (ms)</div>
                    <input
                      type="number"
                      title="How often the market maker re-quotes (milliseconds)"
                      className={inputCls}
                      value={cfg.market_maker.refresh_ms}
                      min={100}
                      step={100}
                      onChange={(e) => updateMM('refresh_ms', Number(e.target.value))}
                    />
                  </div>
                  <div className="flex items-end">
                    <label className="text-xs flex items-center gap-2 cursor-pointer pb-1">
                      <input
                        type="checkbox"
                        className="accent-blue-500"
                        checked={cfg.market_maker.track_trades}
                        onChange={(e) => updateMM('track_trades', e.target.checked)}
                      />
                      <span className="text-slate-300">Track last trade as mid</span>
                    </label>
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="News-driven bots"
              action={
                <span className="text-[10px] text-slate-500 font-mono">Gemini</span>
              }
            >
              <div className={sectionCls}>
                <p className="text-xs text-slate-500">
                  Polls the backend&#39;s <code>/news</code> feed every{' '}
                  <code>poll_seconds</code>, sends new headlines to Gemini for
                  classification, and routes (symbol, direction, confidence)
                  signals to one of three personas. Bots run in-process and are
                  exempt from per-symbol position caps (same carve-out as the
                  market maker).
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className={labelCls}>Poll seconds</div>
                    <input
                      type="number"
                      title="How often to poll the backend's /news endpoint"
                      className={inputCls}
                      value={cfg.news.poll_seconds}
                      min={5}
                      onChange={(e) =>
                        updateNews('poll_seconds', Number(e.target.value))
                      }
                    />
                  </div>
                  <div>
                    <div className={labelCls}>Gemini model</div>
                    <input
                      type="text"
                      title="Gemini model identifier — flash is cheap and fast; pro is smarter"
                      className={inputCls}
                      value={cfg.news.gemini_model}
                      onChange={(e) => updateNews('gemini_model', e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <div className={labelCls}>
                    Gemini API key
                    <span className="text-slate-600 normal-case ml-2 tracking-normal">
                      (or leave blank and set <code>GEMINI_API_KEY</code> env var)
                    </span>
                  </div>
                  <input
                    type="password"
                    title="Gemini API key. Treat the resulting server.json as sensitive — don't commit it."
                    className={inputCls}
                    value={cfg.news.gemini_api_key}
                    placeholder="AIza..."
                    onChange={(e) => updateNews('gemini_api_key', e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {cfg.news.gemini_api_key && (
                    <p className="text-[10px] text-amber-400/80 mt-1">
                      ⚠ The key is now embedded in <code>server.json</code> below.
                      Don&#39;t commit, paste publicly, or share the file.
                    </p>
                  )}
                </div>

                <div className="space-y-2 pt-1">
                  {cfg.news.bots.map((b, i) => {
                    const active = (b.count ?? 0) > 0;
                    return (
                      <div
                        key={b.persona}
                        className={`border rounded-md p-2 space-y-2 ${
                          active
                            ? 'border-blue-900/60 bg-blue-950/20'
                            : 'border-slate-800 bg-slate-900/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-200 capitalize">
                            {b.persona}
                          </span>
                          <label className="text-xs flex items-center gap-2">
                            <span className="text-slate-400 uppercase tracking-wide">
                              Count
                            </span>
                            <input
                              type="number"
                              title="Number of independent instances of this persona to run (0 = disabled)"
                              value={b.count ?? 0}
                              min={0}
                              max={20}
                              onChange={(e) =>
                                updateNewsBot(i, { count: Number(e.target.value) })
                              }
                              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white outline-none w-16 font-mono"
                            />
                          </label>
                        </div>
                        <p className="text-[10px] text-slate-500 leading-snug">
                          {PERSONA_BLURBS[b.persona]}
                        </p>
                        <div
                          className={`grid grid-cols-2 gap-2 ${
                            active ? '' : 'opacity-40 pointer-events-none'
                          }`}
                        >
                          <div>
                            <div className={labelCls}>Size per signal</div>
                            <input
                              type="number"
                              title="Base order size; multiplied by confidence and the size-jitter sample at trade time"
                              className={inputCls}
                              value={b.size_per_signal}
                              min={1}
                              onChange={(e) =>
                                updateNewsBot(i, {
                                  size_per_signal: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div>
                            <div className={labelCls}>
                              Confidence threshold ({b.confidence_threshold.toFixed(2)})
                            </div>
                            <input
                              type="range"
                              title="Skip Gemini signals below this confidence"
                              className="w-full accent-blue-500"
                              value={b.confidence_threshold}
                              min={0}
                              max={1}
                              step={0.05}
                              onChange={(e) =>
                                updateNewsBot(i, {
                                  confidence_threshold: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div>
                            <div className={labelCls}>
                              Size jitter ±{b.size_jitter_pct ?? 0}%
                            </div>
                            <input
                              type="range"
                              title="Per-trade size variation; helps siblings of the same persona produce non-identical orders"
                              className="w-full accent-blue-500"
                              value={b.size_jitter_pct ?? 0}
                              min={0}
                              max={90}
                              step={5}
                              onChange={(e) =>
                                updateNewsBot(i, {
                                  size_jitter_pct: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div>
                            <div className={labelCls}>
                              Price jitter ±{b.price_offset_jitter_bps ?? 0} bps
                            </div>
                            <input
                              type="range"
                              title="Per-trade price-offset variation around the persona's base offset"
                              className="w-full accent-blue-500"
                              value={b.price_offset_jitter_bps ?? 0}
                              min={0}
                              max={100}
                              step={5}
                              onChange={(e) =>
                                updateNewsBot(i, {
                                  price_offset_jitter_bps: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                          <div className="col-span-2">
                            <div className={labelCls}>
                              Background trades every{' '}
                              {b.noise_interval_seconds > 0
                                ? `~${b.noise_interval_seconds}s`
                                : 'OFF'}
                            </div>
                            <input
                              type="range"
                              title="Each instance fires a randomly-directed half-size order at this interval (jittered ±50%) to keep the book active when news is sparse. 0 disables noise."
                              className="w-full accent-blue-500"
                              value={b.noise_interval_seconds ?? 0}
                              min={0}
                              max={120}
                              step={5}
                              onChange={(e) =>
                                updateNewsBot(i, {
                                  noise_interval_seconds: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>

            <button
              type="button"
              onClick={resetDefaults}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Reset to defaults
            </button>
          </div>

          {/* ---------------- RIGHT: output ---------------- */}
          <div className="lg:sticky lg:top-6 self-start space-y-3">
            <Card
              title="server.json"
              action={
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={copy}
                    disabled={errors.length > 0}
                    className="text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white px-3 py-1 rounded flex items-center gap-1 transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3 h-3" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> Copy
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={download}
                    disabled={errors.length > 0}
                    className="text-xs bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-500 text-white px-3 py-1 rounded flex items-center gap-1 transition-colors"
                  >
                    <Download className="w-3 h-3" /> Download
                  </button>
                </div>
              }
            >
              <HighlightedJson value={json} />
            </Card>

            {errors.length > 0 && (
              <div className="bg-red-950/30 border border-red-900/60 rounded-lg p-3 text-xs text-red-300">
                <div className="font-semibold mb-1">Fix these before copying:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 space-y-1">
              <div className="font-semibold text-slate-300 mb-1">Next steps</div>
              <div>
                1. Save as <code className="text-blue-400">server.json</code>.
              </div>
              <div>
                2a. Run bare:{' '}
                <code className="text-blue-400">./engine --config server.json</code>
              </div>
              <div>
                2b. Run via Docker:{' '}
                <code className="text-blue-400">
                  docker run -p {cfg.server.port}:{cfg.server.port} -v
                  $(pwd)/server.json:/cfg/server.json:ro -v engine-data:/data
                  orbital-engine
                </code>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
