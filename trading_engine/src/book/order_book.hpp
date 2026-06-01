#pragma once
#include <list>
#include <map>
#include <memory>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "book/order.hpp"
#include "book/price_level.hpp"
#include "common/types.hpp"

namespace TradingSystem {

struct BookLevel {
    Price price;
    Quantity qty;
};

class OrderBook {
public:
    explicit OrderBook(SymbolId symbol) : symbol_(symbol) {}

    [[nodiscard]] SymbolId symbol_id() const { return symbol_; }

    // Apply a new order. Order is consumed (ownership taken on rest, dropped on full fill / reject).
    // Caller pre-fills order->id via Sequencer.
    [[nodiscard]] ApplyResult apply(std::unique_ptr<Order> order);

    // Cancel by id; user_id must match (unless empty == admin/internal).
    [[nodiscard]] CancelOutcome cancel(OrderId id, std::string_view user_id_must_match);

    // L2 snapshots
    [[nodiscard]] std::vector<BookLevel> top_n_bids(size_t n) const;
    [[nodiscard]] std::vector<BookLevel> top_n_asks(size_t n) const;

    [[nodiscard]] Price best_bid() const;   // 0 if no bid
    [[nodiscard]] Price best_ask() const;   // 0 if no ask

    [[nodiscard]] size_t open_orders() const { return by_id_.size(); }

private:
    struct Resting {
        std::unique_ptr<Order> order;
        Price level_price;
        OrderSide side;
        std::list<NonOwning<Order>>::iterator level_iter;
    };

    void erase_resting(OrderId id);

    SymbolId symbol_;
    std::map<Price, PriceLevel, std::greater<Price>> bids_;   // descending
    std::map<Price, PriceLevel> asks_;                         // ascending
    std::unordered_map<OrderId, Resting> by_id_;
};

}
