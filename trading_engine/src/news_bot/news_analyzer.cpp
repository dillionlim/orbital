#include "news_bot/news_analyzer.hpp"

#include <random>
#include <sstream>

#include "common/http_fetch.hpp"
#include "common/log.hpp"
#include "rapidjson/document.h"

namespace TradingSystem {

namespace {

// Parses "http://host:port" → {host, port}. Mirrors the parser in
// api_key_authenticator.cpp; duplicated rather than shared because that
// file's helper is currently in an anonymous namespace.
std::pair<std::string, int> parse_backend_url(const std::string& url) {
    std::string s = url;
    const std::string http = "http://";
    if (s.rfind(http, 0) == 0) s = s.substr(http.size());
    const auto slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    const auto colon = s.find(':');
    std::string host = (colon == std::string::npos) ? s : s.substr(0, colon);
    int port = 3010;
    if (colon != std::string::npos) {
        try { port = std::stoi(s.substr(colon + 1)); } catch (...) {}
    }
    if (host.empty()) host = "localhost";
    return {host, port};
}

}  // namespace

NewsAnalyzer::NewsAnalyzer(std::string backend_url,
                           std::shared_ptr<SymbolRegistry> registry,
                           std::shared_ptr<GeminiClient> gemini,
                           int poll_seconds,
                           int fetch_limit)
    : registry_(std::move(registry)),
      gemini_(std::move(gemini)),
      poll_seconds_(poll_seconds < 5 ? 5 : poll_seconds),
      // Backend route caps at 200 (NewsController.ts). Clamp here too so
      // the URL we build never asks for more than that — saves a
      // round-trip-and-rejection on misconfigured inputs.
      fetch_limit_(fetch_limit <= 0 ? 200 : (fetch_limit > 200 ? 200 : fetch_limit)) {
    backend_url_ = std::move(backend_url);
    auto [h, p] = parse_backend_url(backend_url_);
    backend_host_ = h;
    backend_port_ = p;

    // Build a descriptive catalog (one symbol per line: "NAME — what it is")
    // so the classifier can map a headline to the right instrument. Falls back
    // to a bare name when a symbol has no description configured.
    std::ostringstream oss;
    for (const auto& s : registry_->symbols()) {
        oss << s.name;
        if (!s.desc.empty()) oss << " — " << s.desc;
        oss << "\n";
    }
    symbols_csv_ = oss.str();
}

NewsAnalyzer::~NewsAnalyzer() { stop(); }

void NewsAnalyzer::subscribe(Callback cb) {
    std::lock_guard<std::mutex> lk(cb_mu_);
    callbacks_.push_back(std::move(cb));
}

void NewsAnalyzer::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread([this] { loop(); });
}

void NewsAnalyzer::stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
}

