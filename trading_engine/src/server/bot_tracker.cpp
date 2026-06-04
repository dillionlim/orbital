#include "server/bot_tracker.hpp"

#include <algorithm>
#include <utility>
#include <variant>

#include "common/time.hpp"

namespace TradingSystem {

namespace {

constexpr int64_t kHourMs = 60 * 60 * 1000;
constexpr int64_t kActiveWindowMs = 30 * 1000;
constexpr const char* kMmUserId = "internal:market_maker";

std::string short_user_label(const std::string& uid) {
    if (uid.size() > 12) return "user:" + uid.substr(0, 8);
    return uid.empty() ? "anon" : uid;
}

}  // namespace

BotTracker::~BotTracker() { stop(); }

void BotTracker::start(EventBus& bus, std::shared_ptr<SnapshotStore> snapshots) {
    bus_ = &bus;
    snapshots_ = std::move(snapshots);
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

void BotTracker::stop() {
    if (bus_ && sub_id_) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
}

void BotTracker::note_client_id(const std::string& user_id, const std::string& client_id) {
    if (user_id.empty() || client_id.empty()) return;
    std::lock_guard<std::mutex> lk(mu_);
    user_to_client_[user_id] = client_id;
    auto& s = by_key_[client_id];
    if (s.user_id.empty()) s.user_id = user_id;
    if (s.client_id.empty()) s.client_id = client_id;
    if (s.first_seen == 0) s.first_seen = now_ms();
    s.last_activity = now_ms();
}

void BotTracker::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            if (e.user_id.empty()) return;
            std::lock_guard<std::mutex> lk(mu_);

            // Resolve the effective client_id: prefer the one on this event, fall
            // back to whatever we last saw for this user. Maker fills (which the
            // engine tags with the resting order's client_id) flow naturally; for
            // older code paths the cache fills the gap.
            std::string client_id = e.client_id;
            if (client_id.empty()) {
                auto cit = user_to_client_.find(e.user_id);
                if (cit != user_to_client_.end()) client_id = cit->second;
            } else {
                user_to_client_[e.user_id] = client_id;
            }
            const std::string key = client_id.empty() ? e.user_id : client_id;

            auto& s = by_key_[key];
            if (s.user_id.empty()) s.user_id = e.user_id;
            if (s.client_id.empty()) s.client_id = client_id;
            s.is_internal = s.is_internal || e.is_internal ||
                            (e.user_id == kMmUserId);
            if (s.first_seen == 0) s.first_seen = e.ts ? e.ts : now_ms();
            s.last_activity = e.ts ? e.ts : now_ms();

            if (e.kind == ExecutionReport::Kind::Ack) {
                s.orders_placed++;
            } else if (e.kind == ExecutionReport::Kind::Fill && e.last_quantity > 0) {
                const double notional =
                    e.last_price * static_cast<double>(e.last_quantity);
                const double cash_delta =
                    (e.side == OrderSide::Sell) ? +notional : -notional;
                const int64_t pos_delta = (e.side == OrderSide::Buy)
                    ? static_cast<int64_t>(e.last_quantity)
                    : -static_cast<int64_t>(e.last_quantity);
                s.cash_realized += cash_delta;
                s.positions[e.symbol] += pos_delta;
                s.fills++;
                s.volume += e.last_quantity;
                s.recent_fills.push_back({s.last_activity, e.symbol, pos_delta, cash_delta});
                prune_old(s.recent_fills, s.last_activity);
            }
        }
    }, ev);
}

void BotTracker::prune_old(std::deque<Fill>& q, Timestamp now) {
    while (!q.empty() && (now - q.front().ts) > static_cast<uint64_t>(kHourMs)) {
        q.pop_front();
    }
}

double BotTracker::mark_value(const State& s) const {
    if (!snapshots_) return 0.0;
    double mark = 0.0;
    for (const auto& [sym, qty] : s.positions) {
        if (qty == 0) continue;
        auto snap = snapshots_->get(sym);
        if (!snap) continue;
        double bid = snap->bids.empty() ? 0.0 : snap->bids.front().price;
        double ask = snap->asks.empty() ? 0.0 : snap->asks.front().price;
        double mid = 0.0;
        if (bid > 0 && ask > 0) mid = (bid + ask) / 2.0;
        else if (bid > 0) mid = bid;
        else if (ask > 0) mid = ask;
        mark += static_cast<double>(qty) * mid;
    }
    return mark;
}

std::vector<BotTracker::BotSnapshot> BotTracker::snapshot() const {
    std::vector<BotSnapshot> out;
    Timestamp now = now_ms();
    std::lock_guard<std::mutex> lk(mu_);
    out.reserve(by_key_.size());
    for (const auto& [_, s] : by_key_) {
        BotSnapshot b;
        b.user_id = s.user_id;
        b.client_id = s.client_id;
        b.is_internal = s.is_internal;
        if (s.is_internal) {
            b.display_name = !s.client_id.empty() ? s.client_id : "Market Maker";
            b.strategy_name = "Spread quotes (in-process)";
        } else {
            b.display_name = !s.client_id.empty() ? s.client_id : short_user_label(s.user_id);
            b.strategy_name = "External bot";
        }
        b.status = (now - s.last_activity) <= static_cast<uint64_t>(kActiveWindowMs)
                       ? "active" : "paused";
        b.orders_placed = s.orders_placed;
        b.fills = s.fills;
        b.volume = s.volume;
        b.first_seen = s.first_seen;
        b.last_activity = s.last_activity;
        b.total_pnl = s.cash_realized + mark_value(s);

        // Hourly PnL ≈ change in (cash + mark) over the last hour. Assuming mark
        // prices haven't drifted significantly in the window, the contribution of
        // each in-window fill is (cash_delta + pos_delta × current_mark).
        double hourly = 0.0;
        for (const auto& f : s.recent_fills) {
            if ((now - f.ts) > static_cast<uint64_t>(kHourMs)) continue;
            double mid = 0.0;
            if (snapshots_) {
                if (auto snap = snapshots_->get(f.symbol)) {
                    double bid = snap->bids.empty() ? 0.0 : snap->bids.front().price;
                    double ask = snap->asks.empty() ? 0.0 : snap->asks.front().price;
                    if (bid > 0 && ask > 0) mid = (bid + ask) / 2.0;
                    else if (bid > 0) mid = bid;
                    else if (ask > 0) mid = ask;
                }
            }
            hourly += f.cash_delta + static_cast<double>(f.pos_delta) * mid;
        }
        b.hourly_pnl = hourly;
        out.push_back(std::move(b));
    }
    // Sort: internal first, then by total_pnl desc, then by display name.
    std::sort(out.begin(), out.end(), [](const BotSnapshot& a, const BotSnapshot& b) {
        if (a.is_internal != b.is_internal) return a.is_internal;
        if (a.total_pnl != b.total_pnl) return a.total_pnl > b.total_pnl;
        return a.display_name < b.display_name;
    });
    return out;
}

}  // namespace TradingSystem
