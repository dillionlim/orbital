#include "engine/matching_engine.hpp"

#include <chrono>
#include <utility>
#include <variant>

#include "common/log.hpp"
#include "common/time.hpp"

namespace TradingSystem {

MatchingEngine::MatchingEngine(SymbolId symbol, EventBus& bus,
                               std::atomic<uint64_t>& trade_id_counter)
    : symbol_(symbol), book_(symbol), bus_(bus), trade_id_counter_(trade_id_counter) {}

void MatchingEngine::start() {
    running_ = true;
    thread_ = std::thread([this] { worker_loop(); });
}

void MatchingEngine::stop() {
    running_ = false;
    if (thread_.joinable()) thread_.join();
}

void MatchingEngine::worker_loop() {
    LOG_INFO("matching shard up: symbol_id=" << symbol_);

    auto handle_place = [&](const PlaceOrderCmd& cmd) {
        auto order = std::make_unique<Order>();
        order->id = cmd.assigned_id;
        order->symbol = cmd.symbol;
        order->side = cmd.side;
        order->type = cmd.type;
        order->quantity = cmd.quantity;
        order->limit_price = cmd.limit_price;
        order->user_id = cmd.user_id;
        order->client_id = cmd.client_id;
        order->client_order_id = cmd.client_order_id;
        order->created_ms = cmd.ts ? cmd.ts : now_ms();
        order->is_internal = cmd.is_internal;

        const std::string user_id = cmd.user_id;
        const std::string client_id = cmd.client_id;
        const std::string client_order_id = cmd.client_order_id;
        const SessionId sess = cmd.session_id;
        const bool is_internal = cmd.is_internal;

        ApplyResult r = book_.apply(std::move(order));

        // Emit STP cancellations as CancelAcks so makers know.
        for (const auto& stp : r.stp_cancels) {
            ExecutionReport e;
            e.kind = ExecutionReport::Kind::CancelAck;
            e.order_id = stp.order_id;
            e.symbol = stp.symbol;
            e.user_id = stp.user_id;
            e.status = OrderStatus::Cancelled;
            e.reason = stp.reason;
            e.ts = now_ms();
            // session_id unknown here; broadcaster will look up by user_id+order_id.
            bus_.publish(e);
        }

        if (r.status == OrderStatus::Rejected) {
            ExecutionReport e;
            e.kind = ExecutionReport::Kind::Reject;
            e.order_id = cmd.assigned_id;
            e.client_order_id = client_order_id;
            e.session_id = sess;
            e.symbol = cmd.symbol;
            e.side = cmd.side;
            e.status = OrderStatus::Rejected;
            e.reason = r.reject_reason;
            e.user_id = user_id;
            e.client_id = client_id;
            e.ts = now_ms();
            e.is_internal = is_internal;
            bus_.publish(e);
            return;
        }

        // Send Ack first (so client knows order was accepted).
        ExecutionReport ack;
        ack.kind = ExecutionReport::Kind::Ack;
        ack.order_id = cmd.assigned_id;
        ack.client_order_id = client_order_id;
        ack.session_id = sess;
        ack.symbol = cmd.symbol;
        ack.side = cmd.side;
        ack.type = cmd.type;
        ack.limit_price = cmd.limit_price;
        ack.status = OrderStatus::Pending;
        ack.remaining = cmd.quantity;
        ack.total_filled = 0;
        ack.avg_price = 0.0;
        ack.user_id = user_id;
        ack.client_id = client_id;
        ack.ts = now_ms();
        ack.is_internal = is_internal;
        bus_.publish(ack);

        // Emit per-fill ExecutionReports + TradePrint events.
        Quantity total_filled = 0;
        for (auto fill : r.fills) {
            fill.trade_id = trade_id_counter_.fetch_add(1, std::memory_order_relaxed);

            // Trade tape (for all subscribers).
            bus_.publish(TradePrint{
                .trade_id       = fill.trade_id,
                .symbol         = fill.symbol,
                .price          = fill.price,
                .quantity       = fill.quantity,
                .taker_order_id = fill.taker_order_id,
                .maker_order_id = fill.maker_order_id,
                .taker_side     = fill.taker_side,
                .ts             = fill.ts,
            });

            // Taker's execution report.
            total_filled += fill.quantity;
            ExecutionReport te;
            te.kind = ExecutionReport::Kind::Fill;
            te.order_id = cmd.assigned_id;
            te.client_order_id = client_order_id;
            te.session_id = sess;
            te.symbol = cmd.symbol;
            te.side = cmd.side;
            te.type = cmd.type;
            te.limit_price = cmd.limit_price;
            te.last_price = fill.price;
            te.last_quantity = fill.quantity;
            te.total_filled = total_filled;
            te.remaining = (cmd.quantity > total_filled) ? cmd.quantity - total_filled : 0;
            te.avg_price = r.avg_price;
            te.trade_id = fill.trade_id;
            te.user_id = user_id;
            te.client_id = client_id;
            te.ts = fill.ts;
            te.is_internal = is_internal;
            te.status = (te.remaining == 0) ? OrderStatus::Filled : OrderStatus::PartiallyFilled;
            bus_.publish(te);

            // Maker's execution report. session_id unknown to engine; broadcaster
            // looks up by user_id+order_id (an open-order index in the broadcaster).
            // `remaining` MUST be the maker's residual after this fill so the maker
            // (e.g. our in-process MM) only re-quotes when truly exhausted.
            ExecutionReport me;
            me.kind = ExecutionReport::Kind::Fill;
            me.order_id = fill.maker_order_id;
            me.symbol = fill.symbol;
            me.side = (fill.taker_side == OrderSide::Buy) ? OrderSide::Sell : OrderSide::Buy;
            me.last_price = fill.price;
            me.last_quantity = fill.quantity;
            me.remaining = fill.maker_remaining;
            me.trade_id = fill.trade_id;
            me.user_id = fill.maker_user_id;
            me.client_id = fill.maker_client_id;
            me.ts = fill.ts;
            me.status = (fill.maker_remaining == 0)
                ? OrderStatus::Filled : OrderStatus::PartiallyFilled;
            bus_.publish(me);
        }
        publish_snapshot();
    };

    auto handle_cancel = [&](const CancelOrderCmd& cmd) {
        CancelOutcome co = book_.cancel(cmd.order_id, cmd.user_id);
        ExecutionReport e;
        e.order_id = cmd.order_id;
        e.session_id = cmd.session_id;
        e.user_id = cmd.user_id;
        e.symbol = co.symbol;
        e.ts = now_ms();
        if (co.ok) {
            e.kind = ExecutionReport::Kind::CancelAck;
            e.status = OrderStatus::Cancelled;
            bus_.publish(e);
            publish_snapshot();
        } else {
            e.kind = ExecutionReport::Kind::Reject;
            e.status = OrderStatus::Rejected;
            e.reason = co.reason;
            bus_.publish(e);
        }
    };

    InboundCmd cmd;
    while (running_.load(std::memory_order_acquire)) {
        if (!queue_.try_pop(cmd)) {
            // Light backoff; keep latency low under load but avoid busy-burning idle CPU.
            std::this_thread::sleep_for(std::chrono::microseconds(50));
            continue;
        }
        std::visit([&](auto&& c) {
            using T = std::decay_t<decltype(c)>;
            if constexpr (std::is_same_v<T, PlaceOrderCmd>) {
                handle_place(c);
            } else if constexpr (std::is_same_v<T, CancelOrderCmd>) {
                handle_cancel(c);
            }
        }, cmd);
    }
    LOG_INFO("matching shard down: symbol_id=" << symbol_);
}

void MatchingEngine::publish_snapshot() {
    bus_.publish(BookSnapshotEvent{
        .symbol = symbol_,
        .ts     = now_ms(),
        .bids   = book_.top_n_bids(20),
        .asks   = book_.top_n_asks(20),
    });
}

}  // namespace TradingSystem
