# Testing

This file documents how to run the project's tests and what each current test covers. Test types are listed as **unit** when the test isolates a function, class, hook, or controller with mocks/fakes, and **integration** when it exercises HTTP routes, React user flows, or multiple engine components together.

## Continuous Integration

`.github/workflows/tests.yml` runs all three suites on every push and pull request, as three
independent jobs so a failure in one still reports results for the others:

| Job | Runs |
|---|---|
| `frontend` | `npm ci`, `tsc --noEmit`, `npm run lint`, `npm test` (vitest) |
| `backend` | `npm ci`, `npx prisma generate`, `tsc --noEmit`, `npm test` (jest), `npm run test:e2e` |
| `trading-engine` | `cmake` configure, build `order_book_tests` + `matching_engine_tests` + `mpsc_ring_tests` + `session_tests` + `protocol_tests` + `ws_frame_tests` + `auth_tests`, `ctest` |

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
cmake --build ./build/tests --target order_book_tests matching_engine_tests mpsc_ring_tests session_tests protocol_tests ws_frame_tests auth_tests -- -j"$(nproc)"

# Run all registered CTest cases
ctest --test-dir ./build/tests --output-on-failure
```

#### Sanitizer checks

The engine is the only component doing manual memory management and multithreading, so the
test suites are also run under sanitizers, and this is how the untrusted-input parsers were
checked for out-of-bounds reads and overflows. Sanitizers only observe code that a test (or a
running process) actually executes, so their value is bounded by the coverage that drives them.

```bash
# AddressSanitizer + UndefinedBehaviorSanitizer: use-after-free, out-of-bounds, integer/enum UB.
# Catches the duplicate-order-id use-after-free and any overflow in the frame/JSON parsers.
cmake -B ./build/asan -S . -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g -O1" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address,undefined"
cmake --build ./build/asan --target order_book_tests matching_engine_tests mpsc_ring_tests \
  session_tests protocol_tests ws_frame_tests auth_tests -- -j"$(nproc)"
ASAN_OPTIONS=detect_leaks=0 ctest --test-dir ./build/asan --output-on-failure

# ThreadSanitizer: data races. Catches the multi-producer queue race, the Session::client_id
# race, and confirms the per-session writer/outbound-queue handoff is race-free.
cmake -B ./build/tsan -S . -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS="-fsanitize=thread -g -O1" \
  -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=thread"
cmake --build ./build/tsan --target mpsc_ring_tests session_tests matching_engine_tests \
  auth_tests -- -j"$(nproc)"
# setarch -R disables ASLR: on newer kernels TSan aborts with "unexpected memory mapping"
# otherwise. It is an ASLR incompatibility, not a code fault.
for t in mpsc_ring_tests session_tests matching_engine_tests auth_tests; do
  setarch "$(uname -m)" -R ./build/tsan/"$t"
done
```

The concurrency tests are written to give the sanitizers something to find: `mpsc_ring_tests`
drives 8 producers into one queue, `session_tests` races 4 readers against a writer mutating
`client_id`, and `auth_tests` hammers `validate()` while another thread mutates the key set.
The assembled engine was additionally run under ASan and sent SIGINT with live connections parked in blocking
reads, to exercise the shutdown teardown path.

## Frontend Tests

### `frontend/src/services/backtest/runner.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `fills market buys at the ask price` | Unit | Confirm aggressive buys pay the ask while equity marks to mid. | Runs one trade through a scripted buy strategy and checks trades, cash, position, and final equity. |
| `fills resting limit orders when a later mark crosses the limit` | Unit | Guard the GTC limit-order path. | Places a non-marketable limit buy, advances the tape below the limit, and checks it fills at the limit without cancellation. |
| `cancels unmarketable IOC orders` | Unit | Ensure IOC orders do not rest when not marketable. | Sends an IOC buy below the ask and checks it is canceled with no cash or position change. |
| `fills market sells at the bid price and goes short from flat` | Unit | Mirror the market-buy path on the sell side and pin the no-short-prevention design. | Sells from a flat book and checks cash, a negative position, and equity marked at mid. |
| `fills marketable sell limits at the bid immediately` | Unit | Ensure a marketable sell limit fills at the touch, not at its (worse) limit. | Sends a sell limit below the bid and checks it fills at the bid with nothing canceled. |
| `fills resting sell limits when a later mark rises through the limit` | Unit | Cover the sell-side GTC resting path. | Rests a sell limit above the bid, advances the tape through it, and checks it fills at the limit. |
| `fills marketable sell IOCs and cancels the rest` | Unit | Split IOC behaviour both ways on one tape. | Sends one marketable and one unmarketable sell IOC and checks one fill and one cancel. |
| `counts limit orders still resting at end of tape as canceled` | Unit | Guarantee GTC limits are never force-filled at the end of the run. | Rests a far-away buy limit, ends the tape, and checks it is reported canceled rather than traded. |
| `cancels limit and IOC orders with a non-finite or missing limit price` | Unit | Never fill at an accidental price when a strategy emits NaN/Infinity/undefined. | Emits three orders with bad limit prices and checks all three cancel with no cash or position change. |
| `computes a per-tick Sharpe from the equity curve` | Unit | Pin the Sharpe formula (mean/std of per-tick returns × √N). | Runs a curve of 1000 → 1100 → 1100 and checks the equity points, Sharpe of 1, and total return. |
| `reports a zero Sharpe when equity never moves` | Unit | Guard the std > 0 divide-by-zero path that would render NaN in the stats panel. | Runs a hold-only strategy and checks Sharpe, max drawdown, and total return are all 0. |
| `tracks the worst peak-to-trough drawdown across the run` | Unit | Pin max-drawdown math and its persistence after recovery. | Runs a curve that dips 1100 → 950 then makes a new high, and checks the drawdown is kept. |
| `reports a negative total return for a losing run` | Unit | Ensure a losing run reports a signed loss rather than clamping at zero. | Runs a curve down to 960 equity and checks total return and drawdown are both -4%. |
| `returns the initial cash as final equity for an empty tape` | Unit | Cover the degenerate no-trades input without reading past an empty points array. | Runs with an empty tape and checks every stat falls back to its zero/initial value. |
| `always keeps the final point` | Unit | Preserve closing chart/stat values during downsampling. | Downsamples a six-point equity curve and checks the last point is still present. |

### `frontend/src/services/backtest/pythonStrategy.test.ts`

