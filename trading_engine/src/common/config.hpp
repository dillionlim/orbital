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
    double spread_bps = 20.0;   // total spread; each side is half this
    Quantity size = 10;
    int refresh_ms = 5000;
    bool track_trades = true;
};

struct ServerConfig {
    int port = 9090;
    std::string backend_url = "http://localhost:3010";
    std::string db_path = "./engine.db";
    int auth_cache_ttl_seconds = 300;

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
