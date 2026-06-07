#pragma once
#include <string>
#include <string_view>

#include "common/config.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

// String spellings for wire protocol (kept in sync with public_api.hpp enum names).
[[nodiscard]] const char* side_name(OrderSide s);
[[nodiscard]] const char* type_name(OrderType t);
[[nodiscard]] const char* status_name(OrderStatus s);

[[nodiscard]] bool parse_side(std::string_view s, OrderSide& out);
[[nodiscard]] bool parse_type(std::string_view s, OrderType& out);

// Parsed inbound message types.
struct InboundHello { std::string client_id; };
struct InboundPlaceOrder {
    std::string client_order_id;
    std::string symbol;       // wire name
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    Quantity quantity = 0;
    Price limit_price = 0.0;
};
struct InboundCancelOrder { OrderId order_id = 0; };
struct InboundSubscribe { std::string channel; std::string symbol; int depth = 10; };
struct InboundUnsubscribe { std::string channel; std::string symbol; };
struct InboundPing {};

struct ParsedMessage {
    enum class Type { Unknown, Hello, Place, Cancel, Subscribe, Unsubscribe, Ping } type =
        Type::Unknown;
    InboundHello hello;
    InboundPlaceOrder place;
    InboundCancelOrder cancel;
    InboundSubscribe subscribe;
    InboundUnsubscribe unsubscribe;
    std::string parse_error;
};

[[nodiscard]] ParsedMessage parse_inbound(std::string_view json);

// Outbound JSON encoders. All produce a single text frame payload.
[[nodiscard]] std::string encode_welcome(std::string_view user_id, Timestamp server_time);
[[nodiscard]] std::string encode_error(std::string_view code, std::string_view message);
[[nodiscard]] std::string encode_pong(Timestamp ts);

[[nodiscard]] std::string encode_execution_report(const ExecutionReport& er, const SymbolRegistry& reg);
[[nodiscard]] std::string encode_trade(const TradePrint& tp, const SymbolRegistry& reg);

// Full L2 snapshot — sent on subscribe (sourced from SnapshotStore) and on
// initial-snapshot deltas. Includes `seq` so clients can validate gap-freedom
// of the delta stream that follows.
[[nodiscard]] std::string encode_book_snapshot(const BookSnapshotEvent& s, const SymbolRegistry& reg);
[[nodiscard]] std::string encode_book_snapshot_from_delta(const BookDelta& d, const SymbolRegistry& reg);

// Incremental top-N changes. Each (price, qty) entry: qty=0 means remove,
// qty>0 means set/update.
[[nodiscard]] std::string encode_book_delta(const BookDelta& d, const SymbolRegistry& reg);

}
