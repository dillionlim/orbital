#!/usr/bin/env python3
"""
momentum.py — naive momentum follower.

Tracks the last N trade prices for a single symbol and trades in the direction
of the recent move:
  - if last_price > N-trade SMA × (1 + threshold), buy
  - if last_price < N-trade SMA × (1 - threshold), sell
Cooldown between actions to avoid stacking orders.

Run:
    uv run momentum.py
"""

from __future__ import annotations

import asyncio
import collections
import os
import sys
import time

from lib import BotClient, env_api_key, env_server

CLIENT_ID = os.environ.get("ORBITAL_BOT_NAME", "momentum-1")
SYMBOL = os.environ.get("ORBITAL_SYMBOL", "BTC-USD")
WINDOW = int(os.environ.get("ORBITAL_WINDOW", "10"))
THRESHOLD_BPS = float(os.environ.get("ORBITAL_THRESHOLD_BPS", "5.0"))
QTY = int(os.environ.get("ORBITAL_QTY", "1"))
COOLDOWN_S = float(os.environ.get("ORBITAL_COOLDOWN_S", "4.0"))
EXECUTION_OFFSET = float(os.environ.get("ORBITAL_EXECUTION_OFFSET", "5"))


async def main() -> None:
    api = env_api_key()
    ws = env_server()
    history: collections.deque[float] = collections.deque(maxlen=WINDOW)
    last_action_at = 0.0

    print(f"[{CLIENT_ID}] connecting to {ws} (sym={SYMBOL} window={WINDOW} "
          f"threshold={THRESHOLD_BPS}bps qty={QTY})")

    async with BotClient(ws, api, client_id=CLIENT_ID) as bot:
        await bot.subscribe("book", SYMBOL)
        await bot.subscribe("trades", SYMBOL)
        async for ev in bot.events():
            if ev.get("t") != "trade" or ev.get("symbol") != SYMBOL:
                continue
            price = float(ev["price"])
            history.append(price)
            if len(history) < WINDOW:
                continue
            sma = sum(history) / len(history)
            now = time.monotonic()
            if now - last_action_at < COOLDOWN_S:
                continue
            top = bot.state.tops.get(SYMBOL)
            if not top or top.bid is None or top.ask is None:
                continue
            up = price > sma * (1 + THRESHOLD_BPS / 10000.0)
            down = price < sma * (1 - THRESHOLD_BPS / 10000.0)
            if up:
                px = round(top.ask * (1 + EXECUTION_OFFSET / 10000.0), 2)
                await bot.place_limit(SYMBOL, "Buy", QTY, px)
                print(f"[{CLIENT_ID}] momentum-up: Buy {QTY} @ {px} (sma={sma:.2f}, last={price:.2f})")
                last_action_at = now
            elif down:
                px = round(top.bid * (1 - EXECUTION_OFFSET / 10000.0), 2)
                await bot.place_limit(SYMBOL, "Sell", QTY, px)
                print(f"[{CLIENT_ID}] momentum-down: Sell {QTY} @ {px} (sma={sma:.2f}, last={price:.2f})")
                last_action_at = now


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
