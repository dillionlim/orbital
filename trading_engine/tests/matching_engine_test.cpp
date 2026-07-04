#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "engine/event_bus.hpp"
#include "engine/matching_engine.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_eq(auto actual, auto expected, const std::string& message) {
    if (!(actual == expected)) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

class EventCollector {
public:
    explicit EventCollector(EventBus& bus) {
        sub_ = bus.subscribe([this](const OutboundEvent& event) {
            {
                std::lock_guard<std::mutex> lock(mu_);
                events_.push_back(event);
            }
            cv_.notify_all();
        });
    }

    template <typename Predicate>
    bool wait_until(Predicate predicate,
                    std::chrono::milliseconds timeout = std::chrono::seconds(2)) {
        std::unique_lock<std::mutex> lock(mu_);
        return cv_.wait_for(lock, timeout, [&] { return predicate(events_); });
    }

private:
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::vector<OutboundEvent> events_;
    EventBus::SubscriberId sub_ = 0;
};

PlaceOrderCmd place(OrderId id, OrderSide side, OrderType type, Quantity quantity,
                    Price price, std::string user, std::string client = "") {
    PlaceOrderCmd cmd;
    cmd.assigned_id = id;
    cmd.symbol = 7;
    cmd.side = side;
    cmd.type = type;
    cmd.quantity = quantity;
    cmd.limit_price = price;
    cmd.user_id = std::move(user);
    cmd.client_id = std::move(client);
    cmd.session_id = id + 1000;
    return cmd;
}

bool has_initial_snapshot(const std::vector<OutboundEvent>& events) {
    for (const auto& event : events) {
        if (const auto* delta = std::get_if<BookDelta>(&event)) {
            if (delta->symbol == 7 && delta->snapshot && delta->seq == 1) {
                return true;
            }
        }
    }
    return false;
}

bool has_reject(const std::vector<OutboundEvent>& events, OrderId id,
                const std::string& reason) {
    for (const auto& event : events) {
        if (const auto* report = std::get_if<ExecutionReport>(&event)) {
            if (report->order_id == id &&
                report->kind == ExecutionReport::Kind::Reject &&
                report->reason == reason) {
                return true;
            }
        }
    }
    return false;
}

bool has_trade_print(const std::vector<OutboundEvent>& events, uint64_t trade_id,
                     Price price, Quantity quantity) {
    for (const auto& event : events) {
        if (const auto* trade = std::get_if<TradePrint>(&event)) {
            if (trade->trade_id == trade_id && trade->symbol == 7 &&
                trade->price == price && trade->quantity == quantity) {
                return true;
            }
        }
    }
    return false;
}

bool has_fill_report(const std::vector<OutboundEvent>& events, OrderId id,
                     Quantity last_quantity, Quantity remaining,
                     OrderStatus status) {
    for (const auto& event : events) {
        if (const auto* report = std::get_if<ExecutionReport>(&event)) {
            if (report->order_id == id &&
                report->kind == ExecutionReport::Kind::Fill &&
                report->last_quantity == last_quantity &&
                report->remaining == remaining &&
                report->status == status) {
                return true;
            }
        }
    }
    return false;
}

bool has_ask_delta(const std::vector<OutboundEvent>& events, Price price, Quantity qty) {
    for (const auto& event : events) {
        if (const auto* delta = std::get_if<BookDelta>(&event)) {
            for (const auto& ask : delta->ask_changes) {
                if (ask.price == price && ask.qty == qty) return true;
            }
        }
    }
    return false;
}

// Confirms shard startup publishes a baseline book snapshot.
void publishes_initial_snapshot_on_start() {
    EventBus bus;
    EventCollector events{bus};
    std::atomic<uint64_t> trade_ids{1};
    MatchingEngine engine{7, bus, trade_ids};

    engine.start();
    require(events.wait_until(has_initial_snapshot), "initial book snapshot should publish");
    engine.stop();
}

// Verifies empty-book market orders emit a reject report.
void rejects_market_order_when_book_is_empty() {
    EventBus bus;
    EventCollector events{bus};
    std::atomic<uint64_t> trade_ids{1};
    MatchingEngine engine{7, bus, trade_ids};
    engine.start();

    require(engine.submit(InboundCmd{place(1, OrderSide::Buy, OrderType::Market, 1, 0.0, "taker")}),
            "market command should enqueue");
    require(events.wait_until([](const auto& snapshot) {
        return has_reject(snapshot, 1, "no_liquidity");
    }), "empty market order should reject");

    engine.stop();
}

// Checks a match emits reports, trade tape, and residual book delta.
void emits_ack_fills_trade_print_and_book_delta_for_a_match() {
    EventBus bus;
    EventCollector events{bus};
    std::atomic<uint64_t> trade_ids{100};
    MatchingEngine engine{7, bus, trade_ids};
    engine.start();

    require(engine.submit(InboundCmd{place(10, OrderSide::Sell, OrderType::Limit, 10, 105.0,
                                         "maker", "maker_bot")}),
            "maker order should enqueue");
    require(events.wait_until([](const auto& snapshot) {
        return has_ask_delta(snapshot, 105.0, 10);
    }), "maker ask should publish to the book");

    require(engine.submit(InboundCmd{place(11, OrderSide::Buy, OrderType::Market, 4, 0.0,
                                         "taker", "taker_bot")}),
            "taker order should enqueue");
    require(events.wait_until([](const auto& snapshot) {
        return has_trade_print(snapshot, 100, 105.0, 4) &&
               has_fill_report(snapshot, 11, 4, 0, OrderStatus::Filled) &&
               has_fill_report(snapshot, 10, 4, 6, OrderStatus::PartiallyFilled) &&
               has_ask_delta(snapshot, 105.0, 6);
    }), "match should publish fills, trade print, and residual book delta");

    require_eq(trade_ids.load(), static_cast<uint64_t>(101),
               "trade id counter should advance after one print");

    engine.stop();
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"publishes_initial_snapshot_on_start", publishes_initial_snapshot_on_start},
        {"rejects_market_order_when_book_is_empty", rejects_market_order_when_book_is_empty},
        {"emits_ack_fills_trade_print_and_book_delta_for_a_match",
         emits_ack_fills_trade_print_and_book_delta_for_a_match},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "matching_engine_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown matching engine test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
