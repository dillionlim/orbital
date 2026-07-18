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

// `user` is bound to a string literal at every call site (static storage), so
// the OrderInput's user_id view stays valid through apply().
OrderInput order(OrderId id, OrderSide side, OrderType type,
                 Quantity quantity, Price price,
                 std::string_view user = "user") {
    OrderInput in;
    in.id = id;
    in.symbol = 42;
    in.side = side;
    in.type = type;
    in.quantity = quantity;
    in.limit_price = price;
    in.user_id = user;
    return in;
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

// Two makers resting at one price fill in arrival order (price-time priority),
// and the level aggregates their quantities.
void fills_same_price_level_in_arrival_order() {
    OrderBook book{42};
    auto early = book.apply(order(50, OrderSide::Sell, OrderType::Limit, 4, 100.0, "maker_early"));
    auto late = book.apply(order(51, OrderSide::Sell, OrderType::Limit, 6, 100.0, "maker_late"));
    require_eq(early.status, OrderStatus::Pending, "early maker should rest");
    require_eq(late.status, OrderStatus::Pending, "late maker should rest");

    auto level = book.top_n_asks(1);
    require_eq(level.size(), static_cast<size_t>(1), "both makers share one level");
    require_eq(level[0].qty, static_cast<Quantity>(10), "level aggregate_qty sums both makers");

    auto result = book.apply(order(52, OrderSide::Buy, OrderType::Limit, 5, 100.0, "taker"));

    require_eq(result.status, OrderStatus::Filled, "taker should fill across both makers");
    require_eq(result.fills.size(), static_cast<size_t>(2), "two fills at one level");
    require_eq(result.fills[0].maker_order_id, static_cast<OrderId>(50),
               "earliest maker fills first");
    require_eq(result.fills[0].quantity, static_cast<Quantity>(4), "earliest maker fills fully");
    require_eq(result.fills[0].maker_remaining, static_cast<Quantity>(0), "earliest maker exhausted");
    require_eq(result.fills[1].maker_order_id, static_cast<OrderId>(51),
               "later maker fills second");
    require_eq(result.fills[1].quantity, static_cast<Quantity>(1), "later maker fills the remainder");
    require_eq(result.fills[1].maker_remaining, static_cast<Quantity>(5), "later maker residual");
    require_price(result.avg_price, 100.0, "single-price sweep averages to the level price");

    auto after = book.top_n_asks(1);
    require_eq(after.size(), static_cast<size_t>(1), "level survives with the residual maker");
    require_eq(after[0].qty, static_cast<Quantity>(5), "level aggregate_qty net of the fills");
    require_eq(book.open_orders(), static_cast<size_t>(1), "only the residual maker is open");
}

// A taker sweeping several levels erases the exhausted ones and reports a
// volume-weighted average price across them.
void sweeps_multiple_price_levels_with_volume_weighted_average() {
    OrderBook book{42};
    auto a = book.apply(order(60, OrderSide::Sell, OrderType::Limit, 2, 100.0, "maker_a"));
    auto b = book.apply(order(61, OrderSide::Sell, OrderType::Limit, 3, 101.0, "maker_b"));
    auto c = book.apply(order(62, OrderSide::Sell, OrderType::Limit, 10, 102.0, "maker_c"));
    require_eq(a.status, OrderStatus::Pending, "first ask should rest");
    require_eq(b.status, OrderStatus::Pending, "second ask should rest");
    require_eq(c.status, OrderStatus::Pending, "third ask should rest");
    require_eq(book.top_n_asks(5).size(), static_cast<size_t>(3), "three ask levels before sweep");

    auto result = book.apply(order(63, OrderSide::Buy, OrderType::Limit, 8, 102.0, "taker"));

    require_eq(result.status, OrderStatus::Filled, "sweeping taker should fill");
    require_eq(result.filled_total, static_cast<Quantity>(8), "sweep filled total");
    require_eq(result.fills.size(), static_cast<size_t>(3), "one fill per level touched");
    require_price(result.fills[0].price, 100.0, "first level fills at 100");
    require_eq(result.fills[0].quantity, static_cast<Quantity>(2), "first level quantity");
    require_price(result.fills[1].price, 101.0, "second level fills at 101");
    require_eq(result.fills[1].quantity, static_cast<Quantity>(3), "second level quantity");
    require_price(result.fills[2].price, 102.0, "third level fills at 102");
    require_eq(result.fills[2].quantity, static_cast<Quantity>(3), "third level quantity");

    // (2*100 + 3*101 + 3*102) / 8 = 809 / 8 = 101.125
    require_price(result.avg_price, 101.125, "avg_price should be volume weighted across levels");

    auto asks = book.top_n_asks(5);
    require_eq(asks.size(), static_cast<size_t>(1), "exhausted levels should be erased");
    require_price(asks[0].price, 102.0, "only the partially consumed level remains");
    require_eq(asks[0].qty, static_cast<Quantity>(7), "residual level aggregate_qty");
    require_price(book.best_ask(), 102.0, "best ask moves up after the sweep");
    require_eq(book.open_orders(), static_cast<size_t>(1), "two makers fully filled, one residual");
}

// A limit taker that crosses only part of its size fills what it can and rests
// the remainder as PartiallyFilled.
void partially_fills_crossing_limit_and_rests_remainder() {
    OrderBook book{42};
    auto maker = book.apply(order(70, OrderSide::Sell, OrderType::Limit, 3, 100.0, "maker"));
    require_eq(maker.status, OrderStatus::Pending, "maker should rest before the cross");

    auto result = book.apply(order(71, OrderSide::Buy, OrderType::Limit, 10, 100.0, "taker"));

    require_eq(result.status, OrderStatus::PartiallyFilled,
               "partially crossed limit should report PartiallyFilled");
    require_eq(result.filled_total, static_cast<Quantity>(3), "taker fills the available size");
    require_price(result.avg_price, 100.0, "taker fills at the maker price");
    require_eq(result.fills.size(), static_cast<size_t>(1), "one fill against the lone maker");

    require_price(book.best_ask(), 0.0, "the ask side should be empty after the cross");
    auto bids = book.top_n_bids(1);
    require_eq(bids.size(), static_cast<size_t>(1), "taker remainder should rest as a bid");
    require_price(bids[0].price, 100.0, "remainder rests at its limit price");
    require_eq(bids[0].qty, static_cast<Quantity>(7), "remainder quantity rests on the level");
    require_eq(book.open_orders(), static_cast<size_t>(1), "only the taker remainder is open");
}

// Cancelling a partially-filled resting order must subtract only its remaining
// quantity from the level aggregate, not its original size.
void cancels_partially_filled_resting_order_and_keeps_level_qty_honest() {
    OrderBook book{42};
    auto big = book.apply(order(80, OrderSide::Sell, OrderType::Limit, 10, 100.0, "maker_big"));
    auto small = book.apply(order(81, OrderSide::Sell, OrderType::Limit, 5, 100.0, "maker_small"));
    require_eq(big.status, OrderStatus::Pending, "big maker should rest");
    require_eq(small.status, OrderStatus::Pending, "small maker should rest");
    require_eq(book.top_n_asks(1)[0].qty, static_cast<Quantity>(15), "level starts at 15");

    auto taker = book.apply(order(82, OrderSide::Buy, OrderType::Limit, 4, 100.0, "taker"));
    require_eq(taker.status, OrderStatus::Filled, "taker should fill against the front maker");
    require_eq(book.top_n_asks(1)[0].qty, static_cast<Quantity>(11), "level nets the 4 filled");

    auto cancelled = book.cancel(80, "maker_big");
    require(cancelled.ok, "partially filled maker should cancel");
    require_eq(cancelled.remaining, static_cast<Quantity>(6),
               "cancel reports the outstanding remainder, not the original qty");

    auto asks = book.top_n_asks(1);
    require_eq(asks.size(), static_cast<size_t>(1), "the untouched maker keeps the level alive");
    require_eq(asks[0].qty, static_cast<Quantity>(5),
               "level aggregate_qty must drop by remaining(), not the original quantity");
    require_eq(book.open_orders(), static_cast<size_t>(1), "only the untouched maker is open");
}

// Cancelling an id the book has never seen is reported as not_found.
void rejects_cancel_of_unknown_order() {
    OrderBook book{42};

    auto missing = book.cancel(999, "anyone");
    require(!missing.ok, "unknown cancel should fail");
    require(missing.reason == "not_found", "unknown cancel reason should be not_found");
    require_eq(missing.order_id, static_cast<OrderId>(999), "outcome echoes the requested id");

    auto resting = book.apply(order(90, OrderSide::Buy, OrderType::Limit, 2, 100.0, "owner"));
    require_eq(resting.status, OrderStatus::Pending, "order should rest");
    auto twice = book.cancel(90, "owner");
    require(twice.ok, "first cancel should succeed");
    auto again = book.cancel(90, "owner");
    require(!again.ok, "double cancel should fail");
    require(again.reason == "not_found", "double cancel reason should be not_found");
}

// An empty user_id_must_match is the admin/internal path: it skips owner checks.
void allows_internal_cancel_to_bypass_owner_check() {
    OrderBook book{42};
    auto resting = book.apply(order(100, OrderSide::Sell, OrderType::Limit, 8, 130.0, "owner"));
    require_eq(resting.status, OrderStatus::Pending, "order should rest before the admin cancel");

    auto admin = book.cancel(100, "");
    require(admin.ok, "empty user_id_must_match should bypass the owner check");
    require(admin.reason.empty(), "successful cancel carries no reason");
    require(admin.user_id == "owner", "outcome should carry the true owner");
    require_eq(admin.remaining, static_cast<Quantity>(8), "admin cancel remaining quantity");
    require_eq(book.open_orders(), static_cast<size_t>(0), "admin cancel removes the order");
    require_price(book.best_ask(), 0.0, "emptied level should be erased");
}

// Self-trade prevention drains every same-user maker sitting at a level.
void cancels_every_same_user_maker_at_a_level() {
    OrderBook book{42};
    auto first = book.apply(order(110, OrderSide::Sell, OrderType::Limit, 3, 100.0, "same_user"));
    auto second = book.apply(order(111, OrderSide::Sell, OrderType::Limit, 4, 100.0, "same_user"));
    require_eq(first.status, OrderStatus::Pending, "first same-user ask should rest");
    require_eq(second.status, OrderStatus::Pending, "second same-user ask should rest");
    require_eq(book.top_n_asks(1)[0].qty, static_cast<Quantity>(7), "both makers aggregate");

    auto result = book.apply(order(112, OrderSide::Buy, OrderType::Limit, 5, 105.0, "same_user"));

    require_eq(result.stp_cancels.size(), static_cast<size_t>(2),
               "both same-user makers should be cancelled");
    require_eq(result.stp_cancels[0].order_id, static_cast<OrderId>(110), "first STP cancel id");
    require_eq(result.stp_cancels[0].remaining, static_cast<Quantity>(3), "first STP remaining");
    require(result.stp_cancels[0].reason == "self_trade_prevention", "STP cancel reason");
    require_eq(result.stp_cancels[1].order_id, static_cast<OrderId>(111), "second STP cancel id");
    require_eq(result.stp_cancels[1].remaining, static_cast<Quantity>(4), "second STP remaining");
    require_eq(result.fills.size(), static_cast<size_t>(0), "self-trade should not fill");
    require_eq(result.status, OrderStatus::Pending, "incoming order rests after draining the level");
    require_price(book.best_ask(), 0.0, "the drained ask level should be erased");
    require_price(book.best_bid(), 105.0, "incoming bid rests");
    require_eq(book.open_orders(), static_cast<size_t>(1), "only the incoming order remains");
}

// A level mixing a same-user maker with another user's maker: the same-user
// maker is cancelled and matching continues into the maker behind it.
void skips_same_user_maker_and_fills_other_maker_at_same_level() {
    OrderBook book{42};
    auto mine = book.apply(order(120, OrderSide::Sell, OrderType::Limit, 3, 100.0, "alice"));
    auto theirs = book.apply(order(121, OrderSide::Sell, OrderType::Limit, 5, 100.0, "bob"));
    require_eq(mine.status, OrderStatus::Pending, "same-user maker should rest at the front");
    require_eq(theirs.status, OrderStatus::Pending, "other-user maker should rest behind it");
    require_eq(book.top_n_asks(1)[0].qty, static_cast<Quantity>(8), "mixed level aggregate");

    auto result = book.apply(order(122, OrderSide::Buy, OrderType::Limit, 4, 100.0, "alice"));

    require_eq(result.stp_cancels.size(), static_cast<size_t>(1),
               "only alice's maker should be STP-cancelled");
    require_eq(result.stp_cancels[0].order_id, static_cast<OrderId>(120), "cancelled maker id");
    require_eq(result.fills.size(), static_cast<size_t>(1), "matching continues into bob's maker");
    require_eq(result.fills[0].maker_order_id, static_cast<OrderId>(121), "bob fills the taker");
    require_eq(result.fills[0].quantity, static_cast<Quantity>(4), "fill quantity");
    require_eq(result.fills[0].maker_remaining, static_cast<Quantity>(1), "bob's residual");
    require_eq(result.status, OrderStatus::Filled, "taker fills fully against bob");
    require_price(result.avg_price, 100.0, "fill at the level price");

    auto asks = book.top_n_asks(1);
    require_eq(asks.size(), static_cast<size_t>(1), "level survives on bob's residual");
    require_eq(asks[0].qty, static_cast<Quantity>(1),
               "level aggregate_qty nets both the STP cancel and the fill");
    require_eq(book.open_orders(), static_cast<size_t>(1), "only bob's residual is open");
}

// Accessors on an empty book, top_n(0), and n larger than the level count.
void handles_top_n_and_empty_book_edges() {
    OrderBook book{42};

    require_eq(book.open_orders(), static_cast<size_t>(0), "empty book has no open orders");
    require_price(book.best_bid(), 0.0, "empty book best bid is 0");
    require_price(book.best_ask(), 0.0, "empty book best ask is 0");
    require_eq(book.top_n_bids(5).size(), static_cast<size_t>(0), "empty book has no bid levels");
    require_eq(book.top_n_asks(5).size(), static_cast<size_t>(0), "empty book has no ask levels");
    require_eq(book.top_n_bids(0).size(), static_cast<size_t>(0), "top_n_bids(0) on empty book");

    auto b1 = book.apply(order(130, OrderSide::Buy, OrderType::Limit, 1, 99.0, "maker"));
    auto b2 = book.apply(order(131, OrderSide::Buy, OrderType::Limit, 2, 98.0, "maker"));
    auto a1 = book.apply(order(132, OrderSide::Sell, OrderType::Limit, 3, 101.0, "maker"));
    require_eq(b1.status, OrderStatus::Pending, "first bid rests");
    require_eq(b2.status, OrderStatus::Pending, "second bid rests");
    require_eq(a1.status, OrderStatus::Pending, "ask rests");

    require_eq(book.top_n_bids(0).size(), static_cast<size_t>(0), "top_n_bids(0) returns nothing");
    require_eq(book.top_n_asks(0).size(), static_cast<size_t>(0), "top_n_asks(0) returns nothing");

    auto bids = book.top_n_bids(50);
    require_eq(bids.size(), static_cast<size_t>(2), "n beyond the level count clamps to the book");
    require_price(bids[0].price, 99.0, "levels stay best-first when over-requested");
    require_price(bids[1].price, 98.0, "second bid level");

    auto asks = book.top_n_asks(50);
    require_eq(asks.size(), static_cast<size_t>(1), "n beyond the ask level count clamps");
    require_price(asks[0].price, 101.0, "only ask level");
    require_eq(asks[0].qty, static_cast<Quantity>(3), "only ask level quantity");
}

// A duplicate id used to free the Order while the price level still held its pointer.
// The book must reject the duplicate and leave the original intact.
void rejects_duplicate_order_id_without_corrupting_the_level() {
    OrderBook book(1);

    auto first = book.apply(order(200, OrderSide::Buy, OrderType::Limit, 5, 100.0, "maker"));
    require_eq(first.status, OrderStatus::Pending, "original order rests");

    auto dup = book.apply(order(200, OrderSide::Buy, OrderType::Limit, 7, 100.0, "other"));
    require_eq(dup.status, OrderStatus::Rejected, "duplicate id is rejected");
    require_eq(dup.reject_reason, std::string("duplicate_order_id"), "duplicate id reason");

    // The level must still describe only the original order.
    require_eq(book.open_orders(), static_cast<size_t>(1), "duplicate did not join the book");
    auto bids = book.top_n_bids(1);
    require_eq(bids.size(), static_cast<size_t>(1), "one bid level survives");
    require_eq(bids[0].qty, static_cast<Quantity>(5), "level qty excludes the rejected duplicate");

    // Reads through the level would touch a freed Order if the pointer had dangled;
    // cancelling walks it and must still find the original owner.
    auto cancelled = book.cancel(200, "maker");
    require(cancelled.ok, "original order is still intact and cancellable");
    require_eq(cancelled.remaining, static_cast<Quantity>(5), "original order kept its quantity");
    require_eq(book.open_orders(), static_cast<size_t>(0), "book empties cleanly");
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
        {"fills_same_price_level_in_arrival_order", fills_same_price_level_in_arrival_order},
        {"sweeps_multiple_price_levels_with_volume_weighted_average",
         sweeps_multiple_price_levels_with_volume_weighted_average},
        {"partially_fills_crossing_limit_and_rests_remainder",
         partially_fills_crossing_limit_and_rests_remainder},
        {"cancels_partially_filled_resting_order_and_keeps_level_qty_honest",
         cancels_partially_filled_resting_order_and_keeps_level_qty_honest},
        {"rejects_cancel_of_unknown_order", rejects_cancel_of_unknown_order},
        {"allows_internal_cancel_to_bypass_owner_check",
         allows_internal_cancel_to_bypass_owner_check},
        {"cancels_every_same_user_maker_at_a_level", cancels_every_same_user_maker_at_a_level},
        {"skips_same_user_maker_and_fills_other_maker_at_same_level",
         skips_same_user_maker_and_fills_other_maker_at_same_level},
        {"handles_top_n_and_empty_book_edges", handles_top_n_and_empty_book_edges},
        {"rejects_duplicate_order_id_without_corrupting_the_level",
         rejects_duplicate_order_id_without_corrupting_the_level},
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
