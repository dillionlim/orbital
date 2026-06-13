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
        for (auto& [_, st] : states_) requote_locked(st);
    }
    sub_id_ = bus_.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
    running_ = true;
    refresh_thread_ = std::thread([this] { refresh_loop(); });
    LOG_INFO("mm_bot: started; symbols=" << states_.size()
             << " levels=" << cfg_.levels << " size=" << cfg_.size);
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

void MarketMakerBot::update_reference_price(SymbolId symbol, Price price) {
    if (price <= 0) return;
    std::lock_guard<std::mutex> lk(mu_);
    auto it = states_.find(symbol);
    if (it == states_.end()) return;
    it->second.mid = price;
    // Drive the anchor even when track_trades is on: index symbols have no real
    // trades, so last_trade_price would otherwise pin to the stale seed.
    if (cfg_.track_trades) it->second.last_trade_price = price;
    // The refresh loop repaints the ladder once |Δanchor| crosses the threshold.
}

Price MarketMakerBot::anchor_of(const State& st) const {
    return (cfg_.track_trades && st.last_trade_price > 0) ? st.last_trade_price : st.mid;
}

// Per-symbol tick derived from the anchor's magnitude (~4 significant figures),
// floored at 0.01. e.g. 66020→1.0, 6155→0.1, 740→0.01, 22→0.01. Keeps ladder
// levels visually distinct across instruments spanning a 3000x price range.
static Price adaptive_tick(Price p) {
    if (p <= 0) return 0.01;
    const double tick = std::pow(10.0, std::floor(std::log10(p)) - 4.0);
    return std::max(tick, 0.01);
}

void MarketMakerBot::post_ladder_locked(State& st, OrderSide side) {
    const Price anchor = anchor_of(st);
    if (anchor <= 0) return;
    const Price tick = adaptive_tick(anchor);
    // Integer tick grid so the inside brackets the real value: best bid sits on
    // the tick at/just below the anchor, best ask one tick above it.
    const long long base_ticks = static_cast<long long>(std::floor(anchor / tick));
    const int levels = std::max(1, cfg_.levels);
    std::uniform_real_distribution<double> jitter(0.7, 1.3);

    auto& ids = (side == OrderSide::Buy) ? st.bid_ids : st.ask_ids;
    for (int i = 0; i < levels; ++i) {
        const long long lvl = (side == OrderSide::Buy) ? (base_ticks - i)
                                                       : (base_ticks + 1 + i);
        Price px = static_cast<double>(lvl) * tick;
        px = std::round(px * 100.0) / 100.0;  // guard fp drift at 2dp
        if (px <= 0) continue;

        // Depth grows with distance from the top, with a little jitter so the
        // book looks organic rather than a perfect geometric ladder.
        Quantity qty = static_cast<Quantity>(
            std::max(1.0, std::round(cfg_.size * (1.0 + 0.4 * i) * jitter(rng_))));

        PlaceOrderCmd cmd;
        cmd.symbol = st.symbol;
        cmd.side = side;
        cmd.type = OrderType::Limit;
        cmd.quantity = qty;
        cmd.limit_price = px;
        cmd.user_id = kUserId;
        cmd.client_id = "Market Maker";   // surfaces as the bot label in the dashboard
        cmd.client_order_id = std::string("mm-") + (side == OrderSide::Buy ? "bid-" : "ask-")
                              + std::to_string(st.symbol) + "-" + std::to_string(i);
        cmd.session_id = kInternalSession;
        cmd.is_internal = true;
        cmd.ts = now_ms();

        OrderId oid = seq_.submit_place(std::move(cmd));
        if (oid == 0) {
            LOG_WARN("mm_bot: place rejected symbol_id=" << st.symbol << " level=" << i);
            continue;
        }
        ids.push_back(oid);
        our_orders_.insert(oid);
    }
}

void MarketMakerBot::cancel_side_locked(State& st, OrderSide side) {
    auto& ids = (side == OrderSide::Buy) ? st.bid_ids : st.ask_ids;
    for (OrderId id : ids) {
        our_orders_.erase(id);
        CancelOrderCmd c;
        c.order_id = id;
        c.user_id = kUserId;
        c.session_id = kInternalSession;
        c.ts = now_ms();
        seq_.submit_cancel(std::move(c));
    }
    ids.clear();
}

void MarketMakerBot::requote_locked(State& st) {
    cancel_side_locked(st, OrderSide::Buy);
    cancel_side_locked(st, OrderSide::Sell);
    // Flush transient churn orders too — they sit at the old inside.
    for (OrderId id : st.churn_ids) {
        our_orders_.erase(id);
        CancelOrderCmd c;
        c.order_id = id;
        c.user_id = kUserId;
        c.session_id = kInternalSession;
        c.ts = now_ms();
        seq_.submit_cancel(std::move(c));
    }
    st.churn_ids.clear();
    post_ladder_locked(st, OrderSide::Buy);
    post_ladder_locked(st, OrderSide::Sell);
    st.quoted_anchor = anchor_of(st);
}

