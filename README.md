# Orbital

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
```
