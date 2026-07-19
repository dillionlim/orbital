// Per-operation IPC / latency probe for the matching hot path.
//
// Unlike engine_bench (which runs every benchmark in one process), this wraps
// ONLY the measured loop of each operation in hardware perf counters via
// perf_event_open, so the reported instructions-per-cycle belong to that
// operation alone — not to the book build-up or teardown around it.
//
// Needs kernel.perf_event_paranoid <= 2 (self-monitoring, user-space only).
// Build: g++ -O3 -std=c++20 -march=native -Isrc -Iinclude \
//            bench/ipc_bench.cpp src/book/order_book.cpp -o ipc_bench -pthread
#include <linux/perf_event.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

#include "book/order_book.hpp"

using namespace TradingSystem;
using Clock = std::chrono::steady_clock;

// ---- minimal perf_event_open wrapper ------------------------------------
namespace {

struct Counter {
    int fd = -1;
    void open(uint64_t config) {
        perf_event_attr attr{};
        attr.size = sizeof(attr);
        attr.type = PERF_TYPE_HARDWARE;
        attr.config = config;
        attr.disabled = 1;
        attr.exclude_kernel = 1;  // user-space only -> works at paranoid<=2
        attr.exclude_hv = 1;
        fd = static_cast<int>(syscall(__NR_perf_event_open, &attr, 0, -1, -1, 0));
    }
    bool ok() const { return fd >= 0; }
    void start() { ioctl(fd, PERF_EVENT_IOC_RESET, 0); ioctl(fd, PERF_EVENT_IOC_ENABLE, 0); }
    void stop() { ioctl(fd, PERF_EVENT_IOC_DISABLE, 0); }
    uint64_t value() { uint64_t v = 0; ssize_t n = read(fd, &v, sizeof(v)); (void)n; return v; }
};

// Counts instructions, cycles, branches and branch-misses across a code region
// and reports IPC + branch-misprediction rate.
struct Region {
    Counter ins, cyc, br, brm;
    bool have = false;
    Region() {
        cyc.open(PERF_COUNT_HW_CPU_CYCLES);
        ins.open(PERF_COUNT_HW_INSTRUCTIONS);
        br.open(PERF_COUNT_HW_BRANCH_INSTRUCTIONS);
        brm.open(PERF_COUNT_HW_BRANCH_MISSES);
        have = cyc.ok() && ins.ok() && br.ok() && brm.ok();
    }
    void start() { if (have) { cyc.start(); ins.start(); br.start(); brm.start(); } }
    void stop() { if (have) { brm.stop(); br.stop(); ins.stop(); cyc.stop(); } }
    void report(const char* name, double ns_per_op, double mops, uint64_t ops) {
        if (have) {
            uint64_t i = ins.value(), c = cyc.value(), b = br.value(), m = brm.value();
            double ipc = c ? static_cast<double>(i) / static_cast<double>(c) : 0.0;
            double ipo = static_cast<double>(i) / static_cast<double>(ops);
            double bmiss = b ? 100.0 * static_cast<double>(m) / static_cast<double>(b) : 0.0;
            printf("  %-14s %8.1f ns/op   %6.2f M/s   IPC %.2f   %.0f instr/op   br-miss %.2f%%\n",
                   name, ns_per_op, mops, ipc, ipo, bmiss);
        } else {
            printf("  %-14s %8.1f ns/op   %6.2f M/s   IPC   n/a   (perf_event_open denied)\n",
                   name, ns_per_op, mops);
        }
    }
};

OrderInput mk(OrderId id, OrderSide side, OrderType type, Price px, Quantity qty,
              std::string_view user) {
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

double ns_per(std::chrono::nanoseconds d, uint64_t n) {
    return static_cast<double>(d.count()) / static_cast<double>(n);
}
double mops(uint64_t n, std::chrono::nanoseconds d) {
    return static_cast<double>(n) / (static_cast<double>(d.count()) / 1e9) / 1e6;
}

}  // namespace

// ---- insert: 2M resting limits across 200 levels ------------------------
static void probe_insert(Region& r, uint64_t N) {
    OrderBook book(1);
    std::mt19937_64 rng(42);
    std::uniform_int_distribution<int> lvl(0, 199);
    r.start();
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) {
        bool buy = (i & 1);
        Price px = buy ? (1000.0 - lvl(rng)) : (2000.0 + lvl(rng));
        auto res = book.apply(mk(i + 1, buy ? OrderSide::Buy : OrderSide::Sell,
                                 OrderType::Limit, px, 10, "u"));
        (void)res;
    }
    auto dt = Clock::now() - t0;
    r.stop();
    r.report("insert", ns_per(dt, N), mops(N, dt), N);
}

