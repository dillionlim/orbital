#pragma once
#include <map>
#include <mutex>
#include <string>

#include "engine/events.hpp"  // Timestamp

namespace TradingSystem {

// Thread-safe cache of the latest live index/reference prices, keyed by the
// engine's symbol name (e.g. "ES", "SPY", "NIKKEI").
//
// This is what makes the ENGINE the source of truth for live prices: the
// IndexPriceFeed fetches them from the upstream (Yahoo) and writes them here;
// the REST /index-prices handler reads them back. The NestJS backend now
// consumes that endpoint instead of polling Yahoo itself, so there is a single
// authoritative price origin (the trading engine) rather than two independent
// fetchers.
class IndexPriceStore {
public:
    struct Entry {
        double price = 0.0;
        Timestamp ts = 0;     // epoch ms of the last successful fetch
        std::string source;   // upstream that produced it ("yahoo")
    };

    void set(const std::string& symbol, double price, Timestamp ts,
             const std::string& source) {
        std::lock_guard<std::mutex> lk(mu_);
        prices_[symbol] = Entry{price, ts, source};
    }

    // Snapshot copy (cheap — a handful of symbols) so callers don't hold the lock.
    [[nodiscard]] std::map<std::string, Entry> snapshot() const {
        std::lock_guard<std::mutex> lk(mu_);
        return prices_;
    }

private:
    mutable std::mutex mu_;
    std::map<std::string, Entry> prices_;
};

}  // namespace TradingSystem