void NewsAnalyzer::loop() {
    LOG_INFO("news_analyzer: started, polling " << backend_host_ << ":" << backend_port_
             << " every " << poll_seconds_ << "s");

    // First poll runs immediately so the bot doesn't sit idle for the full
    // poll period after engine boot. Subsequent polls space themselves.
    bool first = true;
    while (running_.load()) {
        if (!first) {
            // Sleep in 250ms slices so shutdown doesn't have to wait the
            // full poll interval.
            for (int i = 0; i < poll_seconds_ * 4 && running_.load(); ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(250));
            }
            if (!running_.load()) break;
        }
        first = false;

        const auto items = fetch_news();
        if (items.empty()) continue;

        // Cap dedupe set so the engine doesn't grow unbounded over days.
        // When we hit the threshold, drop ~half the old entries; we'll
        // briefly re-classify some news that was already seen if we're
        // unlucky, which is cheap and rare.
        if (seen_ids_.size() > kMaxSeenIds) {
            seen_ids_.clear();
            LOG_INFO("news_analyzer: pruned dedupe set");
        }

        // If the back-off cooldown has elapsed, drop the flag so the next
        // call retries Gemini. Gives users an in-process recovery path
        // when they fix the key without restarting the engine.
        if (auth_backoff_) {
            const auto elapsed = std::chrono::steady_clock::now() - auth_backoff_set_at_;
            if (elapsed >= std::chrono::milliseconds(kAuthBackoffCooldownMs)) {
                LOG_INFO("news_analyzer: auth back-off cooldown expired; retrying Gemini");
                auth_backoff_ = false;
                consecutive_auth_failures_ = 0;
            }
        }

        size_t fresh_processed = 0;
        for (const auto& it : items) {
            if (it.id.empty()) continue;
            if (seen_ids_.count(it.id)) continue;       // already analyzed

            // Skip the API call if we've already given up on this key.
            // We deliberately do NOT mark the item as seen here — once
            // the back-off cools down, this same item should get a fresh
            // shot rather than being silently skipped forever.
            if (auth_backoff_) continue;

            const GeminiResult res = gemini_->classify(it.headline, it.summary, symbols_csv_);

            // AuthFailure: tolerate a small number in a row (occasional
            // 400 from Gemini isn't strictly an auth issue) before
            // tripping the back-off. Don't insert into seen_ids — we want
            // to retry these items after the cooldown.
            if (res.error == GeminiError::AuthFailure) {
                if (++consecutive_auth_failures_ >= kAuthFailuresBeforeBackoff) {
                    LOG_ERROR("news_analyzer: " << consecutive_auth_failures_
                              << " consecutive Gemini auth failures — backing off "
                              "for " << (kAuthBackoffCooldownMs / 1000) << "s "
                              "(check GEMINI_API_KEY / news.gemini_api_key in your config)");
                    auth_backoff_ = true;
                    auth_backoff_set_at_ = std::chrono::steady_clock::now();
                }
                continue;
            }
            consecutive_auth_failures_ = 0;

            // Transient transport / parse errors — leave the item un-seen
            // so the next poll retries. Once we have a *deterministic*
            // result (success, NONE symbol, Hold direction) we mark seen.
            if (res.error != GeminiError::None) continue;

            seen_ids_.insert(it.id);    // got a real answer; don't re-classify
            ++fresh_processed;
            if (!res.analysis) continue;
            if (res.analysis->symbol_name.empty()) continue;
            if (res.analysis->direction == NewsDirection::Hold) continue;

            // Fan out to subscribers. We hold the mutex briefly while
            // copying the callback list so a slow callback doesn't block
            // late-attaching subscribers (currently subscribers attach
            // before start(), so this is just future-proofing).
            std::vector<Callback> snapshot;
            {
                std::lock_guard<std::mutex> lk(cb_mu_);
                snapshot = callbacks_;
            }

            // One log line per signal, regardless of how many subscribers
            // act on it. Putting this at fan-out time (rather than in each
            // bot's on_signal) keeps the boot/runtime log readable when
            // count is in the dozens or higher.
            const char* dir_str = (res.analysis->direction == NewsDirection::Buy)
                                      ? "BUY" : "SELL";
            LOG_INFO("news_analyzer: signal " << dir_str << " " << res.analysis->symbol_name
                     << " conf=" << res.analysis->confidence
                     << " → " << snapshot.size() << " subscribers"
                     << " hl=\"" << it.headline.substr(0, 80) << "\"");

            for (const auto& cb : snapshot) {
                try { cb(it, *res.analysis); }
                catch (const std::exception& e) {
                    LOG_WARN("news_analyzer: subscriber threw: " << e.what());
                }
            }
        }

        // Recycling: if every item in this poll was already in seen_ids_
        // (Finnhub hasn't ingested anything new), pick one stale headline
        // at random and re-classify it as if it were fresh. Keeps news
        // bots producing signals during quiet stretches.
        //
        // We deliberately *don't* mark recycled items in seen_ids_ — the
        // seen-set is only for actual fresh-news dedupe. Same headline
        // can be recycled again next poll cycle if nothing new arrives.
        if (fresh_processed == 0 && !items.empty() && !auth_backoff_) {
            static thread_local std::mt19937 rng(std::random_device{}());
            std::uniform_int_distribution<size_t> pick(0, items.size() - 1);
            const auto& it = items[pick(rng)];

            const GeminiResult res =
                gemini_->classify(it.headline, it.summary, symbols_csv_);
            if (res.error == GeminiError::AuthFailure) {
                if (++consecutive_auth_failures_ >= kAuthFailuresBeforeBackoff) {
                    LOG_ERROR("news_analyzer: " << consecutive_auth_failures_
                              << " consecutive Gemini auth failures (recycle path) — "
                              "backing off for " << (kAuthBackoffCooldownMs / 1000) << "s");
                    auth_backoff_ = true;
                    auth_backoff_set_at_ = std::chrono::steady_clock::now();
                }
            } else if (res.error == GeminiError::None && res.analysis &&
                       !res.analysis->symbol_name.empty() &&
                       res.analysis->direction != NewsDirection::Hold) {
                consecutive_auth_failures_ = 0;
                std::vector<Callback> snapshot;
                {
                    std::lock_guard<std::mutex> lk(cb_mu_);
                    snapshot = callbacks_;
                }
                const char* dir_str = (res.analysis->direction == NewsDirection::Buy)
                                          ? "BUY" : "SELL";
                LOG_INFO("news_analyzer: recycled " << dir_str << " "
                         << res.analysis->symbol_name
                         << " conf=" << res.analysis->confidence
                         << " → " << snapshot.size() << " subscribers"
                         << " hl=\"" << it.headline.substr(0, 80) << "\"");
                for (const auto& cb : snapshot) {
                    try { cb(it, *res.analysis); }
                    catch (const std::exception& e) {
                        LOG_WARN("news_analyzer: subscriber threw: " << e.what());
                    }
                }
            }
        }
    }
    LOG_INFO("news_analyzer: stopped");
}

