#!/usr/bin/env bash
# Launch every bot in this directory in parallel. Each bot uses a distinct
# BUBBLES_BOT_NAME so the dashboard shows one row per strategy. Press
# Ctrl+C once to stop all of them.
#
# Usage:
#   export BUBBLES_API_KEY=sk_live_<your-32-hex-key>          # makers
#   export BUBBLES_TAKER_API_KEY=sk_live_<other-account-key>  # aggressors (optional)
#   ./run_all.sh
#
# Why two keys: the engine has self-trade prevention. When an aggressor
# crosses a resting order from the same user_id, the resting order is
# cancelled rather than filled. Running everything under one key means
# inside-quoter and market_maker never get filled by your taker / momentum /
# mean-reverter / random_walker bots — STP eats every cross.
#
# To see the maker bots actually profit, generate a second API key (e.g. a
# second Clerk account) and export it as BUBBLES_TAKER_API_KEY. The aggressor
# bots will use it; makers stay on BUBBLES_API_KEY. If TAKER_API_KEY is unset,
# the aggressors fall back to BUBBLES_API_KEY (and STP will keep nuking fills).
#
# Optional overrides:
#   BUBBLES_WS=ws://otherhost:9090/ ./run_all.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Source .env if present so child processes inherit the values. Lines starting
# with `#` are comments; bash `set -a` exports every assignment until `set +a`.
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

if [ -z "${BUBBLES_API_KEY:-}" ]; then
    echo "warning: BUBBLES_API_KEY not set; bots will use the test placeholder" >&2
    echo "         (set it in your shell or in bots/.env — see .env.example)" >&2
fi
if [ -z "${BUBBLES_TAKER_API_KEY:-}" ]; then
    echo "warning: BUBBLES_TAKER_API_KEY not set; aggressors will share the maker" >&2
    echo "         user_id and STP will cancel maker fills. inside-quoter / ext-mm" >&2
    echo "         will appear to be doing nothing. Set a second account's key." >&2
fi

pids=()
trap 'echo; echo "stopping bots…"; kill ${pids[@]} 2>/dev/null || true; wait' INT TERM

BUBBLES_BOT_NAME=taker      uv run taker.py         & pids+=($!)
# ext-mm covers all three symbols at ±4bps (tighter than the engine MM's
# ±10bps). It's the user-side "make money" bot — provided BUBBLES_TAKER_API_KEY
# is set so the aggressors below run as a different user_id.
BUBBLES_BOT_NAME=ext-mm     uv run market_maker.py  & pids+=($!)
BUBBLES_BOT_NAME=momentum   uv run momentum.py      & pids+=($!)
BUBBLES_BOT_NAME=mean-rev   uv run mean_reverter.py & pids+=($!)
BUBBLES_BOT_NAME=random     uv run random_walker.py & pids+=($!)

echo "launched ${#pids[@]} bots — Ctrl+C to stop all"
wait
