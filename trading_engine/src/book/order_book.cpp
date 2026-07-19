#include "book/order_book.hpp"

#include <algorithm>
#include <string>

#include "common/time.hpp"

namespace TradingSystem {

OrderBook::~OrderBook() {
    // Run ~Order() on everything still resting so their std::strings are freed.
    // The pool's storage is released with the pool itself.
    auto drain = [this](auto& book_map) {
        for (auto& [px, level] : book_map) {
            Order* o = level.head;
            while (o) {
                Order* next = o->next_;
                pool_.destroy(o);
                o = next;
            }
        }
    };
    drain(bids_);
    drain(asks_);
}

ApplyResult OrderBook::apply(const OrderInput& in) {
    ApplyResult result;
    result.order_id = in.id;

    // Reject a duplicate id before touching the book: a later insert would drop
    // the duplicate after linking it into a level, dangling that pointer.
    if (by_id_.find(in.id) != nullptr) {
        result.status = OrderStatus::Rejected;
        result.reject_reason = "duplicate_order_id";
        return result;
    }

    const bool is_market = (in.type == OrderType::Market);
    const bool is_buy = (in.side == OrderSide::Buy);

    // Taker working state lives on the stack — no allocation unless it rests.
    const Quantity taker_qty = in.quantity;
    Quantity taker_filled = 0;
    auto taker_remaining = [&] {
        return taker_qty > taker_filled ? taker_qty - taker_filled : 0;
    };

    auto crossable_buy_ask = [&](Price ask) {
        return is_market || ask <= in.limit_price;
    };
    auto crossable_sell_bid = [&](Price bid) {
        return is_market || bid >= in.limit_price;
    };

    Price total_value = 0.0;
    // Capture the maker's residual qty *after* this fill so the maker-side
    // ExecutionReport carries an accurate `remaining` (see matching_engine).
    auto record_fill = [&](Order& maker, Price level_price, Quantity match) {
        result.fills.push_back(FillReport{
            .taker_order_id  = in.id,
            .maker_order_id  = maker.id,
            .symbol          = in.symbol,
            .price           = level_price,
            .quantity        = match,
            .maker_remaining = maker.remaining() - match,  // post-fill residual
            .taker_side      = in.side,
            .ts              = now_ms(),
            .trade_id        = 0,                          // assigned by MatchingEngine
            .taker_user_id   = std::string(in.user_id),
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
        while (taker_remaining() > 0 && !level.empty()) {
            Order* maker = level.head;
            // Self-trade prevention: same non-empty user_id cancels the maker.
            if (!maker->user_id.empty() && maker->user_id == in.user_id) {
                result.stp_cancels.push_back(CancelOutcome{
                    .ok        = true,
                    .order_id  = maker->id,
                    .symbol    = in.symbol,
                    .user_id   = maker->user_id,
                    .remaining = maker->remaining(),
                    .reason    = "self_trade_prevention",
                });
                level.aggregate_qty -= maker->remaining();
                level.unlink(maker);
                by_id_.erase(maker->id);
                pool_.destroy(maker);
                continue;
            }

            const Quantity match = std::min(taker_remaining(), maker->remaining());
            record_fill(*maker, level_price, match);
            maker->filled += match;
            taker_filled += match;
            level.aggregate_qty -= match;

            if (maker->remaining() == 0) {
                level.unlink(maker);
                by_id_.erase(maker->id);
                pool_.destroy(maker);
            }
        }
        if (level.empty()) book_map.erase(it);
        return taker_remaining() > 0;
    };

    if (is_buy) {
        while (taker_remaining() > 0 && !asks_.empty()) {
            if (!consume_level(asks_, crossable_buy_ask)) break;
        }
    } else {
        while (taker_remaining() > 0 && !bids_.empty()) {
            if (!consume_level(bids_, crossable_sell_bid)) break;
        }
    }

    result.filled_total = taker_filled;
    result.avg_price = (taker_filled > 0) ? total_value / static_cast<Price>(taker_filled) : 0.0;

    if (taker_remaining() == 0) {
        result.status = OrderStatus::Filled;
        return result;
    }

    if (is_market) {
        if (taker_filled > 0) {
            result.status = OrderStatus::PartiallyFilled;
        } else {
            result.status = OrderStatus::Rejected;
            result.reject_reason = "no_liquidity";
        }
        return result;
    }

    // Limit remainder rests on the book — now (and only now) materialise a
    // pooled Order and copy the caller's strings into it.
    Order* o = pool_.create();
    o->id = in.id;
    o->symbol = in.symbol;
    o->side = in.side;
    o->type = in.type;
    o->quantity = in.quantity;
    o->filled = taker_filled;
    o->limit_price = in.limit_price;
    o->level_price = in.limit_price;
    o->user_id.assign(in.user_id);
    o->client_id.assign(in.client_id);
    o->client_order_id.assign(in.client_order_id);
    o->created_ms = in.created_ms;
    o->is_internal = in.is_internal;

    if (is_buy) {
        auto [lit, _] = bids_.try_emplace(in.limit_price, PriceLevel{in.limit_price, 0, nullptr, nullptr});
        lit->second.push_back(o);
        lit->second.aggregate_qty += o->remaining();
    } else {
        auto [lit, _] = asks_.try_emplace(in.limit_price, PriceLevel{in.limit_price, 0, nullptr, nullptr});
        lit->second.push_back(o);
        lit->second.aggregate_qty += o->remaining();
    }
    by_id_.insert(o->id, o);

    result.status = (taker_filled > 0) ? OrderStatus::PartiallyFilled : OrderStatus::Pending;
    return result;
}

CancelOutcome OrderBook::cancel(OrderId id, std::string_view user_id_must_match) {
    CancelOutcome out;
    out.order_id = id;
    Order* o = by_id_.find(id);
    if (o == nullptr) {
        out.ok = false;
        out.reason = "not_found";
        return out;
    }
    if (!user_id_must_match.empty() && o->user_id != user_id_must_match) {
        out.ok = false;
        out.reason = "owner_mismatch";
        return out;
    }
    out.ok = true;
    out.symbol = o->symbol;
    out.user_id = o->user_id;
    out.remaining = o->remaining();
    erase_resting(o);
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

void OrderBook::erase_resting(Order* o) {
    PriceLevel* level = o->level_;
    level->aggregate_qty -= o->remaining();
    level->unlink(o);
    const bool level_empty = level->empty();
    const Price px = level->price;
    const OrderSide side = o->side;

    by_id_.erase(o->id);
    pool_.destroy(o);

    // A level only empties on its last order's removal, so this by-price erase
    // stays off the common cancel path (the level pointer already gave us O(1)
    // access to everything above).
    if (level_empty) {
        if (side == OrderSide::Buy) {
            bids_.erase(px);
        } else {
            asks_.erase(px);
        }
    }
}

}  // namespace TradingSystem
