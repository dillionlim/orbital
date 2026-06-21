#pragma once
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "common/config.hpp"
#include "news_bot/gemini_client.hpp"

namespace TradingSystem {

struct NewsItem {
    std::string id;          // Finnhub-supplied id (string-coerced; dedupe key)
    std::string headline;
    std::string summary;
    std::string related;     // Finnhub's "related" field — comma-sep tickers
    int64_t     ts_ms = 0;
};

// Polls the local NestJS `/news?limit=N` endpoint, dedupes by id, calls
// Gemini once per never-seen item, and broadcasts the (item, analysis)
// pair to every subscribed callback.
//
// Constructed with the engine's backend_url (parsed for host:port) and
// a GeminiClient. Owns a single polling thread; subscriber callbacks run
// inline on that thread, so they should return quickly (e.g. just enqueue
// an order via Sequencer).
class NewsAnalyzer {
public:
    using Callback = std::function<void(const NewsItem&, const NewsAnalysis&)>;

    NewsAnalyzer(std::string backend_url,
                 std::shared_ptr<SymbolRegistry> registry,
                 std::shared_ptr<GeminiClient> gemini,
                 int poll_seconds,
                 int fetch_limit);
    ~NewsAnalyzer();

    void subscribe(Callback cb);

    void start();
    void stop();

private:
    void loop();

    // Returns std::nullopt on transport error (treated as transient — try
    // again next tick rather than giving up).
    std::vector<NewsItem> fetch_news() const;

    std::string backend_url_;      // full URL incl. scheme (for the curl path)
    std::string backend_host_;
    int         backend_port_ = 3010;
    std::shared_ptr<SymbolRegistry> registry_;
    std::shared_ptr<GeminiClient> gemini_;
    int poll_seconds_ = 30;
    int fetch_limit_ = 200;

    std::thread thread_;
    std::atomic<bool> running_{false};

    // Bounded so the engine can run for days without leaking memory; we
    // periodically erase the oldest half once we hit the cap. Order of
    // insertion isn't preserved by unordered_set but we don't care about
    // *which* old items get forgotten, only that we don't grow unbounded.
    static constexpr size_t kMaxSeenIds = 4096;
    std::unordered_set<std::string> seen_ids_;

    // Auth back-off. After kAuthFailuresBeforeBackoff consecutive auth
    // failures from Gemini we stop calling the API. After
    // kAuthBackoffCooldownMs has elapsed since the back-off was set, we
    // try again so users who fix their key (in server.json or env) get
    // picked up without an engine restart.
    static constexpr int kAuthFailuresBeforeBackoff = 3;
    static constexpr int kAuthBackoffCooldownMs = 5 * 60 * 1000;
    int  consecutive_auth_failures_ = 0;
    bool auth_backoff_ = false;
    std::chrono::steady_clock::time_point auth_backoff_set_at_;

    std::mutex cb_mu_;
    std::vector<Callback> callbacks_;

    // Pre-built CSV of registered symbol names to feed into Gemini's prompt.
    std::string symbols_csv_;
};

}  // namespace TradingSystem
