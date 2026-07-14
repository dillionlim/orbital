#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
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

// A client that stops reading must not grow our outbound queue without bound. Dropping
// individual frames would corrupt the L2 delta stream, so we disconnect it instead.
inline constexpr size_t kMaxOutboundFrames = 4096;

struct Session {
    SessionId id = 0;
    int sockfd = -1;
    std::string user_id;
    std::string api_key;
    bool is_internal = false;       // in-process producer (MM bot)
    std::atomic<bool> alive{true};

    // Written by the reader thread on hello, read by REST threads (kick/leaderboard).
    mutable std::mutex meta_mu;
    std::string client_id;          // optional: bot-provided; guarded by meta_mu

    // Subscriptions. Protected by sub_mu_.
    std::mutex sub_mu;
    std::set<SymbolId> subscribed_books;
    std::set<SymbolId> subscribed_trades;

    // Outbound write serialization (writer thread; also the reader's pong/close).
    std::mutex write_mu;

    // Outbound queue. EventBus::publish runs on the matching shard's worker thread, so a
    // blocking send to a slow client would stall the shard and halt the whole symbol.
    // Publishers only ever enqueue here; the session's writer thread does the actual I/O.
    std::mutex out_mu;
    std::condition_variable out_cv;
    std::deque<std::string> out_q;
    bool out_closing = false;       // drain what's queued, then close
    bool out_dead = false;          // writer has exited; nothing more may be queued

    // Maps order_id → currently outstanding by this session, for routing maker fills.
    std::mutex orders_mu;
    std::set<OrderId> own_orders;

    void set_client_id(std::string_view v) {
        std::lock_guard<std::mutex> lk(meta_mu);
        client_id = v;
    }
    [[nodiscard]] std::string get_client_id() const {
        std::lock_guard<std::mutex> lk(meta_mu);
        return client_id;
    }
};

using SessionPtr = std::shared_ptr<Session>;

// Queue an outbound frame. Never blocks and never writes to the socket. Returns false if
// the session is gone or its queue is full (in which case the session is marked closing).
bool queue_outbound(Session& s, std::string text);

// Ask the writer thread to drain what is queued and then shut the connection down.
void request_close(Session& s);

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
