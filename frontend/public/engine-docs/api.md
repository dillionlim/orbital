# Bubbles Trading Engine — client guide

How to connect a bot to a Bubbles engine. The engine speaks JSON over a single
WebSocket for trading and streaming, plus a small REST surface for snapshots and
account queries (see [`openapi.yaml`](./openapi.yaml)).

There is no client SDK to install — the protocol is small enough to drive from any
language with a WebSocket library. `bots/lib.py` in the repository is the reference
implementation and the strategies beside it (`market_maker.py`, `momentum.py`,
`mean_reverter.py`, `taker.py`) are working examples.

## Endpoints

A Bubbles engine serves REST and WebSocket from **one port**, default `9090`:

| Purpose   | URL                       |
|-----------|---------------------------|
| WebSocket | `ws://<host>:9090/`       |
| REST      | `http://<host>:9090`      |

The WebSocket path is the **root** (`/`).

## Authentication

Send your API key as a header on the WebSocket upgrade request, and on any REST call
that requires auth. Either header works:

```
Api-Key: sk_live_…
Authorization: Bearer sk_live_…
```

Query-string auth (`?api_key=…`) is **not** accepted. It was removed deliberately:
URLs end up in proxy and browser-history logs, and a query-param POST is a "simple"
CORS request that skips preflight.

The engine validates the key against the configured backend (`backend_url` in
`server.json`). A good key completes the upgrade with HTTP 101; a bad one is rejected
with HTTP 401.

## Symbols

Instruments are deployment-specific — read `GET /symbols` rather than hardcoding
them. A default install trades index futures and the ETFs tracking the same indices:

```
ES, NKD, NQ, YM, RTY          index futures
SPY, EWJ, EWH, EWY, FEZ       tracking ETFs
```

Symbol names on the wire are the `name` field from `/symbols` (e.g. `"ES"`).

## Connecting

Send `hello` first; the server replies `welcome`.

```jsonc
// → server
{ "t": "hello", "client_id": "my-bot-1" }

// ← server
{ "t": "welcome", "user_id": "user_abc123", "server_time": 1777800000000 }
```

`client_id` is your own label for this bot. It's what appears on the dashboard and
what `/bots/<client_id>/pause` addresses, so keep it stable and unique per strategy.

## Client → server messages

| `t`             | Fields                                                                        |
|-----------------|-------------------------------------------------------------------------------|
| `hello`         | `client_id`                                                                   |
| `place_order`   | `client_order_id`, `symbol`, `side`, `type`, `quantity`, `limit_price` (Limit) |
| `cancel_order`  | `order_id`                                                                    |
| `subscribe`     | `channel`, `symbol`, optional `depth` (book only, default 10)                 |
| `unsubscribe`   | `channel`, `symbol`                                                           |
| `ping`          | —                                                                             |

`side` is `Buy` or `Sell`. `type` is `Limit` or `Market` — parsing is case-insensitive
(`"limit"`, `"LIMIT"` also work). **Stop and stop-limit orders are not supported.**

### Placing orders

```jsonc
// Limit
{
  "t": "place_order",
  "client_order_id": "c-1",
  "symbol": "ES",
  "side": "Buy",
  "type": "Limit",
  "quantity": 10,
  "limit_price": 7399.75
}

// Market — omit limit_price
{
  "t": "place_order",
  "client_order_id": "c-2",
  "symbol": "ES",
  "side": "Sell",
  "type": "Market",
  "quantity": 5
}
```

`client_order_id` is echoed back on the acknowledgement, which is how you correlate a
fill with the order you sent. A market order against an empty book is rejected.

### Cancelling

```jsonc
{ "t": "cancel_order", "order_id": 4211 }
```

`order_id` is the engine-assigned id from the execution report — not your
`client_order_id`. You may only cancel orders placed by your own `user_id`.

### Subscribing

```jsonc
{ "t": "subscribe", "channel": "book",   "symbol": "ES", "depth": 10 }
{ "t": "subscribe", "channel": "trades", "symbol": "ES" }
```

## Server → client messages

| `t`             | Meaning                                                             |
|-----------------|---------------------------------------------------------------------|
| `welcome`       | Handshake accepted; carries your `user_id` and server time          |
| `execution_report` | Order accepted, filled, cancelled, or rejected                   |
| `trade`         | A trade printed on a subscribed symbol                              |
| `book`          | Full order book snapshot (sent once at subscribe time)              |
| `book_delta`    | Incremental book update                                             |
| `pong`          | Reply to `ping`                                                     |
| `error`         | Carries a `code` and human-readable `message`                       |

### Keeping a book in sync

The engine sends **one** `book` snapshot when you subscribe, then only `book_delta`
patches. You must apply the deltas — if you keep only the snapshot, your view of the
top of book freezes at subscribe time and your quotes will be priced off stale data.
`bots/lib.py` maintains a full per-side price→quantity map this way.

## REST

Full reference in [`openapi.yaml`](./openapi.yaml). Common calls:

```bash
# Liveness
curl -s http://localhost:9090/health
# {"status":"healthy"}

# What can I trade here?
curl -s http://localhost:9090/symbols | jq .

# Book snapshot — `symbol` is required
curl -s 'http://localhost:9090/orderbook?symbol=ES' | jq .

# Recent trades (limit defaults to 50, caps at 500)
curl -s 'http://localhost:9090/trades?symbol=ES&limit=100' | jq .

# Deep history from SQLite (caps at 50000)
curl -s 'http://localhost:9090/trades/historical?symbol=ES&from=1777800000000' | jq .

# Who am I?
curl -s -H 'Api-Key: sk_live_…' http://localhost:9090/me | jq .
```

`/health`, `/status`, `/metrics`, `/symbols`, `/orderbook`, `/trades`, `/bots` and
`/leaderboard` are anonymous-friendly. `/me`, `/me/fills`, `/auth` and the
`/bots/<client_id>` mutations require a key. Passing an invalid key to an
anonymous-friendly endpoint is still a 401.

## Errors

Errors arrive as a frame rather than an exception:

```jsonc
{ "t": "error", "code": "BOT_PAUSED", "message": "bot is paused" }
```

A rejected order arrives as an `execution_report` with status `Rejected`, not as an
`error` frame. Rejections you should expect: unknown symbol, market order against an
empty book, non-positive quantity or price, a position cap breach, and cancelling an
order you don't own.

Note that when a bot is paused from the dashboard the engine writes a `BOT_PAUSED`
error, then closes the socket — treat a clean close as a normal shutdown, not a fault.

## Notes

- There is no rate limiter in the engine. It is a practice venue, not a public
  exchange; be considerate on a shared server.
- Connections are plain `ws://` / `http://`. The engine is designed to run on your own
  machine or a private server, not exposed to the internet.
- Reconnects are your responsibility. Re-send `hello` and re-`subscribe`; resting
  orders survive a disconnect, so reconcile with `/me/fills` before assuming state.
