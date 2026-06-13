#include "server/dispatcher.hpp"

#include <variant>

#include "common/log.hpp"
#include "common/time.hpp"
#include "server/ws_frame.hpp"

namespace TradingSystem {

Dispatcher::Dispatcher(Sequencer& seq, EventBus& bus, SessionRegistry& sessions,
                       std::shared_ptr<SymbolRegistry> registry,
                       std::shared_ptr<SnapshotStore> snapshots, ServerMetrics& metrics,
                       std::shared_ptr<BotTracker> bots,
                       std::shared_ptr<PositionTracker> positions)
    : seq_(seq), bus_(bus), sessions_(sessions), registry_(std::move(registry)),
      snapshots_(std::move(snapshots)), metrics_(metrics), bots_(std::move(bots)),
      positions_(std::move(positions)) {}

Dispatcher::~Dispatcher() { stop(); }

void Dispatcher::start() {
    sub_id_ = bus_.subscribe([this](const OutboundEvent& ev) { on_outbound(ev); });
}

void Dispatcher::stop() {
    if (sub_id_ != 0) {
        bus_.unsubscribe(sub_id_);
        sub_id_ = 0;
    }
}

void Dispatcher::on_connect(SessionPtr s) {
    metrics_.wsConnections++;
    send_text(s, encode_welcome(s->user_id, now_ms()));
}

void Dispatcher::on_message(SessionPtr s, std::string_view payload) {
    auto m = parse_inbound(payload);
    if (m.type == ParsedMessage::Type::Unknown) {
        send_text(s, encode_error("BAD_REQUEST", m.parse_error));
        return;
    }
    switch (m.type) {
        case ParsedMessage::Type::Hello:
            // Hello is informational — store client_id, no reply (welcome was sent on connect).
            if (!m.hello.client_id.empty()) {
                s->client_id = m.hello.client_id;
                if (bots_) bots_->note_client_id(s->user_id, m.hello.client_id);
                // Paused-bot enforcement: the moment we know the client_id we
                // can decide whether this session is allowed. Pause state is
                // user-controlled via the dashboard's pause/resume buttons.
                // Setting alive=false trips the WS read loop's exit check;
                // the connection closes and the bot's reconnect attempt will
                // hit the same check again until it's resumed.
                if (bots_ && bots_->is_paused(s->user_id, m.hello.client_id)) {
                    send_text(s, encode_error("BOT_PAUSED",
                        "Bot is paused. Resume from the dashboard."));
                    s->alive = false;
                }
            }
            return;
        case ParsedMessage::Type::Ping:
            send_text(s, encode_pong(now_ms()));
            return;
        case ParsedMessage::Type::Place:
            handle_place(s, m.place);
            return;
        case ParsedMessage::Type::Cancel:
            handle_cancel(s, m.cancel);
            return;
        case ParsedMessage::Type::Subscribe:
            handle_subscribe(s, m.subscribe);
            return;
        case ParsedMessage::Type::Unsubscribe:
            handle_unsubscribe(s, m.unsubscribe);
            return;
        default:
            return;
    }
}

void Dispatcher::on_disconnect(SessionPtr s) {
    if (metrics_.wsConnections.load() > 0) metrics_.wsConnections--;

    // Reap order_owner_ entries owned by this session.
    std::lock_guard<std::mutex> lk(order_owner_mu_);
    for (auto it = order_owner_.begin(); it != order_owner_.end();) {
        if (it->second == s->id) it = order_owner_.erase(it);
        else ++it;
    }
}

void Dispatcher::cancel_orders_for_client(std::string_view user_id, std::string_view client_id) {
    if (client_id.empty() || user_id.empty()) return;
    std::vector<OrderId> ids;
    sessions_.for_each([&](const SessionPtr& s) {
        if (s->is_internal) return;
        if (s->user_id != user_id) return;       // squatting fix: per-user filter
        if (s->client_id != client_id) return;
        std::lock_guard<std::mutex> lk(s->orders_mu);
        for (OrderId oid : s->own_orders) ids.push_back(oid);
    });
    for (OrderId oid : ids) {
        CancelOrderCmd cmd;
        cmd.order_id = oid;
        cmd.user_id = "";  // engine-initiated; not attributed to a user
        cmd.session_id = kInternalSession;
        cmd.ts = now_ms();
        seq_.submit_cancel(std::move(cmd));
    }
}

void Dispatcher::handle_place(SessionPtr s, const InboundPlaceOrder& p) {
    auto sym = registry_->id_for(p.symbol);
    if (!sym) {
        send_text(s, encode_error("UNKNOWN_SYMBOL", p.symbol));
        metrics_.ordersRejected++;
        return;
    }

    // Defensive pause check — if the bot got paused after hello (mid-session),
    // refuse new orders even though the WS may still be open. The hello-time
    // check already handles new connections.
    if (bots_ && !s->client_id.empty() && bots_->is_paused(s->user_id, s->client_id)) {
        send_text(s, encode_error("BOT_PAUSED", "Bot is paused"));
        metrics_.ordersRejected++;
        return;
    }

    // Per-symbol position cap. Internal MM is exempt (it explicitly needs
    // inventory swing to quote both sides). Done here, before submit_place,
    // so a rejected order never gets an OrderId / persistence row.
    if (positions_ &&
        positions_->would_breach(s->user_id, *sym, p.side, p.quantity, s->is_internal)) {
        send_text(s, encode_error("POSITION_LIMIT",
            "Order would push position past the configured cap for this symbol"));
        metrics_.ordersRejected++;
        return;
    }

    PlaceOrderCmd cmd;
    cmd.symbol = *sym;
    cmd.side = p.side;
    cmd.type = p.type;
    cmd.quantity = p.quantity;
    cmd.limit_price = p.limit_price;
    cmd.user_id = s->user_id;
    cmd.client_id = s->client_id;
    cmd.client_order_id = p.client_order_id;
    cmd.session_id = s->id;
    cmd.is_internal = s->is_internal;
    cmd.ts = now_ms();

    OrderId oid = seq_.submit_place(std::move(cmd));
    if (oid != 0) {
        metrics_.ordersAccepted++;
        std::lock_guard<std::mutex> lk(order_owner_mu_);
        order_owner_[oid] = s->id;
        std::lock_guard<std::mutex> lk2(s->orders_mu);
        s->own_orders.insert(oid);
    } else {
        metrics_.ordersRejected++;
    }
}

void Dispatcher::handle_cancel(SessionPtr s, const InboundCancelOrder& c) {
    CancelOrderCmd cmd;
    cmd.order_id = c.order_id;
    cmd.user_id = s->user_id;
    cmd.session_id = s->id;
    cmd.ts = now_ms();
    seq_.submit_cancel(std::move(cmd));
}

void Dispatcher::handle_subscribe(SessionPtr s, const InboundSubscribe& sub) {
    auto sym = registry_->id_for(sub.symbol);
    if (!sym) {
        send_text(s, encode_error("UNKNOWN_SYMBOL", sub.symbol));
        return;
    }
    {
        std::lock_guard<std::mutex> lk(s->sub_mu);
        if (sub.channel == "book") s->subscribed_books.insert(*sym);
        else if (sub.channel == "trades") s->subscribed_trades.insert(*sym);
        else { send_text(s, encode_error("UNKNOWN_CHANNEL", sub.channel)); return; }
    }
    if (sub.channel == "book") {
        // Send latest snapshot immediately.
        auto snap = snapshots_->get(*sym);
        if (snap) {
            send_text(s, encode_book_snapshot(*snap, *registry_));
        }
    }
}

void Dispatcher::handle_unsubscribe(SessionPtr s, const InboundUnsubscribe& sub) {
    auto sym = registry_->id_for(sub.symbol);
    if (!sym) return;
    std::lock_guard<std::mutex> lk(s->sub_mu);
    if (sub.channel == "book") s->subscribed_books.erase(*sym);
    else if (sub.channel == "trades") s->subscribed_trades.erase(*sym);
}

void Dispatcher::on_outbound(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            // Route by session_id when known, else by user_id (maker fills).
            SessionPtr target;
            if (e.session_id != kInternalSession) {
                target = sessions_.by_id(e.session_id);
            }
            if (!target && !e.user_id.empty()) {
                // Look up via order_owner_ first (preferred — exact session).
                SessionId sid = 0;
                {
                    std::lock_guard<std::mutex> lk(order_owner_mu_);
                    auto it = order_owner_.find(e.order_id);
                    if (it != order_owner_.end()) sid = it->second;
                }
                if (sid != 0) target = sessions_.by_id(sid);
                if (!target) target = sessions_.by_user(e.user_id);
            }
            if (target && !target->is_internal) {
                send_text(target, encode_execution_report(e, *registry_));
            }
            // Trade counter on fills (taker side only — count once per trade).
            if (e.kind == ExecutionReport::Kind::Fill && e.session_id != kInternalSession) {
                if (e.last_quantity > 0) metrics_.tradesMatched++;
            }
            // Reap order_owner_ on terminal states.
            if (e.kind == ExecutionReport::Kind::CancelAck ||
                (e.kind == ExecutionReport::Kind::Fill && e.remaining == 0)) {
                std::lock_guard<std::mutex> lk(order_owner_mu_);
                order_owner_.erase(e.order_id);
            }
        } else if constexpr (std::is_same_v<T, TradePrint>) {
            // Broadcast to everyone subscribed to this symbol's trades, plus book subscribers.
            auto encoded = encode_trade(e, *registry_);
            sessions_.for_each([&](const SessionPtr& s) {
                if (s->is_internal) return;
                bool send;
                {
                    std::lock_guard<std::mutex> lk(s->sub_mu);
                    send = s->subscribed_trades.count(e.symbol) > 0 ||
                           s->subscribed_books.count(e.symbol) > 0;
                }
                if (send) send_text(s, encoded);
            });
        } else if constexpr (std::is_same_v<T, BookDelta>) {
            // SnapshotStore is a separate EventBus subscriber; it has already
            // updated its cached state by the time we get here (subscribers
            // run synchronously in registration order, but each subscriber
            // sees every event — we don't depend on ordering between them).
            //
            // For the wire: snapshot=true gets sent as `book` (full state),
            // snapshot=false as `book_delta` (incremental).
            const std::string encoded = e.snapshot
                ? encode_book_snapshot_from_delta(e, *registry_)
                : encode_book_delta(e, *registry_);
            sessions_.for_each([&](const SessionPtr& s) {
                if (s->is_internal) return;
                bool send;
                {
                    std::lock_guard<std::mutex> lk(s->sub_mu);
                    send = s->subscribed_books.count(e.symbol) > 0;
                }
                if (send) send_text(s, encoded);
            });
        }
    }, ev);
}

void Dispatcher::send_text(SessionPtr s, const std::string& text) {
    if (!s || !s->alive.load() || s->sockfd < 0) return;
    std::lock_guard<std::mutex> lk(s->write_mu);
    if (!ws_write_text(s->sockfd, text)) {
        s->alive = false;
    }
}

}  // namespace TradingSystem
