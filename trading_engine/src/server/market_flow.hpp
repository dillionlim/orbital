#pragma once
#include <deque>
#include <mutex>

#include "engine/event_bus.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

// Aggregates simple market-microstructure stats from the engine's
// TradePrint stream — used by news-bot noise loops to produce realistic
// behavior (herding momentum, threshold-fading contrarians, vol-aware
// scalpers) rather than pure 50/50 random.
//
//   bias() — order-flow EMA, ±1. Positive = Buy-side aggressors dominating.
//   volatility() — stddev of recent log-returns, ~0..0.05+ in practice.
//
// Mutex-protected; subscriber writes from the matching shard, readers
// run on per-bot threads. Even with hundreds of trades/sec the lock is
// effectively uncontended.
class MarketFlow {
public:
    // alpha       — EMA weight for flow_bias (0.005 ≈ 200-trade memory)
    // vol_window  — rolling buffer size for realized-vol stddev
    explicit MarketFlow(double alpha = 0.005, size_t vol_window = 100);
    ~MarketFlow();

    void start(EventBus& bus);
    void stop();

    [[nodiscard]] double bias() const;
    [[nodiscard]] double volatility() const;

private:
    void on_event(const OutboundEvent& ev);

    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;
    double alpha_;
    size_t vol_window_;

    mutable std::mutex mu_;
    double ema_ = 0.0;

    // Realized-volatility tracking. We compute log-returns between
    // consecutive prints (per symbol-mixed; in this single-asset-class
    // simulator that's fine — bots don't need per-symbol vol). Buffer
    // is bounded so memory doesn't grow with engine uptime.
    double last_price_ = 0.0;
    std::deque<double> recent_returns_;
};

}  // namespace TradingSystem
