#pragma once
#include <atomic>
#include <memory>
#include <string>
#include <thread>

#include "common/config.hpp"
#include "market_maker/mm_bot.hpp"

namespace TradingSystem {

// Polls the backend's GET /index-prices for live index anchors and feeds them
// into the market maker's per-symbol reference price. The backend handles the
// HTTPS upstream (Yahoo / Twelve Data); this only talks plain HTTP to the
// backend on localhost, reusing the same socket style as the API-key auth path.
class IndexPriceFeed {
public:
    IndexPriceFeed(MarketMakerBot& mm, std::shared_ptr<SymbolRegistry> registry,
                   std::string backend_url, int poll_ms);
    ~IndexPriceFeed();

    void start();
    void stop();

private:
    void loop();
    bool fetch_and_apply();

    MarketMakerBot& mm_;
    std::shared_ptr<SymbolRegistry> registry_;
    std::string backend_host_;
    int backend_port_ = 3010;
    int poll_ms_ = 5000;

    std::atomic<bool> running_{false};
    std::thread thread_;
};

}  // namespace TradingSystem
