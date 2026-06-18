#pragma once
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <random>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"

namespace TradingSystem {

// In-process market maker. Posts a multi-level Buy/Sell ladder around a
// per-symbol anchor price; re-posts on fills; periodically refreshes; and
// repaints the ladder when the anchor moves. The anchor can be driven live by
// an external feed via update_reference_price() — real top-of-book price with a
// fabricated depth ladder underneath. Wired through Sequencer (NOT through the
// network) so it traffics in the same OrderId namespace as real bots.
class MarketMakerBot {
public:
    MarketMakerBot(Sequencer& seq, EventBus& bus,
                   std::shared_ptr<SymbolRegistry> registry,
                   const MarketMakerConfig& cfg);
    ~MarketMakerBot();

    void start();
    void stop();

    // Set a symbol's reference (anchor) price from an external source. The
    // resting ladder is repainted around it on the next refresh tick.
    void update_reference_price(SymbolId symbol, Price price);

private:
    struct State {
        SymbolId symbol = 0;
        Price mid = 0;
        Price last_trade_price = 0;
        Price quoted_anchor = 0;            // anchor the resting ladder is built on
        std::vector<OrderId> bid_ids;
        std::vector<OrderId> ask_ids;
        std::deque<OrderId> churn_ids;      // transient orders cycled for liveness
    };

    Price anchor_of(const State& st) const;
    void requote_locked(State& st);
    void cancel_side_locked(State& st, OrderSide side);
    void post_ladder_locked(State& st, OrderSide side);
    void churn_step_locked(State& st);
    void on_event(const OutboundEvent& ev);
    void refresh_loop();

    Sequencer& seq_;
    EventBus& bus_;
    std::shared_ptr<SymbolRegistry> registry_;
    MarketMakerConfig cfg_;
    static constexpr const char* kUserId = "internal:market_maker";

    std::mutex mu_;
    std::unordered_map<SymbolId, State> states_;
    std::unordered_set<OrderId> our_orders_;
    std::mt19937 rng_{0x9E3779B9};         // size jitter; fixed seed = reproducible
    EventBus::SubscriberId sub_id_ = 0;

    std::atomic<bool> running_{false};
    std::thread refresh_thread_;
};

}
