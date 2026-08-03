#pragma once
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>

#include "common/config.hpp"
#include "engine/events.hpp"
#include "engine/matching_engine.hpp"

namespace TradingSystem {

// The Sequencer is the single intake point for all order commands. It assigns the
// monotonic OrderId, looks up the per-symbol shard, and forwards the command. We
// take an MPSC queue of "raw" requests so multiple producer threads (the WS IO
// thread + the in-process MM bot) can submit safely.
class Sequencer {
public:
    Sequencer(EventBus& bus, std::shared_ptr<SymbolRegistry> registry);
    ~Sequencer();

    void set_starting_order_id(OrderId next) { next_order_id_.store(next); }

    void start_shards(std::atomic<uint64_t>& trade_id_counter);
    void stop_shards();

    // Submit a place. Allocates an OrderId, pushes into the symbol's shard. Returns
    // 0 if the symbol is unknown or the shard queue is full.
    OrderId submit_place(PlaceOrderCmd cmd);

    // Submit a cancel. Returns false if the symbol cannot be located for the order
    // (engine sends Reject(reason="not_found") in that case from the shard side, but
    // we need the symbol up-front to route). For our model, cancel includes symbol
    // implicitly by tracking an order→symbol map populated on submit_place.
    bool submit_cancel(CancelOrderCmd cmd);

    [[nodiscard]] OrderId peek_next_order_id() const { return next_order_id_.load(); }

    // Number of orders currently routable by cancel. Test seam: the routing map
    // is private and its size is otherwise unobservable.
    [[nodiscard]] size_t routable_orders() const;

private:
    // Drops an order from the routing map once it can no longer be cancelled.
    void on_event(const OutboundEvent& ev);

    EventBus& bus_;
    EventBus::SubscriberId sub_id_ = 0;
    std::shared_ptr<SymbolRegistry> registry_;
    std::atomic<OrderId> next_order_id_{1};

    // Shards by SymbolId.
    std::unordered_map<SymbolId, std::unique_ptr<MatchingEngine>> shards_;

    // OrderId → SymbolId for cancel routing. Entries live exactly as long as the
    // order can still be cancelled: added on submit_place, dropped when the order
    // reaches a terminal state (see on_event).
    mutable std::mutex order_index_mu_;
    std::unordered_map<OrderId, SymbolId> order_to_symbol_;
};

}
