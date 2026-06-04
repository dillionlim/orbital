#include "engine/sequencer.hpp"

#include "common/log.hpp"
#include "common/time.hpp"

namespace TradingSystem {

Sequencer::Sequencer(EventBus& bus, std::shared_ptr<SymbolRegistry> registry)
    : bus_(bus), registry_(std::move(registry)) {}

Sequencer::~Sequencer() { stop_shards(); }

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

OrderId Sequencer::submit_place(PlaceOrderCmd cmd) {
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
    {
        std::lock_guard<std::mutex> lk(order_index_mu_);
        auto it = order_to_symbol_.find(cmd.order_id);
        if (it == order_to_symbol_.end()) {
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
        sym = it->second;
    }
    auto sit = shards_.find(sym);
    if (sit == shards_.end()) return false;
    if (cmd.ts == 0) cmd.ts = now_ms();
    return sit->second->submit(InboundCmd{cmd});
}

}  // namespace TradingSystem
