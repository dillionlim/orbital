#pragma once
#include "book/order.hpp"
#include "common/types.hpp"

namespace TradingSystem {

// One price point in the book. Resting orders form an intrusive FIFO through
// Order::prev_/next_ (arrival order = time priority), so adding or removing an
// order is a handful of pointer writes with no list-node allocation. head_ is
// the front of the queue (matches first); tail_ is where new orders append.
struct PriceLevel {
    Price price = 0.0;
    Quantity aggregate_qty = 0;
    Order* head = nullptr;
    Order* tail = nullptr;

    // Append a resting order to the back of the FIFO.
    void push_back(Order* o) {
        o->prev_ = tail;
        o->next_ = nullptr;
        o->level_ = this;
        if (tail) {
            tail->next_ = o;
        } else {
            head = o;
        }
        tail = o;
    }

    // Unlink an order that belongs to this level (front pop, cancel, or STP).
    void unlink(Order* o) {
        if (o->prev_) {
            o->prev_->next_ = o->next_;
        } else {
            head = o->next_;
        }
        if (o->next_) {
            o->next_->prev_ = o->prev_;
        } else {
            tail = o->prev_;
        }
    }

    [[nodiscard]] bool empty() const { return head == nullptr; }
};

}  // namespace TradingSystem
