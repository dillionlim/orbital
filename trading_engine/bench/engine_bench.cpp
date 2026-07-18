// Quick microbenchmark of the Bubbles matching hot path.
// Exercises the REAL OrderBook and the lock-free SPSC/MPSC rings — no mocks.
// Build with the same -O3 flags the release engine uses.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <random>
#include <thread>
#include <vector>

#include "book/order_book.hpp"
#include "common/spsc_queue.hpp"

using namespace TradingSystem;
using Clock = std::chrono::steady_clock;

static double ns_per(std::chrono::nanoseconds d, uint64_t n) {
    return static_cast<double>(d.count()) / static_cast<double>(n);
}
static double mops(uint64_t n, std::chrono::nanoseconds d) {
    return static_cast<double>(n) / (static_cast<double>(d.count()) / 1e9) / 1e6;
}

static OrderInput mk(OrderId id, OrderSide side, OrderType type,
                     Price px, Quantity qty, std::string_view user) {
    OrderInput in;
    in.id = id;
    in.symbol = 1;
    in.side = side;
    in.type = type;
    in.limit_price = px;
    in.quantity = qty;
    in.user_id = user;
    return in;
}

// ---- 1. Resting-limit insertion into a deep book -------------------------
static void bench_insert(uint64_t N, int levels) {
    OrderBook book(1);
    std::mt19937_64 rng(42);
    std::uniform_int_distribution<int> lvl(0, levels - 1);
    // pre-generate ids
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) {
        // bids well below, asks well above -> never cross, always rest
        bool buy = (i & 1);
        Price px = buy ? (1000.0 - lvl(rng)) : (2000.0 + lvl(rng));
        auto r = book.apply(mk(i + 1, buy ? OrderSide::Buy : OrderSide::Sell,
                               OrderType::Limit, px, 10, "u"));
        (void)r;
    }
    auto dt = Clock::now() - t0;
    printf("  insert (rest) : %8.1f ns/op   %6.2f M ops/s   (book depth ~%zu, %d levels)\n",
           ns_per(dt, N), mops(N, dt), book.open_orders(), levels);
}

// ---- 2. O(1) cancel of resting orders ------------------------------------
static void bench_cancel(uint64_t N) {
    OrderBook book(1);
    std::vector<OrderId> ids;
    ids.reserve(N);
    std::mt19937_64 rng(7);
    std::uniform_int_distribution<int> lvl(0, 199);
    for (uint64_t i = 0; i < N; ++i) {
        bool buy = (i & 1);
        Price px = buy ? (1000.0 - lvl(rng)) : (2000.0 + lvl(rng));
        auto r = book.apply(mk(i + 1, buy ? OrderSide::Buy : OrderSide::Sell,
                               OrderType::Limit, px, 10, "u"));
        (void)r;
        ids.push_back(i + 1);
    }
    std::shuffle(ids.begin(), ids.end(), rng);
    auto t0 = Clock::now();
    uint64_t ok = 0;
    for (OrderId id : ids) {
        auto c = book.cancel(id, "u");
        ok += c.ok;
    }
    auto dt = Clock::now() - t0;
    printf("  cancel        : %8.1f ns/op   %6.2f M ops/s   (%llu/%llu cancelled)\n",
           ns_per(dt, N), mops(N, dt), (unsigned long long)ok, (unsigned long long)N);
}

// ---- 3. best_bid / best_ask read (O(log N)) ------------------------------
static void bench_topofbook(uint64_t N) {
    OrderBook book(1);
    for (int i = 0; i < 200; ++i) {
        auto r1 = book.apply(mk(2 * i + 1, OrderSide::Buy, OrderType::Limit, 1000.0 - i, 10, "u"));
        auto r2 = book.apply(mk(2 * i + 2, OrderSide::Sell, OrderType::Limit, 2000.0 + i, 10, "u"));
        (void)r1; (void)r2;
    }
    volatile double sink = 0;
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) sink += book.best_bid() + book.best_ask();
    auto dt = Clock::now() - t0;
    (void)sink;
    printf("  top-of-book   : %8.1f ns/op   %6.2f M ops/s   (best_bid+best_ask)\n",
           ns_per(dt, 2 * N), mops(2 * N, dt));
}

