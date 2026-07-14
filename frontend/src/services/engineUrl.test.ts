import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SERVER, httpBase, wsBase } from './engineUrl';

// The engine is addressed as a bare `host[:port]`, so the scheme is chosen at
// call time from how the *page* is served. Get this wrong on a hosted dashboard
// and every request is blocked as mixed content — hence the paranoia below.
describe('engineUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Local dev (jsdom serves the page over http:) must stay on the plain schemes;
  // upgrading to https/wss here would break `localhost:9090`, which has no TLS.
  it('uses http/ws when the page is served over http', () => {
    expect(window.location.protocol).toBe('http:');
    expect(httpBase('localhost:9090')).toBe('http://localhost:9090');
    expect(wsBase('localhost:9090')).toBe('ws://localhost:9090');
  });

  // The regression that matters: on an https dashboard both helpers must upgrade,
  // or the browser kills the fetch and the WebSocket as mixed content.
  it('uses https/wss when the page is served over https', () => {
    vi.stubGlobal('location', { protocol: 'https:' });

    expect(httpBase('bubbles-engine.koyeb.app')).toBe('https://bubbles-engine.koyeb.app');
    expect(wsBase('bubbles-engine.koyeb.app')).toBe('wss://bubbles-engine.koyeb.app');
  });

  // Server-side rendering has no `window`; the helpers must not throw on import
  // paths that run during prerender, and fall back to the insecure scheme.
  it('falls back to http/ws when there is no window (SSR)', () => {
    vi.stubGlobal('window', undefined);

    expect(httpBase('engine.test:9090')).toBe('http://engine.test:9090');
    expect(wsBase('engine.test:9090')).toBe('ws://engine.test:9090');
  });

  // The host is pasted through verbatim — no normalization, no trailing slash —
  // so a path suffix appended by callers (`${httpBase(s)}/symbols`) stays valid.
  it('appends the server verbatim without a trailing slash', () => {
    expect(httpBase('10.0.0.7:8080')).toBe('http://10.0.0.7:8080');
    expect(`${httpBase('10.0.0.7:8080')}/symbols`).toBe('http://10.0.0.7:8080/symbols');
  });

  // Without a NEXT_PUBLIC_DEFAULT_SERVER override the dashboard points at a local
  // engine — the value every widget falls back to before the user picks a server.
  it('defaults to the local engine when no build-time server is configured', () => {
    expect(process.env.NEXT_PUBLIC_DEFAULT_SERVER).toBeUndefined();
    expect(DEFAULT_SERVER).toBe('localhost:9090');
  });
});
