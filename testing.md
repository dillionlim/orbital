# Testing

This file documents how to run the project's tests and what each current test covers. Test types are listed as **unit** when the test isolates a function, class, hook, or controller with mocks/fakes, and **integration** when it exercises HTTP routes, React user flows, or multiple engine components together.

## Running Tests

### Frontend

```bash
cd frontend
npm install
npm test

# Optional verification checks
npm exec tsc -- --noEmit
npm run lint
```

### Backend

```bash
cd backend
npm install

# Unit tests from backend/src/**/*.spec.ts
npm test -- --runInBand

# HTTP e2e tests from backend/test/*.e2e-spec.ts
npm run test:e2e -- --runInBand

# Optional type check
npm exec tsc -- --noEmit
```

### Trading Engine

```bash
cd trading_engine

# Configure debug test build
cmake -B ./build/tests -S . -DCMAKE_BUILD_TYPE=Debug

# Build the CTest binaries
cmake --build ./build/tests --target order_book_tests matching_engine_tests -- -j"$(nproc)"

# Run all registered CTest cases
ctest --test-dir ./build/tests --output-on-failure
```

## Frontend Tests

### `frontend/src/services/backtest/runner.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `fills market buys at the ask price` | Unit | Confirm aggressive buys pay the ask while equity marks to mid. | Runs one trade through a scripted buy strategy and checks trades, cash, position, and final equity. |
| `fills resting limit orders when a later mark crosses the limit` | Unit | Guard the GTC limit-order path. | Places a non-marketable limit buy, advances the tape below the limit, and checks it fills at the limit without cancellation. |
| `cancels unmarketable IOC orders` | Unit | Ensure IOC orders do not rest when not marketable. | Sends an IOC buy below the ask and checks it is canceled with no cash or position change. |
| `always keeps the final point` | Unit | Preserve closing chart/stat values during downsampling. | Downsamples a six-point equity curve and checks the last point is still present. |

### `frontend/src/services/engineStream.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `authenticates with the API-key subprotocol and dispatches parsed book/trade messages` | Unit | Verify WebSocket auth framing, subscribe/unsubscribe frames, and stream parsing. | Uses a fake `WebSocket`, subscribes to book/trade channels, feeds malformed, unrouted, wrong-symbol, book, delta, and trade messages, then checks dispatch and outgoing frames. |
| `resubscribes existing listeners after a reconnect` | Unit | Ensure reconnects restore active subscriptions. | Uses fake timers to close a socket, advance the reconnect delay, open the new socket, and assert the subscription is resent. |

### `frontend/src/hooks/useApiKey.test.tsx`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `reconciles a cached key with the backend key` | Unit | Confirm backend API-key state overrides local cache. | Seeds `localStorage`, mocks the backend key lookup, renders the hook, and checks state/cache update to the backend value. |
| `keeps the cached key and surfaces an error when backend lookup fails` | Unit | Keep the UI useful during API-key lookup failures. | Seeds a cached key, mocks a backend rejection, and checks the cached key remains while the error is exposed. |
| `generates and stores a new API key on request` | Unit | Exercise explicit key creation from the hook. | Mocks no existing keys, calls `generateApiKey()`, and checks hook state plus `localStorage` contain the new key. |

### `frontend/src/dashboard/AddServerModal.test.tsx`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `saves a healthy new server after the healthcheck passes` | Integration | Cover the dashboard add-server user flow. | Renders the modal, types a server, mocks a healthy `/health` response, clicks Save, and checks `onSave` plus fetch arguments. |
| `blocks duplicate servers without running a healthcheck` | Integration | Prevent duplicate server entries and unnecessary network calls. | Renders with an existing server, types the same server, checks the duplicate message and disabled Save button, and asserts `fetch` was not called. |

## Backend Tests

### Unit Tests

#### `backend/src/app.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `should return "Hello World!"` | Unit | Smoke-test the root controller/service delegation. | Builds a small Nest testing module and checks `getHello()` returns the service greeting. |

