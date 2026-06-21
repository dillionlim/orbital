'use client';

// Symbol registry fetched from the engine's GET /symbols endpoint, replacing
// the BTC-USD/ETH-USD/LTC-USD hardcoded triplet that used to live inline in
// every dashboard widget. Caches per-server because each engine is its own
// world — switching servers must invalidate the cached list, but repeated
// hook calls within a single server should not refetch.

import { useEffect, useState } from 'react';
import { useCurrentServer } from '../hooks/useCurrentServer';
import { httpBase } from './engineUrl';

export interface EngineSymbol {
  name: string;
  id: number;
  mid: number;
  max_long?: number;
  max_short?: number;
}

const cache = new Map<string, EngineSymbol[]>();
const inflight = new Map<string, Promise<EngineSymbol[]>>();

export async function fetchSymbols(server: string): Promise<EngineSymbol[]> {
  const cached = cache.get(server);
  if (cached) return cached;
  const existing = inflight.get(server);
  if (existing) return existing;
  const p = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${httpBase(server)}/symbols`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { symbols?: EngineSymbol[] };
      const list = j.symbols ?? [];
      cache.set(server, list);
      return list;
    } finally {
      inflight.delete(server);
    }
  })();
  inflight.set(server, p);
  return p;
}

export interface UseSymbolsResult {
  symbols: EngineSymbol[];
  names: string[];
  loading: boolean;
  error: string | null;
}

function snapshotFor(server: string): UseSymbolsResult {
  const cached = cache.get(server);
  return {
    symbols: cached ?? [],
    names: cached?.map((s) => s.name) ?? [],
    loading: !cached,
    error: null,
  };
}

// Hook form. Re-fetches whenever the user-selected server changes.
// Returns cached state synchronously when available so widgets don't flash
// "loading" between re-mounts on the same server.
//
// Server-change reset uses React's "derived state during render" pattern
// (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
// rather than a useEffect — that keeps us out of the
// `react-hooks/set-state-in-effect` rule, which flags cascading-render
// risk when setState fires synchronously from an effect body. The async
// .then/.catch setState calls below are inside microtasks, not the
// effect body itself, so they're fine by the rule.
export function useSymbols(): UseSymbolsResult {
  const server = useCurrentServer();
  const [trackedServer, setTrackedServer] = useState(server);
  const [state, setState] = useState<UseSymbolsResult>(() => snapshotFor(server));
  if (server !== trackedServer) {
    setTrackedServer(server);
    setState(snapshotFor(server));
  }

  useEffect(() => {
    let alive = true;
    fetchSymbols(server)
      .then((symbols) => {
        if (!alive) return;
        setState({
          symbols,
          names: symbols.map((s) => s.name),
          loading: false,
          error: null,
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setState({
          symbols: [],
          names: [],
          loading: false,
          error: e instanceof Error ? e.message : 'fetch failed',
        });
      });
    return () => { alive = false; };
  }, [server]);

  return state;
}
