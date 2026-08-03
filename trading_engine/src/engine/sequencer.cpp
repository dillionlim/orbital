#include "engine/sequencer.hpp"

#include <variant>

#include "common/log.hpp"
#include "common/time.hpp"

namespace TradingSystem {

Sequencer::Sequencer(EventBus& bus, std::shared_ptr<SymbolRegistry> registry)
    : bus_(bus), registry_(std::move(registry)) {
    sub_id_ = bus_.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

Sequencer::~Sequencer() {
    if (sub_id_ != 0) {
        bus_.unsubscribe(sub_id_);
        sub_id_ = 0;
    }
    stop_shards();
}

// An order is routable for cancel only until it reaches a terminal state. Once
// it is filled, cancelled or rejected there is nothing left to route to, so the
// entry is dead weight — and without this the map grew by one entry per order
// placed and was never pruned, for the life of the process. With the in-process
// market maker repainting a ladder per symbol every refresh tick that is a
// steady, unbounded climb.
void Sequencer::on_event(const OutboundEvent& ev) {
    const auto* report = std::get_if<ExecutionReport>(&ev);
    if (report == nullptr || report->order_id == 0) return;

    const bool terminal =
        report->kind == ExecutionReport::Kind::CancelAck ||
        report->kind == ExecutionReport::Kind::Reject ||
        (report->kind == ExecutionReport::Kind::Fill && report->remaining == 0);
    if (!terminal) return;

    std::lock_guard<std::mutex> lk(order_index_mu_);
    order_to_symbol_.erase(report->order_id);
}

size_t Sequencer::routable_orders() const {
    std::lock_guard<std::mutex> lk(order_index_mu_);
    return order_to_symbol_.size();
}

void Sequencer::start_shards(std::atomic<uint64_t>& trade_id_counter) {
    for (const auto& s : registry_->symbols()) {
        auto eng = std::make_unique<MatchingEngine>(s.id, bus_, trade_id_counter);
        eng->start();
        shards_.emplace(s.id, std::move(eng));
    }
}

void Sequencer::stop_shards() {
    for (auto& [_, eng] : shards_) eng->stop();
    shards_.clear();
}

OrderId Sequencer::submit_place(PlaceOrderCmd cmd,
                                const std::function<void(OrderId)>& on_id_assigned) {
    auto it = shards_.find(cmd.symbol);
    if (it == shards_.end()) {
        // Synthesize a Reject so the client gets an error.
        ExecutionReport e;
        e.kind = ExecutionReport::Kind::Reject;
        e.client_order_id = cmd.client_order_id;
        e.session_id = cmd.session_id;
        e.symbol = cmd.symbol;
        e.side = cmd.side;
        e.status = OrderStatus::Rejected;
        e.reason = "unknown_symbol";
        e.user_id = cmd.user_id;
        e.client_id = cmd.client_id;
        e.ts = now_ms();
        bus_.publish(e);
        return 0;
    }
    cmd.assigned_id = next_order_id_.fetch_add(1, std::memory_order_relaxed);
    if (cmd.ts == 0) cmd.ts = now_ms();

    {
        std::lock_guard<std::mutex> lk(order_index_mu_);
        order_to_symbol_[cmd.assigned_id] = cmd.symbol;
    }

    // Last point at which the caller is alone with this order. Everything after
    // the submit below races the shard thread.
    if (on_id_assigned) on_id_assigned(cmd.assigned_id);

    if (!it->second->submit(InboundCmd{cmd})) {
        LOG_WARN("sequencer: shard queue full for symbol_id=" << cmd.symbol);
        ExecutionReport e;
        e.kind = ExecutionReport::Kind::Reject;
        e.order_id = cmd.assigned_id;
        e.client_order_id = cmd.client_order_id;
        e.session_id = cmd.session_id;
        e.symbol = cmd.symbol;
        e.side = cmd.side;
        e.status = OrderStatus::Rejected;
        e.reason = "queue_full";
        e.user_id = cmd.user_id;
        e.client_id = cmd.client_id;
        e.ts = now_ms();
        bus_.publish(e);
        return 0;
    }
    return cmd.assigned_id;
}

bool Sequencer::submit_cancel(CancelOrderCmd cmd) {
    SymbolId sym = 0;
    bool known = false;
    {
        std::lock_guard<std::mutex> lk(order_index_mu_);
        auto it = order_to_symbol_.find(cmd.order_id);
        if (it != order_to_symbol_.end()) {
            sym = it->second;
            known = true;
        }
    }
    // Published outside the lock: publish() runs subscribers synchronously, and
    // one of them is this Sequencer's own reaper, which takes order_index_mu_.
    if (!known) {
        ExecutionReport e;
        e.kind = ExecutionReport::Kind::Reject;
        e.order_id = cmd.order_id;
        e.session_id = cmd.session_id;
        e.status = OrderStatus::Rejected;
        e.reason = "not_found";
        e.user_id = cmd.user_id;
        e.ts = now_ms();
        bus_.publish(e);
        return false;
    }
    auto sit = shards_.find(sym);
    if (sit == shards_.end()) return false;
    if (cmd.ts == 0) cmd.ts = now_ms();
    return sit->second->submit(InboundCmd{cmd});
}

}  // namespace TradingSystem
