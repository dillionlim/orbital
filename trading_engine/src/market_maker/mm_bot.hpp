#pragma once
#include <atomic>
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
        OrderId bid_id = 0;
        OrderId ask_id = 0;
    };

    void seed_quote_locked(State& st);
    void post_side(State& st, OrderSide side);
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
    EventBus::SubscriberId sub_id_ = 0;

    std::atomic<bool> running_{false};
    std::thread refresh_thread_;
};

}
