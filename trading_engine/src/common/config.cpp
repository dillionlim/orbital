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
        if (s.HasMember("index_feed_poll_ms") && s["index_feed_poll_ms"].IsInt())
            cfg.index_feed_poll_ms = s["index_feed_poll_ms"].GetInt();
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
        if (v.HasMember("desc") && v["desc"].IsString())
            sc.desc = v["desc"].GetString();

        // Position-cap parsing.
        //   `max_position` is shorthand: it sets both sides symmetrically.
        //   `max_long` / `max_short` override (asymmetric caps).
        // Order matters: read `max_position` first, then let the explicit
        // fields stomp it so a user can write `{ "max_position": 100,
        // "max_short": 50 }` to mean "long ≤100, short ≤50".
        if (v.HasMember("max_position") && v["max_position"].IsUint64()) {
            const auto m = v["max_position"].GetUint64();
            sc.max_long = m;
            sc.max_short = m;
        }
        if (v.HasMember("max_long") && v["max_long"].IsUint64()) {
            sc.max_long = v["max_long"].GetUint64();
        }
        if (v.HasMember("max_short") && v["max_short"].IsUint64()) {
            sc.max_short = v["max_short"].GetUint64();
        }
        cfg.symbols.push_back(sc);
    }
    if (cfg.symbols.empty()) {
        throw std::runtime_error("config: at least one symbol required");
    }

    if (doc.HasMember("market_maker") && doc["market_maker"].IsObject()) {
        const auto& m = doc["market_maker"];
        auto& mm = cfg.market_maker;
        if (m.HasMember("enabled") && m["enabled"].IsBool()) mm.enabled = m["enabled"].GetBool();
        if (m.HasMember("size") && m["size"].IsUint64()) mm.size = m["size"].GetUint64();
        if (m.HasMember("refresh_ms") && m["refresh_ms"].IsInt())
            mm.refresh_ms = m["refresh_ms"].GetInt();
        if (m.HasMember("track_trades") && m["track_trades"].IsBool())
            mm.track_trades = m["track_trades"].GetBool();
        if (m.HasMember("levels") && m["levels"].IsInt())
            mm.levels = m["levels"].GetInt();
        if (m.HasMember("churn_depth") && m["churn_depth"].IsInt())
            mm.churn_depth = m["churn_depth"].GetInt();
        if (m.HasMember("requote_drift_bps") && m["requote_drift_bps"].IsInt())
            mm.requote_drift_bps = m["requote_drift_bps"].GetInt();
    }

    if (doc.HasMember("news") && doc["news"].IsObject()) {
        const auto& n = doc["news"];
        auto& nc = cfg.news;
        if (n.HasMember("poll_seconds") && n["poll_seconds"].IsInt())
            nc.poll_seconds = n["poll_seconds"].GetInt();
        if (n.HasMember("gemini_model") && n["gemini_model"].IsString())
            nc.gemini_model = n["gemini_model"].GetString();
        if (n.HasMember("gemini_api_key") && n["gemini_api_key"].IsString())
            nc.gemini_api_key = n["gemini_api_key"].GetString();
        if (n.HasMember("fetch_limit") && n["fetch_limit"].IsInt())
            nc.fetch_limit = n["fetch_limit"].GetInt();
        if (n.HasMember("bots") && n["bots"].IsArray()) {
            for (const auto& b : n["bots"].GetArray()) {
                if (!b.IsObject()) continue;
                NewsBotConfig nb;
                if (b.HasMember("persona") && b["persona"].IsString())
                    nb.persona = b["persona"].GetString();
                if (b.HasMember("size_per_signal") && b["size_per_signal"].IsUint64())
                    nb.size_per_signal = b["size_per_signal"].GetUint64();
                if (b.HasMember("confidence_threshold") && b["confidence_threshold"].IsNumber())
                    nb.confidence_threshold = b["confidence_threshold"].GetDouble();
                if (b.HasMember("size_jitter_pct") && b["size_jitter_pct"].IsInt())
                    nb.size_jitter_pct = b["size_jitter_pct"].GetInt();
                if (b.HasMember("price_offset_jitter_bps") && b["price_offset_jitter_bps"].IsInt())
                    nb.price_offset_jitter_bps = b["price_offset_jitter_bps"].GetInt();
                if (b.HasMember("noise_interval_seconds") && b["noise_interval_seconds"].IsInt())
                    nb.noise_interval_seconds = b["noise_interval_seconds"].GetInt();
                if (b.HasMember("signal_delay_ms") && b["signal_delay_ms"].IsInt())
                    nb.signal_delay_ms = b["signal_delay_ms"].GetInt();

                // `count` is the new control. Still accept the old
                // `enabled: bool` for backward compatibility — it maps to
                // count = (enabled ? 1 : 0). Explicit `count` wins.
                if (b.HasMember("count") && b["count"].IsInt()) {
                    nb.count = b["count"].GetInt();
                } else if (b.HasMember("enabled") && b["enabled"].IsBool()) {
                    nb.count = b["enabled"].GetBool() ? 1 : 0;
                }
                if (nb.count < 0) nb.count = 0;
                nc.bots.push_back(std::move(nb));
            }
        }
    }

    return cfg;
}

}  // namespace TradingSystem
