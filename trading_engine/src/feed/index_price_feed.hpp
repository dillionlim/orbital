#pragma once
#include <atomic>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "common/config.hpp"
#include "feed/index_price_store.hpp"
#include "market_maker/mm_bot.hpp"

namespace TradingSystem {

// Fetches live index / ETF / future prices directly from the upstream (Yahoo
// Finance, via curl — the engine links no TLS, same approach as the Gemini
// news client) and is the engine's single source of truth for them:
//   - tradeable symbols (ES, NQ, SPY, …) drive the market maker's per-symbol
//     reference (anchor) price, and
//   - every fetched price (including the display-only cash indices) is written
//     to the shared IndexPriceStore, which the REST /index-prices endpoint
//     serves. The NestJS backend consumes that endpoint instead of polling
//     Yahoo itself.
class IndexPriceFeed {
public:
    IndexPriceFeed(MarketMakerBot& mm, std::shared_ptr<SymbolRegistry> registry,
                   std::shared_ptr<IndexPriceStore> store, int poll_ms);
    ~IndexPriceFeed();

    void start();
    void stop();

private:
    // One upstream instrument. `symbol` is the engine-facing name; `yahoo` is
    // the Yahoo Finance ticker (primary). `massive` (US ETF ticker) and
    // `twelve_data` (cash-index symbol) are optional fallbacks used when Yahoo
    // fails AND the matching API key is configured. `tradeable` instruments
    // also anchor the MM.
    struct Instrument {
        std::string symbol;
        std::string yahoo;
        std::string massive;
        std::string twelve_data;
        bool tradeable;
    };

    void loop();
    void fetch_one(const Instrument& inst);
    std::optional<double> fetch_yahoo(const Instrument& inst);
    std::optional<double> fetch_massive(const Instrument& inst);
    std::optional<double> fetch_twelve_data(const Instrument& inst);

    MarketMakerBot& mm_;
    std::shared_ptr<SymbolRegistry> registry_;
    std::shared_ptr<IndexPriceStore> store_;
    int poll_ms_ = 1000;
    std::vector<Instrument> instruments_;
    // Optional fallback-API credentials, read from the engine's own env
    // (MASSIVE_API_KEY, TWELVEDATA_API_KEYS). Empty => that fallback is off.
    std::string massive_key_;
    std::vector<std::string> td_keys_;
    std::size_t td_cursor_ = 0;  // round-robins td_keys_; only the feed thread touches it

    std::atomic<bool> running_{false};
    std::thread thread_;
};

}  // namespace TradingSystem
