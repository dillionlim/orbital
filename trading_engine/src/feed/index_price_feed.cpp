#include "feed/index_price_feed.hpp"

#include <cctype>
#include <cstdio>
#include <cstdlib>

#include <chrono>
#include <optional>
#include <sstream>

#include "common/log.hpp"
#include "common/time.hpp"
#include "rapidjson/document.h"

namespace TradingSystem {

namespace {

// Percent-encode a string so it's safe both as a URL path/query segment and
// inside the single-quoted shell command below. Only unreserved chars pass
// through; everything else becomes %XX, so no shell metacharacter survives.
std::string url_encode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size() * 3);
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 0xF]);
        }
    }
    return out;
}

// API keys are embedded in the curl command line; refuse anything that isn't a
// plain token so a stray quote/space can't break out of the shell argument.
// (Same defensive check the Gemini client applies to its key.)
bool key_safe(const std::string& key) {
    if (key.empty() || key.size() > 256) return false;
    for (char c : key) {
        if (!std::isalnum(static_cast<unsigned char>(c)) &&
            c != '_' && c != '-' && c != '.') {
            return false;
        }
    }
    return true;
}

// GET a URL via curl and return the body, or nullopt on any failure. curl does
// the TLS the engine itself doesn't link (same trick as gemini_client.cpp).
std::optional<std::string> http_get(const std::string& url) {
    const std::string cmd =
        "curl -sS --max-time 5 -H 'User-Agent: Mozilla/5.0' '" + url + "'";
    FILE* pipe = ::popen(cmd.c_str(), "r");
    if (!pipe) return std::nullopt;
    std::string out;
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), pipe)) > 0) {
        out.append(buf, n);
        if (out.size() > (1u << 20)) break;  // 1 MiB cap on a runaway response
    }
    int rc = ::pclose(pipe);
    if (rc != 0) return std::nullopt;
    return out;
}

}  // namespace

IndexPriceFeed::IndexPriceFeed(MarketMakerBot& mm,
                               std::shared_ptr<SymbolRegistry> registry,
                               std::shared_ptr<IndexPriceStore> store, int poll_ms)
    : mm_(mm), registry_(std::move(registry)), store_(std::move(store)),
      poll_ms_(poll_ms) {
    // Symbol -> {Yahoo, Massive (US ETF), TwelveData (cash index)} tickers.
    // Cash indices are display-only (not tradeable, no order book); the futures
    // + ETFs are the engine's tradeable markets and also anchor the MM. Keep
    // the tradeable names in sync with server.json.
    instruments_ = {
        // Cash indices (display only) — Yahoo primary, TwelveData fallback.
        {"NIKKEI",  "^N225",     "", "N225",      false},
        {"HSI",     "^HSI",      "", "HSI",       false},
        {"KOSPI",   "^KS11",     "", "KS11",      false},
        {"STOXX50", "^STOXX50E", "", "STOXX50E",  false},
        // Index futures (CME, ~24h) — Yahoo only.
        {"ES",  "ES=F",  "", "", true},
        {"NKD", "NKD=F", "", "", true},
        {"NQ",  "NQ=F",  "", "", true},
        {"YM",  "YM=F",  "", "", true},
        {"RTY", "RTY=F", "", "", true},
        // ETFs — Yahoo primary, Massive fallback.
        {"SPY", "SPY", "SPY", "", true},
        {"EWJ", "EWJ", "EWJ", "", true},
        {"EWH", "EWH", "EWH", "", true},
        {"EWY", "EWY", "EWY", "", true},
        {"FEZ", "FEZ", "FEZ", "", true},
    };

    // Optional fallback credentials from the engine's own environment.
    if (const char* mk = std::getenv("MASSIVE_API_KEY")) {
        std::string k(mk);
        if (key_safe(k)) massive_key_ = k;
        else if (!k.empty()) LOG_WARN("index_feed: ignoring malformed MASSIVE_API_KEY");
    }
    if (const char* tk = std::getenv("TWELVEDATA_API_KEYS")) {
        std::stringstream ss(tk);
        std::string key;
        while (std::getline(ss, key, ',')) {
            // trim surrounding whitespace
            size_t a = key.find_first_not_of(" \t");
            size_t b = key.find_last_not_of(" \t");
            if (a == std::string::npos) continue;
            key = key.substr(a, b - a + 1);
            if (key_safe(key)) td_keys_.push_back(key);
            else LOG_WARN("index_feed: ignoring malformed TWELVEDATA_API_KEYS entry");
        }
    }
}

IndexPriceFeed::~IndexPriceFeed() { stop(); }

void IndexPriceFeed::start() {
    running_ = true;
    thread_ = std::thread([this] { loop(); });
    LOG_INFO("index_feed: started; upstream=yahoo instruments=" << instruments_.size()
             << " poll_ms=" << poll_ms_
             << " massive=" << (massive_key_.empty() ? "off" : "on")
             << " twelvedata=" << (td_keys_.empty() ? "off" : std::to_string(td_keys_.size()) + "key")
             );
}

void IndexPriceFeed::stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
}

