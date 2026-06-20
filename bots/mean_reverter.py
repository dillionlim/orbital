#!/usr/bin/env python3
"""
mean_reverter.py — counter-trend strategy.

Watches the rolling SMA of trade prices and bets on snap-back:
  - if last_price > SMA × (1 + threshold), sell (price too high)
  - if last_price < SMA × (1 - threshold), buy  (price too low)
Symmetric to momentum.py — running both at once produces interesting flow.

Run:
    uv run mean_reverter.py
"""

from __future__ import annotations

import asyncio
import collections
import os
import sys
import time

from lib import BotClient, env_server, env_taker_api_key

CLIENT_ID = os.environ.get("BUBBLES_BOT_NAME", "mean-rev-1")
SYMBOL = os.environ.get("BUBBLES_SYMBOL", "ES")
WINDOW = int(os.environ.get("BUBBLES_WINDOW", "12"))
THRESHOLD_BPS = float(os.environ.get("BUBBLES_THRESHOLD_BPS", "8"))
QTY = int(os.environ.get("BUBBLES_QTY", "1"))
COOLDOWN_S = float(os.environ.get("BUBBLES_COOLDOWN_S", "5.0"))
EXECUTION_OFFSET = float(os.environ.get("BUBBLES_EXECUTION_OFFSET", "5"))


async def main() -> None:
    api = env_taker_api_key()
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
                # Too high → fade by selling
                px = round(top.bid * (1 - EXECUTION_OFFSET / 10000.0), 2)
                await bot.place_limit(SYMBOL, "Sell", QTY, px)
                print(f"[{CLIENT_ID}] fade-up: Sell {QTY} @ {px} (sma={sma:.2f}, last={price:.2f})")
                last_action_at = now
            elif down:
                # Too low → fade by buying
                px = round(top.ask * (1 + EXECUTION_OFFSET / 10000.0), 2)
                await bot.place_limit(SYMBOL, "Buy", QTY, px)
                print(f"[{CLIENT_ID}] fade-down: Buy {QTY} @ {px} (sma={sma:.2f}, last={price:.2f})")
                last_action_at = now


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n[{CLIENT_ID}] stopped", file=sys.stderr)
