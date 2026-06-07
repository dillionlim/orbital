#pragma once
#include <atomic>
#include <thread>

#include "book/order_book.hpp"
#include "common/spsc_queue.hpp"
#include "engine/event_bus.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

// One MatchingEngine per symbol. Owns the OrderBook + a worker thread.
// Sequencer pushes commands via submit(); the worker drains and matches.
class MatchingEngine {
public:
    static constexpr size_t kQueueCapacity = 65536;
    using Queue = SPSCQueue<InboundCmd, kQueueCapacity>;

    MatchingEngine(SymbolId symbol, EventBus& bus, std::atomic<uint64_t>& trade_id_counter);

    void start();
    void stop();

    // Producer-side (Sequencer). Returns false if queue is full (extremely unlikely
    // at our scale; caller should log and drop).
    [[nodiscard]] bool submit(InboundCmd cmd) { return queue_.try_push(std::move(cmd)); }

    [[nodiscard]] SymbolId symbol() const { return symbol_; }

    // Read-only snapshot for /orderbook REST handler. NOT thread-safe vs the worker;
    // the engine publishes BookSnapshotEvents via EventBus on each change, and a
    // separate snapshot cache caches them for REST consumers.
    [[nodiscard]] const OrderBook& book_unsafe() const { return book_; }

private:
    void worker_loop();
    // Publishes a `snapshot=true` BookDelta with the current top-20 (used at
    // shard startup so SnapshotStore has a baseline).
    void publish_initial_snapshot();
    // Diffs current top-20 vs prev_bids_/prev_asks_ and publishes an
    // incremental BookDelta if anything in top-20 changed.
    void publish_book_change();

    SymbolId symbol_;
    OrderBook book_;
    Queue queue_;
    EventBus& bus_;
    std::atomic<uint64_t>& trade_id_counter_;
    std::atomic<bool> running_{false};
    std::thread thread_;

    // Per-symbol sequence + last-published top-20 for delta computation. Only
    // touched by publish_initial_snapshot() / publish_book_change(), which are
    // both called from the worker thread (publish_initial_snapshot runs
    // before the thread starts, on the same thread that calls start()).
    uint64_t seq_ = 0;
    std::vector<BookLevel> prev_bids_;
    std::vector<BookLevel> prev_asks_;
};

}
