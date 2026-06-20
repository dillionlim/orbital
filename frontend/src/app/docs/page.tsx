'use client';

// Bubbles trading-engine API docs. Hosted by the frontend (was previously
// embedded into the engine binary at /docs and shipped as static HTML
// under public/engine-docs). Rewritten as TSX so it shares the dashboard
// shell, picks up Tailwind theming, and gets client-side scroll-spy +
// copy-to-clipboard via React rather than a hand-rolled IIFE.
//
// `openapi.yaml` and `api.md` continue to live as raw downloads under
// public/engine-docs/ — those two files are useful as inputs to external
// tools (Swagger UI, Redoc, etc.) and don't need to be ported to TSX.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { highlight } from './highlight';
import BubblesIcon from '@/src/ui/BubblesIcon';

// ---- Reusable inline components -------------------------------------------

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="absolute top-2 right-2 text-[10px] uppercase tracking-wide font-mono px-2 py-0.5 rounded border border-slate-700 bg-slate-900/80 text-slate-400 hover:text-white hover:border-slate-500 transition-colors flex items-center gap-1"
      title="Copy"
    >
      {copied ? (<><Check className="w-3 h-3" /> copied</>) : (<><Copy className="w-3 h-3" /> copy</>)}
    </button>
  );
}

// Code block with a copy button + per-language syntax highlighting via
// the inline tokenizer in ./highlight. lang is also rendered as a quiet
// eyebrow so the reader can tell at a glance which dialect they're
// looking at — same affordance the original docs gave with data-lang.
function CodeBlock({ lang, children }: { lang?: string; children: string }) {
  return (
    <div className="relative my-3">
      {lang && (
        <span className="absolute top-2 left-3 text-[10px] uppercase tracking-wide font-mono text-slate-500">
          {lang}
        </span>
      )}
      <pre className="font-code text-[12px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-3 pt-7 overflow-x-auto whitespace-pre leading-relaxed">
        <code>{highlight(lang, children)}</code>
      </pre>
      {/* Pass the raw children to the clipboard — innerText would lose
          newlines that React fragments preserve, but the prop is the
          original source either way and is the cleanest thing to copy. */}
      <CopyButton getText={() => children} />
    </div>
  );
}

// Anchored section. id matches the original docs slugs so anyone with a
// bookmark to e.g. #ws-place still lands in the right place.
function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 mb-10">
      {children}
    </section>
  );
}

