#include "market_maker/mm_bot.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <variant>

#include "common/log.hpp"
#include "common/time.hpp"

namespace TradingSystem {

MarketMakerBot::MarketMakerBot(Sequencer& seq, EventBus& bus,
                               std::shared_ptr<SymbolRegistry> registry,
                               const MarketMakerConfig& cfg)
    : seq_(seq), bus_(bus), registry_(std::move(registry)), cfg_(cfg) {}

MarketMakerBot::~MarketMakerBot() { stop(); }

void MarketMakerBot::start() {
    if (!cfg_.enabled) {
        LOG_INFO("mm_bot: disabled by config");
        return;
    }
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& s : registry_->symbols()) {
            State st;
            st.symbol = s.id;
            st.mid = s.mid;
            st.last_trade_price = s.mid;
            states_.emplace(s.id, st);
        }
    }
    // Resolve the drift threshold before the subscriber sees its first
    // event (otherwise the comparison is undefined for an instant).
    effective_drift_bps_ = cfg_.requote_drift_bps;
    if (effective_drift_bps_ <= 0) {
        effective_drift_bps_ = std::max(5, static_cast<int>(cfg_.spread_bps / 2.0));
    }

    sub_id_ = bus_.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
    running_ = true;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [_, st] : states_) seed_quote_locked(st);
    }
    refresh_thread_ = std::thread([this] { refresh_loop(); });
    LOG_INFO("mm_bot: started; symbols=" << states_.size()
             << " spread_bps=" << cfg_.spread_bps << " size=" << cfg_.size
             << " drift_bps=" << effective_drift_bps_);
}

void MarketMakerBot::stop() {
    if (!running_.exchange(false)) return;
    if (sub_id_) {
        bus_.unsubscribe(sub_id_);
        sub_id_ = 0;
    }
    if (refresh_thread_.joinable()) refresh_thread_.join();

    // Cancel outstanding quotes.
    std::vector<OrderId> ids;
    {
        std::lock_guard<std::mutex> lk(mu_);
        ids.assign(our_orders_.begin(), our_orders_.end());
    }
    for (OrderId id : ids) {
        CancelOrderCmd c;
        c.order_id = id;
        c.user_id = kUserId;
        c.session_id = kInternalSession;
        c.ts = now_ms();
        seq_.submit_cancel(std::move(c));
    }
}

void MarketMakerBot::seed_quote_locked(State& st) {
    post_side(st, OrderSide::Buy);
    post_side(st, OrderSide::Sell);
}

void MarketMakerBot::post_side(State& st, OrderSide side) {
    const Price half = (cfg_.spread_bps / 2.0) / 10000.0;
    Price anchor = (cfg_.track_trades && st.last_trade_price > 0) ? st.last_trade_price : st.mid;
    // Record the anchor so the drift check has a stable reference. Both
    // sides are posted from seed_quote_locked back-to-back, so they end
    // up sharing the same anchor (the second call just rewrites with the
    // same value).
    st.quote_anchor = anchor;
    Price px = (side == OrderSide::Buy) ? anchor * (1.0 - half) : anchor * (1.0 + half);

    PlaceOrderCmd cmd;
    cmd.symbol = st.symbol;
    cmd.side = side;
    cmd.type = OrderType::Limit;
    cmd.quantity = cfg_.size;
    cmd.limit_price = px;
    cmd.user_id = kUserId;
    cmd.client_id = "Market Maker";   // surfaces as the bot label in the dashboard
    cmd.client_order_id = std::string("mm-") + (side == OrderSide::Buy ? "bid-" : "ask-")
                          + std::to_string(st.symbol);
    cmd.session_id = kInternalSession;
    cmd.is_internal = true;
    cmd.ts = now_ms();

    OrderId oid = seq_.submit_place(std::move(cmd));
    if (oid == 0) {
        LOG_WARN("mm_bot: place rejected for symbol_id=" << st.symbol << " side="
                                                          << (side == OrderSide::Buy ? "Buy" : "Sell"));
        return;
    }
    if (side == OrderSide::Buy) st.bid_id = oid;
    else st.ask_id = oid;
    our_orders_.insert(oid);
}

