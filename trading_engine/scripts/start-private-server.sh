#!/usr/bin/env bash
# Start a local Orbital trading server. Builds (Release) if needed and execs the engine.
# Usage:
#   ./scripts/start-private-server.sh [path/to/server.json]
# Defaults to scripts/server.json (copy from server.json.example).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
