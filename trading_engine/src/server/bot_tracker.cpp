#include "server/bot_tracker.hpp"

#include <algorithm>
#include <cstdlib>
#include <utility>
#include <variant>

#include "common/time.hpp"

namespace TradingSystem {

namespace {

constexpr int64_t kHourMs = 60 * 60 * 1000;
// Keep enough fill history to support any window the dashboard might ask for.
// 24h is the longest window we expose; older fills get pruned.
constexpr int64_t kFillRetentionMs = 24 * 60 * 60 * 1000;
constexpr int64_t kActiveWindowMs = 30 * 1000;
// Forget an external bot that's had no live session and no activity for this long
// so abandoned/disconnected test bots don't pile up in /bots forever.
constexpr int64_t kPruneTtlMs = 10 * 60 * 1000;
constexpr const char* kMmUserId = "internal:market_maker";

// Cap distinct client_id rows per user. Without this, a single attacker
// could rotate through millions of fake client_ids and grow `by_key_`
// without bound. 100 is enough headroom for legitimate multi-strategy
// users while keeping the OOM amplifier closed.
//
// $BUBBLES_MAX_CLIENT_IDS_PER_USER overrides at startup (read once and cached
// — no need to re-read per call). Bumps only take effect on engine restart.
size_t max_client_ids_per_user() {
    static const size_t cached = []() -> size_t {
        const char* env = std::getenv("BUBBLES_MAX_CLIENT_IDS_PER_USER");
        if (!env || !*env) return 100;
        try {
            const long parsed = std::stol(env);
            if (parsed > 0) return static_cast<size_t>(parsed);
        } catch (...) { /* fall through */ }
        return 100;
    }();
    return cached;
}

std::string short_user_label(const std::string& uid) {
    if (uid.size() > 12) return "user:" + uid.substr(0, 8);
    return uid.empty() ? "anon" : uid;
}

}  // namespace

std::string BotTracker::compose_key(std::string_view user_id, std::string_view client_id) {
    std::string out;
    out.reserve(user_id.size() + 2 + client_id.size());
    out.append(user_id);
    out.append("::");
    out.append(client_id);
    return out;
}

BotTracker::~BotTracker() { stop(); }

void BotTracker::start(EventBus& bus, std::shared_ptr<SnapshotStore> snapshots) {
    bus_ = &bus;
    snapshots_ = std::move(snapshots);
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) { on_event(ev); });
}

void BotTracker::stop() {
    if (bus_ && sub_id_) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
}

void BotTracker::register_internal_bot(const std::string& user_id,
                                       const std::string& client_id) {
    if (user_id.empty()) return;
    std::lock_guard<std::mutex> lk(mu_);
    // Compose key the same way fills do, so when a fill eventually arrives it
    // attributes to this row instead of allocating a new one.
    const std::string key = compose_key(user_id, client_id.empty() ? user_id : client_id);
    auto& s = by_key_[key];
    s.user_id = user_id;
    if (!client_id.empty()) s.client_id = client_id;
    s.is_internal = true;
    if (s.first_seen == 0) s.first_seen = now_ms();
    // Deliberately leave last_activity at 0 — the bot hasn't actually traded
    // yet. The snapshot()'s status logic uses (now - last_activity) to decide
    // active/idle, so this leaves the row at "idle" until the first fill.
}

void BotTracker::note_client_id(const std::string& user_id, const std::string& client_id) {
    if (user_id.empty() || client_id.empty()) return;
    std::lock_guard<std::mutex> lk(mu_);
    const std::string key = compose_key(user_id, client_id);
    // Per-user cap: only enforced when allocating a NEW row. Existing bots
    // always update freely so legit clients don't lose state at the cap.
    if (by_key_.find(key) == by_key_.end()) {
        if (user_row_count_[user_id] >= max_client_ids_per_user()) {
            // Silently drop registration. Hello has already returned, so the
            // bot keeps trading — fills just fall back to attributing under
            // user_id without a per-bot row.
            return;
        }
        ++user_row_count_[user_id];
    }
    user_to_client_[user_id] = client_id;
    auto& s = by_key_[key];
    if (s.user_id.empty()) s.user_id = user_id;
    if (s.client_id.empty()) s.client_id = client_id;
    if (s.first_seen == 0) s.first_seen = now_ms();
    s.last_activity = now_ms();
}

