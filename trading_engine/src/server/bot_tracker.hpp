#pragma once
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/types.hpp"
#include "engine/event_bus.hpp"
#include "engine/events.hpp"
#include "server/snapshot_store.hpp"

namespace TradingSystem {

// Tracks per-user trading state derived from EventBus fills. Computes a simple
// total PnL (realized cash + mark-to-market of open positions) and a rolling
// 1-hour realized PnL. Used by the /bots REST endpoint so the frontend can
// reflect what's actually trading on the server.
class BotTracker {
public:
    BotTracker() = default;
    ~BotTracker();

    void start(EventBus& bus, std::shared_ptr<SnapshotStore> snapshots);
    void stop();

    // Called by Dispatcher when a session sends `hello` so we can label external
    // bots by their self-supplied client_id (instead of just user_id).
    void note_client_id(const std::string& user_id, const std::string& client_id);

    struct BotSnapshot {
        std::string user_id;
        std::string client_id;
        std::string display_name;       // human label (client_id, "Market Maker", or trimmed user_id)
        std::string strategy_name;      // e.g. "MM (spread quotes)" or "External bot"
        bool is_internal = false;
        std::string status;             // "active" | "paused"
        uint64_t orders_placed = 0;
        uint64_t fills = 0;
        uint64_t volume = 0;
        double total_pnl = 0.0;
        double hourly_pnl = 0.0;
        Timestamp first_seen = 0;
        Timestamp last_activity = 0;
    };

    std::vector<BotSnapshot> snapshot() const;

private:
    struct Fill {
        Timestamp ts;
        SymbolId symbol;
        int64_t pos_delta;              // signed: + on buy, - on sell
        double cash_delta;              // signed: + on sell, - on buy
    };
    struct State {
        std::string user_id;
        std::string client_id;
        bool is_internal = false;
        Timestamp first_seen = 0;
        Timestamp last_activity = 0;
        uint64_t orders_placed = 0;
        uint64_t fills = 0;
        uint64_t volume = 0;
        double cash_realized = 0.0;
        std::unordered_map<SymbolId, int64_t> positions;
        std::deque<Fill> recent_fills;  // pruned to last hour
    };

    void on_event(const OutboundEvent& ev);
    static void prune_old(std::deque<Fill>& q, Timestamp now);
    double mark_value(const State& s) const;

    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;
    std::shared_ptr<SnapshotStore> snapshots_;

    mutable std::mutex mu_;
    // Keyed by `client_id` when the bot supplied one, else `user_id`. This way
    // multiple scripts sharing an API key but using distinct client_ids each get
    // their own row. The map below remembers user_id → most-recent-known
    // client_id so maker-side fills (which carry user_id from the resting order)
    // attribute to the right bot row.
    std::unordered_map<std::string, State> by_key_;
    std::unordered_map<std::string, std::string> user_to_client_;
};

}
