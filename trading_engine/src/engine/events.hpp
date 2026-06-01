#pragma once
#include <cstdint>
#include <string>
#include <variant>
#include <vector>

#include "book/order.hpp"
#include "book/order_book.hpp"
#include "common/types.hpp"

namespace TradingSystem {

using SessionId = uint64_t;
constexpr SessionId kInternalSession = 0;   // reserved for in-process producers (MM bot)

// ---- inbound (sequencer → matching shard) ----

struct PlaceOrderCmd {
    OrderId assigned_id = 0;
    SymbolId symbol = 0;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    Quantity quantity = 0;
    Price limit_price = 0.0;            // ignored for Market
    std::string user_id;
    std::string client_id;              // self-supplied bot label (from WS hello)
    std::string client_order_id;
    SessionId session_id = kInternalSession;
    bool is_internal = false;
    Timestamp ts = 0;
};

struct CancelOrderCmd {
    OrderId order_id = 0;
    std::string user_id;                // empty bypasses owner check (admin/internal)
    SessionId session_id = kInternalSession;
    Timestamp ts = 0;
};

using InboundCmd = std::variant<PlaceOrderCmd, CancelOrderCmd>;

// ---- outbound (matching shard → broadcaster / persistence / mm) ----

struct ExecutionReport {
    enum class Kind { Ack, Reject, Fill, CancelAck };
    Kind kind = Kind::Ack;
    OrderId order_id = 0;
    std::string client_order_id;
    SessionId session_id = kInternalSession;
    SymbolId symbol = 0;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;  // original order type
    Price limit_price = 0.0;            // original limit (0 for Market)
    OrderStatus status = OrderStatus::Pending;
    Price last_price = 0.0;             // last fill price
    Quantity last_quantity = 0;         // last fill qty
    Quantity remaining = 0;
    Quantity total_filled = 0;
    Price avg_price = 0.0;
    uint64_t trade_id = 0;              // populated for fills
    std::string user_id;
    std::string client_id;              // self-supplied bot label (may be empty)
    std::string reason;                 // populated for Reject
    Timestamp ts = 0;
    bool is_internal = false;
};

struct TradePrint {
    uint64_t trade_id = 0;
    SymbolId symbol = 0;
    Price price = 0.0;
    Quantity quantity = 0;
    OrderId taker_order_id = 0;
    OrderId maker_order_id = 0;
    OrderSide taker_side = OrderSide::Buy;
    Timestamp ts = 0;
};

struct BookSnapshotEvent {
    SymbolId symbol = 0;
    Timestamp ts = 0;
    std::vector<BookLevel> bids;
    std::vector<BookLevel> asks;
};

using OutboundEvent = std::variant<ExecutionReport, TradePrint, BookSnapshotEvent>;

}
