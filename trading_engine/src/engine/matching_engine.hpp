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
    void publish_snapshot();

    SymbolId symbol_;
    OrderBook book_;
    Queue queue_;
    EventBus& bus_;
    std::atomic<uint64_t>& trade_id_counter_;
    std::atomic<bool> running_{false};
    std::thread thread_;
};

}
