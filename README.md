# Bubbles (Orbital Project)

**Bubbles** is a platform for users to engage in mock algorithmic trading. Bots connect to a C++ matching engine over WebSocket, place orders, and trade against an in-process market maker (or each other). A Next.js dashboard shows the order book, trades, and per-bot PnL in real time. Users can also self-host their own trading servers and practice algorithmic trading against their friends.

Bubbles is [hosted](https://orbital-bubbles.pages.dev/). Refer to [quick start (deployed)](#quick-start-deployed) to see how to self-host a private trading server and connect to the deployed backend and frontend. Refer to [quick start (local)](#quick-start-local) to see how to run the entire project locally.

## Project Structure

```
orbital/
├── trading_engine/   # C++ matching engine & WebSocket server
├── backend/          # NestJS backend with Supabase auth, API key issuance & news/index data
├── frontend/         # Next.js dashboard
├── bots/             # Python reference strategies
├── data/             # Synthetic L1 parquet datasets and dataset notes
└── scripts/          # Dataset generation/conversion scripts
```

## Quick Start (Deployed)

### 1. Trading Engine

The a docker image for the trading engine is available in GitHub Container Repository.

```bash
# Pull the image
docker pull ghcr.io/dillionlim/bubbles-engine:latest

# Run the trading engine
docker run --rm -p 9090:9090 \
    -e BUBBLES_BACKEND_URL=https://bubbles-backend-theta.vercel.app \
    -e BUBBLES_ENGINE_SECRET=<shared secret from the team> \
    -v engine-data:/data \
    ghcr.io/dillionlim/bubbles-engine:latest

# [OPTIONAL] Confirm it is running
curl http://localhost:9090/health # -> {"status":"healthy"}

# Perform Port Forwarding 
# - Necessary as trading engine is hosted locally while backend is hosted on internet)
# - Remember to use the URL given below instead of the localhost address when 
#   connecting using the "add server" button on the deployed frontend 
npx localtunnel --port 9090

```

### 2. Bots

Refer to the [bots section](#4-bots) in local deployment.

## Quick Start (Local)

Run each component in its own terminal from the repository root. The default local ports are engine `:9090`, backend `:3010`, and frontend `:3000`.

### 1. Trading Engine

```bash
cd trading_engine
make run
```

`make run` builds the engine and starts it with `trading_engine/scripts/server.json`. If that config is missing, the Makefile copies `server.json.example` first. Use `make run-dev` to start the engine without the in-process market maker.

#### Running Trading Engine with Docker

```bash
GEMINI_API_KEY=... docker compose up --build engine
```

The Docker setup runs the trading engine on `:9090` and points it at the host backend on `:3010`.

### 2. Backend

```bash
cd backend
npm install
npm run start:dev
```

The dev script runs Prisma generation and starts the NestJS API in watch mode on `http://localhost:3010`. Configure local environment variables with `.env` (use `.env.example` as reference) before starting.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

The dashboard starts on `http://localhost:3000`. By default it rewrites `/api/backend/*` to `http://localhost:3010` and points dashboard widgets at `localhost:9090`. Set `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_DEFAULT_SERVER` if those services run elsewhere.

### 4. Bots

```bash
cd bots
uv sync
# Put BUBBLES_API_KEY=... in bots/.env or export it in your shell.
chmod +x ./run_all.sh
./run_all.sh
```

The bots connect to `ws://localhost:9090/` by default. Override with `BUBBLES_WS` if the engine is elsewhere. To run one strategy at a time, use commands such as `uv run taker.py` or `uv run market_maker.py`.

Astral's [uv](https://docs.astral.sh/uv/) was used for package management. Please install if necessary.

## Testing

See [testing.md](testing.md) for test commands and a concise catalogue of the frontend, backend, and trading-engine test cases.