The `WRAPPER_PY` block is plain CPython (`json` + `math` only), so the real wrapper source is
executed under the system `python3` rather than booting Pyodide; those cases skip when `python3`
is unavailable.

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `drops a non-finite limit (%s) instead of emitting invalid JSON` | Unit | Regression: `json.dumps` emits a bare `NaN`/`Infinity` token, which `JSON.parse` rejects, so one bad tick killed the entire run. | Runs `_order()` in real Python for `nan`, `inf`, and `-inf` limits and checks the JSON carries no `NaN`/`Infinity` and the limit is dropped. |
| `drops a non-positive limit (%s)` | Unit | Degrade an unfillable limit to a cancel instead of resting an order that can never trade. | Runs `_order()` with limits `0` and `-5` and checks the limit is stripped. |
| `keeps a normal limit price` | Unit | Ensure the guard doesn't eat valid prices. | Runs `_order()` with `101.5` and checks it survives. |
| `still rejects a limit order with no limit at all` | Unit | Keep a genuine user bug loud, unlike a NaN produced silently by arithmetic. | Runs `_order()` on a limit order with no `limit` key and checks it raises. |
| `passes a bare action string through as a market order` | Unit | Cover the shorthand return values a strategy may emit. | Runs `_order('buy')` and `_order(None)` and checks the `buy`/`hold` market signals. |
| `drops a limit that overflows to Infinity on parse` | Unit | Cover the one non-finite path Python cannot stop: `1e999` is valid JSON that parses to `Infinity`. | Calls `toSignal` with a `1e999` limit and checks the limit is dropped. |
| `drops a non-positive limit` | Unit | Mirror the Python-side non-positive guard on the JS side. | Calls `toSignal` with limits `0` and `-3` and checks both are undefined. |
| `keeps a usable limit and defaults action/type` | Unit | Pin the normalization contract: unknown/missing action and type fall back to `hold`/`market`. | Calls `toSignal` with a good limit, `{}`, and a nonsense action/type. |
| `cancels a limit order whose price was dropped` | Unit | Close the loop: a limit-less limit order must count as a cancel, not fill at an undefined price. | Runs a two-tick backtest with a strategy emitting the dropped-limit signal and checks 0 trades, 2 cancels, and untouched cash/position. |

### `frontend/src/services/engineStream.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `authenticates with the API-key subprotocol and dispatches parsed book/trade messages` | Unit | Verify WebSocket auth framing, subscribe/unsubscribe frames, and stream parsing. | Uses a fake `WebSocket`, subscribes to book/trade channels, feeds malformed, unrouted, wrong-symbol, book, delta, and trade messages, then checks dispatch and outgoing frames. |
| `resubscribes existing listeners after a reconnect` | Unit | Ensure reconnects restore active subscriptions. | Uses fake timers to close a socket, advance the reconnect delay, open the new socket, and assert the subscription is resent. |
| `shares a single socket across consumers of the same server and key` | Unit | Prove the registry opens one connection per (server, key), not one per widget. | Acquires the same server/key twice and checks one socket; acquires a different key and checks it gets its own. |
| `only tears the socket down when the last reference is released` | Unit | Pin refcounted teardown so an unmount doesn't kill a socket others still watch. | Acquires twice, releases once (socket stays open), releases again (socket closes), over-releases (no-op), then re-acquires and checks a fresh socket opens. |
| `doubles the reconnect backoff up to the 30s cap` | Unit | Stop a dead engine from being hammered at 1/s by every open tab. | Fails seven connect attempts with fake timers and checks the delay ladder 1s → 2s → 4s → 8s → 16s → 30s → 30s, then that a successful open resets it. |
| `cancels a pending reconnect when the stream is destroyed` | Unit | Prevent a socket resurrecting itself after the last consumer unmounts. | Schedules a reconnect, releases the stream, advances 60s, and checks no new socket, a `closed` status, and that listeners no longer receive frames. |

### `frontend/src/services/engineUrl.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `uses http/ws when the page is served over http` | Unit | Keep local dev on plain schemes (`localhost:9090` has no TLS). | Reads the jsdom `http:` page protocol and checks `httpBase`/`wsBase` return `http://`/`ws://`. |
| `uses https/wss when the page is served over https` | Unit | Prevent mixed-content blocking on the hosted dashboard. | Stubs `location.protocol` to `https:` and checks both helpers upgrade to `https://`/`wss://`. |
| `falls back to http/ws when there is no window (SSR)` | Unit | Ensure the helpers don't throw during Next prerender. | Stubs `window` to `undefined` and checks the insecure schemes are returned instead of a crash. |
| `appends the server verbatim without a trailing slash` | Unit | Keep caller-appended paths (`${httpBase(s)}/symbols`) valid. | Checks the host is passed through unnormalized and that a suffixed path builds correctly. |
| `defaults to the local engine when no build-time server is configured` | Unit | Pin the fallback every widget uses before a server is picked. | Checks `NEXT_PUBLIC_DEFAULT_SERVER` is unset and `DEFAULT_SERVER` is `localhost:9090`. |

### `frontend/src/services/symbols.test.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `caches the symbol list per server after the first fetch` | Unit | Stop `/symbols` being re-fetched on every widget mount. | Fetches twice for one server and checks one network call and the same array instance back. |
| `dedupes concurrent callers onto one in-flight request` | Unit | Ensure widgets mounting in the same tick share one request. | Holds the engine's reply open, calls twice, and checks a single fetch plus a shared resolved value. |
| `keeps a separate cache entry per server` | Unit | Prevent one engine's symbols leaking into a dashboard pointed at another. | Fetches from two servers and checks each gets its own list and its own request. |
| `rejects on a non-ok response and does not cache the failure` | Unit | Keep a transient blip from leaving the dashboard symbol-less until reload. | Mocks a 503 then a success, checks the first rejects with `HTTP 503` and the retry actually re-fetches. |
| `returns an empty list when the payload omits symbols` | Unit | Guarantee widgets always get an array to map over. | Mocks a payload with no `symbols` key and checks an empty array resolves. |
| `does not cache an empty registry, so a booting engine is retried` | Unit | Regression: an engine still booting answers `200` with no symbols, and caching that wedged every widget on "Loading…" until a page reload. | Serves an empty list then a populated one, and checks the second call re-fetches and returns the symbol. |
| `loads the current server symbols and exposes their names` | Unit | Cover the `useSymbols` happy path. | Seeds `currentServer`, renders the hook, and checks it goes loading → names with no error. |
| `drops the old symbols and refetches when the server switches` | Unit | Prevent a stale cross-server list rendering for a frame after a switch. | Switches the server mid-render and checks the symbol list empties and returns to loading before the new list lands. |
| `returns cached symbols synchronously when switching back` | Unit | Avoid a loading flash when returning to an already-fetched engine. | Switches away and back, and checks `loading` is false immediately with only two fetches total. |
| `surfaces a fetch failure as an error with an empty list` | Unit | Stop a dead engine hanging the widget on `loading` forever. | Rejects the fetch and checks the hook exposes the error message and an empty list. |

