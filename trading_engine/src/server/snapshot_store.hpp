#pragma once
#include <memory>
#include <mutex>
#include <unordered_map>

#include "engine/events.hpp"

namespace TradingSystem {

// Caches the latest BookSnapshotEvent per symbol so the REST /orderbook handler
// can serve a current view without touching the matching thread directly.
class SnapshotStore {
public:
    void publish(std::shared_ptr<const BookSnapshotEvent> snap) {
        std::lock_guard<std::mutex> lk(mu_);
        by_sym_[snap->symbol] = std::move(snap);
    }

    [[nodiscard]] std::shared_ptr<const BookSnapshotEvent> get(SymbolId sym) const {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = by_sym_.find(sym);
        if (it == by_sym_.end()) return nullptr;
        return it->second;
    }

private:
    mutable std::mutex mu_;
    std::unordered_map<SymbolId, std::shared_ptr<const BookSnapshotEvent>> by_sym_;
};

}