BotTracker::PauseResult BotTracker::pause(std::string_view client_id, std::string_view requesting_user_id) {
    if (requesting_user_id.empty()) return PauseResult::NotFound;
    const std::string key = compose_key(requesting_user_id, client_id);
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_key_.find(key);
    if (it == by_key_.end()) return PauseResult::NotFound;
    if (it->second.is_internal || it->second.user_id == kMmUserId) {
        // The in-process market maker isn't a real session and can't be
        // disconnected by setting alive=false anyway. Refuse explicitly so
        // the UI doesn't lie about its effect.
        return PauseResult::InternalBot;
    }
    // Composite-key lookup already enforces ownership, but keep the guard
    // belt-and-braces in case the entry was constructed inconsistently.
    if (it->second.user_id != requesting_user_id) return PauseResult::NotOwner;
    paused_.insert(key);
    return PauseResult::Ok;
}

BotTracker::PauseResult BotTracker::resume(std::string_view client_id, std::string_view requesting_user_id) {
    if (requesting_user_id.empty()) return PauseResult::NotFound;
    const std::string key = compose_key(requesting_user_id, client_id);
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_key_.find(key);
    if (it == by_key_.end()) return PauseResult::NotFound;
    if (it->second.is_internal || it->second.user_id == kMmUserId) return PauseResult::InternalBot;
    if (it->second.user_id != requesting_user_id) return PauseResult::NotOwner;
    paused_.erase(key);
    return PauseResult::Ok;
}

BotTracker::PauseResult BotTracker::remove(std::string_view client_id, std::string_view requesting_user_id) {
    if (requesting_user_id.empty()) return PauseResult::NotFound;
    const std::string key = compose_key(requesting_user_id, client_id);
    std::lock_guard<std::mutex> lk(mu_);
    auto it = by_key_.find(key);
    if (it == by_key_.end()) return PauseResult::NotFound;
    if (it->second.is_internal || it->second.user_id == kMmUserId) return PauseResult::InternalBot;
    if (it->second.user_id != requesting_user_id) return PauseResult::NotOwner;
    // Drop the row and all bookkeeping that referenced it.
    by_key_.erase(it);
    paused_.erase(key);
    const std::string uid(requesting_user_id);
    if (auto uc = user_row_count_.find(uid); uc != user_row_count_.end()) {
        if (uc->second > 0) --uc->second;
        if (uc->second == 0) user_row_count_.erase(uc);
    }
    if (auto u2c = user_to_client_.find(uid);
        u2c != user_to_client_.end() && u2c->second == client_id) {
        user_to_client_.erase(u2c);
    }
    return PauseResult::Ok;
}

bool BotTracker::is_paused(std::string_view user_id, std::string_view client_id) const {
    if (user_id.empty() || client_id.empty()) return false;
    std::lock_guard<std::mutex> lk(mu_);
    return paused_.find(compose_key(user_id, client_id)) != paused_.end();
}

void BotTracker::on_event(const OutboundEvent& ev) {
    std::visit([&](auto&& e) {
        using T = std::decay_t<decltype(e)>;
        if constexpr (std::is_same_v<T, ExecutionReport>) {
            if (e.user_id.empty()) return;
            std::lock_guard<std::mutex> lk(mu_);

            // Resolve the effective client_id: prefer the one on this event, fall
            // back to whatever we last saw for this user. Maker fills (which the
            // engine tags with the resting order's client_id) flow naturally; for
            // older code paths the cache fills the gap.
            std::string client_id = e.client_id;
            if (client_id.empty()) {
                auto cit = user_to_client_.find(e.user_id);
                if (cit != user_to_client_.end()) client_id = cit->second;
            } else {
                user_to_client_[e.user_id] = client_id;
            }
            // Composite key always includes user_id so two users with the same
            // client_id can't collide on the same row.
            const std::string key = compose_key(e.user_id,
                                                client_id.empty() ? e.user_id : client_id);

            // Same per-user cap as note_client_id. Skip allocating a new row
            // if the user is already at the cap; the engine continues to
            // process the fill, we just don't track a per-bot ledger.
            if (by_key_.find(key) == by_key_.end()) {
                if (user_row_count_[e.user_id] >= max_client_ids_per_user()) {
                    return;
                }
                ++user_row_count_[e.user_id];
            }
            auto& s = by_key_[key];
            if (s.user_id.empty()) s.user_id = e.user_id;
            if (s.client_id.empty()) s.client_id = client_id;
            s.is_internal = s.is_internal || e.is_internal ||
                            (e.user_id == kMmUserId);
            if (s.first_seen == 0) s.first_seen = e.ts ? e.ts : now_ms();
            s.last_activity = e.ts ? e.ts : now_ms();

            if (e.kind == ExecutionReport::Kind::Ack) {
                s.orders_placed++;
            } else if (e.kind == ExecutionReport::Kind::Fill && e.last_quantity > 0) {
                const double notional =
                    e.last_price * static_cast<double>(e.last_quantity);
                const double cash_delta =
                    (e.side == OrderSide::Sell) ? +notional : -notional;
                const int64_t pos_delta = (e.side == OrderSide::Buy)
                    ? static_cast<int64_t>(e.last_quantity)
                    : -static_cast<int64_t>(e.last_quantity);
                s.cash_realized += cash_delta;
                s.positions[e.symbol] += pos_delta;
                s.fills++;
                s.volume += e.last_quantity;
                s.recent_fills.push_back({s.last_activity, e.symbol, pos_delta, cash_delta});
                prune_old(s.recent_fills, s.last_activity);
            }
        }
    }, ev);
}