### `frontend/src/hooks/useApiKey.test.tsx`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `reconciles a cached key with the backend key` | Unit | Confirm backend API-key state overrides local cache. | Seeds `localStorage`, mocks the backend key lookup, renders the hook, and checks state/cache update to the backend value. |
| `keeps the cached key and surfaces an error when backend lookup fails` | Unit | Keep the UI useful during API-key lookup failures. | Seeds a cached key, mocks a backend rejection, and checks the cached key remains while the error is exposed. |
| `generates and stores a new API key on request` | Unit | Exercise explicit key creation from the hook. | Mocks no existing keys, calls `generateApiKey()`, and checks hook state plus `localStorage` contain the new key. |

### `frontend/src/hooks/useCurrentServer.test.tsx`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `falls back to the default server when nothing is stored` | Unit | Ensure a fresh browser lands on the build-time default, not `undefined`. | Renders the hook with empty `localStorage` and checks it returns `DEFAULT_SERVER`. |
| `reads the stored server on mount` | Unit | Avoid a one-render flash of the default (which would query the wrong engine). | Seeds `currentServer` and checks the hook returns it synchronously on first render. |
| `broadcasts a same-tab switch to every mounted consumer` | Unit | Guard against the cross-server leak a naive `localStorage.setItem` would cause. | Renders two consumers, calls `setCurrentServer`, and checks both update along with storage. |
| `picks up a cross-tab switch from the storage event` | Unit | Cover the other tab, which only ever sees a native `storage` event. | Dispatches a `StorageEvent` for the key and checks the hook re-reads the new value. |
| `ignores storage events for other keys` | Unit | Stop unrelated writes (API key, onboarding flags) churning the server and refetching. | Dispatches a `storage` event for `apiKey` and checks the server value is unchanged. |
| `falls back to the default when a cross-tab write clears the key` | Unit | Handle a sign-out in another tab without producing an empty host string. | Removes the key, dispatches a `storage` event with `newValue: null`, and checks the default is used. |
| `removes both listeners on unmount` | Unit | Prevent a listener leak that would `setState` into a dead tree on every remount. | Spies on `removeEventListener` and checks both `bubbles:currentServer` and `storage` are removed. |

### `frontend/src/dashboard/orderBookState.test.ts`

The snapshot/delta merge used to live inside `OrderBook.tsx` as `useRef` state mutated from a
`useEffect`, which made it untestable. It is now a set of pure functions in `orderBookState.ts`.

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `replaces the whole book and adopts the snapshot seq` | Unit | Pin the snapshot as the baseline: nothing from a possibly-desynced previous state may survive. | Applies two snapshots and checks the second one's levels and `seq` replace the first wholesale. |
| `applies the in-sequence delta and advances seq` | Unit | Cover the normal path on both sides of the book. | Applies a `seq+1` delta that updates and adds levels, and checks the merge plus the new `seq`. |
| `deletes a level when the delta carries qty 0` | Unit | `qty 0` is the engine's delete marker; keeping it would paint a phantom level at the touch. | Sends a qty-0 bid and ask and checks both levels are removed from the map. |
| `ignores a stale delta instead of asking for a resync` | Unit | Regression: any non-`seq+1` delta was treated as a gap, so every early/duplicate publish triggered a resync storm (a subscribe frame plus a full L2 snapshot per delta). | Sends deltas at and behind the current seq, and checks both return `stale` with the book and `seq` untouched. |
| `reports a forward gap so the caller resyncs` | Unit | Keep a genuinely missed delta resyncing, and treat a delta with no baseline the same way. | Sends a `seq+2` delta, and a delta into a cold state, and checks both return `gap` without mutating. |
| `resumes applying once the sequence catches up after a stale delta` | Unit | Prove a stale delta does not poison the stream, no snapshot round-trip needed. | Sends a stale delta then the in-sequence one and checks it applies normally. |
| `sorts bids descending and asks ascending, with the notional total` | Unit | Both sides must walk outward from the touch so the first rendered row is the best price. | Converts unordered bid/ask maps and checks the ordering and the `price × size` total. |
| `returns an empty list for an empty book` | Unit | Cover the empty-map render path. | Converts an empty map and checks an empty array. |
| `keeps only the levels nearest the touch` | Unit | Stop the far-from-touch tail pushing the levels that matter off screen. | Takes depth from a 20-level side and checks it is capped at `DEPTH_LEVELS` from the touch, plus an explicit 2-level cap. |
| `leaves a book shallower than the cap untouched` | Unit | Never pad or truncate a thin book. | Takes depth from a two-level side and checks it is returned as-is. |

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

#### `backend/src/auth/supabase-auth.guard.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `rejects a request with no Authorization header` | Unit | Close the outermost gate on every authenticated route. | Calls `canActivate` with no headers and checks it throws `UnauthorizedException` without calling Supabase. |
| `rejects a non-Bearer Authorization scheme` | Unit | Honour only the `Bearer <token>` scheme. | Sends a `Basic` header and checks the `missing bearer token` rejection with no Supabase call. |
| `rejects a Bearer header with an empty token` | Unit | Treat `Bearer` with whitespace as malformed, not anonymous. | Sends `Bearer    ` and checks it is rejected before an empty string reaches Supabase. |
| `rejects a raw token sent without the Bearer prefix` | Unit | Keep the scheme check prefix-based and strict. | Sends a bare token and checks it is refused rather than silently accepted. |
| `rejects a token Supabase reports as invalid or expired` | Unit | Ensure a token Supabase refuses cannot authenticate. | Mocks `auth.getUser` returning an error and checks the `invalid or expired session` rejection. |
| `rejects a successful response that carries no user` | Unit | Prevent a 200-with-no-user from producing an undefined `userId`. | Mocks `{ data: { user: null }, error: null }` and checks it still throws. |
| `accepts a valid token and attaches the user id to the request` | Unit | Cover the happy path every controller scopes its queries from. | Mocks a valid Supabase user and checks `req.auth.userId` and `req.auth.claims.email`. |
| `normalizes provider metadata into the claims the controllers expect` | Unit | Reconcile the differing metadata shapes OAuth providers return. | Mocks `user_metadata` with both naming conventions and checks the normalized claims object. |
| `tolerates a user with no metadata` | Unit | Authenticate a metadata-less user instead of blowing up on a missing object. | Mocks a user with no `user_metadata` and checks it authenticates with undefined claims. |
| `serves a repeat request from cache without re-verifying the token` | Unit | Keep Supabase's `/auth/v1/user` off the critical path of every dashboard call. | Calls `canActivate` twice with one token and checks `getUser` ran once. |
| `verifies each distinct token separately` | Unit | Prove the cache is keyed by token, so a hit can never authenticate a stranger. | Calls with two tokens and checks two verifications and two distinct user ids. |
| `shares cached verifications across guard instances` | Unit | Pin that the cache is module-level, not per-instance. | Verifies with one guard, then a fresh guard, and checks `getUser` still ran once. |
| `does not cache failed verifications` | Unit | Ensure a rejection isn't cached, so a newly-valid token isn't locked out. | Fails the same token twice and checks Supabase was called both times. |
| `re-verifies a token once its cache entry expires` | Unit | Bound how long a revoked session keeps working. | Freezes `Date.now`, jumps past the 30s cache window, and checks the token is re-verified. |
| `evicts expired entries instead of growing forever` | Unit | Regression: expired entries were never removed, so a long-lived host leaked one entry per user per token rotation (~hourly). | Caches a token, jumps `Date.now` 300s forward, verifies another, and checks the map holds a single entry. |
| `caps the cache when every entry is still live` | Unit | Stop a burst of distinct *live* tokens growing the map without bound. | Verifies `MAX_CACHE_ENTRIES + 50` fresh tokens and checks the map never exceeds the cap. |

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
| `rejects expired keys` | Unit | Reject keys past their expiry. | Mocks an active but past-expiry key and checks `{ valid: false }`. |
| `rejects revoked keys` | Unit | Reject keys turned off via `isActive`. | Mocks a well-formed, unexpired key with `isActive: false` and checks `{ valid: false }`. |
| `rejects keys that are not in the database` | Unit | Reject well-formed keys that were never issued. | Mocks a `null` lookup and checks `{ valid: false }`. |
| `accepts non-expiring keys` | Unit | Treat a null expiry as "never expires". | Mocks an active key with `expiresAt: null` and checks `{ valid: true, userId }`. |

