# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Orbital trading engine.
#
#   build stage   →  ubuntu:24.04, full toolchain, produces a portable engine
#                    binary (libstdc++/sqlite already statically linked by
#                    CMakeLists.txt; only glibc + libm dynamic).
#   runtime stage →  debian:12-slim, just the binary + a default config.
#
# Build: `bash scripts/build-image.sh`  (wraps `docker build` + `docker save`).
# Run:   `docker run -p 9090:9090 -v engine-data:/data orbital-engine`
#         (override the bundled config by mounting -v ./server.json:/cfg/server.json:ro)

# ---- Build stage ---------------------------------------------------------

FROM ubuntu:24.04 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        python3 \
        libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . /src

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)"

# ---- Runtime stage -------------------------------------------------------
#
# debian:12-slim ships glibc 2.36, which is fine — the build stage produced
# a binary that targets the build host's glibc (Ubuntu 24.04 → glibc 2.39),
# so the runtime image's glibc must be ≥ 2.39. We swap the runtime to
# debian:trixie-slim (glibc 2.41) to stay forward-compatible.

FROM debian:trixie-slim AS runtime

# tini gives us proper PID-1 signal forwarding so Ctrl-C / `docker stop`
# delivers SIGTERM to the engine instead of being swallowed.
#
# curl + ca-certificates are needed by the news-bot subsystem: rather than
# linking libcurl/openssl into the engine, the Gemini client shells out to
# `curl` for the HTTPS POST. Adds ~7 MB to the image; in return the binary
# stays compact and no TLS code lives in our process.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/build/engine /app/engine
COPY --from=build /src/scripts/server.json.example /cfg/server.json

# /data holds engine.db across container restarts. Mount a named volume or
# a host path: `-v engine-data:/data` or `-v $(pwd)/data:/data`.
VOLUME ["/data"]

EXPOSE 9090

ENTRYPOINT ["/usr/bin/tini", "--", "/app/engine"]
CMD ["--config", "/cfg/server.json", "--db", "/data/engine.db"]
