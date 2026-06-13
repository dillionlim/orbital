# 🫧 Orbital — *Bubbles*

> A self-hostable algorithmic trading sandbox. Plug in your bots, watch them trade against a low-latency C++ matching engine, and see the order book, trades, and per-strategy PnL light up in real time.

**NUS Orbital 2026**
**Proposed Level of Achievement: _Artemis_**

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Vision](#2-vision)
3. [User Stories](#3-user-stories)
4. [Core Features](#4-core-features)
5. [System Design](#5-system-design)
6. [Tech Stack](#6-tech-stack)
7. [Project Structure](#7-project-structure)
8. [Getting Started](#8-getting-started)
9. [Milestones & Development Plan](#9-milestones--development-plan)
10. [Project Log](#10-project-log)

---

## 1. Motivation

Algorithmic trading is one of the most exciting intersections of finance and software engineering — but it is also one of the hardest fields to get hands-on experience in.

If you want to *learn* how trading strategies behave, your options today are poor:

- **Paper-trading APIs** (Alpaca, Binance testnet, etc.) hide the matching engine entirely. You send an order, you get a fill — but you never see the order book mechanics, queue priority, or how *your* orders move the market. You can't run an adversarial second strategy against your own.
- **Backtesting libraries** replay historical bars. They assume infinite liquidity and zero market impact, so a strategy that looks profitable on paper can be quietly impossible to fill in practice.
- **Real exchanges** are closed boxes (you can't self-host one), cost real money, and won't let you experiment with the *internals* — latency, the matching algorithm, multi-bot interaction.

There is no easy, **self-hostable** environment where a student or hobbyist can write a bot, point it at a real matching engine, and watch *multiple* strategies fight over the same book in real time.

**Orbital fills that gap.** It is a complete, runs-on-your-laptop trading stack: a real price-time-priority matching engine written in C++, a multi-tenant order-management backend, and a live dashboard. You bring the strategies; Orbital gives you a market to trade them in.

---

## 2. Vision

Orbital (codenamed **Bubbles**) is an end-to-end sandbox that lets anyone:

- Connect one or more **trading bots** to a matching engine over WebSocket.
- Place orders that match against a built-in market maker **or against each other's bots**.
- Watch a **live order book**, a **global trade ticker**, and **per-bot PnL** update in real time.
- **Backtest** a strategy in isolation before running it live.
- Stay in the loop with a **market news feed** ingested from real financial data sources.

All of it self-hostable, all of it open — no brokerage account, no real money, no black boxes.

---

## 3. User Stories

- *As a student learning quant finance,* I want to write a simple market-making bot and watch how it gets filled, so that I understand queue priority and market impact rather than just reading about them.
- *As a strategy developer,* I want to run several bots concurrently against the same order book, so that I can see how my strategy performs against adversarial flow.
- *As a developer,* I want a secure API key to authenticate my bot against the engine, so that I can connect from my own scripts without exposing my account.
- *As a user,* I want a real-time dashboard of the order book, trades, and PnL, so that I can monitor my strategies at a glance.
- *As a cautious trader,* I want to backtest a strategy in a sandbox before going live, so that I don't lose simulated capital on an obviously broken idea.
- *As a discretionary trader,* I want a live market news feed alongside the order book, so that I have context for the price action I'm seeing.

---

## 4. Core Features

| Feature | Description | Status |
|---|---|---|
| **Matching Engine** | Price–time-priority limit order book in C++, exposed over a WebSocket server. | 🟡 In progress |
| **Live Order Book** | Real-time bids/asks with depth, symbol selection, and filtering. | ✅ Built (UI) |
| **Global Trade Ticker** | Scrolling feed of executions with aggressor side. | ✅ Built (UI) |
| **Per-Bot PnL Charts** | Multi-series PnL visualisation with per-bot show/hide. | ✅ Built (UI) |
| **Simulated Bots Panel** | List of active strategies with play / pause / delete controls. | ✅ Built (UI) |
| **API Key Issuance** | Per-user keys for authenticating bots against the engine. | ✅ Built |
| **Authentication** | Clerk-based sign-in/sign-up, gated dashboard, user sync. | ✅ Built |
| **Market News Feed** | Live financial news ingested on a cron from Finnhub, with a searchable archive. | ✅ Built |
| **Backtester** | Isolated environment to replay a strategy before going live. | 🟡 In progress |
| **Multi-Server Support** | Connect to and switch between multiple engine instances with health checks. | ✅ Built (UI) |

Legend: ✅ implemented · 🟡 in progress · ⚪ planned

---

## 5. System Design

Orbital is split into three independently deployable services plus user-supplied bots.

```
                          ┌──────────────────────────┐
                          │        Bubbles UI         │
                          │   Next.js dashboard :3000  │
                          │  order book · PnL · news   │
                          └────────────┬───────────────┘
                                       │  REST (auth, news, keys)
                                       │  + direct market data
                       ┌───────────────┴───────────────┐
                       │                                │
            ┌──────────▼───────────┐        ┌───────────▼────────────┐
            │   Backend (NestJS)    │        │  Trading Engine (C++)   │
            │        :3010          │        │         :9090           │
            │  • Clerk auth guard   │        │  • WebSocket server     │
            │  • API key issuance   │◄──────►│  • Price-time-priority  │
            │  • News cron (Finnhub)│ verify │    matching engine      │
            │  • Prisma / Postgres  │  key   │  • Market maker         │
            └──────────┬────────────┘        └───────────▲────────────┘
                       │                                  │ WebSocket
              ┌────────▼────────┐                ┌────────┴────────┐
              │   PostgreSQL    │                │   Trading Bots   │
              │ users·keys·news │                │ (Python / any)   │
              └─────────────────┘                └─────────────────┘
```

**How the pieces fit together**

- **Frontend (`/frontend`)** — Next.js dashboard. Talks to the backend for auth, news, and API keys (proxied via `/api/backend/*`), and connects directly to a chosen engine instance for live market data.
- **Backend (`/backend`)** — NestJS Order Management System. Handles Clerk authentication, issues and validates API keys, and runs a cron job that ingests market news into Postgres.
- **Trading Engine (`/trading_engine`)** — Standalone C++ binary running the matching engine and WebSocket server. Verifies bot API keys against the backend using a shared secret before accepting orders.
- **Bots (`/bots`, planned)** — Reference Python strategies that connect to the engine over WebSocket. Users can write their own.

**Key auth flow**

1. User signs in via Clerk on the dashboard.
2. Backend issues a unique API key (stored in Postgres, one active key per user).
3. The bot presents the key when connecting to the engine.
4. The engine calls the backend's `/api-keys/validate` endpoint (gated by `ENGINE_SHARED_SECRET`) to confirm the key before accepting orders.

---

## 6. Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 15 · React 19 · TypeScript · TailwindCSS 4 · Recharts · Lucide |
| **Auth** | Clerk (`@clerk/nextjs` + Clerk Node SDK) |
| **Backend** | NestJS 11 · Prisma 7 · Passport / JWT · `@nestjs/schedule` |
| **Database** | PostgreSQL (Dockerised) |
| **Trading Engine** | C++20 · CMake · POSIX threads · WebSocket |
| **Market Data** | Finnhub API |

---

## 7. Project Structure

```
orbital/
├── trading_engine/   # C++ matching engine + WebSocket server
│   ├── src/main.cpp
│   ├── CMakeLists.txt
│   └── Makefile
├── backend/          # NestJS OMS
│   ├── src/
│   │   ├── api-keys/  # key issuance & validation
│   │   ├── auth/      # Clerk guard + JWT strategy
│   │   ├── trading/   # market data & portfolio proxy
│   │   ├── news/      # Finnhub ingestion cron
│   │   └── users/     # user sync
│   ├── prisma/        # schema + migrations
│   └── Dockerfile.DB  # Postgres container
├── frontend/         # Next.js dashboard
│   └── src/
│       ├── app/       # landing, /dashboard, /profile
│       └── dashboard/ # OrderBook, PnLCharts, NewsFeed, …
└── bots/             # reference strategies (planned)
```

---

## 8. Getting Started

### Prerequisites

- Node.js 20+ and npm
- Docker (for PostgreSQL)
- A C++20 toolchain and CMake 3.15+ (for the engine)
- Accounts / keys: a [Clerk](https://clerk.com) application and a [Finnhub](https://finnhub.io) API key

### Environment variables

**`backend/.env`**

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/orbital
DIRECT_URL=postgresql://user:pass@localhost:5432/orbital
CLERK_SECRET_KEY=sk_test_...
FINNHUB_API_KEY=...
ENGINE_SHARED_SECRET=...   # shared with the trading engine
```

**`frontend/.env.local`**

```env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
```

### Run it

```bash
# 1. Database — Postgres in Docker
cd backend
docker build -f Dockerfile.DB -t orbital-db .
docker run -p 5432:5432 orbital-db
npx prisma migrate deploy        # apply schema

# 2. Trading engine — idles/listens on :9090
cd trading_engine && make run

# 3. Backend — NestJS API on :3010
cd backend && npm install && npm run start:dev

# 4. Frontend — dashboard on :3000
cd frontend && npm install && npm run dev
```

Then open **http://localhost:3000**, sign in, and head to the dashboard.

---

## 9. Milestones & Development Plan

### ✅ Milestone 1 — Ideation

- Problem motivation, vision, user stories, and proposed core features (this README).
- System architecture: three-service design (engine / backend / frontend) + bots.
- Tech-stack decisions and project scaffolding.

### 🟡 Milestone 2 — Prototype

**Core features developed**

- Full Next.js dashboard UI: order book, trade ticker, PnL charts, simulated-bots panel, multi-server selector, backtester shell.
- NestJS backend with Clerk authentication, per-user API key issuance/validation, and user sync.
- Finnhub news ingestion (cron) with a live feed and searchable archive.
- Dockerised PostgreSQL with Prisma schema and migrations.
- C++ trading engine scaffold (process + WebSocket server skeleton on :9090).

**In progress / next**

- End-to-end wiring of the matching engine to the dashboard's live market data.
- Real order matching (price–time priority) and execution reporting.
- Reference Python bots placing orders against the engine.

### ⚪ Milestone 3 — Extension

- Hardened matching engine (cancels, modifies, multiple symbols).
- Full backtesting pipeline over historical data.
- Richer strategy analytics, edge-case handling, bug-squashing, and user testing.

---

## 10. Project Log

*Problems encountered and how we approached them — updated each milestone.*

- **Three runtimes, one product.** Coordinating a C++ engine, a Node backend, and a Next.js frontend means three build systems and three deployment stories. We isolated each behind a clean network boundary (WebSocket for market data, REST for everything else) so they can be developed and tested independently.
- **Authenticating bots without leaking accounts.** Bots can't carry a browser session, so we issue per-user API keys and have the engine verify them against the backend over a shared-secret-gated endpoint — keeping the validation path unauthenticated for the engine but rate-limited against abuse.
- **Resilient news ingestion.** The Finnhub cron and dashboard need to degrade gracefully when the upstream API or the database is briefly unreachable, so reads surface transient errors (503) rather than crashing, and inserts skip duplicates.

---

<div align="center">

*Built for NUS Orbital 2026 · Apollo 11 → Gemini → **Artemis***

</div>