#### `backend/src/api-keys/api-key.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `issues a key for the authenticated user using their verified claims` | Unit | Ensure a key is minted for the caller, never for a user id from the body or query. | Calls `createApiKey` with a guard-populated `req.auth` and checks the service is called with the verified id, email, and username. |
| `falls back to preferred_username when username is absent` | Unit | Avoid provisioning a nameless user when the provider only sends `preferred_username`. | Passes claims with only `preferred_username` and checks it is used as the username. |
| `synthesizes an email when the token carries no email claim` | Unit | Satisfy the NOT NULL email column for tokens without an email. | Passes claimless auth and checks a synthetic `user_<id>@clerk.dev` address is used. |
| `lists only the authenticated user’s keys` | Unit | Scope listing to the caller. | Calls `getApiKeys` and checks the service sees only the auth user id. |
| `returns an empty list when the user has no key` | Unit | Return an empty list, not an error, for a user who never provisioned a key. | Mocks an empty service result and checks an empty array resolves. |
| `deletes the key on behalf of the authenticated user` | Unit | Ensure the route passes the caller's id so the service can enforce ownership. | Calls `deleteApiKey` and checks the service receives both the key id and the auth user id. |
| `propagates the service rejection for another user’s key` | Unit | Surface a cross-tenant delete rejection rather than swallowing it into a 200. | Mocks a service rejection and checks the route rethrows it. |
| `rejects a request with no key in the body` | Unit | Reject a malformed engine validation request before it reaches Prisma. | Calls `validateApiKey` with an empty body and checks an `HttpException` with no service call. |
| `validates the key when no shared secret is configured` | Unit | Keep the endpoint dev-friendly when `ENGINE_SHARED_SECRET` is unset. | Unsets the env var and checks the key is forwarded to the validator. |
| `rejects a mismatched engine secret before touching the database` | Unit | Stop a stranger mounting a DB-DoS amplifier against `findUnique`. | Sets the secret, sends the wrong one, and checks the `engine secret missing or invalid` rejection with no service call. |
| `accepts the request when the engine secret matches` | Unit | Let the engine through the gate with the right secret. | Sets and sends the matching secret and checks the service is called with the key. |

#### `backend/src/trading/trading.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `returns market data from the trading service` | Unit | Ensure market reads pass through to the service. | Injects a mocked `TradingEngineService`, returns a market object, and checks the controller returns the same object. |
| `uses the authenticated user id when loading a portfolio` | Unit | Ensure portfolio reads are scoped to the request identity. | Passes a request with `auth.userId` and checks the service is called with that user id. |

#### `backend/src/users/users.service.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `creates a missing user and atomically provisions the first API key` | Unit | Ensure user sync creates both profile and default key. | Mocks no user, creates one, upserts a generated key, and reloads the user with key included. |
| `updates changed profile fields without rotating an existing key` | Unit | Keep existing credentials stable during profile updates. | Mocks a user with changed fields and an existing key, then checks only `user.update` runs. |
| `leaves an unchanged user with an existing key alone` | Unit | Protect the already-synced no-op path. | Mocks an unchanged user and checks no create, update, or key upsert occurs. |
| `short-circuits empty lookup requests` | Unit | Avoid database work for empty leaderboard joins. | Calls `getUsernames([])` and checks no Prisma query happens. |
| `maps auth user ids to usernames for leaderboard joins` | Unit | Resolve display names for leaderboard rows. | Mocks `findMany` results and checks auth IDs map to username strings. |

#### `backend/src/users/users.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `resolves the requested user ids to usernames` | Unit | Cover the leaderboard join: engine ids in, display names out. | Calls `names()` with one id and checks the service is called with it and the map returned. |
| `clamps an oversized id batch to the first 500 entries` | Unit | Stop a caller making Prisma build an unbounded `IN (...)` list. | Passes 900 ids and checks only the first 500 reach the service. |
| `passes a batch of exactly 500 ids through unchanged` | Unit | Pin the clamp boundary as inclusive. | Passes exactly 500 ids and checks all 500 survive. |
| `treats a missing or non-array ids field as an empty lookup` | Unit | Degrade a malformed body to an empty lookup rather than a 500. | Calls with `{}` and with a string `ids`, and checks both forward an empty array. |
| `syncs the authenticated user from their token claims` | Unit | Ensure nothing in the request body can influence which user is written. | Calls `syncUser` with guard-verified claims and checks the service receives id, email, username, and names. |
| `falls back to preferred_username for the display name` | Unit | Give providers that only expose `preferred_username` a display name. | Passes only `preferred_username` and checks it is used. |
| `synthesizes a no-reply email when the token has no claims` | Unit | Satisfy the required email column for a claimless token. | Calls with no claims and checks an `<id>@users.noreply` address is used. |

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
| `returns an empty trade list when the payload has no chart result` | Unit | Treat an unknown Yahoo ticker as an empty backtest, not a 500. | Mocks `chart.result: null` and checks a well-formed zero-trade response. |
| `drops bars with a null close and defaults missing open/volume` | Unit | Keep holiday/halted bars from becoming NaN-priced trades. | Mocks a payload with null closes/opens/volumes and checks the bad bar is skipped and defaults are applied. |
| `survives a completely empty payload` | Unit | Produce a well-formed response for an empty Yahoo body. | Mocks `{ data: {} }` and checks `count: 0` with an empty trade list. |
| `rejects a missing symbol with a 400 instead of throwing a TypeError` | Unit | Regression: a missing `?symbol=` hit `symbol.toLowerCase()` on `undefined` and 500ed. | Calls `getCandles(undefined)` and checks a `BadRequestException` with no upstream call. |
| `rejects an unknown symbol rather than relaying it to Yahoo` | Unit | Regression: an unknown symbol was forwarded verbatim, making this unauthenticated endpoint an open relay for arbitrary tickers. | Calls `getCandles` with `AAPL` and a path-traversal string and checks both 400 with no upstream call. |
| `degrades to an empty series when Yahoo fails` | Unit | Treat a Yahoo rate-limit/outage as an empty series, not a server error of ours. | Throws a 429 on the fetch and checks a well-formed zero-trade response. |
| `serves cached prices when the engine fetch fails` | Unit | Stop a dead engine 500ing the dashboard. | Seeds the store, makes the engine fetch throw, and checks the cached price is still served. |
| `returns empty maps rather than throwing when the engine is down and the cache is cold` | Unit | Keep the endpoint healthy with nothing cached and no upstream. | Throws on the engine fetch with an empty store and checks empty maps resolve. |
| `still renders every index when the Yahoo daily fetch 5xxs` | Unit | Keep the indices panel rendering through a Yahoo outage. | Throws on every fetch and checks all four indices come back with null daily numbers. |
| `falls back to the stale daily series when the refetch fails` | Unit | Use the daily cache instead of blanking the chart on a failed refresh. | Seeds a stale daily entry, fails the refetch, and checks the stale prevClose/series are served. |
| `degrades the returns endpoint to nulls on a network failure` | Unit | Keep the full instrument universe served with nulls rather than an error. | Throws on the fetch and checks 14 instruments with null prices/returns and empty series. |
| `ignores a malformed Yahoo daily payload with no chart result` | Unit | Treat a 200-with-no-result like an outage: no data, no crash. | Routes Yahoo to `chart.result: null` while the engine answers, and checks the live price lands but the daily numbers don't. |
| `ignores non-numeric and non-positive engine prices` | Unit | Stop the store being poisoned with NaN/negative/zero prices. | Feeds the engine junk values alongside one good price and checks only the good symbol is stored. |