// Two-column "key | value" table — used for routes, types, error codes.
function KvTable({ headers, rows }: { headers?: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-sm border border-slate-800 rounded">
        {headers && (
          <thead className="bg-slate-800/60">
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="text-left px-3 py-2 text-[11px] uppercase tracking-wide text-slate-400 font-semibold border-b border-slate-800">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((cells, ri) => (
            <tr key={ri} className="border-b border-slate-800/60 last:border-b-0">
              {cells.map((c, ci) => (
                <td key={ci} className="px-3 py-2 align-top text-slate-300">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Inline `<code>` with the dashboard's accent color.
const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className="font-code text-[12.5px] text-blue-300 bg-slate-800/60 px-1 py-0.5 rounded">
    {children}
  </code>
);

// ---- Sidebar ---------------------------------------------------------------

interface NavEntry { href: string; label: string; }
interface NavGroup { title: string; entries: NavEntry[]; }

const NAV: NavGroup[] = [
  {
    title: 'Getting started',
    entries: [
      { href: '#overview',   label: 'Overview' },
      { href: '#quickstart', label: 'Quick start' },
      { href: '#config',     label: 'Server config' },
    ],
  },
  {
    title: 'REST API',
    entries: [
      { href: '#rest-endpoints', label: 'Endpoints' },
      { href: '#rest-health',    label: 'GET /health' },
      { href: '#rest-status',    label: 'GET /status' },
      { href: '#rest-metrics',   label: 'GET /metrics' },
      { href: '#rest-symbols',   label: 'GET /symbols' },
      { href: '#rest-orderbook', label: 'GET /orderbook' },
      { href: '#rest-trades',    label: 'GET /trades' },
      { href: '#rest-bots',      label: 'GET /bots' },
      { href: '#rest-auth',      label: 'POST /auth' },
    ],
  },
  {
    title: 'WebSocket',
    entries: [
      { href: '#ws-connect',   label: 'Connect & auth' },
      { href: '#ws-protocol',  label: 'Wire protocol' },
      { href: '#ws-place',     label: 'place_order' },
      { href: '#ws-cancel',    label: 'cancel_order' },
      { href: '#ws-subscribe', label: 'subscribe' },
      { href: '#ws-events',    label: 'Server events' },
    ],
  },
  {
    title: 'Reference',
    entries: [
      { href: '#types',       label: 'Types' },
      { href: '#symbols',     label: 'Symbol registry' },
      { href: '#errors',      label: 'Error codes' },
      { href: '#mm',          label: 'Market maker' },
      { href: '#news-bots',   label: 'News-driven bots' },
      { href: '#persistence', label: 'Persistence' },
    ],
  },
];

// Scroll-spy: pick the topmost visible section as "active" so the sidebar
// link follows the reader. Falls back to the URL hash on browsers without
// IntersectionObserver (every modern browser has it; this is just defense).
function useActiveSection(allIds: string[]): string {
  const [active, setActive] = useState<string>(allIds[0] ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      // Pick the first visible section in document order so the active
      // link doesn't oscillate between adjacent sections that happen to
      // both be on screen.
      for (const id of allIds) {
        if (visible.has(id)) { setActive(id); break; }
      }
    }, { rootMargin: '-72px 0px -60% 0px', threshold: 0 });
    for (const id of allIds) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [allIds]);
  return active;
}

// ---- Page -----------------------------------------------------------------

export default function DocsPage() {
  const allIds = NAV.flatMap((g) => g.entries.map((e) => e.href.slice(1)));
  const active = useActiveSection(allIds);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
             <BubblesIcon className="text-white w-5 h-5" />
           </div>
          <span className="font-bold text-xl tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-sky-300 via-blue-500 to-indigo-600">
            Bubbles
          </span>
          <span className="ml-2 text-xs text-slate-500 font-mono">/ docs</span>
        </Link>
        <div className="flex items-center gap-3">
          <a
            href="/engine-docs/openapi.yaml"
            className="text-xs font-mono px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
          >
            openapi.yaml
          </a>
          <a
            href="/engine-docs/api.md"
            className="text-xs font-mono px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
          >
            api.md
          </a>
          <Link
            href="/dashboard"
            className="text-sm font-medium text-slate-400 hover:text-white transition-colors flex items-center gap-1"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8">
        {/* Sidebar */}
        <aside className="hidden lg:block sticky top-24 self-start max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
          {NAV.map((group) => (
            <div key={group.title} className="mb-6">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-2">
                {group.title}
              </div>
              <ul className="space-y-1">
                {group.entries.map((e) => {
                  const id = e.href.slice(1);
                  const isActive = id === active;
                  return (
                    <li key={e.href}>
                      <a
                        href={e.href}
                        className={`block text-xs px-2 py-1 rounded border-l-2 transition-colors ${
                          isActive
                            ? 'border-blue-500 text-white bg-slate-800/60'
                            : 'border-transparent text-slate-400 hover:text-white hover:bg-slate-800/30'
                        }`}
                      >
                        {e.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </aside>

        {/* Main content */}
        <main className="min-w-0">
          {/* ============== Overview ============== */}
          <Section id="overview">
            <h1 className="text-3xl font-bold text-white mb-3">Bubbles Trading Engine</h1>
            <p className="text-slate-300 mb-4">
              A self-contained C++20 trading server. Single port (default <Mono>:9090</Mono>) speaks
              both REST and WebSocket. Bots place orders over WebSocket against a real
              price-time priority matching engine; an in-process market maker keeps the book
              liquid; SQLite persists every order and trade.
            </p>
            <div className="grid sm:grid-cols-3 gap-3 my-4">
              {[
                ['Engine',       'Per-symbol matching',     'One thread per symbol shard. SPSC queues from a single Sequencer. Lock-free hot path.'],
                ['Wire',         'JSON over WebSocket',     'Easy to drive from Python, JS, or any WS client. RFC 6455.'],
                ['Self-hosted',  'Single binary',           'One ./engine. SQLite linked statically; everything else compiled in.'],
              ].map(([eyebrow, title, body]) => (
                <div key={title} className="bg-slate-800/40 border border-slate-700 rounded p-3">
                  <div className="text-[10px] uppercase tracking-wider text-blue-400 font-bold mb-1">{eyebrow}</div>
                  <div className="text-sm font-semibold text-white mb-1">{title}</div>
                  <p className="text-xs text-slate-400">{body}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* ============== Quickstart ============== */}
          <Section id="quickstart">
            <h2 className="text-2xl font-bold text-white mb-3">Quick start</h2>
            <p className="text-slate-300">From the project root:</p>
            <CodeBlock lang="bash">{`cd trading_engine
make run                # builds Release, then starts the engine on :9090`}</CodeBlock>
            <p className="text-slate-300 text-sm mt-2">
              The engine logs the listening port and the symbols its market maker has seeded.
            </p>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">1. Hit the REST surface</h3>
            <CodeBlock lang="bash">{`curl http://localhost:9090/health
# {"status":"healthy"}

curl 'http://localhost:9090/orderbook?symbol=BTC' | jq .
# { "symbol":"BTC-USD", "timestamp":"...", "bids":[...], "asks":[...] }

curl http://localhost:9090/symbols | jq .
# { "symbols":[ {"name":"BTC-USD","id":1,"mid":50000}, ... ] }`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">2. Connect a bot via WebSocket</h3>
            <CodeBlock lang="python">{`import asyncio, json, websockets

API_KEY = "sk_live_<your-32-hex-key>"   # issued by the backend's /api-keys endpoint

async def main():
    async with websockets.connect(
        "ws://localhost:9090/",
        extra_headers={"Api-Key": API_KEY},
    ) as ws:
        await ws.send(json.dumps({"t": "hello", "client_id": "demo-bot"}))
        await ws.send(json.dumps({"t": "subscribe", "channel": "book", "symbol": "BTC-USD"}))
        await ws.send(json.dumps({
            "t": "place_order",
            "client_order_id": "x1",
            "symbol": "BTC-USD",
            "side": "Buy",
            "type": "Limit",
            "quantity": 5,
            "limit_price": 50100.0,
        }))
        async for msg in ws:
            print(json.loads(msg))

asyncio.run(main())`}</CodeBlock>
            <p className="text-slate-300 text-sm mt-2">
              Expected message sequence: <Mono>welcome</Mono> → <Mono>book</Mono> snapshot → <Mono>order_ack</Mono> → <Mono>trade</Mono> → <Mono>order_fill</Mono> → <Mono>book</Mono> delta.
            </p>
          </Section>

          {/* ============== Server config ============== */}
          <Section id="config">
            <h2 className="text-2xl font-bold text-white mb-3">Server config</h2>
            <p className="text-slate-300">
              JSON file passed as <Mono>--config</Mono>. Defaults loaded if omitted. The
              dashboard ships a{' '}
              <Link href="/config-generator" className="text-blue-400 hover:underline">
                Config Generator
              </Link>
              {' '}page that builds this file interactively.
            </p>
            <CodeBlock lang="json">{`{
  "server": {
    "port": 9090,
    "backend_url": "http://localhost:3010",
    "db_path": "./engine.db",
    "auth_cache_ttl_seconds": 300
  },
  "symbols": [
    { "name": "BTC-USD", "id": 1, "mid": 50000.0, "max_long": 100, "max_short": 100 },
    { "name": "ETH-USD", "id": 2, "mid": 3000.0  },
    { "name": "LTC-USD", "id": 3, "mid": 100.0   }
  ],
  "market_maker": {
    "enabled": true,
    "spread_bps": 20,
    "size": 10,
    "refresh_ms": 5000,
    "track_trades": true,
    "requote_drift_bps": 0
  },
  "news": {
    "poll_seconds": 30,
    "gemini_model": "gemini-2.5-flash",
    "gemini_api_key": "",
    "fetch_limit": 200,
    "bots": [
      { "count": 0, "persona": "momentum",   "size_per_signal": 5, "confidence_threshold": 0.6,  "size_jitter_pct": 25, "price_offset_jitter_bps": 15, "noise_interval_seconds": 0, "signal_delay_ms": 3000 }
    ]
  }
}`}</CodeBlock>
            <KvTable
              headers={['CLI flag', 'Effect']}
              rows={[
                [<Mono key="c">--config &lt;path&gt;</Mono>,      'Load JSON config'],
                [<Mono key="p">--port &lt;n&gt;</Mono>,           'Override server port'],
                [<Mono key="b">--backend-url &lt;url&gt;</Mono>,  'Override NestJS backend URL for API key validation'],
                [<Mono key="d">--db &lt;path&gt;</Mono>,          'Override SQLite path'],
                [<Mono key="m">--no-mm</Mono>,                   'Disable in-process market maker'],
                [<Mono key="h">--help</Mono>,                    'Print usage and exit'],
              ]}
            />
          </Section>

          {/* ============== REST endpoints ============== */}
          <Section id="rest-endpoints">
            <h2 className="text-2xl font-bold text-white mb-3">REST endpoints</h2>
            <p className="text-slate-300">
              All responses are JSON unless noted. CORS is enabled (<Mono>*</Mono>) for
              browser clients.
            </p>
            <KvTable
              headers={['Method', 'Path', 'Auth', 'Purpose']}
              rows={[
                ['GET',  <Mono key="h">/health</Mono>,                                    '—',         'Liveness check'],
                ['GET',  <Mono key="s">/status</Mono>,                                    '—',         'Server status + metrics'],
                ['GET',  <Mono key="m">/metrics</Mono>,                                   '—',         'Counters: connections, orders, trades'],
                ['GET',  <Mono key="sy">/symbols</Mono>,                                  '—',         'Configured symbol registry (name, id, mid, caps)'],
                ['GET',  <Mono key="o">/orderbook?symbol=&lt;sym&gt;</Mono>,              'optional',  'L2 snapshot (top 20 levels)'],
                ['GET',  <Mono key="t">/trades?symbol=&lt;sym&gt;&amp;limit=N</Mono>,     'optional',  'Recent trades from the in-memory cache'],
                ['GET',  <Mono key="th">/trades/historical?symbol=&hellip;&amp;from=&amp;to=</Mono>, 'optional',  'Trades from SQLite (paged, capped 50k)'],
                ['GET',  <Mono key="b">/bots</Mono>,                                      '—',         'Live bot/strategy snapshot for the dashboard'],
                ['POST', <Mono key="bp">/bots/&lt;client_id&gt;/{'{'}pause,resume{'}'}</Mono>, 'API key',   'Owner-only pause/resume of a strategy'],
                ['GET',  <Mono key="me">/me</Mono>,                                       'API key',   'Resolve API key → user_id'],
                ['POST', <Mono key="a">/auth</Mono>,                                      'API key',   'Validate an API key'],
              ]}
            />

            <h3 id="rest-health" className="text-lg font-semibold text-white mt-6 mb-2">GET /health</h3>
            <CodeBlock lang="bash">{`$ curl -s http://localhost:9090/health
{"status":"healthy"}`}</CodeBlock>

            <h3 id="rest-status" className="text-lg font-semibold text-white mt-6 mb-2">GET /status</h3>
            <CodeBlock lang="json">{`{
  "status": "running",
  "port": 9090,
  "version": "1.0.0",
  "uptime_seconds": 42,
  "metrics": { ... }
}`}</CodeBlock>

            <h3 id="rest-metrics" className="text-lg font-semibold text-white mt-6 mb-2">GET /metrics</h3>
            <CodeBlock lang="json">{`{
  "uptime_seconds": 42,
  "total_connections": 17,
  "active_connections": 3,
  "total_requests": 89,
  "total_errors": 0,
  "ws_connections": 2,
  "orders_accepted": 14,
  "orders_rejected": 1,
  "trades_matched": 11
}`}</CodeBlock>

            <h3 id="rest-symbols" className="text-lg font-semibold text-white mt-6 mb-2">GET /symbols</h3>
            <p className="text-slate-300 text-sm">
              Returns the symbol registry as configured at boot. The dashboard uses this to
              populate symbol pickers and WS subscriptions instead of hardcoding a default
              triplet. <Mono>max_long</Mono> / <Mono>max_short</Mono> are emitted only when a
              cap is configured for that symbol.
            </p>
            <CodeBlock lang="json">{`{
  "symbols": [
    { "name": "BTC-USD", "id": 1, "mid": 50000.0, "max_long": 100, "max_short": 100 },
    { "name": "ETH-USD", "id": 2, "mid": 3000.0  },
    { "name": "LTC-USD", "id": 3, "mid": 100.0   }
  ]
}`}</CodeBlock>

            <h3 id="rest-orderbook" className="text-lg font-semibold text-white mt-6 mb-2">GET /orderbook</h3>
            <p className="text-slate-300 text-sm">
              Returns the top 20 levels per side. Symbol can be the canonical name
              (<Mono>BTC-USD</Mono>) or shorthand (<Mono>BTC</Mono>).
            </p>
            <CodeBlock lang="json">{`{
  "symbol": "BTC-USD",
  "timestamp": "1777800000000",
  "bids": [{ "price": 49950, "size": 10, "total": 499500 }, ...],
  "asks": [{ "price": 50050, "size": 10, "total": 500500 }, ...]
}`}</CodeBlock>

            <h3 id="rest-trades" className="text-lg font-semibold text-white mt-6 mb-2">GET /trades</h3>
            <p className="text-slate-300 text-sm">
              Recent trades from the in-memory cache. Use <Mono>?symbol=BTC-USD</Mono> to
              filter and <Mono>?limit=N</Mono> to cap (max 500). For deep history, hit{' '}
              <Mono>/trades/historical</Mono>, which pages from SQLite.
            </p>
            <CodeBlock lang="json">{`{
  "trades": [
    { "trade_id": 98, "symbol": "BTC-USD", "price": 49995.0, "quantity": 50, "taker_side": "Buy", "ts": 1777800000123 }
  ]
}`}</CodeBlock>

            <h3 id="rest-bots" className="text-lg font-semibold text-white mt-6 mb-2">GET /bots</h3>
            <p className="text-slate-300 text-sm">
              Snapshot of all known bots / strategies — every connected client_id plus the
              in-process market maker and news bots. Optional <Mono>?window_ms=N</Mono>{' '}
              controls the rolling-PnL window (default 1h).
            </p>
            <CodeBlock lang="json">{`{
  "bots": [
    {
      "user_id": "internal:market_maker",
      "client_id": "Market Maker",
      "name": "Market Maker",
      "strategy_name": "in-process MM",
      "is_internal": true,
      "status": "active",
      "paused": false,
      "orders_placed": 1234,
      "fills": 56,
      "volume": 12340,
      "total_pnl": 12.34,
      "windowed_pnl": 4.20,
      ...
    }
  ]
}`}</CodeBlock>

            <h3 id="rest-auth" className="text-lg font-semibold text-white mt-6 mb-2">POST /auth</h3>
            <p className="text-slate-300 text-sm">
              Validates the API key sent via <Mono>Api-Key:</Mono>, <Mono>Authorization: Bearer</Mono>, or <Mono>?api_key=</Mono>.
            </p>
            <CodeBlock lang="bash">{`$ curl -s -X POST -H 'Api-Key: sk_live_…' http://localhost:9090/auth
{"authenticated":true,"user_id":"user_abc123"}`}</CodeBlock>
          </Section>

          {/* ============== WebSocket ============== */}
          <Section id="ws-connect">
            <h2 className="text-2xl font-bold text-white mb-3">WebSocket: connect &amp; auth</h2>
            <p className="text-slate-300">
              Open a WebSocket to <Mono>ws://&lt;host&gt;:&lt;port&gt;/</Mono>. The HTTP
              upgrade request must carry an API key in one of three forms:
            </p>
            <ul className="list-disc list-inside text-slate-300 text-sm space-y-1 my-2">
              <li><Mono>Api-Key: sk_live_…</Mono></li>
              <li><Mono>Authorization: Bearer sk_live_…</Mono></li>
              <li><Mono>?api_key=sk_live_…</Mono> (query string)</li>
            </ul>
            <p className="text-slate-300 text-sm">
              The engine validates against the configured backend
              (<Mono>backend_url</Mono>). On success the upgrade completes (HTTP 101); on
              failure it&apos;s rejected with HTTP 401.
            </p>
            <p className="text-slate-300 text-sm mt-3">
              The first message you should send is a <Mono>hello</Mono>; the server replies
              with <Mono>welcome</Mono>:
            </p>
            <CodeBlock lang="json">{`// → server
{ "t": "hello", "client_id": "my-bot-1" }

// ← server
{ "t": "welcome", "user_id": "user_abc123", "server_time": 1777800000000 }`}</CodeBlock>
          </Section>

          <Section id="ws-protocol">
            <h2 className="text-2xl font-bold text-white mb-3">WebSocket: wire protocol</h2>
            <p className="text-slate-300 text-sm">
              Every frame is a JSON object with a <Mono>t</Mono> field selecting the type.
              Numeric prices are floats; quantities are unsigned integers; timestamps are ms
              since epoch.
            </p>

            <h3 id="ws-place" className="text-lg font-semibold text-white mt-5 mb-2">place_order</h3>
            <CodeBlock lang="json">{`{
  "t": "place_order",
  "client_order_id": "abc",
  "symbol": "BTC-USD",
  "side": "Buy",
  "type": "Limit",
  "quantity": 100,
  "limit_price": 50000.0
}`}</CodeBlock>
            <p className="text-slate-300 text-sm">
              <Mono>type</Mono> is <Mono>Limit</Mono> or <Mono>Market</Mono>.
              <Mono>limit_price</Mono> is required for Limit. If the symbol has{' '}
              <Mono>max_long</Mono> / <Mono>max_short</Mono> caps configured, the engine
              pre-trade rejects orders that would breach them with reason{' '}
              <Mono>POSITION_LIMIT</Mono> (in-process bots are exempt).
            </p>

            <h3 id="ws-cancel" className="text-lg font-semibold text-white mt-5 mb-2">cancel_order</h3>
            <CodeBlock lang="json">{`{ "t": "cancel_order", "order_id": 12345 }`}</CodeBlock>
            <p className="text-slate-300 text-sm">
              You may only cancel orders you placed (matched by your <Mono>user_id</Mono>).
            </p>

            <h3 id="ws-subscribe" className="text-lg font-semibold text-white mt-5 mb-2">subscribe / unsubscribe</h3>
            <CodeBlock lang="json">{`{ "t": "subscribe",   "channel": "book",   "symbol": "BTC-USD", "depth": 20 }
{ "t": "subscribe",   "channel": "trades", "symbol": "BTC-USD" }
{ "t": "unsubscribe", "channel": "book",   "symbol": "BTC-USD" }`}</CodeBlock>
            <p className="text-slate-300 text-sm">
              On subscribing to <Mono>book</Mono>, the server immediately pushes a snapshot.
            </p>
          </Section>

          <Section id="ws-events">
            <h2 className="text-2xl font-bold text-white mb-3">WebSocket: server-pushed events</h2>

            <h3 className="text-lg font-semibold text-white mt-3 mb-2">order_ack</h3>
            <CodeBlock lang="json">{`{
  "t": "order_ack",
  "order_id": 12345,
  "client_order_id": "abc",
  "symbol": "BTC-USD",
  "side": "Buy",
  "status": "Pending",
  "ts": 1777800000000
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">order_fill</h3>
            <CodeBlock lang="json">{`{
  "t": "order_fill",
  "order_id": 12345,
  "client_order_id": "abc",
  "symbol": "BTC-USD",
  "side": "Buy",
  "status": "PartiallyFilled",
  "price": 49995.0,
  "quantity": 50,
  "remaining": 50,
  "total_filled": 50,
  "avg_price": 49995.0,
  "trade_id": 98,
  "ts": 1777800000123
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">order_reject</h3>
            <CodeBlock lang="json">{`{
  "t": "order_reject",
  "client_order_id": "abc",
  "status": "Rejected",
  "reason": "POSITION_LIMIT",
  "ts": 1777800000000
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">cancel_ack</h3>
            <CodeBlock lang="json">{`{
  "t": "cancel_ack",
  "order_id": 12345,
  "status": "Cancelled",
  "ts": 1777800000000
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">book (snapshot &amp; deltas)</h3>
            <CodeBlock lang="json">{`{
  "t": "book",
  "symbol": "BTC-USD",
  "snapshot": true,
  "ts": 1777800000000,
  "bids": [[49950, 10], [49940, 5], ...],
  "asks": [[50050, 10], [50060, 8], ...]
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">trade</h3>
            <CodeBlock lang="json">{`{
  "t": "trade",
  "symbol": "BTC-USD",
  "trade_id": 98,
  "price": 49995.0,
  "quantity": 50,
  "taker_side": "Buy",
  "ts": 1777800000123
}`}</CodeBlock>

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">error</h3>
            <CodeBlock lang="json">{`{ "t": "error", "code": "UNKNOWN_SYMBOL", "message": "FOO-BAR" }`}</CodeBlock>
          </Section>

          {/* ============== Reference ============== */}
          <Section id="types">
            <h2 className="text-2xl font-bold text-white mb-3">Types</h2>
            <KvTable
              rows={[
                ['OrderSide',   <span key="os"><Mono>{'"Buy"'}</Mono> | <Mono>{'"Sell"'}</Mono></span>],
                ['OrderType',   <span key="ot"><Mono>{'"Limit"'}</Mono> | <Mono>{'"Market"'}</Mono></span>],
                ['OrderStatus', <span key="ost"><Mono>{'"Pending"'}</Mono> | <Mono>{'"PartiallyFilled"'}</Mono> | <Mono>{'"Filled"'}</Mono> | <Mono>{'"Cancelled"'}</Mono> | <Mono>{'"Rejected"'}</Mono></span>],
                ['Price',       'JSON number (double)'],
                ['Quantity',    'JSON unsigned integer'],
                ['Timestamp',   'JSON unsigned integer (ms since epoch)'],
              ]}
            />
          </Section>

          <Section id="symbols">
            <h2 className="text-2xl font-bold text-white mb-3">Symbol registry</h2>
            <p className="text-slate-300 text-sm">
              Symbols are configured in <Mono>server.json</Mono>. The <Mono>name</Mono> is
              the wire identifier; the <Mono>id</Mono> is internal. The frontend fetches
              this list from <Mono>GET /symbols</Mono> at runtime — it is no longer
              hardcoded. Default seed symbols:
            </p>
            <KvTable
              headers={['Name', 'ID', 'Default mid']}
              rows={[
                [<Mono key="b">BTC-USD</Mono>, '1', '50000.0'],
                [<Mono key="e">ETH-USD</Mono>, '2', '3000.0'],
                [<Mono key="l">LTC-USD</Mono>, '3', '100.0'],
              ]}
            />
            <p className="text-slate-300 text-sm mt-2">
              The REST <Mono>/orderbook</Mono> handler accepts case-insensitive shorthand
              (<Mono>btc</Mono>, <Mono>BTC</Mono>, <Mono>BTC-USD</Mono> all resolve to the
              same book).
            </p>
          </Section>

          <Section id="errors">
            <h2 className="text-2xl font-bold text-white mb-3">Error codes</h2>
            <KvTable
              headers={['Code', 'Meaning']}
              rows={[
                [<Mono key="b">BAD_REQUEST</Mono>,     'Malformed JSON or missing required field'],
                [<Mono key="u">UNKNOWN_SYMBOL</Mono>,  'Symbol not in registry'],
                [<Mono key="c">UNKNOWN_CHANNEL</Mono>, 'Subscribe/unsubscribe to unknown channel'],
                [<Mono key="a">AUTH</Mono>,            'Auth-related failure'],
              ]}
            />

            <h3 className="text-lg font-semibold text-white mt-5 mb-2">
              Reject reasons (in <Mono>order_reject</Mono>)
            </h3>
            <KvTable
              rows={[
                [<Mono key="nl">no_liquidity</Mono>,           'Market order with empty opposite book'],
                [<Mono key="qf">queue_full</Mono>,             'Per-symbol shard backed up (extremely unlikely)'],
                [<Mono key="us">unknown_symbol</Mono>,         'Submitted symbol not configured'],
                [<Mono key="nf">not_found</Mono>,              'Cancel: order_id not known'],
                [<Mono key="om">owner_mismatch</Mono>,         'Cancel: order belongs to a different user'],
                [<Mono key="pl">POSITION_LIMIT</Mono>,         'Pre-trade check: would breach max_long/max_short for this user'],
                [<Mono key="st">self_trade_prevention</Mono>,  'STP cancelled the maker (carried in cancel_ack)'],
                [<Mono key="sr">server_restart</Mono>,         'Order was open at last shutdown; reset on boot'],
              ]}
            />
          </Section>

          <Section id="mm">
            <h2 className="text-2xl font-bold text-white mb-3">Market maker</h2>
            <p className="text-slate-300">
              The in-process market maker posts symmetric Buy/Sell quotes around each
              symbol&apos;s configured <Mono>mid</Mono> at <Mono>spread_bps / 2</Mono> on each
              side, in size <Mono>size</Mono>. On a fill it immediately re-posts. With
              <Mono>track_trades = true</Mono> the anchor follows the last trade price.
            </p>
            <p className="text-slate-300 mt-3">
              Event-driven requote: when an external trade prints more than{' '}
              <Mono>requote_drift_bps</Mono> (default <Mono>max(spread_bps/2, 5)</Mono>) from
              the current quote anchor, both sides are cancelled and reposted at the new
              price. Cooldown of 250 ms prevents thrash on bursty prints. This is what keeps
              the MM responsive when news bots stampede the book.
            </p>
            <p className="text-slate-300 mt-3">
              The MM connects through the same <Mono>Sequencer</Mono> as external bots, so
              its orders share the OrderId namespace and appear in <Mono>engine.db</Mono>{' '}
              under <Mono>{'user_id = "internal:market_maker"'}</Mono>. Disable with{' '}
              <Mono>--no-mm</Mono>.
            </p>
          </Section>

          <Section id="news-bots">
            <h2 className="text-2xl font-bold text-white mb-3">News-driven bots</h2>
            <p className="text-slate-300">
              Optional in-process bots that react to live headlines. The engine polls the
              backend&apos;s <Mono>/news</Mono> endpoint, classifies each unseen item with Gemini
              (key in <Mono>news.gemini_api_key</Mono> or env <Mono>GEMINI_API_KEY</Mono>),
              and fans the signal out to every configured persona instance.
            </p>
            <KvTable
              headers={['Persona', 'Behaviour']}
              rows={[
                [<Mono key="m">momentum</Mono>,
                  'Trades the headline direction. Aggressive limit (cross 50 bps). Noise tilt grows nonlinearly with |market_flow.bias| → cascades when many instances are online.'],
                [<Mono key="c">contrarian</Mono>,
                  'Inverts the headline. Threshold-gated noise: skips below |bias| ≈ 0.3, fades hard above.'],
                [<Mono key="s">scalper</Mono>,
                  'Same direction as momentum but passive (10 bps inside the spread) and half-size. Noise size scales DOWN with realized volatility.'],
              ]}
            />
            <p className="text-slate-300 mt-3 text-sm">
              <Mono>signal_delay_ms</Mono> staggers reaction across a count=N cohort
              (each instance picks an independent random delay in <Mono>[0, signal_delay_ms]</Mono>),
              giving the MM time to requote between waves of bot fills.
              <Mono>noise_interval_seconds</Mono> turns on background noise trading so the
              market is alive between news events. Each instance has a distinct{' '}
              <Mono>internal:news_&lt;persona&gt;_&lt;n&gt;</Mono> user_id so STP doesn&apos;t
              fire between siblings.
            </p>
          </Section>

          <Section id="persistence">
            <h2 className="text-2xl font-bold text-white mb-3">Persistence</h2>
            <p className="text-slate-300">
              Orders and trades are persisted to a SQLite file (default{' '}
              <Mono>./engine.db</Mono>) by a dedicated writer thread that batches with{' '}
              <Mono>BEGIN/COMMIT</Mono> every 50 events or 50&nbsp;ms. WAL mode +{' '}
              <Mono>synchronous=NORMAL</Mono>.
            </p>
            <p className="text-slate-300 mt-3">On boot, the engine:</p>
            <ul className="list-disc list-inside text-slate-300 text-sm space-y-1 my-2 ml-2">
              <li>Marks any <Mono>Pending</Mono> / <Mono>PartiallyFilled</Mono> rows as <Mono>Cancelled (server_restart)</Mono>.</li>
              <li>Reads <Mono>MAX(order_id)</Mono> and the persisted <Mono>next_order_id</Mono> watermark; new orders get IDs strictly above both.</li>
              <li>Does <em>not</em> rehydrate the live book — the market maker repopulates quotes within ~1&nbsp;s.</li>
            </ul>
            <p className="text-slate-300 mt-3">Inspect with the standard SQLite CLI:</p>
            <CodeBlock lang="bash">{`sqlite3 engine.db 'SELECT * FROM trades ORDER BY ts_ms DESC LIMIT 10;'`}</CodeBlock>
          </Section>

          <footer className="mt-12 pt-6 border-t border-slate-800 text-xs text-slate-500">
            Bubbles · NUS Orbital
          </footer>
        </main>
      </div>
    </div>
  );
}
