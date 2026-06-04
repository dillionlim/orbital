#include "common/config.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "rapidjson/document.h"

namespace TradingSystem {

namespace {

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string read_file(const std::string& path) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("config: cannot open " + path);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

}  // namespace

SymbolRegistry::SymbolRegistry(const std::vector<SymbolConfig>& symbols)
    : symbols_(symbols) {
    for (const auto& s : symbols_) {
        by_name_lower_[lower(s.name)] = s.id;
        by_id_[s.id] = s.name;
    }
}

std::optional<SymbolId> SymbolRegistry::id_for(std::string_view name) const {
    auto it = by_name_lower_.find(lower(std::string(name)));
    if (it == by_name_lower_.end()) return std::nullopt;
    return it->second;
}

std::optional<std::string> SymbolRegistry::name_for(SymbolId id) const {
    auto it = by_id_.find(id);
    if (it == by_id_.end()) return std::nullopt;
    return it->second;
}

ServerConfig load_config(const std::string& path) {
    rapidjson::Document doc;
    const std::string raw = read_file(path);
    if (doc.Parse(raw.c_str()).HasParseError()) {
        throw std::runtime_error("config: JSON parse error in " + path);
    }
    if (!doc.IsObject()) {
        throw std::runtime_error("config: top-level must be object");
    }

    ServerConfig cfg;

    if (doc.HasMember("server") && doc["server"].IsObject()) {
        const auto& s = doc["server"];
        if (s.HasMember("port") && s["port"].IsInt()) cfg.port = s["port"].GetInt();
        if (s.HasMember("backend_url") && s["backend_url"].IsString())
            cfg.backend_url = s["backend_url"].GetString();
        if (s.HasMember("db_path") && s["db_path"].IsString())
            cfg.db_path = s["db_path"].GetString();
        if (s.HasMember("auth_cache_ttl_seconds") && s["auth_cache_ttl_seconds"].IsInt())
            cfg.auth_cache_ttl_seconds = s["auth_cache_ttl_seconds"].GetInt();
    }

    if (!doc.HasMember("symbols") || !doc["symbols"].IsArray()) {
        throw std::runtime_error("config: missing 'symbols' array");
    }
    for (const auto& v : doc["symbols"].GetArray()) {
        if (!v.IsObject()) throw std::runtime_error("config: symbol entry must be object");
        SymbolConfig sc;
        if (!v.HasMember("name") || !v["name"].IsString())
            throw std::runtime_error("config: symbol.name required");
        if (!v.HasMember("id") || !v["id"].IsUint64())
            throw std::runtime_error("config: symbol.id required (uint)");
        if (!v.HasMember("mid") || !v["mid"].IsNumber())
            throw std::runtime_error("config: symbol.mid required (number)");
        sc.name = v["name"].GetString();
        sc.id = v["id"].GetUint64();
        sc.mid = v["mid"].GetDouble();
        cfg.symbols.push_back(sc);
    }
    if (cfg.symbols.empty()) {
        throw std::runtime_error("config: at least one symbol required");
    }

    if (doc.HasMember("market_maker") && doc["market_maker"].IsObject()) {
        const auto& m = doc["market_maker"];
        auto& mm = cfg.market_maker;
        if (m.HasMember("enabled") && m["enabled"].IsBool()) mm.enabled = m["enabled"].GetBool();
        if (m.HasMember("spread_bps") && m["spread_bps"].IsNumber())
            mm.spread_bps = m["spread_bps"].GetDouble();
        if (m.HasMember("size") && m["size"].IsUint64()) mm.size = m["size"].GetUint64();
        if (m.HasMember("refresh_ms") && m["refresh_ms"].IsInt())
            mm.refresh_ms = m["refresh_ms"].GetInt();
        if (m.HasMember("track_trades") && m["track_trades"].IsBool())
            mm.track_trades = m["track_trades"].GetBool();
    }

    return cfg;
}

}  // namespace TradingSystem
