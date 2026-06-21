import React, { useEffect, useMemo, useState } from 'react';
import { Card } from '../ui/Card';
import { Info, Activity, Pause, Play } from 'lucide-react';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { useApiKey } from '../hooks/useApiKey';
import { useEngineUserId } from '../hooks/useEngineUserId';
import { pauseBot, resumeBot } from '../services/botControl';
import { httpBase } from '../services/engineUrl';

interface EngineBot {
  user_id: string;
  client_id: string;
  name: string;
  strategy_name: string;
  is_internal: boolean;
  status: 'active' | 'idle' | 'paused' | 'error';
  paused: boolean;
  orders_placed: number;
  fills: number;
  volume: number;
  total_pnl: number;
  hourly_pnl: number;
  first_seen: number;
  last_activity: number;
}

const POLL_MS = 1500;

const fmtMoney = (v: number): string => {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toFixed(2);
};

export const SimulatedBots: React.FC = () => {
  const [bots, setBots] = useState<EngineBot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const server = useCurrentServer();
  const { apiKey } = useApiKey();
  const engineUserId = useEngineUserId();

  // Wipe bot rows when server changes — different engine, different bots.
  useEffect(() => {
    setBots([]); setError(null); setActionError(null);
  }, [server]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${httpBase(server)}/bots`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { bots: EngineBot[] };
        if (!alive) return;
        setBots(data.bots || []);
        setError(null);
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

  const onToggle = async (bot: EngineBot) => {
    if (!apiKey) { setActionError('Missing API key'); return; }
    const id = bot.client_id || bot.user_id;
    setBusyId(id);
    setActionError(null);
    const fn = bot.paused ? resumeBot : pauseBot;
    const res = await fn(server, id, apiKey);
    if (!res.ok) {
      const map: Record<string, string> = {
        unauthorized: 'Invalid API key',
        not_owner: 'You can only pause your own bots',
        not_found: 'Bot not found on engine',
        internal_bot: 'Internal market maker can\'t be paused',
        network: 'Network error',
      };
      setActionError(map[res.error || 'network'] || 'Failed');
    } else {
      // Optimistic flip until next poll picks it up.
      setBots(prev => prev.map(b =>
        (b.client_id || b.user_id) === id
          ? { ...b, paused: !bot.paused, status: !bot.paused ? 'paused' : 'active' }
          : b,
      ));
    }
    setBusyId(null);
  };

  // Collapse all internal news bots into a single synthetic row so the
  // table doesn't blow up when count > 5 across three personas. Sums the
  // numeric fields and picks the most "alive" status across all of them
  // ("active" > "idle" > "paused" > "error"), so the badge reflects what
  // any sibling is currently doing.
  const displayBots = useMemo<EngineBot[]>(() => {
    const news: EngineBot[] = [];
    const rest: EngineBot[] = [];
    for (const b of bots) {
      if (b.user_id.startsWith('internal:news_')) news.push(b);
      else rest.push(b);
    }
    if (news.length === 0) return rest;

    // Status precedence: any active bot wins; then idle; then paused; then error.
    const order: Record<EngineBot['status'], number> = {
      active: 0, idle: 1, paused: 2, error: 3,
    };
    const aggStatus = news.reduce<EngineBot['status']>(
      (s, b) => (order[b.status] < order[s] ? b.status : s),
      news[0].status,
    );
    const lastActivity = news.reduce((m, b) => Math.max(m, b.last_activity || 0), 0);
    const firstSeen = news.reduce(
      (m, b) => (b.first_seen && (m === 0 || b.first_seen < m) ? b.first_seen : m),
      0,
    );
    const synthetic: EngineBot = {
      user_id: 'internal:news_aggregate',
      client_id: '',
      name: `News bots (${news.length})`,
      strategy_name: 'News-driven (Gemini, all personas)',
      is_internal: true,
      status: aggStatus,
      paused: news.every((b) => b.paused),
      orders_placed: news.reduce((s, b) => s + (b.orders_placed || 0), 0),
      fills: news.reduce((s, b) => s + (b.fills || 0), 0),
      volume: news.reduce((s, b) => s + (b.volume || 0), 0),
      total_pnl: news.reduce((s, b) => s + (b.total_pnl || 0), 0),
      hourly_pnl: news.reduce((s, b) => s + (b.hourly_pnl || 0), 0),
      first_seen: firstSeen,
      last_activity: lastActivity,
    };
    return [synthetic, ...rest];
  }, [bots]);

  const dotColor = (b: EngineBot) => {
    if (b.paused || b.status === 'paused') return 'bg-yellow-500';
    if (b.status === 'error') return 'bg-red-500';
    if (b.status === 'idle') return 'bg-slate-500';
    return b.is_internal ? 'bg-blue-400 animate-pulse' : 'bg-green-500 animate-pulse';
  };

  const statusBadge = (b: EngineBot) => {
    if (b.paused || b.status === 'paused') {
      return 'bg-yellow-900/40 text-yellow-300 border border-yellow-800/60';
    }
    if (b.status === 'error') return 'bg-red-900/40 text-red-300 border border-red-800/60';
    if (b.status === 'idle') return 'bg-slate-800 text-slate-400 border border-slate-700';
    return 'bg-green-900/40 text-green-300 border border-green-800/60';
  };

  return (
    <Card title="Active Strategy Nodes" className="h-[300px] md:h-full">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="text-[10px] uppercase text-slate-400 bg-slate-900/50 sticky top-0">
              <tr>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Bot</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap">Strategy</th>
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Fills</th>
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Total PnL</th>
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">1h PnL</th>
                <th className="px-3 py-2 font-medium text-center whitespace-nowrap">Status</th>
                <th className="px-3 py-2 font-medium text-center whitespace-nowrap w-12">Ctl</th>
              </tr>
            </thead>
            <tbody className="text-sm divide-y divide-slate-800">
              {displayBots.map((bot) => {
                const id = bot.client_id || bot.user_id;
                const isOwn = !!engineUserId && bot.user_id === engineUserId && !bot.is_internal;
                const busy = busyId === id;
                return (
                  <tr key={`${bot.user_id}::${id}`} className="group hover:bg-slate-700/30 transition-colors">
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${dotColor(bot)}`} />
                        <span className="font-medium text-white">{bot.name}</span>
                        {bot.is_internal && (
                          <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800/60">
                            internal
                          </span>
                        )}
                        {isOwn && (
                          <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-800/60">
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{bot.strategy_name}</td>
                    <td className="px-3 py-2 text-right text-slate-300 font-mono text-xs">
                      {bot.fills.toLocaleString()}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${bot.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {bot.total_pnl > 0 ? '+' : ''}{fmtMoney(bot.total_pnl)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${bot.hourly_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {bot.hourly_pnl > 0 ? '+' : ''}{fmtMoney(bot.hourly_pnl)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded ${statusBadge(bot)}`}>
                        {bot.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {isOwn ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onToggle(bot)}
                          title={bot.paused ? 'Resume bot' : 'Pause bot'}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            bot.paused
                              ? 'bg-green-900/40 text-green-300 hover:bg-green-800/60'
                              : 'bg-yellow-900/40 text-yellow-300 hover:bg-yellow-800/60'
                          }`}
                        >
                          {bot.paused
                            ? <Play className="w-3.5 h-3.5" />
                            : <Pause className="w-3.5 h-3.5" />}
                        </button>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {bots.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-slate-500 text-sm">
                    {error
                      ? `No engine at ${server}`
                      : 'No active bots yet — waiting for activity…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-2 py-2 border-t border-slate-700 flex justify-center items-center gap-2 text-xs text-slate-500">
          <Activity className="w-3.5 h-3.5" />
          {actionError
            ? <span className="text-red-400">{actionError}</span>
            : <>Server-managed. You can pause/resume bots tagged <span className="text-purple-300 font-mono">you</span>.</>}
          <Info className="w-3.5 h-3.5" />
        </div>
      </div>
    </Card>
  );
};
