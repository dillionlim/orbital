#!/usr/bin/env python3
"""
market_maker.py — external market maker.

Posts symmetric Buy/Sell limit quotes around the mid for each configured symbol,
re-quoting whenever a fill consumes a side. Demonstrates running a second MM
alongside the engine's in-process MM.

Run:
    uv run market_maker.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional

from lib import BotClient, env_api_key, env_server

CLIENT_ID = os.environ.get("ORBITAL_BOT_NAME", "ext-mm-1")
SYMBOLS = os.environ.get("ORBITAL_SYMBOLS", "BTC-USD,ETH-USD").split(",")
SPREAD_BPS = float(os.environ.get("ORBITAL_SPREAD_BPS", "30"))   # wider than engine MM (20bps)
SIZE = int(os.environ.get("ORBITAL_SIZE", "5"))
REPRICE_SECS = float(os.environ.get("ORBITAL_REPRICE_S", "10"))


def quote_prices(mid: float) -> tuple[float, float]:
    half = (SPREAD_BPS / 2) / 10000.0
    return round(mid * (1 - half), 2), round(mid * (1 + half), 2)


async def post_side(bot: BotClient, sym: str, side: str, mid: float,
                    open_ids: dict[str, dict[str, int]]) -> None:
    bid_px, ask_px = quote_prices(mid)
    px = bid_px if side == "Buy" else ask_px
    coid = await bot.place_limit(sym, side, SIZE, px)
    print(f"[{CLIENT_ID}] post {side} {SIZE} {sym} @ {px}")


async def main() -> None:
    api = env_api_key()
    ws = env_server()
    open_ids: dict[str, dict[str, int]] = {sym: {} for sym in SYMBOLS}
    last_post: dict[tuple[str, str], float] = {}

    print(f"[{CLIENT_ID}] connecting to {ws} ({SPREAD_BPS}bps × {SIZE}, {SYMBOLS})")
    async with BotClient(ws, api, client_id=CLIENT_ID) as bot:
        for sym in SYMBOLS:
            await bot.subscribe("book", sym)
            await bot.subscribe("trades", sym)

        async def reader() -> None:
            async for ev in bot.events():
                t = ev.get("t")
                if t == "order_ack":
                    sym = ev.get("symbol", "")
                    side = ev.get("side", "")
                    if sym in open_ids:
                        open_ids[sym][side] = int(ev["order_id"])
                elif t == "order_fill" and int(ev.get("remaining", 0)) == 0:
                    sym = ev.get("symbol", "")
                    side = ev.get("side", "")
                    if sym in open_ids:
                        open_ids[sym].pop(side, None)
                    # Re-post immediately on the filled side.
                    top = bot.state.tops.get(sym)
                    mid: Optional[float] = top.mid if top else None
                    if mid is not None:
                        await post_side(bot, sym, side, mid, open_ids)

        async def seeder() -> None:
            # Wait briefly for the first book snapshot, then seed both sides.
            await asyncio.sleep(0.5)
            for sym in SYMBOLS:
                top = bot.state.tops.get(sym)
                mid = top.mid if top else None
                if mid is None:
                    continue
                if "Buy" not in open_ids[sym]:
                    await post_side(bot, sym, "Buy", mid, open_ids)
                if "Sell" not in open_ids[sym]:
                    await post_side(bot, sym, "Sell", mid, open_ids)

        async def re_quoter() -> None:
            # Periodically cancel + re-post if the mid has drifted ≥ half-spread.
            half_bps = SPREAD_BPS / 2
            while True:
                await asyncio.sleep(REPRICE_SECS)
                for sym in SYMBOLS:
                    top = bot.state.tops.get(sym)
                    mid = top.mid if top else None
                    if mid is None:
                        continue
                    bid_px, ask_px = quote_prices(mid)
                    for side, want_px in (("Buy", bid_px), ("Sell", ask_px)):
                        oid = open_ids[sym].get(side)
                        if oid is None:
                            await post_side(bot, sym, side, mid, open_ids)
                            continue
                        # Drift check via the last_post price.
                        prev = last_post.get((sym, side))
                        if prev is None or abs(prev - want_px) / want_px > half_bps / 10000.0:
                            await bot.cancel(oid)
                            await post_side(bot, sym, side, mid, open_ids)
                            last_post[(sym, side)] = want_px

        await asyncio.gather(reader(), seeder(), re_quoter())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
