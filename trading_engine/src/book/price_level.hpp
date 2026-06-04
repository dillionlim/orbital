#pragma once
#include <list>

#include "book/order.hpp"
#include "common/types.hpp"

namespace TradingSystem {

// Marker alias to make non-owning intent unmistakable at the use site.
// `OrderBook::by_id_` is the sole owner of every Order; price levels hold
// observer pointers into that map.
template <typename T>
using NonOwning = T*;

struct PriceLevel {
    Price price = 0.0;
    Quantity aggregate_qty = 0;
    std::list<NonOwning<Order>> orders;
};

}
