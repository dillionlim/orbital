#pragma once
#include <algorithm>
#include <concepts>
#include <functional>
#include <mutex>
#include <utility>
#include <vector>

#include "engine/events.hpp"

namespace TradingSystem {

// Subscriber callback shape: anything invocable with `const OutboundEvent&`.
template <typename H>
concept EventHandler = std::invocable<H, const OutboundEvent&>;

// Synchronous fan-out, but publishes use a snapshot of the subscriber list so
// matching threads don't serialize on subscribe/unsubscribe. Subscribers should
// still keep their callbacks fast (push to their own queue and return).
class EventBus {
public:
    using Handler = std::function<void(const OutboundEvent&)>;
    using SubscriberId = uint64_t;

    template <EventHandler H>
    SubscriberId subscribe(H&& cb) {
        std::lock_guard<std::mutex> lk(mu_);
        SubscriberId id = ++next_id_;
        subs_.emplace_back(id, Handler{std::forward<H>(cb)});
        return id;
    }

    void unsubscribe(SubscriberId id) {
        std::lock_guard<std::mutex> lk(mu_);
        subs_.erase(std::remove_if(subs_.begin(), subs_.end(),
                                   [&](auto& p) { return p.first == id; }),
                    subs_.end());
    }

    void publish(const OutboundEvent& ev) {
        std::vector<std::pair<SubscriberId, Handler>> snap;
        {
            std::lock_guard<std::mutex> lk(mu_);
            snap = subs_;
        }
        for (auto& [_, cb] : snap) cb(ev);
    }

private:
    std::mutex mu_;
    SubscriberId next_id_ = 0;
    std::vector<std::pair<SubscriberId, Handler>> subs_;
};

}
