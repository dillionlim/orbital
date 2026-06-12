#!/usr/bin/env python3
"""
taker.py — random aggressor.

Every few seconds, picks a symbol and crosses the spread with a small Limit
order priced through the opposite top-of-book. Useful for generating live
trade flow against the in-process market maker.

Run:
    uv run taker.py
    # or with overrides:
    ORBITAL_SYMBOLS=BTC-USD,ETH-USD uv run taker.py
"""

from __future__ import annotations

import asyncio
import os
import random
import sys

from lib import BotClient, env_server, env_taker_api_key, run_with_periodic_tick

CLIENT_ID = os.environ.get("ORBITAL_BOT_NAME", "taker-1")
SYMBOLS = os.environ.get("ORBITAL_SYMBOLS", "BTC-USD,ETH-USD,LTC-USD").split(",")
TICK_S = float(os.environ.get("ORBITAL_TICK_S", "3.0"))
QTY_MIN, QTY_MAX = 1, 3


async def on_tick(bot: BotClient) -> None:
    sym = random.choice(SYMBOLS)
    top = bot.state.tops.get(sym)
    if not top or top.bid is None or top.ask is None:
        return  # no quotes yet
    side = random.choice(["Buy", "Sell"])
    qty = random.randint(QTY_MIN, QTY_MAX)
    # Aggressive limit: 5 bps inside the opposite top so we always cross.
    if side == "Buy":
        px = round(top.ask * 1.0005, 2)
    else:
        px = round(top.bid * 0.9995, 2)
    await bot.place_limit(sym, side, qty, px)
    print(f"[{bot.client_id}] {side} {qty} {sym} @ {px}")


async def main() -> None:
    api = env_taker_api_key()
    ws = env_server()
    print(f"[{CLIENT_ID}] connecting to {ws} (tick {TICK_S}s, symbols {SYMBOLS})")
    async with BotClient(ws, api, client_id=CLIENT_ID) as bot:
        for s in SYMBOLS:
            await bot.subscribe("book", s)
        await run_with_periodic_tick(bot, TICK_S, on_tick)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
