#pragma once
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
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

    // Pre-register an in-process bot so it appears in /bots immediately,
    // even before its first ExecutionReport. Without this, news bots stay
    // invisible until their first headline arrives — which can be tens of
    // minutes after engine start.
    void register_internal_bot(const std::string& user_id,
                               const std::string& client_id);

    // ---- Pause control --------------------------------------------------
    //
    // Pausing is keyed by `client_id` (the user-supplied bot label). Only
    // the owning user_id can pause/resume their own bots; everyone can see
    // the paused state (via snapshot) for read-only attribution.
    //
    // State is in-memory only — engine restart resets every bot to active.
    // That's fine for v1; persistence is a P2-ish concern.
    enum class PauseResult {
        Ok,
        NotFound,        // no bot with that client_id has been seen
        NotOwner,        // requesting user_id doesn't match the bot's owner
        InternalBot,     // can't pause the in-process market maker
    };

    [[nodiscard]] PauseResult pause(std::string_view client_id, std::string_view requesting_user_id);
    [[nodiscard]] PauseResult resume(std::string_view client_id, std::string_view requesting_user_id);

    // Forget a bot row entirely (owner-only). Clears stale, disconnected bots
    // from /bots. Same outcomes as pause (NotFound / NotOwner / InternalBot). A
    // still-live bot would re-register on its next event, so the REST handler
    // disconnects it before calling this.
    [[nodiscard]] PauseResult remove(std::string_view client_id, std::string_view requesting_user_id);

    // Used by Dispatcher on `hello` (and defensively on place_order) to
    // reject paused bots' traffic. Cheap; called per inbound message.
    // Takes user_id so two distinct users can't pause each other's bots
    // by registering the same client_id (the squatting bug).
    [[nodiscard]] bool is_paused(std::string_view user_id, std::string_view client_id) const;

    struct BotSnapshot {
        std::string user_id;
        std::string client_id;
        std::string display_name;       // human label (client_id, "Market Maker", or trimmed user_id)
        std::string strategy_name;      // e.g. "MM (spread quotes)" or "External bot"
        bool is_internal = false;
        std::string status;             // "active" | "idle" | "paused" | "error"
        bool paused = false;            // explicit pause flag (set via pause())
        uint64_t orders_placed = 0;
        uint64_t fills = 0;
        uint64_t volume = 0;
        double total_pnl = 0.0;
        double hourly_pnl = 0.0;        // realized PnL over the last 60min (kept for compat)
        double windowed_pnl = 0.0;      // realized PnL over the requested window
        int64_t window_ms = 0;          // window used to compute windowed_pnl
        Timestamp first_seen = 0;
        Timestamp last_activity = 0;
    };

    // `connected_client_ids` is the set of client_ids with a live WS session
    // right now (see SessionRegistry::connected_client_ids). Used to flag
    // entries whose bot has dropped off as "error" rather than "idle".
    // `window_ms` controls the rolling window for windowed_pnl (clamped
    // 1s..24h server-side). hourly_pnl is always 60min for backward compat.
    std::vector<BotSnapshot> snapshot(
        const std::unordered_set<std::string>& connected_client_ids = {},
        int64_t window_ms = 60 * 60 * 1000) const;

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

    // All map keys here use the COMPOSITE form `user_id + "::" + client_id`
    // (or `user_id + "::" + user_id` if the bot didn't supply a client_id).
    // Without the user_id half, an attacker who connected first with a
    // victim's known client_id would steal the row and could later block the
    // real owner from pausing/resuming.
    [[nodiscard]] static std::string compose_key(std::string_view user_id,
                                                 std::string_view client_id);

    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;
    std::shared_ptr<SnapshotStore> snapshots_;

    mutable std::mutex mu_;
    // user_id::client_id → State. Two different users with the same client_id
    // get distinct rows (and distinct pause flags). user_to_client_ remembers
    // each user's most-recent-known client_id so maker-side fills (which carry
    // user_id from the resting order) still attribute to the right bot row.
    // user_row_count_ tracks the number of distinct client_ids per user so we
    // can enforce kMaxClientIdsPerUser in O(1) without scanning by_key_.
    std::unordered_map<std::string, State> by_key_;
    std::unordered_map<std::string, std::string> user_to_client_;
    std::unordered_map<std::string, size_t> user_row_count_;

    // Set of paused composite keys. Lookup is hot (per inbound WS message) so
    // unordered_set is appropriate. Mutated only via pause()/resume().
    std::unordered_set<std::string> paused_;
};

}
