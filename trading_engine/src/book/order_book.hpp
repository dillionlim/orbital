#pragma once
#include <functional>
#include <map>
#include <string_view>
#include <vector>

#include "book/order.hpp"
#include "book/order_index.hpp"
#include "book/price_level.hpp"
#include "common/object_pool.hpp"
#include "common/types.hpp"

namespace TradingSystem {

struct BookLevel {
    Price price;
    Quantity qty;
};

class OrderBook {
public:
    explicit OrderBook(SymbolId symbol) : symbol_(symbol) {}
    ~OrderBook();

    OrderBook(const OrderBook&) = delete;
    OrderBook& operator=(const OrderBook&) = delete;

    [[nodiscard]] SymbolId symbol_id() const { return symbol_; }

    // Apply a new order described by `in`. A pooled Order is materialised only
    // if a remainder rests; market orders and fully-crossing limits allocate
    // nothing. Caller pre-fills in.id via Sequencer.
    [[nodiscard]] ApplyResult apply(const OrderInput& in);

    // Cancel by id; user_id must match (unless empty == admin/internal).
    [[nodiscard]] CancelOutcome cancel(OrderId id, std::string_view user_id_must_match);

    // L2 snapshots
    [[nodiscard]] std::vector<BookLevel> top_n_bids(size_t n) const;
    [[nodiscard]] std::vector<BookLevel> top_n_asks(size_t n) const;

    [[nodiscard]] Price best_bid() const;   // 0 if no bid
    [[nodiscard]] Price best_ask() const;   // 0 if no ask

    [[nodiscard]] size_t open_orders() const { return by_id_.size(); }

private:
    // Unlink a resting order from its level, drop it from the id index, and
    // return it to the pool. Erases the level if it becomes empty.
    void erase_resting(Order* o);

    SymbolId symbol_;
    std::map<Price, PriceLevel, std::greater<Price>> bids_;   // descending
    std::map<Price, PriceLevel> asks_;                         // ascending
    ObjectPool<Order> pool_;
    OrderIndex by_id_;
};

}
