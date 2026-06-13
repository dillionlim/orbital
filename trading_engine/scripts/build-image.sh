#!/usr/bin/env bash
# Build the engine Docker image and save it as a gzipped tarball you can
# email / drop into a release / hand to anyone with Docker installed.
#
# Usage:
#   bash scripts/build-image.sh                       # default tag + dist/ output
#   IMAGE_TAG=v0.3 bash scripts/build-image.sh        # custom tag
#   OUT_DIR=/tmp bash scripts/build-image.sh          # custom output dir
#
# Recipient workflow:
#   docker load < orbital-engine-latest.tar.gz
#   docker run -p 9090:9090 -v engine-data:/data orbital-engine:latest
#
# To use a custom config, mount it over the baked default:
#   docker run -p 9090:9090 \
#              -v $(pwd)/server.json:/cfg/server.json:ro \
#              -v engine-data:/data \
#              orbital-engine:latest

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_NAME="${IMAGE_NAME:-orbital-engine}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
OUT_DIR="${OUT_DIR:-./dist}"

echo "==> Building ${IMAGE_NAME}:${IMAGE_TAG}"
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

mkdir -p "$OUT_DIR"
OUT_FILE="${OUT_DIR}/${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"

echo "==> Saving image to ${OUT_FILE}"
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "$OUT_FILE"

# Drop a sidecar server.json next to the tarball so the recipient has
# something to edit. The image already bakes this in as the default config,
# but mounting an edited copy is the only sane way to change settings without
# rebuilding — so we hand them an editable starting point.
SIDECAR="${OUT_DIR}/server.json"
cp scripts/server.json.example "$SIDECAR"

# Generate a one-page README the recipient can follow without prior Docker
# knowledge.
cat > "${OUT_DIR}/README.txt" <<EOF
Orbital Trading Engine — Docker bundle
=======================================

Files in this directory:
  ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz   the engine image
  server.json                          editable config (mount this into the container)
  README.txt                           this file

1. Load the image (one-time)
   docker load < ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz

2. (Optional) edit server.json — port, symbols, market-maker params, etc.

3. Run the engine. Two volumes matter:
     /cfg/server.json  → your edited config (read-only)
     /data             → SQLite database (persistent)

   docker run --rm -p 9090:9090 \\
              -v "\$(pwd)/server.json:/cfg/server.json:ro" \\
              -v engine-data:/data \\
              ${IMAGE_NAME}:${IMAGE_TAG}

   Engine listens on http://localhost:9090.
   curl http://localhost:9090/health   →  {"status":"healthy"}

4. To stop:  Ctrl-C, or  docker stop <container-id>
   To inspect data:  docker volume inspect engine-data
EOF

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo ""
echo "Bundle ready in ${OUT_DIR}/:"
echo "  ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz   (${SIZE})"
echo "  server.json                          (editable)"
echo "  README.txt                           (recipient instructions)"
echo ""
echo "Ship the entire ${OUT_DIR}/ directory (or zip it). Recipient follows README.txt."