// ---- cancel: build 2M, then count only the cancel sweep -----------------
static void probe_cancel(Region& r, uint64_t N) {
    OrderBook book(1);
    std::vector<OrderId> ids;
    ids.reserve(N);
    std::mt19937_64 rng(7);
    std::uniform_int_distribution<int> lvl(0, 199);
    for (uint64_t i = 0; i < N; ++i) {
        bool buy = (i & 1);
        Price px = buy ? (1000.0 - lvl(rng)) : (2000.0 + lvl(rng));
        auto res = book.apply(mk(i + 1, buy ? OrderSide::Buy : OrderSide::Sell,
                                 OrderType::Limit, px, 10, "u"));
        (void)res;
        ids.push_back(i + 1);
    }
    std::shuffle(ids.begin(), ids.end(), rng);
    r.start();
    auto t0 = Clock::now();
    for (OrderId id : ids) { auto c = book.cancel(id, "u"); (void)c; }
    auto dt = Clock::now() - t0;
    r.stop();
    r.report("cancel", ns_per(dt, N), mops(N, dt), N);
}

// ---- match: shallow refilled wall, mirroring engine_bench's bench_match --
// The book is kept shallow (~2000 makers, topped up when it drains below 100),
// exactly as engine_bench measures it; the occasional refill is inside the
// counted region and amortises away, matching the reported match latency.
static void probe_match(Region& r, uint64_t N) {
    OrderBook book(1);
    OrderId next = 1;
    auto refill = [&](int count) {
        for (int i = 0; i < count; ++i) {
            auto res = book.apply(mk(next++, OrderSide::Sell, OrderType::Limit,
                                     1500.0 + (i % 50), 10, "maker"));
            (void)res;
        }
    };
    refill(2000);
    uint64_t fills = 0;
    r.start();
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) {
        if (book.open_orders() < 100) refill(2000);
        auto res = book.apply(mk(next++, OrderSide::Buy, OrderType::Market, 0, 10, "taker"));
        fills += res.fills.size();
    }
    auto dt = Clock::now() - t0;
    r.stop();
    r.report("match", ns_per(dt, N), mops(N, dt), N);
    (void)fills;
}

// ---- top-of-book: best_bid + best_ask reads over a 200-level book --------
static void probe_top(Region& r, uint64_t N) {
    OrderBook book(1);
    for (int i = 0; i < 200; ++i) {
        auto a = book.apply(mk(2 * i + 1, OrderSide::Buy, OrderType::Limit, 1000.0 - i, 10, "u"));
        auto b = book.apply(mk(2 * i + 2, OrderSide::Sell, OrderType::Limit, 2000.0 + i, 10, "u"));
        (void)a; (void)b;
    }
    volatile double sink = 0;
    r.start();
    auto t0 = Clock::now();
    for (uint64_t i = 0; i < N; ++i) sink += book.best_bid() + book.best_ask();
    auto dt = Clock::now() - t0;
    r.stop();
    (void)sink;
    r.report("top-of-book", ns_per(dt, 2 * N), mops(2 * N, dt), 2 * N);
}

int main() {
    const uint64_t N = 2'000'000;
    printf("== per-operation IPC probe (N=%llu, user-space counters) ==\n",
           (unsigned long long)N);
    { Region r; probe_top(r, 50'000'000); }
    { Region r; probe_insert(r, N); }
    { Region r; probe_match(r, N); }
    { Region r; probe_cancel(r, N); }
    return 0;
}
