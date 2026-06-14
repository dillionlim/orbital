#pragma once
#include <cstddef>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "engine/events.hpp"

namespace TradingSystem {

// One executed fill belonging to a specific user (their side of a trade).
struct UserFill {
    uint64_t trade_id = 0;
    SymbolId symbol = 0;
    OrderSide side = OrderSide::Buy;
    Price price = 0.0;
    Quantity quantity = 0;
    Timestamp ts = 0;
};

// Bounded in-memory ring of recent fills keyed by user_id. Fed from the
// ExecutionReport stream (Fill kind) on the EventBus; read by the REST
// /me/fills handler (gated by the caller's API key). Internal bots (MM, news)
// are skipped so the cache only holds real users' executions.
class UserFillsCache {
public:
    explicit UserFillsCache(std::size_t cap = 128) : cap_(cap) {}

    void push(const std::string& user_id, const UserFill& f) {
        if (user_id.empty()) return;
        std::lock_guard<std::mutex> lk(mu_);
        auto& q = by_user_[user_id];
        q.push_front(f);
        if (q.size() > cap_) q.pop_back();
    }

    // Most-recent-first.
    [[nodiscard]] std::vector<UserFill> get(const std::string& user_id,
                                            std::size_t limit) const {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = by_user_.find(user_id);
        if (it == by_user_.end()) return {};
        std::vector<UserFill> out;
        out.reserve(std::min(limit, it->second.size()));
        for (const auto& f : it->second) {
            if (out.size() >= limit) break;
            out.push_back(f);
        }
        return out;
    }

private:
    const std::size_t cap_;
    mutable std::mutex mu_;
    std::unordered_map<std::string, std::deque<UserFill>> by_user_;
};

}  // namespace TradingSystem
