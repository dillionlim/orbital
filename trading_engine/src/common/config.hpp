#pragma once
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/types.hpp"

namespace TradingSystem {

// Sentinel for "no limit" on per-symbol position caps. Picked over
// std::optional<Quantity> to keep the hot-path comparisons branch-light;
// UINT64_MAX is not a realistic position size.
inline constexpr Quantity kNoPositionLimit = std::numeric_limits<Quantity>::max();

struct SymbolConfig {
    std::string name;     // wire name, e.g. "BTC-USD"
    SymbolId id;          // internal id
    Price mid;             // initial mid for the market maker
    std::string desc;      // human description (e.g. "S&P 500 E-mini future") —
                           // fed to the news analyzer so it maps headlines accurately

    // Per-symbol position caps applied to external users (in-process MM is
    // exempt). max_long bounds (position + open_buy_qty), max_short bounds
    // (-position + open_sell_qty). Either may be kNoPositionLimit.
    Quantity max_long = kNoPositionLimit;
    Quantity max_short = kNoPositionLimit;
};

struct MarketMakerConfig {
    bool enabled = true;
    Quantity size = 10;         // base size at the top level (deeper levels scale up)
    int refresh_ms = 1000;
    bool track_trades = true;
    int levels = 8;             // depth levels quoted per side (the fabricated ladder)
    int churn_depth = 6;        // transient orders cycled near the top for liveness (0 = off)
    // The book is priced on a per-symbol tick derived from the anchor's
    // magnitude; the inside (best bid/ask) brackets the real value by one tick.

    // Event-driven requote: when an external trade prints at a price more
    // than this many bps from the anchor of our currently-resting quote,
    // cancel both sides and repost at the new anchor. 0 = use a sane
    // default of max(spread_bps/2, 5) so the MM doesn't sit stale a full
    // half-spread away when news bots stampede the book.
    int requote_drift_bps = 0;
};

// One in-process news-driven bot persona. `count` controls how many
// independent instances of this persona are spawned — useful for
// generating richer market action without declaring N separate config
// entries. Each instance has its own user_id (so STP doesn't fire
// between siblings) and applies a fresh jitter sample per trade.
struct NewsBotConfig {
    int count = 0;                            // 0 disables; N spawns N instances
    std::string persona;                      // "momentum" | "contrarian" | "scalper"
    Quantity size_per_signal = 5;
    double confidence_threshold = 0.6;        // 0..1; reject signals below this

    // Per-trade randomness so siblings don't submit identical orders on
    // the same Gemini signal. 0 = deterministic (back to previous
    // behavior). Values are clamped sanely at trade time.
    int size_jitter_pct = 0;                  // ± this % around size_per_signal
    int price_offset_jitter_bps = 0;          // ± this many bps around persona's base offset

    // Background "noise" trading. Each instance fires a randomly-directed
    // small order at this average interval (jittered ±50%) so the market
    // shows continuous activity even when no news has arrived. 0 disables
    // the noise trader and keeps the bot purely news-reactive. Noise size
    // is half the persona's size_per_signal × the same jitter sample.
    int noise_interval_seconds = 0;

    // Stagger window for signal-driven trades. When > 0, each instance
    // picks a random delay in [0, signal_delay_ms] before firing on a
    // Gemini signal — so a count=1000 cohort spreads its reaction over
    // the window instead of stampeding the book in a single tick. Gives
    // the in-process MM time to requote between waves of bot fills,
    // producing the gradual price discovery you'd see in a real market.
    // 0 keeps the legacy synchronous-fire behavior (cheap; no worker
    // thread spawned just for staggering).
    int signal_delay_ms = 0;
};

// News-analysis subsystem. The Gemini API key can live either here in the
// JSON (`gemini_api_key`) or in the GEMINI_API_KEY env var; the config
// field wins when both are set. Putting the key in JSON keeps the whole
// engine setup in one file — convenient for single-user deployments, but
// remember the file is now sensitive (don't commit, don't share).
struct NewsAnalysisConfig {
    int poll_seconds = 30;                    // NestJS /news poll interval
    std::string gemini_model = "gemini-2.5-flash";
    std::string gemini_api_key;               // empty → fall back to env var

    // Number of rows to pull from the backend's `/news` table on each
    // poll. Bigger = deeper recycling pool when Finnhub goes quiet (the
    // analyzer rotates through old headlines to keep bots active).
    // Backend caps at 200; values higher than that are silently clamped.
    int fetch_limit = 200;

    std::vector<NewsBotConfig> bots;
};

struct ServerConfig {
    int port = 9090;
    std::string backend_url = "http://localhost:3010";
    std::string db_path = "./engine.db";
    int auth_cache_ttl_seconds = 300;
    int index_feed_poll_ms = 1000;  // how often to pull live index anchors from the backend

    std::vector<SymbolConfig> symbols;
    MarketMakerConfig market_maker;
    NewsAnalysisConfig news;
};

// Loads JSON configuration. Throws std::runtime_error on parse / validation errors.
ServerConfig load_config(const std::string& path);

// Tiny helper: case-insensitive symbol-name resolution. Throws if not found.
class SymbolRegistry {
public:
    explicit SymbolRegistry(const std::vector<SymbolConfig>& symbols);

    std::optional<SymbolId> id_for(std::string_view name) const;
    std::optional<std::string> name_for(SymbolId id) const;
    const std::vector<SymbolConfig>& symbols() const { return symbols_; }

private:
    std::vector<SymbolConfig> symbols_;
    std::unordered_map<std::string, SymbolId> by_name_lower_;
    std::unordered_map<SymbolId, std::string> by_id_;
};

}
