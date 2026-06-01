#pragma once
#include <cstddef>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <vector>

#include "engine/events.hpp"

namespace TradingSystem {

// Bounded in-memory ring of recent TradePrint events. Subscribed to the
// EventBus by main(); read by the REST /trades handler.
class RecentTradesCache {
public:
    explicit RecentTradesCache(std::size_t cap = 256) : cap_(cap) {}

    void push(const TradePrint& t) {
        std::lock_guard<std::mutex> lk(mu_);
        all_.push_front(t);
        if (all_.size() > cap_) all_.pop_back();
        auto& q = by_sym_[t.symbol];
        q.push_front(t);
        if (q.size() > cap_) q.pop_back();
    }

    // Most-recent-first.
    [[nodiscard]] std::vector<TradePrint> get(SymbolId sym, std::size_t limit) const {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = by_sym_.find(sym);
        if (it == by_sym_.end()) return {};
        std::vector<TradePrint> out;
        const auto& q = it->second;
        out.reserve(std::min(limit, q.size()));
        for (auto& t : q) {
            if (out.size() >= limit) break;
            out.push_back(t);
        }
        return out;
    }

    [[nodiscard]] std::vector<TradePrint> get_all(std::size_t limit) const {
        std::lock_guard<std::mutex> lk(mu_);
        std::vector<TradePrint> out;
        out.reserve(std::min(limit, all_.size()));
        for (auto& t : all_) {
            if (out.size() >= limit) break;
            out.push_back(t);
        }
        return out;
    }

private:
    const std::size_t cap_;
    mutable std::mutex mu_;
    std::deque<TradePrint> all_;
    std::unordered_map<SymbolId, std::deque<TradePrint>> by_sym_;
};

}