#### `backend/src/trading/trading.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `returns market data from the trading service` | Unit | Ensure market reads pass through to the service. | Injects a mocked `TradingEngineService`, returns a market object, and checks the controller returns the same object. |
| `uses the authenticated user id when loading a portfolio` | Unit | Ensure portfolio reads are scoped to the request identity. | Passes a request with `auth.userId` and checks the service is called with that user id. |

#### `backend/src/api-keys/api-key.service.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `creates the user, removes old keys, and stores a generated key` | Unit | Cover first-time key creation and one-key rotation behavior. | Mocks a missing user, user creation, old-key deletion, and generated `sk_live_*` key creation. |
| `updates the stored username before rotating an existing user key` | Unit | Persist profile drift before issuing a replacement key. | Mocks an existing user with an old username and checks `user.update` then old-key deletion. |
| `preserves the frontend array contract around the 1:1 apiKey relation` | Unit | Keep API-key list shape compatible with the frontend. | Mocks a user with one related key and checks `getApiKeys` returns a one-item array. |
| `returns an empty array when the user or key is missing` | Unit | Document the no-key response. | Mocks a missing user and checks an empty array is returned. |
| `deletes only keys owned by the authenticated user` | Unit | Enforce owner-scoped key deletion. | Mocks a key owned by the requester and checks `apiKey.delete` is called. |
| `rejects deletion when the key is missing or owned by another user` | Unit | Reject unauthorized or missing-key deletes. | Mocks another owner and checks the service throws without deleting. |
| `rejects malformed keys without querying the database` | Unit | Fail invalid key formats cheaply. | Calls validation with a bad key and checks no Prisma lookup occurs. |
| `accepts an active, unexpired key and returns the owning auth user id` | Unit | Validate active keys for the engine. | Mocks an active future-expiring key and checks `{ valid: true, userId }`. |
| `rejects inactive or expired keys` | Unit | Reject valid-looking but unusable keys. | Mocks an expired key and checks `{ valid: false }`. |

#### `backend/src/users/users.service.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `creates a missing user and atomically provisions the first API key` | Unit | Ensure user sync creates both profile and default key. | Mocks no user, creates one, upserts a generated key, and reloads the user with key included. |
| `updates changed profile fields without rotating an existing key` | Unit | Keep existing credentials stable during profile updates. | Mocks a user with changed fields and an existing key, then checks only `user.update` runs. |
| `leaves an unchanged user with an existing key alone` | Unit | Protect the already-synced no-op path. | Mocks an unchanged user and checks no create, update, or key upsert occurs. |
| `short-circuits empty lookup requests` | Unit | Avoid database work for empty leaderboard joins. | Calls `getUsernames([])` and checks no Prisma query happens. |
| `maps auth user ids to usernames for leaderboard joins` | Unit | Resolve display names for leaderboard rows. | Mocks `findMany` results and checks auth IDs map to username strings. |