std::vector<NewsItem> NewsAnalyzer::fetch_news() const {
    // Route through curl so an https:// backend works (the engine links no TLS).
    // curl also transparently de-chunks the response, so no manual unchunking.
    std::string base = backend_url_;
    while (!base.empty() && base.back() == '/') base.pop_back();
    const std::string url = base + "/news?limit=" + std::to_string(fetch_limit_);

    HttpResponse resp = http_fetch("GET", url, "", {"Accept: application/json"}, 10);
    // Anything non-2xx means the backend is down or the route changed; treat as
    // no news rather than spamming logs.
    if (!resp.ok || resp.status < 200 || resp.status >= 300) return {};
    const std::string& json_body = resp.body;

    rapidjson::Document doc;
    if (doc.Parse(json_body.c_str()).HasParseError() || !doc.IsArray()) return {};

    std::vector<NewsItem> out;
    out.reserve(doc.Size());
    for (const auto& v : doc.GetArray()) {
        if (!v.IsObject()) continue;
        NewsItem n;
        // Finnhub's `id` is numeric; NestJS may pass it through as-is or
        // string-encoded depending on Prisma config. Accept either.
        if (v.HasMember("id")) {
            const auto& id = v["id"];
            if (id.IsString())       n.id = id.GetString();
            else if (id.IsInt())     n.id = std::to_string(id.GetInt());
            else if (id.IsInt64())   n.id = std::to_string(id.GetInt64());
            else if (id.IsUint())    n.id = std::to_string(id.GetUint());
            else if (id.IsUint64())  n.id = std::to_string(id.GetUint64());
        }
        if (v.HasMember("headline") && v["headline"].IsString())
            n.headline = v["headline"].GetString();
        if (v.HasMember("summary") && v["summary"].IsString())
            n.summary = v["summary"].GetString();
        if (v.HasMember("related") && v["related"].IsString())
            n.related = v["related"].GetString();
        // datetime can come as ISO string from Prisma — just record any int
        // representation we can find for ordering; not load-bearing.
        if (v.HasMember("datetime")) {
            const auto& dt = v["datetime"];
            if (dt.IsInt64())  n.ts_ms = dt.GetInt64();
            else if (dt.IsInt()) n.ts_ms = dt.GetInt();
        }
        if (!n.id.empty() && !n.headline.empty()) out.push_back(std::move(n));
    }
    return out;
}

}  // namespace TradingSystem
