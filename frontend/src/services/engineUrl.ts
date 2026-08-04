// Engine REST/WS URL helpers. The dashboard talks to the trading engine
// directly (a host[:port] like `localhost:9090` or `bubbles-engine.koyeb.app`).
// Use a scheme that matches how the page itself is served: wss/https when the
// dashboard is on HTTPS (so a hosted engine works without mixed-content errors),
// ws/http for local dev.

function secure(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:';
}

export function httpBase(server: string): string {
  return `${secure() ? 'https' : 'http'}://${server}`;
}

function isLocalTunnel(server: string): boolean {
  const hostname = server.toLowerCase().split(':', 1)[0];
  return hostname.endsWith('.loca.lt') || hostname.endsWith('.localtunnel.me');
}

// LocalTunnel puts browser requests behind a reminder page. Its supported
// opt-out is the bypass-tunnel-reminder header. Apply it only to LocalTunnel
// hosts so ordinary engines keep making simple (non-preflighted) GET requests.
export function engineFetch(
  server: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (isLocalTunnel(server)) {
    headers.set('bypass-tunnel-reminder', 'true');
  }
  return fetch(`${httpBase(server)}${path}`, { ...init, headers });
}

export function wsBase(server: string): string {
  return `${secure() ? 'wss' : 'ws'}://${server}`;
}

// Default engine server. Override at build time with NEXT_PUBLIC_DEFAULT_SERVER
// (e.g. `bubbles-engine.koyeb.app` for a hosted dashboard).
export const DEFAULT_SERVER =
  process.env.NEXT_PUBLIC_DEFAULT_SERVER || 'localhost:9090';
