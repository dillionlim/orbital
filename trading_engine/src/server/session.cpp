#include "server/session.hpp"

#include <vector>

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

size_t SessionRegistry::size() const {
    std::lock_guard<std::mutex> lk(mu_);
    return by_id_.size();
}

}  // namespace TradingSystem
