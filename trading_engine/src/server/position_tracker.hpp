#pragma once
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>

#include "common/config.hpp"
#include "common/types.hpp"
#include "engine/event_bus.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

// Maintains per-(user, symbol) realized position and the sum of remaining
// quantity on each user's open orders, by subscribing to the engine's
// ExecutionReport stream. Used by Dispatcher to enforce per-symbol
// max_long / max_short caps pre-trade.
//
// In-process orders (the in-process market maker) are tracked for accuracy
// but exempt from would_breach()'s veto — MMs need inventory swing to
// quote both sides.
//
// Race note: would_breach() is called from the WS dispatcher thread before
// submit_place(); state updates happen on the matching shard thread when
// ExecutionReports arrive. There is a small window where a freshly placed
// order's Ack hasn't been processed yet, so a rapid second order from the
// same user could pass the check using stale open_qty. Acceptable for v1
// — exchanges generally treat pre-trade limits as best-effort against
// recent state, and the gap is microseconds.
class PositionTracker {
public:
    explicit PositionTracker(std::shared_ptr<SymbolRegistry> registry);
    ~PositionTracker();

    void start(EventBus& bus);
    void stop();

    // True if accepting `qty` on `side` for (user_id, symbol) would push
    // the user past max_long (Buy) or max_short (Sell) for that symbol.
    // is_internal=true short-circuits to false (MM exemption).
    [[nodiscard]] bool would_breach(std::string_view user_id, SymbolId symbol,
                                    OrderSide side, Quantity qty,
                                    bool is_internal) const;

    struct Position {
        int64_t  position  = 0;   // signed: net realized (long > 0, short < 0)
        Quantity open_buy  = 0;   // sum of remaining qty on open Buy orders
        Quantity open_sell = 0;   // sum of remaining qty on open Sell orders
    };
    [[nodiscard]] Position get(std::string_view user_id, SymbolId symbol) const;

private:
    void on_event(const OutboundEvent& ev);
    static std::string compose(std::string_view user_id, SymbolId symbol);

    std::shared_ptr<SymbolRegistry> registry_;
    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;

    // Cached per-symbol caps so would_breach doesn't scan registry on every
    // place. Filled at construction; stable for engine lifetime.
    std::unordered_map<SymbolId, std::pair<Quantity, Quantity>> caps_;

    mutable std::mutex mu_;

    // Per-resting-order state; needed because CancelAck doesn't carry the
    // remaining qty so we have to remember it to deduct correctly.
    struct OpenOrder {
        std::string user_id;
        SymbolId    symbol;
        OrderSide   side;
        Quantity    remaining;
    };
    std::unordered_map<OrderId, OpenOrder> open_;

    // user_id + ":" + symbol_id → Position. Composite-key style mirrors
    // bot_tracker — keeps two distinct users on the same symbol distinct.
    std::unordered_map<std::string, Position> by_user_sym_;
};

}  // namespace TradingSystem
