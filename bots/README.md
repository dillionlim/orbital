# Mock trading bots

Five Python scripts that connect to the Orbital trading engine over WebSocket
and demonstrate distinct strategies. They share a tiny client wrapper
(`lib.py`) so each bot stays short and readable.

## Setup

```bash
cd bots
uv sync                       # install deps from pyproject.toml + uv.lock
cp .env.example .env          # then edit .env and paste your API key
```

`uv run script.py` auto-syncs and uses `bots/.venv`, so `uv sync` is optional
on first run — `uv run taker.py` will install deps and execute the script in
one go.

If you don't use `uv`, plain `pip install websockets python-dotenv` followed
by `python3 taker.py` works too.

The default WebSocket URL is `ws://localhost:9090/`. Override with
`ORBITAL_WS=...` (in `.env` or your shell) if the engine runs elsewhere.

`.env` is loaded automatically by `lib.py` (via `python-dotenv`) and by
`run_all.sh` before launching child processes. Real shell exports always win
over `.env` values. The file is in `.gitignore`, so the key never ends up in
git.

## Bots

| Script | What it does | Style |
|---|---|---|
| [`taker.py`](taker.py) | Random small aggressor that crosses the spread every few seconds. | Pure taker, generates trade flow. |
| [`market_maker.py`](market_maker.py) | Posts symmetric Buy/Sell quotes around mid; re-posts on fill, re-quotes on drift. | External MM (wider spread than the engine's in-process MM). |
| [`momentum.py`](momentum.py) | Tracks SMA of recent trades; trades in the direction of the move. | Trend follower. |
| [`mean_reverter.py`](mean_reverter.py) | Same SMA, opposite sign — fades stretches from the mean. | Counter-trend. |
| [`random_walker.py`](random_walker.py) | Random side, random qty, sometimes passive sometimes aggressive. | Just makes the dashboard interesting. |

Every bot self-identifies with a `client_id` (the WS `hello` field), which the
engine uses to attribute fills. They can all share one API key — the dashboard
will still show each as its own row in **Active Strategy Nodes** and as its own
line in **Performance Analytics**.

## Running

One at a time (recommended for development — easier to read logs):

```bash
ORBITAL_BOT_NAME=alice uv run taker.py
```

All at once:

```bash
./run_all.sh
```

Each bot's print output is interleaved on stdout, prefixed with its
`client_id`. Press `Ctrl+C` to stop all of them.

## Tuning

Most knobs are environment variables — see the docstring at the top of each
script. Common ones:

| Var | Default | Effect |
|---|---|---|
| `ORBITAL_BOT_NAME` | per script | Label the bot uses in `hello` |
| `ORBITAL_SYMBOL` / `ORBITAL_SYMBOLS` | `BTC-USD,…` | Which symbols to trade |
| `ORBITAL_TICK_S` | varies | Seconds between actions |
| `ORBITAL_QTY` | small | Order size per action |
| `ORBITAL_THRESHOLD_BPS` | 5–8 | Trigger sensitivity (momentum / mean-rev) |
| `ORBITAL_SPREAD_BPS` | 30 | Total spread for the external MM |

## Writing a new strategy

`lib.py` exposes a `BotClient` async context manager. Minimal skeleton:

```python
import asyncio
from lib import BotClient, env_api_key, env_server, run_with_periodic_tick

async def on_tick(bot):
    top = bot.state.tops.get("BTC-USD")
    if top and top.mid:
        await bot.place_limit("BTC-USD", "Buy", 1, top.mid - 5)

async def main():
    async with BotClient(env_server(), env_api_key(), client_id="my-bot") as bot:
        await bot.subscribe("book", "BTC-USD")
        await run_with_periodic_tick(bot, 3.0, on_tick)

asyncio.run(main())
```

`bot.state` is updated automatically as events arrive:
- `state.tops[symbol]` — current best bid/ask + sizes
- `state.last_trade_price` — most recent fill price
- `state.open_orders` — outstanding orders this bot placed
- `state.fills` — count of fills received

For the full wire protocol, browse `http://localhost:9090/docs` after starting
the engine.