#### `backend/src/index-prices/historical-data.service.spec.ts`

The parquet reader (`hyparquet`) is loaded through a memoized dynamic import, so the specs seed
that field with a fake reader over an in-memory row array rather than crossing the ESM boundary.

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `rejects an unknown symbol` | Unit | Keep an arbitrary symbol from becoming an arbitrary file path. | Calls `getBacktestTrades('NOPE', …)` and checks a `BadRequestException`. |
| `slices the requested range off the tail of the file` | Unit | Pin the lookback window: a range is measured back from the last bar, not from today. | Requests `5d` of daily bars from a ~10y file and checks the row count, the final `ts`, and the bid/ask columns. |
| `reuses the cached ts column across calls on an unchanged file` | Unit | Keep repeat backtests cheap by not re-decoding the `ts` column of an unchanged file. | Runs two requests and counts the single-column parquet reads, expecting exactly one. |
| `re-decodes the ts column when the parquet is regenerated with more rows` | Unit | Regression: the cache was keyed by path while `nrows` was re-read fresh, so a regenerated (longer) parquet left `tsArr` short, `tsArr[nrows-1]` was `undefined` → `NaN` → `lowerBound(0)` → the whole 10-year file came back for a `5d` request. Silently wrong backtest data. | Warms the cache, grows the row array by a year, re-requests `5d`, and checks the slice is still short and ends on the new final bar. |
| `serves no trades when the ts column is unusable` | Unit | Never fall back to "return everything" when the requested range is unknowable. | Corrupts the final `ts` to `NaN` and checks zero trades come back. |
| `returns an empty result for a file with no rows` | Unit | Cover the empty-parquet degenerate input. | Empties the row array and checks a well-formed zero-trade response. |

#### `backend/src/news/news.service.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `parses RSS items into news rows and inserts them` | Unit | Cover the main RSS parse path with CDATA and HTML stripped. | Feeds one CNBC feed a canned RSS document and checks the written rows' headline, summary, url, category, source, and datetime. |
| `skips items missing a headline or a link` | Unit | Drop unkeyable/unlinkable items instead of writing half-rows. | Includes a title-less item in the feed and checks only the two complete items are written. |
| `falls back to the current time for an item with no pubDate` | Unit | Avoid an Invalid Date that Prisma would reject. | Checks the pubDate-less item's `datetime` is a valid time close to now. |
| `dedupes the same story appearing in two feeds` | Unit | Collapse a syndicated story to one row before the insert. | Serves the same RSS from two feeds and checks two rows with two distinct hashed ids. |
| `keeps ingesting when a single feed fails` | Unit | Ensure one broken feed doesn't sink the whole ingest cycle. | Throws on one feed, serves RSS from another, and checks the surviving feed's rows are still written. |
| `writes nothing when every feed fails` | Unit | Never fire an insert with an empty data array. | Throws on every feed and checks `createMany` is not called and nothing rejects. |
| `tolerates a feed that returns no RSS items at all` | Unit | Handle a feed answering with an HTML error page. | Serves `502 Bad Gateway` HTML and checks the cycle resolves with no insert. |
| `swallows a failed database insert` | Unit | Prevent a DB failure becoming an unhandled rejection in the scheduler. | Rejects `createMany` and checks `ingestMarketNews()` still resolves. |
| `skips Finnhub when no API key is configured` | Unit | Keep Finnhub opt-in. | Runs with no `FINNHUB_API_KEY` and checks no finnhub.io URL was requested. |
| `merges Finnhub items in when a key is set` | Unit | Cover the Finnhub path and its epoch-second → Date conversion. | Sets the key, serves a Finnhub item, and checks it is merged alongside the RSS rows with a real `Date`. |
| `still ingests RSS when Finnhub fails` | Unit | Stop a Finnhub outage taking the keyless RSS rows down with it. | Throws on the Finnhub call and checks the two RSS rows are still written. |
| `serves the newest cached items up to the limit` | Unit | Pin the read path: newest first, bounded by the caller's limit. | Calls `getLatestNews(25)` and checks the Prisma `orderBy`/`take` arguments. |
| `defaults to 50 items` | Unit | Document the default page size. | Calls `getLatestNews()` with no limit and checks `take: 50`. |
| `maps an unreachable database to a 503` | Unit | Surface a transient infra problem as retryable, not as "there is no news". | Rejects with a Prisma `P1001` and checks a `ServiceUnavailableException`. |
| `maps a DNS failure to a 503 as well` | Unit | Put DNS failures on the same retryable path as Prisma's P100x codes. | Rejects with `EAI_AGAIN` and checks the `database_unavailable` response body. |
| `rethrows a non-transient query error untouched` | Unit | Keep a genuine bug from being disguised as a retryable 503. | Rejects with `P2022` and checks the original error propagates, not a 503. |

