#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"
#include "server/dispatcher.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

std::shared_ptr<SymbolRegistry> one_symbol_registry() {
    SymbolConfig sym;
    sym.name = "ES";
    sym.id = 1;
    sym.mid = 100.0;
    return std::make_shared<SymbolRegistry>(std::vector<SymbolConfig>{sym});
}

// Everything the Dispatcher needs, with no sockets: a Session whose sockfd is
// -1 has its outbound frames dropped by send_text, which is all we want here.
struct Harness {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    std::shared_ptr<SymbolRegistry> registry = one_symbol_registry();
    std::shared_ptr<SnapshotStore> snapshots = std::make_shared<SnapshotStore>();
    SessionRegistry sessions;
    ServerMetrics metrics;
    Sequencer seq{bus, registry};
    Dispatcher dispatcher{seq, bus, sessions, registry, snapshots, metrics, nullptr, nullptr};

    Harness() {
        snapshots->start(bus);
        seq.start_shards(trade_ids);
        dispatcher.start();
    }

    ~Harness() {
        dispatcher.stop();
        seq.stop_shards();
        snapshots->stop();
    }

    SessionPtr connect(const std::string& user) {
        return sessions.create(-1, "sk_live_test", user);
    }

    void place(const SessionPtr& s, const char* side, Quantity qty, Price price) {
        const std::string frame =
            std::string("{\"t\":\"place_order\",\"symbol\":\"ES\",\"side\":\"") + side +
            "\",\"type\":\"Limit\",\"quantity\":" + std::to_string(qty) +
            ",\"limit_price\":" + std::to_string(price) + "}";
        dispatcher.on_message(s, frame);
    }
};

size_t open_order_count(const SessionPtr& s) {
    std::lock_guard<std::mutex> lk(s->orders_mu);
    return s->own_orders.size();
}

template <typename Predicate>
bool eventually(Predicate predicate,
                std::chrono::milliseconds timeout = std::chrono::seconds(3)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (predicate()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return predicate();
}

// The guarantee the Dispatcher's ownership bookkeeping rests on: no event for an
// order can be observed before that order's registration hook has run. Register
// after submit_place() returns instead and a marketable order can be matched,
// reported and reaped on the shard thread first — the reap finds nothing, then
// the late write strands an entry for an order that is already dead.
void assigns_the_order_id_before_the_shard_can_report_it() {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    Sequencer seq{bus, one_symbol_registry()};

    std::mutex mu;
    std::set<OrderId> registered;
    std::atomic<int> reported_before_registration{0};

    bus.subscribe([&](const OutboundEvent& ev) {
        const auto* report = std::get_if<ExecutionReport>(&ev);
        if (report == nullptr || report->order_id == 0) return;
        std::lock_guard<std::mutex> lk(mu);
        if (registered.find(report->order_id) == registered.end()) {
            ++reported_before_registration;
        }
    });
    seq.start_shards(trade_ids);

    // Alternate resting and crossing orders so the shard is continuously busy —
    // its worker only sleeps when the queue drains, so a backlog keeps it
    // spinning on try_pop and makes the window as tight as it ever gets.
    for (int i = 0; i < 500; ++i) {
        PlaceOrderCmd cmd;
        cmd.symbol = 1;
        cmd.side = (i % 2 == 0) ? OrderSide::Sell : OrderSide::Buy;
        cmd.type = OrderType::Limit;
        cmd.quantity = 1;
        cmd.limit_price = 100.0;
        cmd.user_id = (i % 2 == 0) ? "maker_user" : "taker_user";
        seq.submit_place(std::move(cmd), [&](OrderId id) {
            std::lock_guard<std::mutex> lk(mu);
            registered.insert(id);
        });
    }

    seq.stop_shards();
    require(reported_before_registration.load() == 0,
            "no order may be reported before its registration hook has run");
}

// Orders that cross on arrival still have to be reaped from both the owner index
// and the placing session.
void reaps_orders_that_fill_immediately() {
    Harness h;
    auto maker = h.connect("maker_user");
    auto taker = h.connect("taker_user");

    for (int i = 0; i < 50; ++i) {
        h.place(maker, "Sell", 1, 100.0);
        h.place(taker, "Buy", 1, 100.0);
    }

    require(eventually([&] { return h.dispatcher.tracked_orders() == 0; }),
            "every fully filled order should be reaped from the owner index");
    require(eventually([&] { return open_order_count(maker) == 0; }),
            "the maker session should have no open orders left");
    require(eventually([&] { return open_order_count(taker) == 0; }),
            "the taker session should have no open orders left");
}

// The pause/remove path walks Session::own_orders to cancel a bot's resting
// orders. Orders that already went terminal must not still be in there.
void prunes_filled_and_cancelled_orders_from_the_session() {
    Harness h;
    auto s = h.connect("solo_user");

    // Three resting bids, well below any offer, so nothing crosses.
    h.place(s, "Buy", 1, 90.0);
    h.place(s, "Buy", 1, 91.0);
    h.place(s, "Buy", 1, 92.0);
    require(eventually([&] { return open_order_count(s) == 3; }),
            "all three resting orders should be tracked");

    // Cancel one of them by id.
    OrderId victim = 0;
    {
        std::lock_guard<std::mutex> lk(s->orders_mu);
        victim = *s->own_orders.begin();
    }
    h.dispatcher.on_message(
        s, "{\"t\":\"cancel_order\",\"order_id\":" + std::to_string(victim) + "}");

    require(eventually([&] { return open_order_count(s) == 2; }),
            "a cancelled order should be pruned from the session");
    require(eventually([&] { return h.dispatcher.tracked_orders() == 2; }),
            "and from the owner index");
}

// A resting order is genuinely outstanding and must stay tracked — the reap
// has to be precise, not merely aggressive.
void keeps_tracking_orders_that_are_still_working() {
    Harness h;
    auto s = h.connect("resting_user");

    h.place(s, "Buy", 5, 90.0);
    require(eventually([&] { return open_order_count(s) == 1; }), "the order should be tracked");

    // Nothing crosses it, so it stays working.
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(open_order_count(s) == 1, "a working order must stay in the session's set");
    require(h.dispatcher.tracked_orders() == 1, "and in the owner index");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"assigns_the_order_id_before_the_shard_can_report_it",
         assigns_the_order_id_before_the_shard_can_report_it},
        {"reaps_orders_that_fill_immediately", reaps_orders_that_fill_immediately},
        {"prunes_filled_and_cancelled_orders_from_the_session",
         prunes_filled_and_cancelled_orders_from_the_session},
        {"keeps_tracking_orders_that_are_still_working",
         keeps_tracking_orders_that_are_still_working},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "dispatcher_tests passed (" << cases.size() << " cases)\n";
        return 0;
    }

    const std::string requested = argv[1];
    for (const auto& test : cases) {
        if (requested == test.name) {
            test.run();
            std::cout << test.name << " passed\n";
            return 0;
        }
    }

    std::cerr << "Unknown dispatcher test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
