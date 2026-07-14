#include "book/order_book.hpp"

#include <algorithm>
#include <utility>

#include "common/time.hpp"

namespace TradingSystem {

ApplyResult OrderBook::apply(std::unique_ptr<Order> order) {
    ApplyResult result;
    Order* o = order.get();
    result.order_id = o->id;

    // by_id_.emplace() below would drop a duplicate id *after* the raw Order* was linked
    // into the price level, leaving the level holding a dangling pointer. Reject up front.
    if (by_id_.count(o->id) != 0) {
        result.status = OrderStatus::Rejected;
        result.reject_reason = "duplicate_order_id";
        return result;
    }

    const bool is_market = (o->type == OrderType::Market);
    const bool is_buy = (o->side == OrderSide::Buy);

    auto crossable_buy_ask = [&](Price ask) {
        return is_market || ask <= o->limit_price;
    };
    auto crossable_sell_bid = [&](Price bid) {
        return is_market || bid >= o->limit_price;
    };

    Price total_value = 0.0;
    // Capture maker's residual qty *after* this fill — needed by the matching layer
    // so the maker-side ExecutionReport carries an accurate `remaining`. Without
    // this, makers see remaining=0 on every partial fill and over-react (e.g. the
    // in-process MM repeatedly reposts and the book grows stale levels).
    auto record_fill = [&](Order& maker, Price level_price, Quantity match) {
        result.fills.push_back(FillReport{
            .taker_order_id  = o->id,
            .maker_order_id  = maker.id,
            .symbol          = o->symbol,
            .price           = level_price,
            .quantity        = match,
            .maker_remaining = maker.remaining() - match,  // post-fill residual
            .taker_side      = o->side,
            .ts              = now_ms(),
            .trade_id        = 0,                          // assigned by MatchingEngine before publishing
            .taker_user_id   = o->user_id,
            .maker_user_id   = maker.user_id,
            .maker_client_id = maker.client_id,
        });
        total_value += level_price * static_cast<Price>(match);
    };

    auto consume_level = [&](auto& book_map, auto it_pred) -> bool {
        auto it = book_map.begin();
        if (it == book_map.end()) return false;
        if (!it_pred(it->first)) return false;
        PriceLevel& level = it->second;
        const Price level_price = it->first;
        while (o->remaining() > 0 && !level.orders.empty()) {
            Order* maker = level.orders.front();
            // Self-trade prevention: same non-empty user_id and not internal-vs-internal exception.
            if (!maker->user_id.empty() && maker->user_id == o->user_id) {
                // Cancel the resting (CancelNewest equivalent for same user).
                result.stp_cancels.push_back(CancelOutcome{
                    .ok        = true,
                    .order_id  = maker->id,
                    .symbol    = o->symbol,
                    .user_id   = maker->user_id,
                    .remaining = maker->remaining(),
                    .reason    = "self_trade_prevention",
                });

                level.aggregate_qty -= maker->remaining();
                level.orders.pop_front();
                by_id_.erase(maker->id);
                continue;
            }

            const Quantity match = std::min(o->remaining(), maker->remaining());
            record_fill(*maker, level_price, match);
            maker->filled += match;
            o->filled += match;
            level.aggregate_qty -= match;

            if (maker->remaining() == 0) {
                level.orders.pop_front();
                by_id_.erase(maker->id);
            }
        }
        if (level.orders.empty()) book_map.erase(it);
        return o->remaining() > 0;
    };

    if (is_buy) {
        while (o->remaining() > 0 && !asks_.empty()) {
            if (!consume_level(asks_, crossable_buy_ask)) break;
        }
    } else {
        while (o->remaining() > 0 && !bids_.empty()) {
            if (!consume_level(bids_, crossable_sell_bid)) break;
        }
    }

    result.filled_total = o->filled;
    result.avg_price = (o->filled > 0) ? total_value / static_cast<Price>(o->filled) : 0.0;

    if (o->remaining() == 0) {
        result.status = OrderStatus::Filled;
        return result;
    }

    if (is_market) {
        if (o->filled > 0) {
            result.status = OrderStatus::PartiallyFilled;
        } else {
            result.status = OrderStatus::Rejected;
            result.reject_reason = "no_liquidity";
        }
        return result;
    }

    // Limit remainder: rest on book.
    o->level_price = o->limit_price;
    if (is_buy) {
        auto [lit, _] = bids_.try_emplace(o->limit_price, PriceLevel{o->limit_price, 0, {}});
        lit->second.orders.push_back(o);
        lit->second.aggregate_qty += o->remaining();
        auto pos = std::prev(lit->second.orders.end());
        by_id_.emplace(o->id, Resting{std::move(order), o->limit_price, OrderSide::Buy, pos});
    } else {
        auto [lit, _] = asks_.try_emplace(o->limit_price, PriceLevel{o->limit_price, 0, {}});
        lit->second.orders.push_back(o);
        lit->second.aggregate_qty += o->remaining();
        auto pos = std::prev(lit->second.orders.end());
        by_id_.emplace(o->id, Resting{std::move(order), o->limit_price, OrderSide::Sell, pos});
    }

    result.status = (o->filled > 0) ? OrderStatus::PartiallyFilled : OrderStatus::Pending;
    return result;
}

CancelOutcome OrderBook::cancel(OrderId id, std::string_view user_id_must_match) {
    CancelOutcome out;
    out.order_id = id;
    auto it = by_id_.find(id);
    if (it == by_id_.end()) {
        out.ok = false;
        out.reason = "not_found";
        return out;
    }
    Order* o = it->second.order.get();
    if (!user_id_must_match.empty() && o->user_id != user_id_must_match) {
        out.ok = false;
        out.reason = "owner_mismatch";
        return out;
    }
    out.ok = true;
    out.symbol = o->symbol;
    out.user_id = o->user_id;
    out.remaining = o->remaining();
    erase_resting(id);
    return out;
}

std::vector<BookLevel> OrderBook::top_n_bids(size_t n) const {
    std::vector<BookLevel> out;
    out.reserve(std::min(n, bids_.size()));
    for (auto it = bids_.begin(); it != bids_.end() && out.size() < n; ++it) {
        out.push_back({it->first, it->second.aggregate_qty});
    }
    return out;
}

std::vector<BookLevel> OrderBook::top_n_asks(size_t n) const {
    std::vector<BookLevel> out;
    out.reserve(std::min(n, asks_.size()));
    for (auto it = asks_.begin(); it != asks_.end() && out.size() < n; ++it) {
        out.push_back({it->first, it->second.aggregate_qty});
    }
    return out;
}

Price OrderBook::best_bid() const { return bids_.empty() ? 0.0 : bids_.begin()->first; }
Price OrderBook::best_ask() const { return asks_.empty() ? 0.0 : asks_.begin()->first; }

void OrderBook::erase_resting(OrderId id) {
    auto it = by_id_.find(id);
    if (it == by_id_.end()) return;
    Resting& r = it->second;
    Order* o = r.order.get();
    if (r.side == OrderSide::Buy) {
        auto lit = bids_.find(r.level_price);
        if (lit != bids_.end()) {
            lit->second.aggregate_qty -= o->remaining();
            lit->second.orders.erase(r.level_iter);
            if (lit->second.orders.empty()) bids_.erase(lit);
        }
    } else {
        auto lit = asks_.find(r.level_price);
        if (lit != asks_.end()) {
            lit->second.aggregate_qty -= o->remaining();
            lit->second.orders.erase(r.level_iter);
            if (lit->second.orders.empty()) asks_.erase(lit);
        }
    }
    by_id_.erase(it);
}

}  // namespace TradingSystem
