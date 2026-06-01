#pragma once
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>

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

    [[nodiscard]] size_t size() const;

private:
    mutable std::mutex mu_;
    std::unordered_map<SessionId, SessionPtr> by_id_;
    SessionId next_id_ = 1;     // 0 reserved for internal session
    SessionPtr internal_;
};

}
