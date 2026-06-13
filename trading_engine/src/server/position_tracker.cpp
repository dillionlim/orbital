#include "server/position_tracker.hpp"

#include <algorithm>
#include <variant>

namespace TradingSystem {

PositionTracker::PositionTracker(std::shared_ptr<SymbolRegistry> registry)
    : registry_(std::move(registry)) {
    for (const auto& s : registry_->symbols()) {
        caps_[s.id] = {s.max_long, s.max_short};
    }
}

PositionTracker::~PositionTracker() { stop(); }

void PositionTracker::start(EventBus& bus) {
    bus_ = &bus;
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

void PositionTracker::stop() {
    if (bus_ && sub_id_ != 0) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
}

std::string PositionTracker::compose(std::string_view u, SymbolId s) {
    std::string out;
    out.reserve(u.size() + 1 + 20);
    out.append(u);
    out.push_back(':');
    out.append(std::to_string(s));
    return out;
}

void PositionTracker::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            if (e.user_id.empty()) return;  // anonymous / engine-internal cancels

            std::lock_guard<std::mutex> lk(mu_);
            const std::string key = compose(e.user_id, e.symbol);

            switch (e.kind) {
                case ExecutionReport::Kind::Ack: {
                    // Track this order so we can decrement the open-qty bucket
                    // correctly on later fills / cancels (CancelAck doesn't
                    // carry the remaining qty itself).
                    open_[e.order_id] = OpenOrder{e.user_id, e.symbol, e.side, e.remaining};
                    auto& p = by_user_sym_[key];
                    if (e.side == OrderSide::Buy) p.open_buy  += e.remaining;
                    else                          p.open_sell += e.remaining;
                    break;
                }
                case ExecutionReport::Kind::Fill: {
                    auto& p = by_user_sym_[key];

                    // Move qty from open-bucket to realized position.
                    auto it = open_.find(e.order_id);
                    if (it != open_.end()) {
                        const Quantity dec =
                            std::min<Quantity>(e.last_quantity, it->second.remaining);
                        it->second.remaining -= dec;
                        if (it->second.side == OrderSide::Buy) {
                            p.open_buy = (p.open_buy > dec) ? p.open_buy - dec : 0;
                        } else {
                            p.open_sell = (p.open_sell > dec) ? p.open_sell - dec : 0;
                        }
                        if (it->second.remaining == 0) open_.erase(it);
                    }

                    const int64_t signed_qty = static_cast<int64_t>(e.last_quantity);
                    if (e.side == OrderSide::Buy) p.position += signed_qty;
                    else                          p.position -= signed_qty;
                    break;
                }
                case ExecutionReport::Kind::CancelAck: {
                    // CancelAck arrives without a remaining field — look up
                    // the OpenOrder we stashed at Ack time to know how much
                    // to deduct, and from which user/side bucket.
                    auto it = open_.find(e.order_id);
                    if (it != open_.end()) {
                        const OpenOrder oo = it->second;
                        const std::string ckey = compose(oo.user_id, oo.symbol);
                        auto& p = by_user_sym_[ckey];
                        if (oo.side == OrderSide::Buy) {
                            p.open_buy  = (p.open_buy  > oo.remaining) ? p.open_buy  - oo.remaining : 0;
                        } else {
                            p.open_sell = (p.open_sell > oo.remaining) ? p.open_sell - oo.remaining : 0;
                        }
                        open_.erase(it);
                    }
                    break;
                }
                case ExecutionReport::Kind::Reject:
                    // Pre-trade rejects never reserved qty; nothing to undo.
                    break;
            }
        }
    }, ev);
}

bool PositionTracker::would_breach(std::string_view user_id, SymbolId symbol,
                                   OrderSide side, Quantity qty,
                                   bool is_internal) const {
    if (is_internal) return false;
    if (qty == 0) return false;

    Quantity max_long  = kNoPositionLimit;
    Quantity max_short = kNoPositionLimit;
    if (auto it = caps_.find(symbol); it != caps_.end()) {
        max_long  = it->second.first;
        max_short = it->second.second;
    }
    if (max_long == kNoPositionLimit && max_short == kNoPositionLimit) return false;

    std::lock_guard<std::mutex> lk(mu_);
    const std::string key = compose(user_id, symbol);
    Position p{};
    if (auto it = by_user_sym_.find(key); it != by_user_sym_.end()) p = it->second;

    if (side == OrderSide::Buy) {
        if (max_long == kNoPositionLimit) return false;
        // Worst-case long exposure if every working buy filled, plus this new one.
        const int64_t hypo = p.position
                           + static_cast<int64_t>(p.open_buy)
                           + static_cast<int64_t>(qty);
        return hypo > static_cast<int64_t>(max_long);
    } else {
        if (max_short == kNoPositionLimit) return false;
        // Worst-case short exposure if every working sell filled, plus this new one.
        const int64_t hypo = p.position
                           - static_cast<int64_t>(p.open_sell)
                           - static_cast<int64_t>(qty);
        return hypo < -static_cast<int64_t>(max_short);
    }
}

PositionTracker::Position PositionTracker::get(std::string_view user_id,
                                               SymbolId symbol) const {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_user_sym_.find(compose(user_id, symbol));
    return (it != by_user_sym_.end()) ? it->second : Position{};
}

}  // namespace TradingSystem
