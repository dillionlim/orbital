"""
Tiny shared library for Orbital trading bots.

Every script in this directory uses BotClient — connect, send `hello`, place
orders, react to events. Strategies stay short and demonstrative.

Usage:
    from lib import BotClient, env_api_key

    async def main():
        async with BotClient("ws://localhost:9090/", env_api_key(),
                             client_id="my-bot") as bot:
            await bot.subscribe("book", "ES")
            async for ev in bot.events():
                ...
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Optional

# Auto-load bots/.env if present, before any os.environ.get() in this module.
# Existing shell exports take precedence (load_dotenv default: override=False).
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

try:
    import websockets
except ImportError:
    print("error: `websockets` not installed. From bots/, run:  uv sync   "
          "(or: pip install websockets python-dotenv)", file=sys.stderr)
    raise


import inspect as _inspect
try:
    _connect_params = _inspect.signature(websockets.connect).parameters
    _HEADERS_KWARG = "additional_headers" if "additional_headers" in _connect_params else "extra_headers"
except (ValueError, TypeError):
    _HEADERS_KWARG = "additional_headers"


def env_api_key() -> str:
    key = os.environ.get("ORBITAL_API_KEY", "")
    if not key:
        key = "sk_live_" + "0" * 32
    return key


def env_taker_api_key() -> str:
    """Separate API key for aggressor bots, falling back to ORBITAL_API_KEY.

    The engine has self-trade prevention: when a taker matches a resting
    order from the same user_id, the resting order is cancelled rather
    than filled. Without two distinct user_ids, market-making bots in
    this directory can't actually profit from the takers in this directory
    — STP eats every cross. Set ORBITAL_TAKER_API_KEY (different account)
    to give your aggressor bots a separate identity so the maker bots
    actually fill.
    """
    return os.environ.get("ORBITAL_TAKER_API_KEY", "") or env_api_key()


def env_server() -> str:
    """Return the WS URL for the engine (default ws://localhost:9090/)."""
    return os.environ.get("ORBITAL_WS", "ws://localhost:9090/")


@dataclass
class TopOfBook:
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_size: int = 0
    ask_size: int = 0
    # Full per-side book (price -> qty), maintained from the initial `book`
    # snapshot plus subsequent `book_delta` patches. The engine sends one
    # snapshot at subscribe time, then only incremental deltas — without
    # applying the deltas, bid/ask freeze at subscribe time and bots quote
    # against a stale top (orders never cross, never fill).
    bids: dict[float, int] = field(default_factory=dict)
    asks: dict[float, int] = field(default_factory=dict)

    @property
    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2.0
        return self.bid or self.ask

    def _recompute_top(self) -> None:
        if self.bids:
            self.bid = max(self.bids)
            self.bid_size = self.bids[self.bid]
        else:
            self.bid, self.bid_size = None, 0
        if self.asks:
            self.ask = min(self.asks)
            self.ask_size = self.asks[self.ask]
        else:
            self.ask, self.ask_size = None, 0


@dataclass
class BotState:
    """Mutable state the strategy can read between events."""
    last_trade_price: Optional[float] = None
    tops: dict[str, TopOfBook] = field(default_factory=dict)
    open_orders: dict[int, dict] = field(default_factory=dict)
    fills: int = 0


class BotClient:
    """Minimal async WebSocket wrapper for the Orbital trading engine."""

    def __init__(self, ws_url: str, api_key: str, client_id: str):
        self.ws_url = ws_url
        self.api_key = api_key
        self.client_id = client_id
        self.state = BotState()
        self._ws = None
        self._client_order_seq = 0

    # ---- lifecycle ----

    async def __aenter__(self) -> "BotClient":
        kwargs = {_HEADERS_KWARG: {"Api-Key": self.api_key}}
        self._ws = await websockets.connect(self.ws_url, **kwargs)
        await self._send({"t": "hello", "client_id": self.client_id})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        # Swallow server-initiated disconnects (clean 1000 close *or* abrupt
        # drop) so callers don't have to wrap every gather in a try/except.
        # In practice this fires when the dashboard pauses the bot — the engine
        # writes a BOT_PAUSED error, sends a close frame, and shuts the socket.
        if exc_type is not None and issubclass(
            exc_type, websockets.exceptions.ConnectionClosed,
        ):
            print(f"[{self.client_id}] connection closed: {exc}", file=sys.stderr)
            return True
        return False

    async def _send(self, payload: dict) -> None:
        assert self._ws is not None
        await self._ws.send(json.dumps(payload))

    def _next_coid(self) -> str:
        self._client_order_seq += 1
        return f"{self.client_id}-{self._client_order_seq}"

    async def subscribe(self, channel: str, symbol: str) -> None:
        await self._send({"t": "subscribe", "channel": channel, "symbol": symbol})

    async def unsubscribe(self, channel: str, symbol: str) -> None:
        await self._send({"t": "unsubscribe", "channel": channel, "symbol": symbol})

    async def place_limit(self, symbol: str, side: str, qty: int, price: float,
                          client_order_id: Optional[str] = None) -> str:
        coid = client_order_id or self._next_coid()
        await self._send({
            "t": "place_order",
            "client_order_id": coid,
            "symbol": symbol,
            "side": side,
            "type": "Limit",
            "quantity": int(qty),
            "limit_price": float(price),
        })
        return coid

    async def place_market(self, symbol: str, side: str, qty: int,
                           client_order_id: Optional[str] = None) -> str:
        coid = client_order_id or self._next_coid()
        await self._send({
            "t": "place_order",
            "client_order_id": coid,
            "symbol": symbol,
            "side": side,
            "type": "Market",
            "quantity": int(qty),
        })
        return coid

    async def cancel(self, order_id: int) -> None:
        await self._send({"t": "cancel_order", "order_id": int(order_id)})

    async def events(self) -> AsyncIterator[dict]:
        """Yield every server message, while keeping `self.state` in sync.

        Returns cleanly on disconnect (clean 1000 close, or abrupt drop with no
        close frame — e.g. when the engine kicks the session because the bot
        was paused from the dashboard). Callers should treat exhaustion of the
        generator as "the engine closed the connection" and exit gracefully.
        """
        assert self._ws is not None
        try:
            async for msg in self._ws:
                try:
                    ev = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                self._update_state(ev)
                yield ev
        except websockets.exceptions.ConnectionClosed as e:
            # Both ConnectionClosedOK (clean 1000) and ConnectionClosedError
            # (abrupt) end up here. Surface the reason and exit the iterator.
            print(f"[{self.client_id}] disconnected: {e}", file=sys.stderr)

    def _update_state(self, ev: dict) -> None:
        t = ev.get("t")
        if t == "book":
            # Full snapshot — replace the maintained book wholesale.
            sym = ev.get("symbol", "")
            top = self.state.tops.setdefault(sym, TopOfBook())
            top.bids = {float(p): int(q) for p, q in (ev.get("bids") or []) if int(q) > 0}
            top.asks = {float(p): int(q) for p, q in (ev.get("asks") or []) if int(q) > 0}
            top._recompute_top()
        elif t == "book_delta":
            # Incremental patch: qty 0 removes the level, otherwise set it.
            sym = ev.get("symbol", "")
            top = self.state.tops.setdefault(sym, TopOfBook())
            for p, q in (ev.get("bids") or []):
                price, qty = float(p), int(q)
                if qty > 0:
                    top.bids[price] = qty
                else:
                    top.bids.pop(price, None)
            for p, q in (ev.get("asks") or []):
                price, qty = float(p), int(q)
                if qty > 0:
                    top.asks[price] = qty
                else:
                    top.asks.pop(price, None)
            top._recompute_top()
        elif t == "trade":
            self.state.last_trade_price = float(ev.get("price", 0.0))
        elif t == "order_ack":
            oid = int(ev.get("order_id", 0))
            self.state.open_orders[oid] = ev
        elif t == "order_fill":
            self.state.fills += 1
            oid = int(ev.get("order_id", 0))
            if int(ev.get("remaining", 0)) == 0:
                self.state.open_orders.pop(oid, None)
        elif t == "cancel_ack":
            oid = int(ev.get("order_id", 0))
            self.state.open_orders.pop(oid, None)
        elif t == "error":
            # Surface server-side rejections instead of silently dropping them.
            # The classic "my bot does nothing" cause is a stale symbol: the
            # engine replies UNKNOWN_SYMBOL to subscribe/place_order and the bot
            # waits forever for a book that never arrives. Make it loud.
            print(f"[{self.client_id}] server error: {ev.get('code')} "
                  f"{ev.get('message', '')}", file=sys.stderr)


async def run_with_periodic_tick(
    bot: BotClient,
    tick_every_seconds: float,
    on_tick,
) -> None:
    """Run the bot's event loop and call `on_tick(bot)` every N seconds."""
    stop = asyncio.Event()

    async def reader() -> None:
        try:
            async for _ in bot.events():
                pass
        finally:
            stop.set()

    async def ticker() -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=tick_every_seconds)
                return
            except asyncio.TimeoutError:
                pass
            try:
                await on_tick(bot)
            except Exception as e:  # don't kill the bot for a strategy error
                print(f"[{bot.client_id}] tick error: {e}", file=sys.stderr)

    await asyncio.gather(reader(), ticker())
