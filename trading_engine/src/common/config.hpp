#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "common/types.hpp"

namespace TradingSystem {

struct SymbolConfig {
    std::string name;     // wire name, e.g. "BTC-USD"
    SymbolId id;          // internal id
    Price mid;            // initial mid for the market maker
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
};

struct ServerConfig {
    int port = 9090;
    std::string backend_url = "http://localhost:3010";
    std::string db_path = "./engine.db";
    int auth_cache_ttl_seconds = 300;
    int index_feed_poll_ms = 1000;  // how often to pull live index anchors from the backend

    std::vector<SymbolConfig> symbols;
    MarketMakerConfig market_maker;
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
