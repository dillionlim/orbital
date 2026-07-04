#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
#include <utility>

#include "book/order_book.hpp"

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

void require_price(Price actual, Price expected, const std::string& message) {
    if (std::fabs(actual - expected) > 0.000001) {
        std::cerr << "FAILED: " << message << " (expected " << expected
                  << ", got " << actual << ")\n";
        std::exit(1);
    }
}

std::unique_ptr<Order> order(OrderId id, OrderSide side, OrderType type,
                             Quantity quantity, Price price,
                             std::string user = "user") {
    auto o = std::make_unique<Order>();
    o->id = id;
    o->symbol = 42;
    o->side = side;
    o->type = type;
    o->quantity = quantity;
    o->limit_price = price;
    o->user_id = std::move(user);
    return o;
}

// Checks resting bids are aggregated and sorted by best price first.
void rests_limit_orders_by_price_priority() {
    OrderBook book{42};

    auto first = book.apply(order(1, OrderSide::Buy, OrderType::Limit, 5, 100.0));
    auto second = book.apply(order(2, OrderSide::Buy, OrderType::Limit, 3, 101.0));

    require_eq(first.status, OrderStatus::Pending, "first bid should rest");
    require_eq(second.status, OrderStatus::Pending, "second bid should rest");
    require_eq(book.open_orders(), static_cast<size_t>(2), "two orders should rest");
    require_price(book.best_bid(), 101.0, "highest bid should be best bid");

    auto bids = book.top_n_bids(2);
    require_eq(bids.size(), static_cast<size_t>(2), "two bid levels should be visible");
    require_price(bids[0].price, 101.0, "best bid level price");
    require_eq(bids[0].qty, static_cast<Quantity>(3), "best bid level quantity");
    require_price(bids[1].price, 100.0, "second bid level price");
    require_eq(bids[1].qty, static_cast<Quantity>(5), "second bid level quantity");
}

// Verifies a crossing taker fills at the resting maker price.
void matches_crossing_order_at_maker_price() {
    OrderBook book{42};
    auto maker = book.apply(order(10, OrderSide::Sell, OrderType::Limit, 10, 105.0, "maker"));
    require_eq(maker.status, OrderStatus::Pending, "maker ask should rest before crossing");

    auto result = book.apply(order(11, OrderSide::Buy, OrderType::Limit, 4, 110.0, "taker"));

    require_eq(result.status, OrderStatus::Filled, "crossing taker should fill");
    require_eq(result.filled_total, static_cast<Quantity>(4), "filled total");
    require_price(result.avg_price, 105.0, "fills should use maker price");
    require_eq(result.fills.size(), static_cast<size_t>(1), "one fill should be reported");
    require_eq(result.fills[0].maker_order_id, static_cast<OrderId>(10), "maker order id");
    require_eq(result.fills[0].maker_remaining, static_cast<Quantity>(6), "maker residual");

    auto asks = book.top_n_asks(1);
    require_eq(asks.size(), static_cast<size_t>(1), "residual maker ask should remain");
    require_price(asks[0].price, 105.0, "ask price");
    require_eq(asks[0].qty, static_cast<Quantity>(6), "ask residual quantity");
}

// Covers the no-liquidity rejection path for market orders.
void rejects_market_order_without_liquidity() {
    OrderBook book{42};

    auto result = book.apply(order(20, OrderSide::Buy, OrderType::Market, 1, 0.0));

    require_eq(result.status, OrderStatus::Rejected, "empty market order should reject");
    require(result.reject_reason == "no_liquidity", "reject reason should be no_liquidity");
    require_eq(book.open_orders(), static_cast<size_t>(0), "market reject should not rest");
}

// Ensures user-scoped cancels cannot remove another user's order.
void enforces_cancel_ownership() {
    OrderBook book{42};
    auto resting = book.apply(order(30, OrderSide::Sell, OrderType::Limit, 7, 120.0, "owner"));
    require_eq(resting.status, OrderStatus::Pending, "order should rest before cancel tests");

    auto wrong = book.cancel(30, "intruder");
    require(!wrong.ok, "wrong owner cancel should fail");
    require(wrong.reason == "owner_mismatch", "wrong owner reason");
    require_eq(book.open_orders(), static_cast<size_t>(1), "failed cancel should keep order");

    auto ok = book.cancel(30, "owner");
    require(ok.ok, "owner cancel should succeed");
    require_eq(ok.remaining, static_cast<Quantity>(7), "cancel remaining quantity");
    require_eq(book.open_orders(), static_cast<size_t>(0), "successful cancel removes order");
}

// Checks self-trade prevention cancels the maker and rests the taker.
void cancels_resting_self_trade_and_keeps_incoming_remainder() {
    OrderBook book{42};
    auto resting = book.apply(order(40, OrderSide::Sell, OrderType::Limit, 5, 100.0, "same_user"));
    require_eq(resting.status, OrderStatus::Pending, "same-user ask should rest before STP");

    auto result = book.apply(order(41, OrderSide::Buy, OrderType::Limit, 5, 105.0, "same_user"));

    require_eq(result.stp_cancels.size(), static_cast<size_t>(1), "self-trade prevention cancel");
    require_eq(result.stp_cancels[0].order_id, static_cast<OrderId>(40), "cancelled maker id");
    require_eq(result.status, OrderStatus::Pending, "incoming order should rest after STP");
    require_eq(result.fills.size(), static_cast<size_t>(0), "self-trade should not fill");
    require_price(book.best_ask(), 0.0, "resting ask should be removed");
    require_price(book.best_bid(), 105.0, "incoming bid should rest");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"rests_limit_orders_by_price_priority", rests_limit_orders_by_price_priority},
        {"matches_crossing_order_at_maker_price", matches_crossing_order_at_maker_price},
        {"rejects_market_order_without_liquidity", rejects_market_order_without_liquidity},
        {"enforces_cancel_ownership", enforces_cancel_ownership},
        {"cancels_resting_self_trade_and_keeps_incoming_remainder",
         cancels_resting_self_trade_and_keeps_incoming_remainder},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "order_book_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown order book test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
