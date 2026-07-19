#pragma once
#include <string>
#include <string_view>
#include <vector>

#include "common/types.hpp"
#include "public_api.hpp"

namespace TradingSystem {

using Bubbles::OrderSide;
using Bubbles::OrderType;
using Bubbles::OrderStatus;

struct PriceLevel;

// A resting order. Instances live in OrderBook's ObjectPool and are linked into
// their PriceLevel via the intrusive prev_/next_ pointers below — there is no
// separate list node to allocate. Only fields the book needs after the order
// rests are kept; the transient taker state lives on the stack in apply().
struct Order {
    OrderId id = 0;
    SymbolId symbol = 0;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    Quantity quantity = 0;
    Quantity filled = 0;
    Price limit_price = 0.0;        // 0 for Market
    Price level_price = 0.0;        // price level it currently rests on (when resting)
    std::string user_id;
    std::string client_id;          // self-supplied bot label (from WS hello)
    std::string client_order_id;
    Timestamp created_ms = 0;
    bool is_internal = false;       // market-maker / system bot

    // Intrusive linkage into the owning PriceLevel's FIFO. Valid only while the
    // order rests on the book; the level pointer gives O(1) cancel with no map
    // lookup for the price.
    Order* prev_ = nullptr;
    Order* next_ = nullptr;
    PriceLevel* level_ = nullptr;

    [[nodiscard]] Quantity remaining() const {
        return quantity > filled ? quantity - filled : 0;
    }
};

// What the matching layer submits to OrderBook::apply(). Passing this by const
// reference (rather than a heap-allocated Order) keeps market orders and fully
// crossing limits allocation-free — a pooled Order is only materialised if a
// remainder actually rests. Strings are views: they are copied into the pool
// exactly once, and only when the order rests.
struct OrderInput {
    OrderId id = 0;
    SymbolId symbol = 0;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    Quantity quantity = 0;
    Price limit_price = 0.0;
    std::string_view user_id;
    std::string_view client_id;
    std::string_view client_order_id;
    Timestamp created_ms = 0;
    bool is_internal = false;
};

struct FillReport {
    OrderId taker_order_id = 0;
    OrderId maker_order_id = 0;
    SymbolId symbol = 0;
    Price price = 0.0;
    Quantity quantity = 0;
    Quantity maker_remaining = 0;   // maker's remaining qty AFTER this fill (0 = fully filled)
    OrderSide taker_side = OrderSide::Buy;
    Timestamp ts = 0;
    uint64_t trade_id = 0;          // assigned by MatchingEngine
    std::string taker_user_id;
    std::string maker_user_id;
    std::string maker_client_id;    // empty unless propagated by the matching layer
};

struct CancelOutcome {
    bool ok = false;
    OrderId order_id = 0;
    SymbolId symbol = 0;
    std::string user_id;            // owner of the cancelled order
    Quantity remaining = 0;         // qty that was outstanding before cancel
    std::string reason;             // empty on success
};

struct ApplyResult {
    OrderId order_id = 0;
    OrderStatus status = OrderStatus::Pending;
    Quantity filled_total = 0;
    Price avg_price = 0.0;
    std::string reject_reason;
    std::vector<FillReport> fills;
    // Orders cancelled as a side effect of self-trade prevention.
    std::vector<CancelOutcome> stp_cancels;
};

}