void IndexPriceFeed::loop() {
    while (running_.load()) {
        // Fetch sequentially so we spawn at most one curl at a time; this also
        // self-throttles the upstream request rate across a full cycle.
        for (const auto& inst : instruments_) {
            if (!running_.load()) break;
            fetch_one(inst);
        }
        // Sleep in small slices so shutdown stays responsive.
        for (int slept = 0; slept < poll_ms_ && running_.load(); slept += 100) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

std::optional<double> IndexPriceFeed::fetch_yahoo(const Instrument& inst) {
    if (inst.yahoo.empty()) return std::nullopt;
    const std::string url =
        "https://query1.finance.yahoo.com/v8/finance/chart/" + url_encode(inst.yahoo) +
        "?interval=1m&range=1d";
    auto body = http_get(url);
    if (!body) return std::nullopt;
    rapidjson::Document doc;
    if (doc.Parse(body->c_str()).HasParseError() || !doc.IsObject()) return std::nullopt;
    if (!doc.HasMember("chart") || !doc["chart"].IsObject()) return std::nullopt;
    const auto& chart = doc["chart"];
    if (!chart.HasMember("result") || !chart["result"].IsArray() || chart["result"].Empty())
        return std::nullopt;
    const auto& r0 = chart["result"][0];
    if (!r0.HasMember("meta") || !r0["meta"].IsObject()) return std::nullopt;
    const auto& meta = r0["meta"];
    if (!meta.HasMember("regularMarketPrice") || !meta["regularMarketPrice"].IsNumber())
        return std::nullopt;
    const double price = meta["regularMarketPrice"].GetDouble();
    return price > 0.0 ? std::optional<double>(price) : std::nullopt;
}

std::optional<double> IndexPriceFeed::fetch_massive(const Instrument& inst) {
    if (inst.massive.empty() || massive_key_.empty()) return std::nullopt;
    const std::string url =
        "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/" +
        url_encode(inst.massive) + "?apiKey=" + url_encode(massive_key_);
    auto body = http_get(url);
    if (!body) return std::nullopt;
    rapidjson::Document doc;
    if (doc.Parse(body->c_str()).HasParseError() || !doc.IsObject()) return std::nullopt;
    if (!doc.HasMember("ticker") || !doc["ticker"].IsObject()) return std::nullopt;
    const auto& t = doc["ticker"];
    // price = lastTrade.p ?? day.c ?? prevDay.c ?? min.c   (first present & >0)
    auto nested = [&](const char* a, const char* b) -> std::optional<double> {
        if (!t.HasMember(a) || !t[a].IsObject()) return std::nullopt;
        const auto& o = t[a];
        if (!o.HasMember(b) || !o[b].IsNumber()) return std::nullopt;
        double v = o[b].GetDouble();
        return v > 0.0 ? std::optional<double>(v) : std::nullopt;
    };
    if (auto v = nested("lastTrade", "p")) return v;
    if (auto v = nested("day", "c")) return v;
    if (auto v = nested("prevDay", "c")) return v;
    if (auto v = nested("min", "c")) return v;
    return std::nullopt;
}

std::optional<double> IndexPriceFeed::fetch_twelve_data(const Instrument& inst) {
    if (inst.twelve_data.empty() || td_keys_.empty()) return std::nullopt;
    const std::string& key = td_keys_[td_cursor_ % td_keys_.size()];
    ++td_cursor_;
    const std::string url = "https://api.twelvedata.com/price?symbol=" +
                            url_encode(inst.twelve_data) + "&apikey=" + url_encode(key);
    auto body = http_get(url);
    if (!body) return std::nullopt;
    rapidjson::Document doc;
    if (doc.Parse(body->c_str()).HasParseError() || !doc.IsObject()) return std::nullopt;
    // { "price": "740.25" }  or  { "status": "error", ... }
    if (doc.HasMember("status") && doc["status"].IsString() &&
        std::string(doc["status"].GetString()) == "error") {
        return std::nullopt;
    }
    if (!doc.HasMember("price") || !doc["price"].IsString()) return std::nullopt;
    try {
        double v = std::stod(doc["price"].GetString());
        return v > 0.0 ? std::optional<double>(v) : std::nullopt;
    } catch (...) {
        return std::nullopt;
    }
}

void IndexPriceFeed::fetch_one(const Instrument& inst) {
    // Yahoo primary, then Massive (ETFs), then TwelveData (cash indices) — the
    // same precedence the backend used before the engine took over fetching.
    const char* source = "yahoo";
    std::optional<double> price = fetch_yahoo(inst);
    if (!price) { price = fetch_massive(inst); if (price) source = "massive"; }
    if (!price) { price = fetch_twelve_data(inst); if (price) source = "twelvedata"; }
    if (!price) {
        LOG_DEBUG("index_feed: all sources failed for " << inst.symbol);
        return;
    }

    store_->set(inst.symbol, *price, now_ms(), source);

    // Tradeable symbols also drive the MM anchor (if configured in the engine).
    if (inst.tradeable) {
        if (auto id = registry_->id_for(inst.symbol)) {
            mm_.update_reference_price(*id, *price);
        }
    }
}

}  // namespace TradingSystem
