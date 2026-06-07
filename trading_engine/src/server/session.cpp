#include "server/session.hpp"

#include <sys/socket.h>

#include <vector>

#include "server/protocol.hpp"
#include "server/ws_frame.hpp"

namespace TradingSystem {

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

size_t SessionRegistry::kick_by_client_id(std::string_view client_id) {
    if (client_id.empty()) return 0;
    std::vector<SessionPtr> targets;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& [_, s] : by_id_) {
            if (s->is_internal) continue;
            if (s->client_id == client_id) targets.push_back(s);
        }
    }
    // For each target: write a BOT_PAUSED error + a 1000 close frame so the
    // client sees a clean disconnect (websockets clients otherwise raise
    // ConnectionClosedError "no close frame received or sent"). Then
    // shutdown(SHUT_RDWR) wakes the blocked reader, which exits its loop and
    // goes through the normal disconnect/erase path. Tiny race: if the session
    // disconnected between snapshot and shutdown, the fd may have been closed
    // (EBADF, harmless) or — worst case — reused. Manual user action, rare;
    // accept it.
    size_t kicked = 0;
    for (auto& s : targets) {
        s->alive = false;
        if (s->sockfd >= 0) {
            {
                std::lock_guard<std::mutex> lk(s->write_mu);
                ws_write_text(s->sockfd, encode_error("BOT_PAUSED",
                    "Bot was paused from the dashboard."));
                ws_write_close(s->sockfd, 1000, "paused");
            }
            ::shutdown(s->sockfd, SHUT_RDWR);
        }
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
        if (!s->client_id.empty()) out.insert(s->client_id);
    }
    return out;
}

}  // namespace TradingSystem