#### `backend/src/index-prices/index-prices.service.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `returns the latest prices + meta from the store` | Unit | Expose cached latest prices with metadata. | Seeds the in-memory store and checks `prices` and `meta` output. |
| `returns empty maps when nothing is stored` | Unit | Preserve empty-cache response shape. | Calls `getPrices()` with no seeded values and checks empty maps. |
| `fetches the engine on read and records the price` | Unit | Verify pull-through reads update cache and samples. | Mocks an engine HTTP price response, calls `getPrices()`, and checks latest price plus rolling sample. |
| `returns only the four cash indices` | Unit | Keep the cash-index endpoint scoped to indices. | Calls `getIndices()` and checks futures/ETFs are excluded. |
| `computes the daily return from the previous close` | Unit | Pin daily return math. | Seeds latest price plus previous close and checks fractional daily return. |
| `computes the 10-minute return from rolling samples` | Unit | Pin rolling-window return math. | Seeds two window samples and checks the 10-minute return. |
| `downsamples the daily series to at most 120 points keeping both ends` | Unit | Keep chart payloads bounded while preserving endpoints. | Seeds 500 daily samples and checks length plus first/last points. |
| `returns null fields when data is missing` | Unit | Document sparse-data responses. | Calls `getIndices()` without seeded values and checks null price/return fields. |
| `returns every tracked instrument` | Unit | Ensure returns cover the full instrument universe. | Calls `getReturns()` and checks the 14-instrument count. |
| `expresses the daily return as a percent of the previous close` | Unit | Pin percent-return and chart-series conversion. | Seeds latest/daily values and checks `returnDay` plus `seriesDay`. |
| `maps bars to trades and resolves the Yahoo ticker` | Unit | Normalize Yahoo candles into trade-like rows. | Mocks Yahoo chart data, checks ticker mapping, count, price, side, and timestamp. |
| `clamps an invalid range and interval to defaults` | Unit | Defend against unsupported candle query params. | Calls `getCandles()` with invalid params and checks default range/interval. |

### HTTP Integration Tests

#### `backend/test/app.e2e-spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `/ (GET)` | Integration | Smoke-test the root HTTP route. | Boots a minimal Nest app and uses Supertest to expect `200` and `Hello World!`. |

#### `backend/test/trading.e2e-spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `serves market data over HTTP` | Integration | Exercise the authenticated market endpoint. | Boots a Nest app with a mocked guard/service and checks `GET /trading/market`. |
| `passes the authenticated user to the portfolio service call` | Integration | Ensure HTTP identity reaches the portfolio service. | Mock guard injects `auth.userId`; Supertest hits `/trading/portfolio` and verifies service args. |

#### `backend/test/api-key.e2e-spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `requires the engine shared secret when configured` | Integration | Enforce engine-only access to validation. | Sets `ENGINE_SHARED_SECRET`, sends the wrong header, and expects `401` with no service call. |
| `rejects requests without a key before hitting the service` | Integration | Validate request shape at the controller boundary. | Sends an empty body with the right secret and expects `400`. |
| `validates a key through the service for the trading engine` | Integration | Cover the successful engine-facing validation flow. | Mocks service success, posts a key with the right secret, and checks response plus service args. |

## Trading Engine Tests

### `trading_engine/tests/order_book_test.cpp`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `rests_limit_orders_by_price_priority` | Unit | Verify resting bids aggregate and sort by best price. | Applies two buy limits, checks open order count, best bid, and top-N bid levels. |
| `matches_crossing_order_at_maker_price` | Unit | Confirm crossing orders fill at the resting maker price. | Rests an ask, submits a crossing buy, and checks fill report plus residual ask. |
| `rejects_market_order_without_liquidity` | Unit | Cover empty-book market-order rejection. | Submits a market buy with no liquidity and checks rejection reason and no resting order. |
| `enforces_cancel_ownership` | Unit | Prevent users from canceling another user's orders. | Rests an order, attempts cancel by an intruder, then cancels with the owner. |
| `cancels_resting_self_trade_and_keeps_incoming_remainder` | Unit | Enforce self-trade prevention. | Rests an ask and sends a same-user crossing buy, checking maker cancel and incoming rest. |

### `trading_engine/tests/matching_engine_test.cpp`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `publishes_initial_snapshot_on_start` | Integration | Confirm engine startup publishes a baseline book snapshot. | Starts a `MatchingEngine` with an `EventBus` collector and waits for the snapshot event. |
| `rejects_market_order_when_book_is_empty` | Integration | Ensure engine-level empty-book rejects are emitted. | Starts the engine, submits a market command, and waits for a reject execution report. |
| `emits_ack_fills_trade_print_and_book_delta_for_a_match` | Integration | Verify matching emits fills, trade tape, and book deltas. | Starts the engine, rests a maker ask, submits a taker market buy, and checks trade print, fill reports, residual delta, and trade-id increment. |
