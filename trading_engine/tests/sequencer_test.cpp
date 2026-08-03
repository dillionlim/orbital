#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"

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

PlaceOrderCmd place(OrderSide side, OrderType type, Quantity qty, Price price,
                    std::string user) {
    PlaceOrderCmd cmd;
    cmd.symbol = 1;
    cmd.side = side;
    cmd.type = type;
    cmd.quantity = qty;
    cmd.limit_price = price;
    cmd.user_id = std::move(user);
    cmd.session_id = 5;
    return cmd;
}

// The shards run on their own threads, so routing-map bookkeeping settles
// asynchronously.
bool eventually(Sequencer& seq, size_t expected,
                std::chrono::milliseconds timeout = std::chrono::seconds(2)) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (seq.routable_orders() == expected) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return seq.routable_orders() == expected;
}

// A resting order stays routable, and stops being routable the moment it is
// cancelled. Without the reap the entry survived for the life of the process.
void drops_routing_entries_once_an_order_is_cancelled() {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    Sequencer seq{bus, one_symbol_registry()};
    seq.start_shards(trade_ids);

    const OrderId id = seq.submit_place(place(OrderSide::Buy, OrderType::Limit, 5, 99.0, "u1"));
    require(id != 0, "the place should be accepted");
    require(seq.routable_orders() == 1, "a live order is routable for cancel");

    CancelOrderCmd cancel;
    cancel.order_id = id;
    cancel.user_id = "u1";
    require(seq.submit_cancel(cancel), "cancel should route to the shard");
    require(eventually(seq, 0), "a cancelled order should stop being routable");

    seq.stop_shards();
}

// Same for an order that ends its life by filling rather than by cancel.
void drops_routing_entries_once_an_order_is_filled() {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    Sequencer seq{bus, one_symbol_registry()};
    seq.start_shards(trade_ids);

    require(seq.submit_place(place(OrderSide::Sell, OrderType::Limit, 5, 99.0, "maker")) != 0,
            "maker should be accepted");
    require(eventually(seq, 1), "the resting maker is routable");

    // A different user lifts the whole offer: both orders end up terminal.
    require(seq.submit_place(place(OrderSide::Buy, OrderType::Limit, 5, 99.0, "taker")) != 0,
            "taker should be accepted");
    require(eventually(seq, 0), "fully filled orders should stop being routable");

    seq.stop_shards();
}

// A rejected place must not leave a routing entry behind either.
void keeps_no_routing_entry_for_a_rejected_place() {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    Sequencer seq{bus, one_symbol_registry()};
    seq.start_shards(trade_ids);

    PlaceOrderCmd unknown = place(OrderSide::Buy, OrderType::Limit, 5, 99.0, "u1");
    unknown.symbol = 999;  // no such shard
    require(seq.submit_place(unknown) == 0, "an unknown symbol should be refused");
    require(seq.routable_orders() == 0, "a refused place should not be routable");

    // A market order into an empty book is rejected by the shard, not up front.
    require(seq.submit_place(place(OrderSide::Buy, OrderType::Market, 5, 0.0, "u1")) != 0,
            "the market order is accepted for routing before the book sees it");
    require(eventually(seq, 0), "a shard-rejected order should stop being routable");

    seq.stop_shards();
}

// The reaper subscribes to the same bus the Sequencer publishes its own rejects
// on, so publish() re-enters the Sequencer on the caller's thread. Cancelling an
// unknown id takes that path; it must not deadlock against the routing lock.
void rejects_an_unknown_cancel_without_deadlocking() {
    EventBus bus;
    std::atomic<uint64_t> trade_ids{1};
    Sequencer seq{bus, one_symbol_registry()};
    seq.start_shards(trade_ids);

    CancelOrderCmd cancel;
    cancel.order_id = 4242;
    cancel.user_id = "u1";
    require(!seq.submit_cancel(cancel), "an unknown cancel should be refused");
    require(seq.routable_orders() == 0, "and should leave the routing map empty");

    seq.stop_shards();
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"drops_routing_entries_once_an_order_is_cancelled",
         drops_routing_entries_once_an_order_is_cancelled},
        {"drops_routing_entries_once_an_order_is_filled",
         drops_routing_entries_once_an_order_is_filled},
        {"keeps_no_routing_entry_for_a_rejected_place",
         keeps_no_routing_entry_for_a_rejected_place},
        {"rejects_an_unknown_cancel_without_deadlocking",
         rejects_an_unknown_cancel_without_deadlocking},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "sequencer_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown sequencer test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