// Cancel a single side if posted. Caller must hold mu_. Submits the cancel
// to the sequencer and clears the corresponding bid_id/ask_id eagerly so
// subsequent post_side() calls don't double-post — our_orders_ keeps the
// stale id around until the CancelAck arrives, which is harmless.
void MarketMakerBot::cancel_side_locked(State& st, OrderSide side) {
    const OrderId id = (side == OrderSide::Buy) ? st.bid_id : st.ask_id;
    if (id == 0) return;
    CancelOrderCmd c;
    c.order_id = id;
    c.user_id = kUserId;
    c.session_id = kInternalSession;
    c.ts = now_ms();
    seq_.submit_cancel(std::move(c));
    if (side == OrderSide::Buy) st.bid_id = 0;
    else st.ask_id = 0;
}

// Cancel both sides and seed fresh quotes against the current anchor
// (last_trade_price when track_trades is on). Cancels are queued first so
// the matching engine processes "remove old → place new" in order on the
// per-symbol shard; there's a brief window with no MM bid/ask, which is
// preferable to leaving stale quotes a half-spread away from the market.
void MarketMakerBot::requote_locked(State& st) {
    cancel_side_locked(st, OrderSide::Buy);
    cancel_side_locked(st, OrderSide::Sell);
    seed_quote_locked(st);
    st.last_requote_at = std::chrono::steady_clock::now();
}

void MarketMakerBot::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            // Only react to our own fills / cancels (by user_id).
            if (e.user_id != kUserId) return;
            if (e.kind == ExecutionReport::Kind::Fill) {
                if (e.remaining > 0) return;  // still has size, don't repost yet
                std::lock_guard<std::mutex> lk(mu_);
                our_orders_.erase(e.order_id);
                auto it = states_.find(e.symbol);
                if (it == states_.end()) return;
                State& st = it->second;
                if (e.last_price > 0) st.last_trade_price = e.last_price;
                OrderSide our_side = e.side;
                if (our_side == OrderSide::Buy) st.bid_id = 0;
                else st.ask_id = 0;
                // When tracking trades, requote BOTH sides at the new
                // anchor so the surviving side doesn't sit ~spread_bps
                // away from where the market is now. Otherwise fall back
                // to the old "repost just the filled side" behavior.
                if (cfg_.track_trades && st.last_trade_price > 0) {
                    requote_locked(st);
                } else {
                    post_side(st, our_side);
                }
            } else if (e.kind == ExecutionReport::Kind::CancelAck) {
                std::lock_guard<std::mutex> lk(mu_);
                our_orders_.erase(e.order_id);
                auto it = states_.find(e.symbol);
                if (it == states_.end()) return;
                State& st = it->second;
                if (st.bid_id == e.order_id) st.bid_id = 0;
                if (st.ask_id == e.order_id) st.ask_id = 0;
            }
        } else if constexpr (std::is_same_v<T, TradePrint>) {
            if (!cfg_.track_trades) return;
            std::lock_guard<std::mutex> lk(mu_);
            auto it = states_.find(e.symbol);
            if (it == states_.end()) return;
            State& st = it->second;
            st.last_trade_price = e.price;
            // Drift-driven requote: when the print is far enough from
            // our anchor, our resting quotes are stale relative to where
            // the market is now. Cancel + replace both sides. Cooldown
            // prevents thrash on a burst of prints close together.
            if (st.quote_anchor <= 0 || effective_drift_bps_ <= 0) return;
            const double drift_bps =
                std::abs(e.price - st.quote_anchor) / st.quote_anchor * 10000.0;
            if (drift_bps < effective_drift_bps_) return;
            const auto now = std::chrono::steady_clock::now();
            if (now - st.last_requote_at <
                std::chrono::milliseconds(kRequoteCooldownMs)) return;
            requote_locked(st);
        }
    }, ev);
}

void MarketMakerBot::refresh_loop() {
    while (running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg_.refresh_ms));
        if (!running_.load()) break;
        // Re-seed any sides that aren't currently posted.
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [_, st] : states_) {
            if (st.bid_id == 0) post_side(st, OrderSide::Buy);
            if (st.ask_id == 0) post_side(st, OrderSide::Sell);
        }
    }
}

}  // namespace TradingSystem
