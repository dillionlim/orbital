#include "server/market_flow.hpp"

#include <algorithm>
#include <cmath>
#include <variant>

namespace TradingSystem {

MarketFlow::MarketFlow(double alpha, size_t vol_window)
    : alpha_(alpha), vol_window_(vol_window) {}

MarketFlow::~MarketFlow() { stop(); }

void MarketFlow::start(EventBus& bus) {
    bus_ = &bus;
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

void MarketFlow::stop() {
    if (bus_ && sub_id_) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
}

void MarketFlow::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, TradePrint>) {
            std::lock_guard<std::mutex> lk(mu_);

            // ---- flow EMA -----------------------------------------------
            // Sign is +1 if the taker was a Buy (someone consumed an ask,
            // pressuring price up) and -1 for a Sell taker. Weight by
            // quantity but cap so one whale can't pin the EMA at ±1.
            const double sign = (e.taker_side == OrderSide::Buy) ? 1.0 : -1.0;
            const double weight = std::min(static_cast<double>(e.quantity), 50.0);
            ema_ = ema_ * (1.0 - alpha_) + sign * weight * alpha_ / 50.0;
            if (ema_ >  1.0) ema_ =  1.0;
            if (ema_ < -1.0) ema_ = -1.0;

            // ---- realized volatility -----------------------------------
            // log-return between consecutive prints. Bounded buffer: we
            // pop the oldest once we exceed the configured window.
            if (last_price_ > 0.0 && e.price > 0.0) {
                const double r = std::log(e.price / last_price_);
                recent_returns_.push_back(r);
                while (recent_returns_.size() > vol_window_) recent_returns_.pop_front();
            }
            last_price_ = e.price;
        }
    }, ev);
}

double MarketFlow::bias() const {
    std::lock_guard<std::mutex> lk(mu_);
    return ema_;
}

double MarketFlow::volatility() const {
    std::lock_guard<std::mutex> lk(mu_);
    if (recent_returns_.size() < 2) return 0.0;
    double mean = 0.0;
    for (double r : recent_returns_) mean += r;
    mean /= static_cast<double>(recent_returns_.size());
    double sq = 0.0;
    for (double r : recent_returns_) {
        const double d = r - mean;
        sq += d * d;
    }
    return std::sqrt(sq / static_cast<double>(recent_returns_.size()));
}

}  // namespace TradingSystem
