#include "server/snapshot_store.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>
#include <variant>

namespace TradingSystem {

SnapshotStore::~SnapshotStore() { stop(); }

void SnapshotStore::start(EventBus& bus) {
    bus_ = &bus;
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

void SnapshotStore::stop() {
    if (bus_ && sub_id_) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
}

void SnapshotStore::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, BookDelta>) {
            apply(e);
        }
    }, ev);
}

namespace {

// In-place: merge `changes` into `side`. qty=0 removes; qty>0 sets/adds.
void merge_changes(std::vector<BookLevel>& side, const std::vector<BookLevel>& changes) {
    for (const auto& c : changes) {
        auto pos = std::find_if(side.begin(), side.end(),
                                [&](const BookLevel& l) { return l.price == c.price; });
        if (c.qty == 0) {
            if (pos != side.end()) side.erase(pos);
        } else if (pos != side.end()) {
            pos->qty = c.qty;
        } else {
            side.push_back(c);
        }
    }
}

void sort_sides(BookSnapshotEvent& s) {
    std::sort(s.bids.begin(), s.bids.end(),
              [](const BookLevel& a, const BookLevel& b) { return a.price > b.price; });
    std::sort(s.asks.begin(), s.asks.end(),
              [](const BookLevel& a, const BookLevel& b) { return a.price < b.price; });
}

}  // namespace

void SnapshotStore::apply(const BookDelta& d) {
    std::lock_guard<std::mutex> lk(mu_);

    if (d.snapshot) {
        auto next = std::make_shared<BookSnapshotEvent>();
        next->symbol = d.symbol;
        next->ts = d.ts;
        next->seq = d.seq;
        next->bids = d.bid_changes;
        next->asks = d.ask_changes;
        sort_sides(*next);
        by_sym_[d.symbol] = std::move(next);
        return;
    }

    auto it = by_sym_.find(d.symbol);
    if (it == by_sym_.end()) {
        // No baseline yet — drop. The shard's startup snapshot will catch us up.
        return;
    }
    auto next = std::make_shared<BookSnapshotEvent>(*it->second);
    next->ts = d.ts;
    next->seq = d.seq;
    merge_changes(next->bids, d.bid_changes);
    merge_changes(next->asks, d.ask_changes);
    sort_sides(*next);
    by_sym_[d.symbol] = std::move(next);
}

std::shared_ptr<const BookSnapshotEvent> SnapshotStore::get(SymbolId sym) const {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_sym_.find(sym);
    if (it == by_sym_.end()) return nullptr;
    return it->second;
}

}  // namespace TradingSystem
