#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"
#include "news_bot/news_analyzer.hpp"
#include "server/bot_tracker.hpp"
#include "server/market_flow.hpp"

namespace TradingSystem {

// In-process bot that reacts to Gemini-classified news signals. One
// instance per enabled persona; all instances subscribe to the same
// NewsAnalyzer so Gemini is called once per news item, not once per bot.
//
// Marked is_internal=true on every order, which: (a) routes through the
// in-process Sequencer with no auth round-trip; (b) makes it exempt from
// per-symbol position caps (same carve-out the market maker enjoys); and
// (c) lets BotTracker label the row as an internal bot in /bots.
class NewsBot {
public:
    // `instance_id` (1..N) labels this instance among siblings of the same
    // persona. Set to 1 when there's only one instance of the persona; the
    // user-facing label still includes "-1" for consistency.
    NewsBot(NewsBotConfig cfg,
            int instance_id,
            Sequencer& seq,
            std::shared_ptr<SymbolRegistry> registry,
            std::shared_ptr<BotTracker> bot_tracker,
            std::shared_ptr<MarketFlow> market_flow);
    ~NewsBot();

    void attach_to(NewsAnalyzer& analyzer);

    // Spins up the noise-trading thread when noise_interval_seconds > 0.
    // Idempotent — safe to call after attach_to whether or not noise is
    // configured.
    void start();
    void stop();

private:
    void on_signal(const NewsItem& news, const NewsAnalysis& a);
    void emit_order(SymbolId symbol, OrderSide side, Quantity base_qty,
                    double base_off_bps, double signal_confidence);
    void worker_loop();
    void run_noise_tick();
    OrderSide effective_side(NewsDirection dir) const;

    // Trade staged by on_signal when signal_delay_ms > 0. Worker thread
    // wakes at fire_at and submits the order. Comparator sorts the
    // priority_queue so top() is the *earliest* due trade.
    struct PendingSignal {
        std::chrono::steady_clock::time_point fire_at;
        SymbolId symbol = 0;
        OrderSide side = OrderSide::Buy;
        Quantity base_qty = 0;
        double off_bps = 0.0;
        double confidence = 0.0;
        bool operator>(const PendingSignal& o) const { return fire_at > o.fire_at; }
    };

    NewsBotConfig cfg_;
    int instance_id_ = 1;
    Sequencer& seq_;
    std::shared_ptr<SymbolRegistry> registry_;
    std::shared_ptr<BotTracker> bot_tracker_;
    std::shared_ptr<MarketFlow> market_flow_;

    // Per-instance user_id and client_id labels. Each sibling of the same
    // persona gets a *distinct* user_id ("internal:news_momentum_2") so
    // self-trade prevention doesn't fire between siblings on the same
    // book; bot_tracker still recognises them as a single persona via the
    // "internal:news_<persona>_*" prefix in its display logic.
    std::string user_id_;
    std::string client_id_;

    // Monotonic counter for client_order_id correlation in logs.
    std::atomic<uint64_t> seq_num_{0};

    // Background worker. Only spawned when there's actual work for it —
    // noise_interval_seconds > 0 (periodic noise) or signal_delay_ms > 0
    // (pending-signal drainage). When neither is set, on_signal fires
    // synchronously and we keep the legacy zero-thread, zero-cost path.
    std::atomic<bool> running_{false};
    std::thread worker_thread_;

    std::mutex queue_mu_;
    std::condition_variable queue_cv_;
    std::priority_queue<PendingSignal,
                        std::vector<PendingSignal>,
                        std::greater<PendingSignal>> pending_;
};

}  // namespace TradingSystem