#### `backend/src/news/news.controller.spec.ts`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `returns the cached news items` | Unit | Cover the read path and its default limit. | Calls `getNews()` and checks the items pass through with a limit of 50. |
| `honours a limit inside the allowed range` | Unit | Pass a sane limit through untouched. | Calls `getNews('120')` and checks the service sees 120. |
| `clamps an absurdly large limit to 200` | Unit | Stop `?limit=1000000` materializing the whole news table, a cheap DoS. | Calls with `1000000` and checks the service sees 200. |
| `allows exactly 200` | Unit | Pin the upper bound as inclusive. | Calls with `200` and checks it is not clamped down. |
| `allows exactly 1 but falls back to the default below it` | Unit | Pin the lower bound and stop `take: -5` reaching Prisma. | Calls with `1`, `0`, and `-5` and checks 1, 50, 50. |
| `falls back to the default for non-numeric or infinite limits` | Unit | Reject garbage and `Infinity` as non-finite. | Calls with `abc` and `Infinity` and checks both default to 50. |
| `floors a fractional limit to an integer` | Unit | Keep Prisma's `take` an integer. | Calls with `10.9` and checks the service sees 10. |

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
| `fills_same_price_level_in_arrival_order` | Unit | Pin price-time priority within a single level. | Rests two makers at one price, sweeps part of the level, and checks the earlier maker fills first and the level aggregate nets correctly. |
| `sweeps_multiple_price_levels_with_volume_weighted_average` | Unit | Verify a multi-level sweep erases exhausted levels and reports a VWAP. | Rests three asks, crosses eight units, and checks one fill per level, `avg_price` of 101.125, and the residual level. |
| `partially_fills_crossing_limit_and_rests_remainder` | Unit | Cover the partially-crossed limit path. | Crosses a 3-lot maker with a 10-lot limit and checks `PartiallyFilled` plus a 7-lot resting bid. |
| `cancels_partially_filled_resting_order_and_keeps_level_qty_honest` | Unit | Ensure a cancel subtracts the *remaining* quantity, not the original size. | Partially fills a maker, cancels it, and checks the reported remainder and the level aggregate. |
| `rejects_cancel_of_unknown_order` | Unit | Report unknown and double cancels as `not_found`. | Cancels an id the book never saw, then cancels a resting order twice. |
| `allows_internal_cancel_to_bypass_owner_check` | Unit | Cover the admin/internal cancel path (empty `user_id_must_match`). | Cancels another user's order with an empty owner and checks it succeeds and carries the true owner. |
| `cancels_every_same_user_maker_at_a_level` | Unit | Ensure STP drains *all* same-user makers at a level, not just the front one. | Rests two same-user asks, crosses them, and checks two STP cancels, no fills, and an erased level. |
| `skips_same_user_maker_and_fills_other_maker_at_same_level` | Unit | Ensure matching continues past an STP-cancelled maker into the next one. | Rests a same-user and another user's maker at one price and checks one STP cancel plus a fill against the other maker. |
| `handles_top_n_and_empty_book_edges` | Unit | Pin accessor edges: empty book, `top_n(0)`, and `n` beyond the level count. | Reads best bid/ask and `top_n_*` on an empty book, then over-requests levels on a populated one. |
| `rejects_duplicate_order_id_without_corrupting_the_level` | Unit | Regression: a duplicate id used to free the `Order` after linking it, leaving a dangling pointer in the level. | Applies the same id twice, checks the `duplicate_order_id` reject, and then cancels the original to prove the level is intact. |

### `trading_engine/tests/matching_engine_test.cpp`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `publishes_initial_snapshot_on_start` | Integration | Confirm engine startup publishes a baseline book snapshot. | Starts a `MatchingEngine` with an `EventBus` collector and waits for the snapshot event. |
| `rejects_market_order_when_book_is_empty` | Integration | Ensure engine-level empty-book rejects are emitted. | Starts the engine, submits a market command, and waits for a reject execution report. |
| `emits_ack_fills_trade_print_and_book_delta_for_a_match` | Integration | Verify matching emits fills, trade tape, and book deltas. | Starts the engine, rests a maker ask, submits a taker market buy, and checks trade print, fill reports, residual delta, and trade-id increment. |
| `publishes_book_delta_when_self_trade_prevention_empties_the_book` | Integration | Regression: the reject path used to return before publishing, leaving subscribers rendering a cancelled level forever. | Rests a maker, self-crosses it with a market order, and checks both the `no_liquidity` reject *and* a qty-0 delta removing the level. |

### `trading_engine/tests/mpsc_ring_test.cpp`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `loses_no_commands_under_concurrent_producers` | Unit | Regression: the old SPSC queue's non-atomic head update let two producers claim one slot, silently dropping an order. | Drives 8 threads × 4096 pushes through a 1024-slot `MPSCRing` against one consumer and asserts every value arrives exactly once. |
| `reports_full_instead_of_overwriting` | Unit | Ensure a full ring reports full (which the Sequencer turns into a `queue_full` reject) rather than clobbering an unread slot. | Fills a 4-slot ring, checks the next push fails, then drains it and checks FIFO order and `empty()`. |

### `trading_engine/tests/session_test.cpp`

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `queues_outbound_without_touching_the_socket` | Unit | `EventBus::publish` runs on the matching shard's worker thread, so queuing a frame must never block or touch the socket, however far behind the client is. | Queues two frames on a session whose `sockfd` is `-1` (a write would fault) and checks both land on the pending queue in order. |
| `kicks_a_session_whose_queue_overflows` | Unit | A client that stops reading would otherwise grow the queue without bound; dropping frames would corrupt the L2 delta stream, so the session is closed instead. | Fills the queue to `kMaxOutboundFrames`, checks the next push is refused, the session is marked closing, and no queued frame was silently dropped. |
| `refuses_to_queue_after_the_writer_exits` | Unit | Once the writer thread is gone nothing drains the queue, so queuing must stop rather than strand frames. | Marks the session `out_dead`, checks the queue call is refused, and checks nothing is left on the queue. |
| `request_close_marks_the_session_closing` | Unit | Pin the shutdown contract: no new frames, but already-queued frames still drain. | Queues a frame, calls `request_close`, and checks further queuing is refused while the pending frame survives. |
| `client_id_survives_concurrent_reads_and_writes` | Unit | Regression: `client_id` was a bare `std::string` written by the reader thread on hello and read by REST threads (pause, leaderboard), a data race, and on a reallocating assignment a read of freed memory. | Runs one writer alternating SSO and heap-allocating values against four readers for 20k iterations (run under ThreadSanitizer) and checks every reader only ever observes a whole value. |

### `trading_engine/tests/protocol_test.cpp`

