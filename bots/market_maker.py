#!/usr/bin/env python3
"""
market_maker.py — narrow-spread multi-symbol market maker.

The engine's in-process MM quotes at ±10bps from its anchored mid (20bps
round trip). This bot quotes at ±4bps from each symbol's last trade, so
any taker that crosses the spread hits *us* first, and we collect ~8bps
per round trip while the engine MM sits idle.

Mid anchor is the last trade per symbol (not the book midpoint, which
would include our own quotes and produce a degenerate feedback loop).

Per-symbol inventory management:
  - Skew the effective mid based on inventory: when long, push the mid
    down so our ask becomes attractive (encourages a buyer to flatten
    us). Symmetric when short.
  - Pull a side entirely at the inventory cap so we never go further off.

When this strategy works:
  - Random / mean-reverting flow (taker.py, random_walker, mean_reverter):
    we collect spread on each round trip. Wins.
  - Strong directional momentum: we accumulate inventory in the wrong
    direction and bleed mark-to-market. Skew + caps limit but don't fix.

Important: the engine has self-trade prevention. If your aggressor bots
share this bot's user_id, every cross gets cancelled instead of filled
and you'll see places=lots, fills=0. Set BUBBLES_TAKER_API_KEY to a
second account's key so taker.py et al run as a different user.

Run:
    uv run market_maker.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from typing import Optional

from lib import BotClient, env_api_key, env_server

CLIENT_ID = os.environ.get("BUBBLES_BOT_NAME", "ext-mm")
SYMBOLS = os.environ.get("BUBBLES_SYMBOLS", "ES,NQ,SPY").split(",")
SPREAD_BPS = float(os.environ.get("BUBBLES_SPREAD_BPS", "8"))      # half = 4bps each side
SIZE = int(os.environ.get("BUBBLES_SIZE", "3"))
REFRESH_S = float(os.environ.get("BUBBLES_REFRESH_S", "1.5"))
MAX_INVENTORY = int(os.environ.get("BUBBLES_MAX_INV", "30"))
SKEW_BPS = float(os.environ.get("BUBBLES_SKEW_BPS", "6"))          # max mid skew at full inv
PNL_EVERY_S = float(os.environ.get("BUBBLES_PNL_EVERY_S", "10.0"))

# Event-driven requote: when a trade prints this many bps from our quote
# anchor, cancel + replace both sides immediately rather than waiting for
# the next REFRESH_S tick. Without this the bot sits stale across fast
# moves (e.g. news bot cohort fills) and gets picked off on the wrong
# side. Default = half the configured spread; cooldown rate-limits the
# cancel/replace loop on bursty prints.
DRIFT_BPS = float(os.environ.get("BUBBLES_DRIFT_BPS", str(SPREAD_BPS / 2)))
REQUOTE_COOLDOWN_S = float(os.environ.get("BUBBLES_REQUOTE_COOLDOWN_S", "0.2"))


class SymbolState:
    """Per-symbol bookkeeping. Cash + inventory drive PnL; open_orders
    tracks what's resting so we can cancel + replace each tick.

    quote_anchor records the mid we anchored the *currently resting*
    quotes against — drift checks compare last_trade against this rather
    than against a moving target. lock serialises the timed requote
    (quoter task) with event-driven requotes (trade / fill handlers) so
    we don't issue duplicate cancel+place for the same symbol.
    """
    __slots__ = ("inventory", "cash", "open_orders", "last_trade",
                 "quote_anchor", "last_requote_at", "lock")

    def __init__(self) -> None:
        self.inventory: int = 0
        self.cash: float = 0.0                  # signed: + on sell, - on buy
        self.open_orders: dict[str, int] = {}   # side ("Buy"/"Sell") -> order_id
        self.last_trade: Optional[float] = None
        self.quote_anchor: Optional[float] = None
        self.last_requote_at: float = 0.0
        self.lock: asyncio.Lock = asyncio.Lock()


def quotes_for(mid: float, inventory: int) -> tuple[float, float]:
    """Bid + ask prices for a given mid and current inventory.

    Inventory > 0 (long) → push mid DOWN so our ask is lower → attracts
    buyers who lift it, reducing our long. Symmetric when short.
    """
    skew_bps = (-inventory / MAX_INVENTORY) * SKEW_BPS
    eff_mid = mid * (1 + skew_bps / 10_000)
    half = (SPREAD_BPS / 2) / 10_000
    return round(eff_mid * (1 - half), 2), round(eff_mid * (1 + half), 2)


async def main() -> None:
    api = env_api_key()
    ws = env_server()
    states: dict[str, SymbolState] = {sym: SymbolState() for sym in SYMBOLS}
    fills_total = 0
    last_pnl_print = time.monotonic()

    print(f"[{CLIENT_ID}] connecting to {ws} (sym={','.join(SYMBOLS)} "
          f"spread={SPREAD_BPS}bps size={SIZE} max_inv={MAX_INVENTORY} "
          f"skew={SKEW_BPS}bps)")

    async with BotClient(ws, api, client_id=CLIENT_ID) as bot:
        for sym in SYMBOLS:
            await bot.subscribe("book", sym)
            await bot.subscribe("trades", sym)

        def current_mid(sym: str, st: SymbolState) -> Optional[float]:
            """Best mid reference: last trade if we have one, else book midpoint."""
            if st.last_trade is not None:
                return st.last_trade
            top = bot.state.tops.get(sym)
            if top and top.bid is not None and top.ask is not None:
                return (top.bid + top.ask) / 2.0
            return None

        async def requote(sym: str, st: SymbolState, *, force: bool = False) -> None:
            """Cancel both sides + repost at the current mid.

            force=True bypasses the drift + cooldown gates (used by the
            timed quoter task on every REFRESH_S tick). force=False is
            for the event-driven path: we only requote when the price
            has actually drifted enough vs our anchor and the cooldown
            has elapsed — otherwise a busy book would send us into a
            pointless cancel/replace loop.
            """
            mid = current_mid(sym, st)
            if mid is None:
                return
            if not force:
                if st.quote_anchor is not None:
                    drift_bps = abs(mid - st.quote_anchor) / st.quote_anchor * 10_000
                    if drift_bps < DRIFT_BPS:
                        return
                if time.monotonic() - st.last_requote_at < REQUOTE_COOLDOWN_S:
                    return
            async with st.lock:
                # Re-fetch mid inside the lock — another task may have
                # just requoted while we were waiting.
                mid = current_mid(sym, st) or mid
                if not force and st.quote_anchor is not None:
                    drift_bps = abs(mid - st.quote_anchor) / st.quote_anchor * 10_000
                    cooldown_remaining = (
                        REQUOTE_COOLDOWN_S - (time.monotonic() - st.last_requote_at)
                    )
                    if drift_bps < DRIFT_BPS and cooldown_remaining > 0:
                        return

                # Cancel everything outstanding for this symbol — simpler
                # than diff'ing prices, and well within engine throughput.
                for oid in list(st.open_orders.values()):
                    await bot.cancel(oid)

                bid_px, ask_px = quotes_for(mid, st.inventory)

                # Pull a side at the inventory cap so we don't go further off.
                if st.inventory < MAX_INVENTORY:
                    await bot.place_limit(sym, "Buy", SIZE, bid_px)
                if st.inventory > -MAX_INVENTORY:
                    await bot.place_limit(sym, "Sell", SIZE, ask_px)
                st.quote_anchor = mid
                st.last_requote_at = time.monotonic()

        async def reader() -> None:
            nonlocal fills_total, last_pnl_print
            async for ev in bot.events():
                t = ev.get("t")
                sym = ev.get("symbol")
                st = states.get(sym) if sym else None
                if t == "trade" and st is not None:
                    st.last_trade = float(ev["price"])
                    # Event-driven fast-react: a print far from our anchor
                    # means our quotes are stale. Schedule (don't await) so
                    # the reader keeps draining events; the requote helper
                    # internally gates on drift + cooldown.
                    asyncio.create_task(requote(sym, st))
                elif t == "order_ack" and st is not None:
                    side = ev.get("side", "")
                    st.open_orders[side] = int(ev["order_id"])
                elif t == "order_fill" and st is not None:
                    side = ev.get("side", "")
                    qty = int(ev.get("last_quantity", 0))
                    px = float(ev.get("last_price", 0.0))
                    if side == "Buy":
                        st.inventory += qty
                        st.cash -= qty * px
                    elif side == "Sell":
                        st.inventory -= qty
                        st.cash += qty * px
                    fills_total += 1
                    if int(ev.get("remaining", 0)) == 0:
                        st.open_orders.pop(side, None)
                    if px > 0:
                        st.last_trade = px
                        # Just got hit — reposition the surviving side
                        # immediately rather than waiting for the next
                        # tick. Drift gate keeps this cheap when the
                        # fill was within our spread.
                        asyncio.create_task(requote(sym, st))
                    now = time.monotonic()
                    if now - last_pnl_print >= PNL_EVERY_S:
                        # Total PnL across symbols using each symbol's last trade as mark.
                        total = 0.0
                        legs = []
                        for s, sst in states.items():
                            mark = (sst.last_trade or 0.0) * sst.inventory
                            pnl = sst.cash + mark
                            total += pnl
                            if sst.inventory or sst.cash:
                                legs.append(f"{s}:inv={sst.inventory:+d} pnl={pnl:+.2f}")
                        print(f"[{CLIENT_ID}] fills={fills_total} total_pnl={total:+.2f} "
                              + " ".join(legs))
                        last_pnl_print = now
                elif t == "cancel_ack" and st is not None:
                    oid = int(ev.get("order_id", 0))
                    for side, existing in list(st.open_orders.items()):
                        if existing == oid:
                            st.open_orders.pop(side, None)
                            break
                elif t == "order_reject" and st is not None:
                    # Drop our local record so we re-quote next tick.
                    st.open_orders.pop(ev.get("side", ""), None)

        async def quoter() -> None:
            # Wait for any per-symbol price reference (trade or book) before
            # the first quote round.
            while True:
                ready = any(current_mid(sym, st) is not None
                            for sym, st in states.items())
                if ready:
                    break
                await asyncio.sleep(0.2)

            while True:
                await asyncio.sleep(REFRESH_S)
                for sym, st in states.items():
                    await requote(sym, st, force=True)

        await asyncio.gather(reader(), quoter())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
