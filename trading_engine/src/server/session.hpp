#pragma once
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

#include "common/types.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

struct Session {
    SessionId id = 0;
    int sockfd = -1;
    std::string user_id;
    std::string client_id;          // optional: bot-provided
    std::string api_key;
    bool is_internal = false;       // in-process producer (MM bot)
    std::atomic<bool> alive{true};

    // Subscriptions. Protected by sub_mu_.
    std::mutex sub_mu;
    std::set<SymbolId> subscribed_books;
    std::set<SymbolId> subscribed_trades;

    // Outbound write serialization.
    std::mutex write_mu;

    // Maps order_id → currently outstanding by this session, for routing maker fills.
    std::mutex orders_mu;
    std::set<OrderId> own_orders;
};

using SessionPtr = std::shared_ptr<Session>;

class SessionRegistry {
public:
    SessionPtr create(int sockfd, std::string_view api_key, std::string_view user_id);
    SessionPtr internal_session();
    void erase(SessionId id);

    [[nodiscard]] SessionPtr by_id(SessionId id) const;
    [[nodiscard]] SessionPtr by_user(std::string_view user_id) const;  // returns first match

    // Visit all live sessions.
    void for_each(const std::function<void(const SessionPtr&)>& fn) const;

    // Force-disconnect every live session whose `(user_id, client_id)` pair
    // matches. Used by the pause endpoint to drop already-connected bots so
    // they have to reconnect (and hit the dispatcher's pause check). Filtering
    // by user_id is mandatory: two distinct users may share a client_id, and
    // one user's pause must not kick the other's session. Returns the number
    // of sessions kicked. The shutdown(SHUT_RDWR) unblocks the reader thread
    // which then exits its loop, closes the fd, and erases the session.
    size_t kick_by_client_id(std::string_view user_id, std::string_view client_id);

    // Snapshot of all `user_id::client_id` composites currently holding a
    // live, non-internal WS session. Used by BotTracker to distinguish
    // "connected but quiet" (idle) from "previously connected, now gone"
    // (error). Composite key matches BotTracker::compose_key.
    [[nodiscard]] std::unordered_set<std::string> connected_client_ids() const;

    [[nodiscard]] size_t size() const;

private:
    mutable std::mutex mu_;
    std::unordered_map<SessionId, SessionPtr> by_id_;
    SessionId next_id_ = 1;     // 0 reserved for internal session
    SessionPtr internal_;
};

}