Exercises `parse_inbound` (the JSON trust boundary for every byte a client puts on the wire) and
the `encode_*` frame builders (which must never let a hostile string break out of its JSON value).

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `parses_hello_and_ping` | Unit | Cover the happy paths for the two simplest frames, including an optional `client_id`. | Parses `hello` with and without a `client_id`, and `ping`, and checks the type and empty parse_error. |
| `parses_limit_place_order` | Unit | Pin the full limit-order parse plus the accepted enum spellings. | Parses a limit `place_order` and checks every field, then that side/type accept three cases each and the `*_name` helpers round-trip. |
| `parses_market_place_order_without_price` | Unit | Ensure a market order parses with no `limit_price`, and that any supplied price is ignored. | Parses a market `place_order` and checks the limit price stays 0, including when a negative `limit_price` is present. |
| `parses_cancel_order` | Unit | Cover the cancel happy path. | Parses `cancel_order` with an `order_id` and checks the type and id. |
| `parses_subscribe_and_unsubscribe` | Unit | Cover the market-data subscription frames and the depth default. | Parses `subscribe`/`unsubscribe` and checks channel, symbol, explicit depth, and the default depth of 10. |
| `rejects_malformed_json` | Unit | Reject every shape of un-parseable input with a single stable reason. | Feeds 15 broken payloads plus an embedded-NUL-with-trailing-junk frame and checks each is `Unknown` with `invalid_json_or_missing_t`. |
| `rejects_non_object_toplevel` | Unit | Only a JSON object is a message; a bare scalar or array is not. | Feeds numbers, strings, booleans, null, and arrays and checks each is rejected with the same reason. |
| `rejects_deeply_nested_payloads` | Unit | Survive and reject adversarial nesting rather than blowing the stack. | Feeds 20k-deep unterminated openers and a 2000-deep balanced array, and checks a deep junk *value* under a valid `ping` still dispatches. |
| `rejects_missing_or_untyped_t` | Unit | Require a string `t` discriminator. | Feeds objects with no `t` or a non-string `t` and checks each is `Unknown` with `invalid_json_or_missing_t`. |
| `rejects_unknown_message_type` | Unit | Reject a well-formed frame whose `t` names no known type. | Feeds `place`, `PING`, empty, a trailing-space type, and `amend_order` and checks each is `Unknown` with `unknown_type`. |
| `rejects_place_order_missing_required_fields` | Unit | Flag the exact missing field for each required slot. | Drops symbol, side, type, quantity, and limit price in turn and checks each reports its own reason, plus a cancel with no `order_id`. |
| `rejects_place_order_with_wrong_field_types` | Unit | Treat a wrong-typed field as invalid, never coerced. | Feeds string/null/bool/object/array/fractional quantities and prices and non-string symbol/side/type and checks each reports the right reason and carries no price. |
| `rejects_unknown_enum_spellings` | Unit | Accept only the exact side/type spellings on the wire. | Feeds `bid`, `b`, `stop`, etc. to `parse_side`/`parse_type` and to a full place order and checks each is rejected. |
| `rejects_zero_and_out_of_range_quantities` | Unit | Regression: a negative JSON quantity/order_id was cast straight to uint64, so `-1` became UINT64_MAX and slipped past the zero-guard. | Checks quantity 0, > uint64-max, and `1e999` reject; that uint64-max itself parses; and that negative quantities and a negative cancel `order_id` are rejected, not wrapped. |
| `rejects_non_positive_and_non_finite_prices` | Unit | Reject `<= 0` and non-finite limit prices while letting a finite-but-huge price through. | Feeds 0/negative prices and `NaN`/`Infinity` tokens and checks each rejects, then that `1e308` parses finite and positive. |
| `rejects_zero_order_id_on_cancel` | Unit | Treat `order_id` 0 as missing, not a real order. | Parses a cancel with `order_id:0` and checks `missing_order_id` and that no id is carried. |
| `accepts_any_channel_string_on_subscribe` | Unit | Echo channel/symbol verbatim (the dispatcher resolves them) while defaulting bad field types. | Checks an unknown channel/symbol pass through, and that non-string channel/symbol and non-integer depth fall back to empty/10. |
| `carries_long_and_escaped_strings_without_truncation` | Unit | Never truncate a large field, and decode JSON escapes to raw bytes. | Parses 64KiB/32KiB client_id/symbol/client_order_id and checks sizes survive, then that `\"`/`\\`/`\n` decode to their raw bytes. |
| `escapes_hostile_strings_in_welcome_and_error` | Unit | A hostile `user_id`/error string must land inside its JSON value, never inject a key. | Encodes welcome/error/pong with quote/backslash/newline/control bytes and a break-out `","admin":true` string and checks each re-parses to exactly the original with no injected key. |
| `escapes_hostile_strings_in_execution_reports` | Unit | Ack/fill/reject/cancel frames carry client- and config-supplied strings safely, and drop an unknown symbol. | Encodes each execution-report kind with hostile symbol/client_order_id/reason and checks the re-parsed fields, that fills omit `reason`, and that an unresolvable symbol id is omitted. |
| `escapes_hostile_symbols_in_market_data_frames` | Unit | Trade/delta/snapshot frames must escape a hostile symbol and encode a `qty 0` removal. | Encodes trade, book_delta, snapshot-from-delta, and book snapshot with a hostile symbol and checks the escaped fields, the qty-0 level removal, empty sides as `[]`, and that an unknown symbol id is dropped. |
| `keeps_frames_valid_json_under_every_control_byte` | Unit | Any frame built entirely from control bytes must still be one fully-decodable JSON object. | Builds welcome/error/execution-report frames from every byte 1–31 plus `"\/` and checks each re-parses to the original with no raw control byte surviving into the frame. |

### `trading_engine/tests/ws_frame_test.cpp`

