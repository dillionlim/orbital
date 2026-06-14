#!/usr/bin/env bash
# Start a local Orbital trading server. Builds (Release) if needed and execs the engine.
# Usage:
#   ./scripts/start-private-server.sh [path/to/server.json]
# Defaults to scripts/server.json (copy from server.json.example).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Source .env if present so ORBITAL_ENGINE_SECRET / ORBITAL_MAX_CLIENT_IDS_PER_USER
# / etc. land in the engine's environment without the user re-exporting them
# every time. Existing shell exports still win (load order: shell → .env).
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

if [ -z "${ORBITAL_ENGINE_SECRET:-}" ]; then
    echo "warning: ORBITAL_ENGINE_SECRET not set; backend's /api-keys/validate" >&2
    echo "         will be open if its ENGINE_SHARED_SECRET is also unset" >&2
fi

CONFIG="${1:-scripts/server.json}"
if [ ! -f "$CONFIG" ]; then
    if [ -f "scripts/server.json.example" ]; then
        echo "no $CONFIG found; copying scripts/server.json.example → scripts/server.json"
        cp scripts/server.json.example scripts/server.json
        CONFIG="scripts/server.json"
    else
        echo "Missing $CONFIG and no example to copy from."
        exit 1
    fi
fi

if [ ! -d build ]; then
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
fi
cmake --build build -j"$(nproc)"

exec ./build/engine --config "$CONFIG"
