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

export function wsBase(server: string): string {
  return `${secure() ? 'wss' : 'ws'}://${server}`;
}

// Default engine server. Override at build time with NEXT_PUBLIC_DEFAULT_SERVER
// (e.g. `bubbles-engine.koyeb.app` for a hosted dashboard).
export const DEFAULT_SERVER =
  process.env.NEXT_PUBLIC_DEFAULT_SERVER || 'localhost:9090';
