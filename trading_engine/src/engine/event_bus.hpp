#pragma once
#include <algorithm>
#include <concepts>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <utility>
#include <vector>

#include "engine/events.hpp"

namespace TradingSystem {

// Subscriber callback shape: anything invocable with `const OutboundEvent&`.
template <typename H>
concept EventHandler = std::invocable<H, const OutboundEvent&>;

// Synchronous fan-out. Publishes take the lock in shared mode, so matching
// threads still fan out concurrently with each other; only subscribe and
// unsubscribe are exclusive. Subscribers should keep their callbacks fast (push
// to their own queue and return).
//
// unsubscribe() blocks until every in-flight publish has finished, which is what
// makes it safe to destroy a subscriber right after unsubscribing — every
// subscriber here captures `this`, so a callback that outlives its owner is a
// use-after-free. Callbacks therefore must not call back into the bus
// (subscribe, unsubscribe, or publish): re-entering while holding the shared
// lock deadlocks against any waiting writer.
class EventBus {
public:
    using Handler = std::function<void(const OutboundEvent&)>;
    using SubscriberId = uint64_t;

    template <EventHandler H>
    SubscriberId subscribe(H&& cb) {
        std::unique_lock<std::shared_mutex> lk(mu_);
        SubscriberId id = ++next_id_;
        subs_.emplace_back(id, Handler{std::forward<H>(cb)});
        return id;
    }

    void unsubscribe(SubscriberId id) {
        std::unique_lock<std::shared_mutex> lk(mu_);
        subs_.erase(std::remove_if(subs_.begin(), subs_.end(),
                                   [&](auto& p) { return p.first == id; }),
                    subs_.end());
    }

    void publish(const OutboundEvent& ev) {
        std::shared_lock<std::shared_mutex> lk(mu_);
        for (const auto& [_, cb] : subs_) cb(ev);
    }

private:
    std::shared_mutex mu_;
    SubscriberId next_id_ = 0;
    std::vector<std::pair<SubscriberId, Handler>> subs_;
};

}
