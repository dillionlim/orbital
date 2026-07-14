import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineSymbol } from './symbols';

// The symbol cache lives in module scope, so each test needs a pristine copy of
// the module graph (symbols.ts + the useCurrentServer it imports) — otherwise a
// cache entry from an earlier test would silently satisfy the next fetch.
type SymbolsModule = typeof import('./symbols');
type ServerModule = typeof import('../hooks/useCurrentServer');

let symbolsModule: SymbolsModule;
let serverModule: ServerModule;

function symbol(name: string, id: number): EngineSymbol {
  return { name, id, mid: 100 };
}

function symbolsResponse(list: EngineSymbol[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ symbols: list }),
  } as Response;
}

// Lets a test hold the engine's reply open, which is the only way to observe the
// in-flight promise being shared instead of a second request going out.
function deferredResponse(list: EngineSymbol[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    respond: async (): Promise<Response> => {
      await gate;
      return symbolsResponse(list);
    },
  };
}

describe('symbols', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    symbolsModule = await import('./symbols');
    serverModule = await import('../hooks/useCurrentServer');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // The registry is fetched once per engine and reused: widgets call this on every
  // mount, and hammering /symbols on each render is what the cache exists to stop.
  it('caches the symbol list per server after the first fetch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(symbolsResponse([symbol('BTC-USD', 1)]));

    const first = await symbolsModule.fetchSymbols('engine.a:9090');
    const second = await symbolsModule.fetchSymbols('engine.a:9090');

    expect(first.map((s) => s.name)).toEqual(['BTC-USD']);
    expect(second).toBe(first); // same array instance — served straight from cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://engine.a:9090/symbols');
  });

  // Two widgets mounting in the same tick must not each open a request; the second
  // caller joins the in-flight promise.
  it('dedupes concurrent callers onto one in-flight request', async () => {
    const fetchMock = vi.mocked(fetch);
    const pending = deferredResponse([symbol('BTC-USD', 1), symbol('ETH-USD', 2)]);
    fetchMock.mockImplementation(pending.respond);

    const a = symbolsModule.fetchSymbols('engine.a:9090');
    const b = symbolsModule.fetchSymbols('engine.a:9090');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.release();
    expect(await a).toBe(await b);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once settled the entry is cached, so a later caller still doesn't refetch.
    await symbolsModule.fetchSymbols('engine.a:9090');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Each engine is its own world: caching by server (not globally) is what keeps
  // engine B's symbols from leaking into a dashboard pointed at engine A.
  it('keeps a separate cache entry per server', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('engine.a')
        ? symbolsResponse([symbol('BTC-USD', 1)])
        : symbolsResponse([symbol('AAPL', 7)]),
    );

    const a = await symbolsModule.fetchSymbols('engine.a:9090');
    const b = await symbolsModule.fetchSymbols('engine.b:9090');

    expect(a.map((s) => s.name)).toEqual(['BTC-USD']);
    expect(b.map((s) => s.name)).toEqual(['AAPL']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A non-2xx reply is an error, not an empty registry — and it must not be cached,
  // or a single blip would leave the dashboard symbol-less until a reload.
  it('rejects on a non-ok response and does not cache the failure', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    fetchMock.mockResolvedValueOnce(symbolsResponse([symbol('BTC-USD', 1)]));

    await expect(symbolsModule.fetchSymbols('engine.a:9090')).rejects.toThrow('HTTP 503');

    const retry = await symbolsModule.fetchSymbols('engine.a:9090');
    expect(retry.map((s) => s.name)).toEqual(['BTC-USD']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // An engine that answers without a `symbols` key yields an empty list rather than
  // undefined — widgets map over this array directly.
  it('returns an empty list when the payload omits symbols', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);

    await expect(symbolsModule.fetchSymbols('engine.a:9090')).resolves.toEqual([]);
  });

  // An engine that's still booting answers 200 with no symbols. Caching that would
  // be permanent — every widget would sit on "Loading…" until a page reload.
  it('does not cache an empty registry, so a booting engine is retried', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(symbolsResponse([]));
    fetchMock.mockResolvedValueOnce(symbolsResponse([symbol('BTC-USD', 1)]));

    await expect(symbolsModule.fetchSymbols('engine.a:9090')).resolves.toEqual([]);

    const retry = await symbolsModule.fetchSymbols('engine.a:9090');
    expect(retry.map((s) => s.name)).toEqual(['BTC-USD']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useSymbols', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    symbolsModule = await import('./symbols');
    serverModule = await import('../hooks/useCurrentServer');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // The happy path: loading until the registry lands, then names for the dropdowns.
  it('loads the current server symbols and exposes their names', async () => {
    vi.mocked(fetch).mockResolvedValue(symbolsResponse([symbol('BTC-USD', 1), symbol('ETH-USD', 2)]));
    localStorage.setItem('currentServer', 'engine.a:9090');

    const { result } = renderHook(() => symbolsModule.useSymbols());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.names).toEqual(['BTC-USD', 'ETH-USD']);
    expect(result.current.error).toBeNull();
  });

  // Switching servers must invalidate what the widget is showing *during the same
  // render* — keeping engine A's symbols on screen while engine B loads is the
  // cross-server leak this whole module is structured to prevent.
  it('drops the old symbols and refetches when the server switches', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('engine.a')
        ? symbolsResponse([symbol('BTC-USD', 1)])
        : symbolsResponse([symbol('AAPL', 7)]),
    );
    localStorage.setItem('currentServer', 'engine.a:9090');

    const { result } = renderHook(() => symbolsModule.useSymbols());
    await waitFor(() => expect(result.current.names).toEqual(['BTC-USD']));

    act(() => serverModule.setCurrentServer('engine.b:9090'));

    // Engine A's list is gone immediately; we're back to loading, not stale data.
    expect(result.current.symbols).toEqual([]);
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.names).toEqual(['AAPL']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Returning to an already-fetched server is served from cache synchronously —
  // no "loading" flash between remounts, which is the stated reason for the cache.
  it('returns cached symbols synchronously when switching back', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) =>
      String(input).includes('engine.a')
        ? symbolsResponse([symbol('BTC-USD', 1)])
        : symbolsResponse([symbol('AAPL', 7)]),
    );
    localStorage.setItem('currentServer', 'engine.a:9090');

    const { result } = renderHook(() => symbolsModule.useSymbols());
    await waitFor(() => expect(result.current.names).toEqual(['BTC-USD']));

    act(() => serverModule.setCurrentServer('engine.b:9090'));
    await waitFor(() => expect(result.current.names).toEqual(['AAPL']));

    act(() => serverModule.setCurrentServer('engine.a:9090'));
    expect(result.current.loading).toBe(false);
    expect(result.current.names).toEqual(['BTC-USD']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A dead engine surfaces its error instead of hanging on `loading` forever.
  it('surfaces a fetch failure as an error with an empty list', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'));
    localStorage.setItem('currentServer', 'engine.down:9090');

    const { result } = renderHook(() => symbolsModule.useSymbols());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('connection refused');
    expect(result.current.symbols).toEqual([]);
  });
});
