#!/usr/bin/env python3
"""
random_walker.py — minimal demo bot.

Picks a random side and a random small quantity each tick, prices either passive
(joining the book) or aggressive (crossing). Just enough activity to make the
dashboard interesting.

Run:
    uv run random_walker.py
"""

from __future__ import annotations

import asyncio
import os
import random
import sys

from lib import BotClient, env_server, env_taker_api_key, run_with_periodic_tick

CLIENT_ID = os.environ.get("ORBITAL_BOT_NAME", "random-1")
SYMBOL = os.environ.get("ORBITAL_SYMBOL", "BTC-USD")
TICK_S = float(os.environ.get("ORBITAL_TICK_S", "2.5"))
AGGRESSIVE_PROB = float(os.environ.get("ORBITAL_AGG", "0.4"))


async def on_tick(bot: BotClient) -> None:
    top = bot.state.tops.get(SYMBOL)
    if not top or top.bid is None or top.ask is None:
        return
    side = random.choice(["Buy", "Sell"])
    qty = random.randint(1, 2)
    aggressive = random.random() < AGGRESSIVE_PROB
    if side == "Buy":
        px = round(top.ask * 1.0005 if aggressive else top.bid - 1, 2)
    else:
        px = round(top.bid * 0.9995 if aggressive else top.ask + 1, 2)
    await bot.place_limit(SYMBOL, side, qty, px)
    tag = "AGG" if aggressive else "passive"
    print(f"[{bot.client_id}] {tag} {side} {qty} {SYMBOL} @ {px}")


async def main() -> None:
    api = env_taker_api_key()
    ws = env_server()
    print(f"[{CLIENT_ID}] connecting to {ws} (sym={SYMBOL} tick={TICK_S}s "
          f"agg-prob={AGGRESSIVE_PROB})")
    async with BotClient(ws, api, client_id=CLIENT_ID) as bot:
        await bot.subscribe("book", SYMBOL)
        await run_with_periodic_tick(bot, TICK_S, on_tick)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