// Adds one small transient order at a random top level (and retires the oldest
// once the pool is full), so the inside size keeps moving like real order flow
// even when the anchor is static. The resting ladder is untouched — no blink.
void MarketMakerBot::churn_step_locked(State& st) {
    if (cfg_.churn_depth <= 0) return;
    const Price anchor = anchor_of(st);
    if (anchor <= 0) return;
    const Price tick = adaptive_tick(anchor);
    const long long base_ticks = static_cast<long long>(std::floor(anchor / tick));

    std::uniform_int_distribution<int> lvl_d(0, std::min(2, std::max(0, cfg_.levels - 1)));
    std::uniform_int_distribution<int> side_d(0, 1);
    std::uniform_real_distribution<double> sz_d(0.3, 1.1);

    const OrderSide side = side_d(rng_) ? OrderSide::Buy : OrderSide::Sell;
    const int i = lvl_d(rng_);
    const long long lvl = (side == OrderSide::Buy) ? (base_ticks - i) : (base_ticks + 1 + i);
    Price px = std::round(static_cast<double>(lvl) * tick * 100.0) / 100.0;
    if (px > 0) {
        const Quantity qty =
            static_cast<Quantity>(std::max(1.0, std::round(cfg_.size * sz_d(rng_))));
        PlaceOrderCmd cmd;
        cmd.symbol = st.symbol;
        cmd.side = side;
        cmd.type = OrderType::Limit;
        cmd.quantity = qty;
        cmd.limit_price = px;
        cmd.user_id = kUserId;
        cmd.client_id = "Market Maker";
        cmd.client_order_id = std::string("mm-churn-") + std::to_string(st.symbol);
        cmd.session_id = kInternalSession;
        cmd.is_internal = true;
        cmd.ts = now_ms();
        OrderId oid = seq_.submit_place(std::move(cmd));
        if (oid != 0) {
            our_orders_.insert(oid);
            st.churn_ids.push_back(oid);
        }
    }

    while (static_cast<int>(st.churn_ids.size()) > cfg_.churn_depth) {
        OrderId old = st.churn_ids.front();
        st.churn_ids.pop_front();
        our_orders_.erase(old);
        CancelOrderCmd c;
        c.order_id = old;
        c.user_id = kUserId;
        c.session_id = kInternalSession;
        c.ts = now_ms();
        seq_.submit_cancel(std::move(c));
    }
}

void MarketMakerBot::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            // Only react to our own fills / cancels (by user_id).
            if (e.user_id != kUserId) return;
            if (e.kind == ExecutionReport::Kind::Fill) {
                if (e.remaining > 0) return;  // partially filled; keep resting
                std::lock_guard<std::mutex> lk(mu_);
                our_orders_.erase(e.order_id);
                auto it = states_.find(e.symbol);
                if (it == states_.end()) return;
                State& st = it->second;
                if (e.last_price > 0) st.last_trade_price = e.last_price;
                auto drop = [&](std::vector<OrderId>& v) {
                    v.erase(std::remove(v.begin(), v.end(), e.order_id), v.end());
                };
                drop(st.bid_ids);
                drop(st.ask_ids);
                st.churn_ids.erase(std::remove(st.churn_ids.begin(), st.churn_ids.end(), e.order_id),
                                   st.churn_ids.end());
                // The refresh loop tops the ladder back up.
            } else if (e.kind == ExecutionReport::Kind::CancelAck) {
                std::lock_guard<std::mutex> lk(mu_);
                our_orders_.erase(e.order_id);
                auto it = states_.find(e.symbol);
                if (it == states_.end()) return;
                State& st = it->second;
                auto drop = [&](std::vector<OrderId>& v) {
                    v.erase(std::remove(v.begin(), v.end(), e.order_id), v.end());
                };
                drop(st.bid_ids);
                drop(st.ask_ids);
                st.churn_ids.erase(std::remove(st.churn_ids.begin(), st.churn_ids.end(), e.order_id),
                                   st.churn_ids.end());
            }
        } else if constexpr (std::is_same_v<T, TradePrint>) {
            if (cfg_.track_trades) {
                std::lock_guard<std::mutex> lk(mu_);
                auto it = states_.find(e.symbol);
                if (it != states_.end()) it->second.last_trade_price = e.price;
            }
        }
    }, ev);
}

void MarketMakerBot::refresh_loop() {
    const int min_levels = std::max(1, cfg_.levels / 2);
    while (running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg_.refresh_ms));
        if (!running_.load()) break;
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& [_, st] : states_) {
            const Price a = anchor_of(st);
            // Repaint when the anchor crosses to a different tick (so the top of
            // book keeps hugging the real value) or when a side has been eaten down.
            const Price tick = adaptive_tick(a > 0 ? a : st.quoted_anchor);
            const bool moved = st.quoted_anchor <= 0 ||
                std::floor(a / tick) != std::floor(st.quoted_anchor / tick);
            const bool depleted = static_cast<int>(st.bid_ids.size()) < min_levels ||
                                  static_cast<int>(st.ask_ids.size()) < min_levels;
            if (moved || depleted) requote_locked(st);
            // Always churn the inside so the top keeps moving even when static.
            churn_step_locked(st);
        }
    }
}

}  // namespace TradingSystem
