#include "server/session.hpp"

#include <sys/socket.h>

#include <vector>

#include "server/protocol.hpp"
#include "server/ws_frame.hpp"

namespace TradingSystem {

bool queue_outbound(Session& s, std::string text) {
    {
        std::lock_guard<std::mutex> lk(s.out_mu);
        if (s.out_dead || s.out_closing) return false;
        if (s.out_q.size() >= kMaxOutboundFrames) {
            // Slow consumer. Kick it rather than drop frames out of the delta stream.
            s.out_closing = true;
            s.out_cv.notify_all();
            return false;
        }
        s.out_q.push_back(std::move(text));
    }
    s.out_cv.notify_one();
    return true;
}

void request_close(Session& s) {
    {
        std::lock_guard<std::mutex> lk(s.out_mu);
        s.out_closing = true;
    }
    s.out_cv.notify_all();
}

SessionPtr SessionRegistry::create(int sockfd, std::string_view api_key,
                                   std::string_view user_id) {
    auto s = std::make_shared<Session>();
    {
        std::lock_guard<std::mutex> lk(mu_);
        s->id = next_id_++;
        if (s->id == kInternalSession) s->id = next_id_++;
        s->sockfd = sockfd;
        s->api_key = std::string(api_key);
        s->user_id = std::string(user_id);
        by_id_[s->id] = s;
    }
    return s;
}

SessionPtr SessionRegistry::internal_session() {
    std::lock_guard<std::mutex> lk(mu_);
    if (!internal_) {
        internal_ = std::make_shared<Session>();
        internal_->id = kInternalSession;
        internal_->user_id = "internal:market_maker";
        internal_->is_internal = true;
    }
    return internal_;
}

void SessionRegistry::erase(SessionId id) {
    std::lock_guard<std::mutex> lk(mu_);
    by_id_.erase(id);
}

SessionPtr SessionRegistry::by_id(SessionId id) const {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_id_.find(id);
    if (it == by_id_.end()) return nullptr;
    return it->second;
}

SessionPtr SessionRegistry::by_user(std::string_view user_id) const {
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& [_, s] : by_id_) {
        if (s->user_id == user_id) return s;
    }
    return nullptr;
}

void SessionRegistry::for_each(const std::function<void(const SessionPtr&)>& fn) const {
    std::vector<SessionPtr> snapshot;
    {
        std::lock_guard<std::mutex> lk(mu_);
        snapshot.reserve(by_id_.size());
        for (const auto& [_, s] : by_id_) snapshot.push_back(s);
    }
    for (auto& s : snapshot) fn(s);
}

size_t SessionRegistry::kick_by_client_id(std::string_view user_id, std::string_view client_id) {
    if (client_id.empty() || user_id.empty()) return 0;
    std::vector<SessionPtr> targets;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& [_, s] : by_id_) {
            if (s->is_internal) continue;
            if (s->user_id != user_id) continue;       // squatting fix
            if (s->get_client_id() != client_id) continue;
            targets.push_back(s);
        }
    }
    // Hand the frames to the session's writer thread rather than writing the fd here: it
    // is the only thread allowed to touch the socket, and it is joined before the fd is
    // closed, so we cannot write onto an fd that has been recycled to another connection.
    size_t kicked = 0;
    for (auto& s : targets) {
        queue_outbound(*s, encode_error("BOT_PAUSED", "Bot was paused from the dashboard."));
        request_close(*s);
        ++kicked;
    }
    return kicked;
}

size_t SessionRegistry::size() const {
    std::lock_guard<std::mutex> lk(mu_);
    return by_id_.size();
}

std::unordered_set<std::string> SessionRegistry::connected_client_ids() const {
    std::unordered_set<std::string> out;
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& [_, s] : by_id_) {
        if (s->is_internal) continue;
        if (!s->alive.load()) continue;
        const std::string cid = s->get_client_id();
        if (cid.empty() || s->user_id.empty()) continue;
        // Composite key: matches BotTracker's by_key_ scheme so two distinct
        // users with the same client_id don't see each other's "live" status.
        out.insert(s->user_id + "::" + cid);
    }
    return out;
}

}  // namespace TradingSystem