// ---- 4. Marketable orders that actually match ----------------------------
static void bench_match(uint64_t N) {
    OrderBook book(1);
    OrderId next = 1;
    // seed a wall of asks to eat through, refilled as needed
    auto refill = [&](int count) {
        for (int i = 0; i < count; ++i)
            { auto r = book.apply(mk(next++, OrderSide::Sell, OrderType::Limit,
                                     1500.0 + (i % 50), 10, "maker")); (void)r; }
    };
    refill(2000);
    uint64_t fills = 0;
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) {
        if (book.open_orders() < 100) refill(2000);
        auto r = book.apply(mk(next++, OrderSide::Buy, OrderType::Market, 0, 10, "taker"));
        fills += r.fills.size();
    }
    auto dt = Clock::now() - t0;
    printf("  market match  : %8.1f ns/op   %6.2f M ops/s   (%llu fills produced)\n",
           ns_per(dt, N), mops(N, dt), (unsigned long long)fills);
}

// ---- 5. Lock-free SPSC ring throughput (2 threads) -----------------------
static void bench_spsc(uint64_t N) {
    SPSCQueue<uint64_t, 1u << 16> q;
    std::atomic<bool> go{false};
    uint64_t checksum = 0;
    std::thread cons([&] {
        while (!go.load()) {}
        uint64_t got = 0, v;
        while (got < N) { if (q.try_pop(v)) { checksum += v; ++got; } }
    });
    go.store(true);
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) while (!q.try_push(i)) {}
    cons.join();
    auto dt = Clock::now() - t0;
    printf("  SPSC ring     : %8.1f ns/op   %6.2f M msg/s   (2 threads, checksum=%llu)\n",
           ns_per(dt, N), mops(N, dt), (unsigned long long)checksum);
}

// ---- 6. Lock-free MPSC ring throughput (4 producers) ---------------------
static void bench_mpsc(uint64_t per, int producers) {
    MPSCRing<uint64_t, 1u << 16> q;
    std::atomic<bool> go{false};
    uint64_t N = per * producers;
    std::atomic<uint64_t> checksum{0};
    std::thread cons([&] {
        while (!go.load()) {}
        uint64_t got = 0, v, sum = 0;
        while (got < N) { if (q.try_pop(v)) { sum += v; ++got; } }
        checksum = sum;
    });
    std::vector<std::thread> prod;
    auto t0 = Clock::now();
    go.store(true);
    for (int p = 0; p < producers; ++p)
        prod.emplace_back([&, p] {
            for (uint64_t i = 0; i < per; ++i) while (!q.try_push(i)) {}
        });
    for (auto& t : prod) t.join();
    cons.join();
    auto dt = Clock::now() - t0;
    printf("  MPSC ring     : %8.1f ns/op   %6.2f M msg/s   (%d producers -> 1 consumer)\n",
           ns_per(dt, N), mops(N, dt), producers);
}

// ---- Order-of-growth core measurement -----------------------------------
// Build a book of N resting orders spread across L distinct price levels,
// then time insert (build), top-of-book read, and cancel. Returns per-op ns.
struct Row { double insert, cancel, top; };

static Row measure(uint64_t N, uint64_t L, uint64_t seed) {
    OrderBook book(1);
    std::mt19937_64 rng(seed);
    std::uniform_int_distribution<int> lvl(0, (int)L - 1);
    std::vector<OrderId> ids; ids.reserve(N);
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) {
        bool buy = (i & 1);
        // bids far below asks so nothing crosses -> every order rests
        Price px = buy ? (100000.0 - lvl(rng)) : (200000.0 + lvl(rng));
        auto r = book.apply(mk(i + 1, buy ? OrderSide::Buy : OrderSide::Sell,
                               OrderType::Limit, px, 10, "u"));
        (void)r; ids.push_back(i + 1);
    }
    double ins = ns_per(Clock::now() - t0, N);
    volatile double s = 0;
    auto t1 = Clock::now();
    for (int k = 0; k < 2'000'000; ++k) s += book.best_bid() + book.best_ask();
    double top = ns_per(Clock::now() - t1, 4'000'000); (void)s;
    std::shuffle(ids.begin(), ids.end(), rng);
    auto t2 = Clock::now();
    for (OrderId id : ids) { auto c = book.cancel(id, "u"); (void)c; }
    double can = ns_per(Clock::now() - t2, N);
    return {ins, can, top};
}