Drives `ws_read_frame`, `read_http_headers`, and the handshake helpers over a real `AF_UNIX`
socketpair, so the code under test reads untrusted bytes exactly as it would off a client socket.

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `reads_and_unmasks_a_well_formed_text_frame` | Unit | Cover the normal masked client frame, including a mask key containing zero bytes. | Writes two masked text frames (one with a zero-byte mask column) and checks the fin bit, opcode, and unmasked payloads. |
| `rejects_an_unmasked_client_frame` | Unit | RFC 6455 §5.1: an unmasked client frame is a protocol violation. | Writes a frame with the mask bit clear and checks `ws_read_frame` returns false. |
| `parses_every_payload_length_encoding` | Unit | Cover the 7-bit, 16-bit (126), and 64-bit (127) length encodings. | Reads a 125-byte, a 300-byte, and a 70000-byte frame (the last fed from a thread) and checks each payload size and contents. |
| `refuses_payloads_above_max_payload` | Unit | Refuse an oversized declared length before any payload is read or allocated. | Declares 200 bytes against a 100-byte cap, then the `0xFFFF…FFFF` and high-bit-set 64-bit lengths, and checks each is refused instantly with no allocation. |
| `rejects_truncated_frames` | Unit | Every truncation point returns false rather than hanging or reading garbage. | Cuts the header, 16-bit length, 64-bit length, mask key, and payload short in turn and checks each is refused. |
| `returns_false_on_immediate_eof` | Unit | A peer that connects and hangs up must not read as a frame. | Closes the writer with no bytes sent and checks `ws_read_frame` returns false. |
| `parses_control_frames_and_zero_length_payloads` | Unit | Close/Ping/Pong parse with the right opcode, and a zero-length payload works. | Writes Close (with a status code + reason), Ping, an empty Pong, and an empty Text frame and checks each opcode and payload. |
| `reports_the_fin_bit_for_fragmented_frames` | Unit | Surface the fin bit and Continuation opcode so the caller can reassemble fragments. | Writes a `fin=false` Text head and a `fin=true` Continuation and checks the fin bit, opcode, and payload of each. |
| `passes_unknown_opcodes_through` | Unit | The framing layer reports reserved/unknown opcodes verbatim rather than policing them. | Writes reserved data (0x3), reserved control (0xB), and 0xF opcodes and checks each is reported as only the low nibble, with RSV bits masked off. |
| `reads_headers_terminated_by_crlfcrlf` | Unit | Return headers at `\r\n\r\n` without blocking for a body, leaving the socket usable. | Reads a header block, then sends `BODY` afterward and checks it is still readable off the socket. |
| `keeps_body_bytes_that_arrive_in_the_same_read` | Unit | Document that a body arriving in the same segment as the headers is consumed into `out`. | Sends headers plus a partial body in one write and checks `out` contains both and the terminator. |
| `refuses_headers_above_max_size` | Unit | Drop a header block that blows past `max_size` instead of growing without bound. | Floods 8KiB of unterminated headers against a 256-byte cap and checks the read fails and stops early. |
| `enforces_the_deadline_against_a_trickling_client` | Unit | Slowloris: the deadline must bound the whole read, not each `::read`. | Trickles one byte every 10ms without ever terminating and checks the read fails between 150ms and 3s, below the size cap. |
| `treats_a_socket_recv_timeout_as_a_failed_read` | Unit | A silent peer under `SO_RCVTIMEO` must fail the read, not park the thread. | Sets a 50ms recv timeout on a peer that sends nothing and checks the read fails quickly with nothing read. |
| `computes_the_rfc6455_accept_key` | Unit | Pin the RFC 6455 §1.3 worked-example accept-key derivation. | Checks `ws_accept_key` returns the RFC's expected value, differs for different keys, and is always 28 base64 chars. |
| `builds_the_handshake_response` | Unit | Emit a correct 101 handshake, echoing the subprotocol only when one was selected. | Checks the status line, Upgrade/Connection/Accept headers, and blank-line terminator, with and without a selected subprotocol. |

### `trading_engine/tests/auth_test.cpp`

Covers `extractApiKeyFromHttp` (pulling a credential out of a raw HTTP request) and the offline
`ApiKeyAuthenticator` (format check, cache, and revocation), including a ThreadSanitizer race case.

| Test | Type | Purpose | What it does |
|---|---|---|---|
| `extracts_bearer_token_from_authorization_header` | Unit | Cover the documented `Authorization: Bearer <key>` happy path. | Extracts the key from a full CRLF request, a bare-LF request, and a no-space-after-colon header. |
| `matches_only_the_two_spellings_of_each_header` | Unit | Recognise only the exact `Authorization:`/`authorization:` and `Api-Key:`/`api-key:` spellings. | Checks the two lowercase forms are recognised while uppercase headers and a lowercase `bearer` scheme are not. |
| `extracts_api_key_header_form` | Unit | Support the `Api-Key:` header and let `Authorization` win over it. | Extracts an `Api-Key` value (with and without a space) and checks `Authorization` takes precedence regardless of order. |
| `ignores_query_string_api_key` | Unit | Query-string auth was removed; `?api_key=` must yield nothing. | Feeds requests with `?api_key=` and `&api_key=` and checks the extracted key is empty. |
| `returns_empty_when_no_key_is_present` | Unit | Never return a partial match when there is no credential. | Feeds empty, whitespace-only, no-auth, colon-less, and bare-`Bearer` inputs and checks each yields an empty string. |
| `handles_malformed_authorization_headers` | Unit | A malformed Authorization line must not yield a token. | Feeds empty values, `Bearer` with no token, a `Basic` scheme, and truncated header names and checks each yields nothing. |
| `handles_whitespace_and_tab_variations` | Unit | Pin the asymmetric space/tab handling and prove untrimmed junk cannot validate. | Checks Api-Key skips leading spaces but keeps a tab, Bearer keeps a second space and trailing spaces, and that such space/tab-padded keys fail `validateApiKey`. |
| `stops_value_at_header_boundary_against_injection` | Unit | Regression: the value must stop at the header boundary, so a lone-LF-terminated header does not swallow later lines. | Checks CRLF- and LF-terminated values stop at the boundary and still validate, and that an embedded NUL is data, not a terminator. |
| `handles_truncated_and_oversized_requests` | Unit | Read unterminated and 256KiB values in-bounds without overflow. | Extracts keys from unterminated Bearer/Api-Key lines and a dangling CR, then 256KiB values, and checks the oversized value does not validate. |
| `takes_the_first_of_multiple_authorization_headers` | Unit | Regression: the Bearer scan is scoped to the Authorization line, so a `Bearer` in a later header is not picked up. | Checks the first of duplicate Authorization/Api-Key headers wins, and that an empty Authorization plus a `Bearer` in a later header (or the body) yields nothing. |
| `validates_known_key_offline` | Unit | Serve a seeded key from the offline cache without a network hop. | Seeds keys with and without a user id and checks `validate` returns the seeded id, that a re-seed overwrites it, and `validateApiKey` agrees. |
| `rejects_unknown_and_malformed_keys` | Unit | Reject anything that is not a seeded, format-valid `sk_live_[a-f0-9]{32}` key. | Feeds unseeded, empty, wrong-prefix, wrong-length, uppercase, non-hex, trailing-newline, and embedded-NUL keys and checks the format check runs before the cache. |
| `revokes_keys_with_remove_key` | Unit | `removeKey` revokes immediately and idempotently, and the key can be re-added. | Revokes a valid key and checks it and its user id are gone, that removing twice or an absent key is harmless, and that it can be re-seeded. |
| `serves_cached_positive_and_honours_revocation` | Unit | A seeded entry outlives the configured TTL; only revocation ends it. | Serves the cached positive 100 times with TTL 0, changes the TTL, and checks revocation still beats a long TTL. |
| `survives_concurrent_validate_and_mutation` | Unit | Readers and mutators racing on the same keys must never crash, tear, or race. | Runs six readers against a mutator adding/removing keys for 2000 iterations (under ThreadSanitizer) and checks no user id tears and no unseeded key validates. |
