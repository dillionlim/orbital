#pragma once
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"

namespace TradingSystem {

// In-process market maker. Posts symmetric Buy/Sell quotes around a per-symbol
// mid price; re-posts on fills; periodically refreshes if there's no activity.
// Wired through Sequencer (NOT through the network) so it traffics in the same
// OrderId namespace as real bots.
class MarketMakerBot {
public:
    MarketMakerBot(Sequencer& seq, EventBus& bus,
                   std::shared_ptr<SymbolRegistry> registry,
                   const MarketMakerConfig& cfg);
    ~MarketMakerBot();

    void start();
    void stop();

private:
    struct State {
        SymbolId symbol = 0;
        Price mid = 0;
        Price last_trade_price = 0;
        // The price the *currently resting* quotes are anchored to. We
        // compare last_trade_price against this to decide when external
        // price action has drifted far enough to make our quotes stale.
        Price quote_anchor = 0;
        OrderId bid_id = 0;
        OrderId ask_id = 0;
        // Cooldown timestamp on event-driven requotes so a burst of
        // trades can't trigger a cancel-and-replace on every print.
        std::chrono::steady_clock::time_point last_requote_at{};
    };

    void seed_quote_locked(State& st);
    void post_side(State& st, OrderSide side);
    void cancel_side_locked(State& st, OrderSide side);
    void requote_locked(State& st);
    void on_event(const OutboundEvent& ev);
    void refresh_loop();

    // Resolved at start() from cfg_.requote_drift_bps (or its default).
    int effective_drift_bps_ = 0;
    static constexpr int kRequoteCooldownMs = 250;

    Sequencer& seq_;
    EventBus& bus_;
    std::shared_ptr<SymbolRegistry> registry_;
    MarketMakerConfig cfg_;
    static constexpr const char* kUserId = "internal:market_maker";

    std::mutex mu_;
    std::unordered_map<SymbolId, State> states_;
    std::unordered_set<OrderId> our_orders_;
    EventBus::SubscriberId sub_id_ = 0;

    std::atomic<bool> running_{false};
    std::thread refresh_thread_;
};

}