static Row measure_avg(uint64_t N, uint64_t L, int reps) {
    Row acc{0, 0, 0};
    for (int r = 0; r < reps; ++r) {
        Row x = measure(N, L, 1000 + r);
        acc.insert += x.insert; acc.cancel += x.cancel; acc.top += x.top;
    }
    return {acc.insert / reps, acc.cancel / reps, acc.top / reps};
}

// ---- 7. Deepen the book (grow N, fix price levels L) ---------------------
static void bench_scale_depth() {
    const uint64_t L = 64;
    printf("[Order of growth] deepen book: grow resting orders N, fixed L=%llu price levels\n",
           (unsigned long long)L);
    printf("       N          insert(ns)   cancel(ns)   top-of-book(ns)\n");
    for (uint64_t N : {1000ull, 4000ull, 16000ull, 64000ull, 256000ull, 1000000ull, 4000000ull}) {
        Row x = measure(N, L, 1);
        printf("  %10llu     %8.1f     %8.1f     %8.2f\n",
               (unsigned long long)N, x.insert, x.cancel, x.top);
    }
}

// ---- 8. Widen the book (grow price levels L, fix N) ----------------------
static void bench_scale_levels() {
    const uint64_t N = 1'000'000;
    printf("[Order of growth] widen book: grow price levels L, fixed N=%llu orders\n",
           (unsigned long long)N);
    printf("       L      log2(L)   insert(ns)   cancel(ns)   top-of-book(ns)\n");
    for (uint64_t L : {1ull, 8ull, 64ull, 512ull, 4096ull, 32768ull, 262144ull}) {
        Row x = measure(N, L, 2);
        printf("  %8llu   %6.1f     %8.1f     %8.1f     %8.2f\n",
               (unsigned long long)L, std::log2((double)L), x.insert, x.cancel, x.top);
    }
}

// ---- CSV emitters for plotting (averaged over reps) ----------------------
static void csv_depth(int reps) {
    const uint64_t L = 64;
    printf("N,insert_ns,cancel_ns,top_ns\n");
    for (uint64_t N : {1000ull, 2000ull, 4000ull, 8000ull, 16000ull, 32000ull,
                       64000ull, 128000ull, 256000ull, 512000ull, 1000000ull,
                       2000000ull, 4000000ull, 8000000ull}) {
        Row x = measure_avg(N, L, reps);
        printf("%llu,%.3f,%.3f,%.4f\n", (unsigned long long)N, x.insert, x.cancel, x.top);
    }
}

static void csv_levels(int reps) {
    const uint64_t N = 1'000'000;
    printf("L,log2L,insert_ns,cancel_ns,top_ns\n");
    for (uint64_t L : {1ull, 4ull, 16ull, 64ull, 256ull, 1024ull, 4096ull,
                       16384ull, 65536ull, 262144ull, 1048576ull}) {
        Row x = measure_avg(N, L, reps);
        printf("%llu,%.4f,%.3f,%.3f,%.4f\n", (unsigned long long)L,
               std::log2((double)L), x.insert, x.cancel, x.top);
    }
}

int main(int argc, char** argv) {
    std::string which = (argc > 1) ? argv[1] : "all";
    if (which == "all")
        printf("== Bubbles engine microbenchmark (single symbol, one shard) ==\n\n");
    if (which == "all" || which == "insert") bench_insert(2'000'000, 200);
    if (which == "all" || which == "cancel") bench_cancel(2'000'000);
    if (which == "all" || which == "top")    bench_topofbook(20'000'000);
    if (which == "all" || which == "match")  bench_match(2'000'000);
    if (which == "all" || which == "spsc")   bench_spsc(20'000'000);
    if (which == "all" || which == "mpsc")   bench_mpsc(5'000'000, 4);
    if (which == "all") printf("\n");
    if (which == "all" || which == "scale")  bench_scale_depth();
    if (which == "all") printf("\n");
    if (which == "all" || which == "levels") bench_scale_levels();
    // Machine-readable output for plotting (averaged); not part of "all".
    if (which == "csv-depth")  csv_depth(argc > 2 ? atoi(argv[2]) : 5);
    if (which == "csv-levels") csv_levels(argc > 2 ? atoi(argv[2]) : 5);
    return 0;
}
