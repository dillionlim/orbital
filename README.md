# Bubbles (Orbital Project)

A self-hostable algorithmic trading sandbox. Bots connect to a C++ matching engine over WebSocket, place orders, and trade against an in-process market maker (or each other). A Next.js dashboard shows the order book, trades, and per-bot PnL in real time.

## Layout

```
orbital/
├── trading_engine/   # C++ matching engine + WS server (binary)
├── backend/          # NestJS OMS: Clerk auth, API key issuance, news ingest
├── frontend/         # Next.js dashboard
└── bots/             # Python reference strategies
```

## Quick start

```bash
# Engine: idles on :9090
cd trading_engine && make run

# Backend: NestJS "hello world" on :3010
cd backend && npm install && npm run start:dev

# Frontend: NextJS landing page on :3000
cd frontend && npm install && npm run dev

# Bots
cd bots && chmod +x ./run_all.sh && ./run_all.sh
```

## Testing

#### Trading engine 

```bash
cd trading_engine

# Configure project and generates build files
cmake -B ./build/tests -S . -DCMAKE_BUILD_TYPE=Debug

# Compile and links code
cmake --build ./build/tests --target order_book_tests matching_engine_tests -- -j"$(nproc)"

# Run tests
ctest --test-dir ./build/tests --output-on-failure
```

#### Backend

```bash
cd backend

# Run unit tests (in parallel) 
npm test -- --runInBand

# Run end-to-end tests (in parallel)
npm run test:e2e -- --runInBand

# Runs type-check
npm exec tsc -- --noEmit
```

#### Frontend
```bash
cd backend

# Run unit tests (sequentially) 
npm test 

# Runs type-check
npm exec tsc -- --noEmit
```