void BotTracker::prune_old(std::deque<Fill>& q, Timestamp now) {
    while (!q.empty() && (now - q.front().ts) > static_cast<uint64_t>(kFillRetentionMs)) {
        q.pop_front();
    }
}

double BotTracker::mark_value(const State& s) const {
    if (!snapshots_) return 0.0;
    double mark = 0.0;
    for (const auto& [sym, qty] : s.positions) {
        if (qty == 0) continue;
        auto snap = snapshots_->get(sym);
        if (!snap) continue;
        double bid = snap->bids.empty() ? 0.0 : snap->bids.front().price;
        double ask = snap->asks.empty() ? 0.0 : snap->asks.front().price;
        double mid = 0.0;
        if (bid > 0 && ask > 0) mid = (bid + ask) / 2.0;
        else if (bid > 0) mid = bid;
        else if (ask > 0) mid = ask;
        mark += static_cast<double>(qty) * mid;
    }
    return mark;
}

std::vector<BotTracker::BotSnapshot> BotTracker::snapshot(
    const std::unordered_set<std::string>& connected_client_ids,
    int64_t window_ms) {
    // Clamp to fill retention so callers can't ask for more history than we keep.
    if (window_ms < 1000) window_ms = 1000;
    if (window_ms > kFillRetentionMs) window_ms = kFillRetentionMs;
    std::vector<BotSnapshot> out;
    Timestamp now = now_ms();
    std::lock_guard<std::mutex> lk(mu_);
    // Prune abandoned external bots first: no live session, not paused, and idle
    // past the TTL — so /bots doesn't accumulate stale rows from old test runs.
    for (auto it = by_key_.begin(); it != by_key_.end();) {
        const State& s = it->second;
        const std::string composite = compose_key(
            s.user_id, s.client_id.empty() ? s.user_id : s.client_id);
        const bool connected = !s.client_id.empty() &&
            connected_client_ids.find(composite) != connected_client_ids.end();
        const bool paused = paused_.find(composite) != paused_.end();
        if (!s.is_internal && !connected && !paused && s.last_activity > 0 &&
            (now - s.last_activity) > static_cast<uint64_t>(kPruneTtlMs)) {
            paused_.erase(composite);
            if (auto uc = user_row_count_.find(s.user_id);
                uc != user_row_count_.end()) {
                if (uc->second > 0) --uc->second;
                if (uc->second == 0) user_row_count_.erase(uc);
            }
            if (auto u2c = user_to_client_.find(s.user_id);
                u2c != user_to_client_.end() && u2c->second == s.client_id) {
                user_to_client_.erase(u2c);
            }
            it = by_key_.erase(it);
        } else {
            ++it;
        }
    }
    out.reserve(by_key_.size());
    for (const auto& [_, s] : by_key_) {
        BotSnapshot b;
        b.user_id = s.user_id;
        b.client_id = s.client_id;
        b.is_internal = s.is_internal;
        if (s.is_internal) {
            // Distinguish the in-process MM from the news-driven personas so
            // /bots gives a meaningful "what is this thing actually doing"
            // label instead of mislabeling everything as MM-style quoting.
            const std::string news_prefix = "internal:news_";
            if (s.user_id.rfind(news_prefix, 0) == 0) {
                // user_id shape: "internal:news_<persona>_<instance>". Strip
                // the trailing "_<n>" so the strategy label collapses to the
                // persona, while the row keeps its full client_id label so
                // siblings stay visually distinct in /bots.
                const std::string suffix = s.user_id.substr(news_prefix.size());
                const auto under = suffix.rfind('_');
                std::string persona = suffix;
                if (under != std::string::npos) {
                    const std::string tail = suffix.substr(under + 1);
                    bool tail_is_int = !tail.empty() &&
                        std::all_of(tail.begin(), tail.end(),
                                    [](unsigned char c) { return std::isdigit(c); });
                    if (tail_is_int) persona = suffix.substr(0, under);
                }
                b.display_name = !s.client_id.empty() ? s.client_id : ("News " + suffix);
                b.strategy_name = "News-driven (" + persona + ", Gemini)";
            } else if (s.user_id == kMmUserId) {
                b.display_name = !s.client_id.empty() ? s.client_id : "Market Maker";
                b.strategy_name = "Spread quotes (in-process)";
            } else {
                b.display_name = !s.client_id.empty() ? s.client_id : s.user_id;
                b.strategy_name = "Internal bot";
            }
        } else {
            b.display_name = !s.client_id.empty() ? s.client_id : short_user_label(s.user_id);
            b.strategy_name = "External bot";
        }
        const std::string composite = compose_key(s.user_id,
                                                  s.client_id.empty() ? s.user_id : s.client_id);
        b.paused = paused_.find(composite) != paused_.end();
        if (b.paused) {
            b.status = "paused";
        } else if (s.is_internal) {
            // The in-process MM only emits ExecutionReports on fills/cancels —
            // resting quotes don't bump last_activity. So treat the MM row as
            // permanently "active" once it exists.
            //
            // News bots, by contrast, may legitimately go a long time between
            // trades while waiting for relevant headlines — fall back to the
            // recent-activity check so the badge reflects reality.
            if (s.user_id == kMmUserId) {
                b.status = "active";
            } else {
                b.status = (s.last_activity > 0 &&
                            (now - s.last_activity) <= static_cast<uint64_t>(kActiveWindowMs))
                               ? "active" : "idle";
            }
        } else if (!s.client_id.empty() &&
                   connected_client_ids.find(composite) != connected_client_ids.end()) {
            // Bot has a live WS session: distinguish recent activity (active)
            // from connected-but-quiet (idle).
            b.status = (now - s.last_activity) <= static_cast<uint64_t>(kActiveWindowMs)
                           ? "active" : "idle";
        } else {
            // Was tracked (so connected at some point) but has no live session
            // now and isn't paused — likely crashed, killed, or lost network.
            b.status = "error";
        }
        b.orders_placed = s.orders_placed;
        b.fills = s.fills;
        b.volume = s.volume;
        b.first_seen = s.first_seen;
        b.last_activity = s.last_activity;
        b.total_pnl = s.cash_realized + mark_value(s);

        // Realized PnL over a window ≈ change in (cash + mark) attributable
        // to in-window fills. Assuming mark hasn't drifted much in the window,
        // each fill contributes (cash_delta + pos_delta × current_mark).
        // Compute both: hourly_pnl (fixed 60min, backward compat) and
        // windowed_pnl (caller-controlled window). Single pass, two cutoffs.
        const uint64_t hour_cutoff = static_cast<uint64_t>(kHourMs);
        const uint64_t window_cutoff = static_cast<uint64_t>(window_ms);
        double hourly = 0.0;
        double windowed = 0.0;
        for (const auto& f : s.recent_fills) {
            const uint64_t age = now - f.ts;
            if (age > hour_cutoff && age > window_cutoff) continue;
            double mid = 0.0;
            if (snapshots_) {
                if (auto snap = snapshots_->get(f.symbol)) {
                    double bid = snap->bids.empty() ? 0.0 : snap->bids.front().price;
                    double ask = snap->asks.empty() ? 0.0 : snap->asks.front().price;
                    if (bid > 0 && ask > 0) mid = (bid + ask) / 2.0;
                    else if (bid > 0) mid = bid;
                    else if (ask > 0) mid = ask;
                }
            }
            const double contrib = f.cash_delta + static_cast<double>(f.pos_delta) * mid;
            if (age <= hour_cutoff) hourly += contrib;
            if (age <= window_cutoff) windowed += contrib;
        }
        b.hourly_pnl = hourly;
        b.windowed_pnl = windowed;
        b.window_ms = window_ms;
        out.push_back(std::move(b));
    }
    // Sort: internal first, then by total_pnl desc, then by display name.
    std::sort(out.begin(), out.end(), [](const BotSnapshot& a, const BotSnapshot& b) {
        if (a.is_internal != b.is_internal) return a.is_internal;
        if (a.total_pnl != b.total_pnl) return a.total_pnl > b.total_pnl;
        return a.display_name < b.display_name;
    });
    return out;
}

}  // namespace TradingSystem
