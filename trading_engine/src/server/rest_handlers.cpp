#include "server/rest_handlers.hpp"

#include <sstream>

#include "common/time.hpp"
#include "server/protocol.hpp"

namespace TradingSystem {

std::string http_cors_preflight() {
    std::ostringstream oss;
    oss << "HTTP/1.1 204 No Content\r\n"
        << "Access-Control-Allow-Origin: *\r\n"
        << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        << "Access-Control-Allow-Headers: Origin, Content-Type, Authorization, Api-Key, Accept, "
           "Access-Control-Request-Method, Access-Control-Request-Headers, Cache-Control, Pragma\r\n"
        << "Access-Control-Max-Age: 86400\r\n"
        << "Access-Control-Allow-Credentials: false\r\n"
        << "Connection: close\r\n\r\n";
    return oss.str();
}

std::string http_response(int status_code, std::string_view body, std::string_view content_type) {
    const char* phrase = "OK";
    switch (status_code) {
        case 200: phrase = "OK"; break;
        case 400: phrase = "Bad Request"; break;
        case 401: phrase = "Unauthorized"; break;
        case 403: phrase = "Forbidden"; break;
        case 404: phrase = "Not Found"; break;
        case 405: phrase = "Method Not Allowed"; break;
        case 409: phrase = "Conflict"; break;
        case 503: phrase = "Service Unavailable"; break;
        default: phrase = "Error"; break;
    }
    std::ostringstream oss;
    oss << "HTTP/1.1 " << status_code << " " << phrase << "\r\n"
        << "Content-Type: " << content_type << "\r\n"
        << "Content-Length: " << body.size() << "\r\n"
        << "Access-Control-Allow-Origin: *\r\n"
        << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        << "Access-Control-Allow-Headers: Origin, Content-Type, Authorization, Api-Key, Accept, "
           "Cache-Control, Pragma\r\n"
        << "Access-Control-Allow-Credentials: false\r\n"
        << "Connection: close\r\n\r\n"
        << body;
    return oss.str();
}

std::string parse_http_path(std::string_view request) {
    size_t start = std::string_view::npos;
    for (std::string_view method : {"GET ", "POST ", "OPTIONS ", "HEAD ", "PUT ", "DELETE "}) {
        start = request.find(method);
        if (start == 0) {
            start += method.size();
            break;
        }
        start = std::string_view::npos;
    }
    if (start == std::string_view::npos) return "/";
    size_t end = request.find(' ', start);
    if (end == std::string_view::npos) return "/";
    return std::string(request.substr(start, end - start));
}

std::string parse_http_method(std::string_view request) {
    if (request.rfind("POST ", 0) == 0) return "POST";
    if (request.rfind("OPTIONS ", 0) == 0) return "OPTIONS";
    if (request.rfind("GET ", 0) == 0) return "GET";
    if (request.rfind("HEAD ", 0) == 0) return "HEAD";
    if (request.rfind("PUT ", 0) == 0) return "PUT";
    if (request.rfind("DELETE ", 0) == 0) return "DELETE";
    return "GET";
}

std::string parse_query_param(std::string_view path, std::string_view key) {
    const std::string needle = std::string(key) + "=";
    size_t pos = path.find(needle);
    if (pos == std::string_view::npos) return "";
    pos += needle.size();
    size_t end = path.find('&', pos);
    if (end == std::string_view::npos) end = path.length();
    return std::string(path.substr(pos, end - pos));
}

std::string RestRouter::handle(std::string_view request) {
    metrics_.recordRequest();

    const std::string method = parse_http_method(request);
    const std::string path = parse_http_path(request);

    if (method == "OPTIONS") return http_cors_preflight();
    if (path == "/health" || path.rfind("/health?", 0) == 0) {
        return http_response(200, "{\"status\":\"healthy\"}", "application/json");
    }
    if (path == "/status" || path.rfind("/status?", 0) == 0) {
        return http_response(200, metrics_.getStatusJson(port_), "application/json");
    }
    if (path == "/metrics" || path.rfind("/metrics?", 0) == 0) {
        return http_response(200, metrics_.getMetricsJson(), "application/json");
    }
    if (path == "/auth" || path.rfind("/auth?", 0) == 0) {
        if (method != "POST") return http_response(405, "Method Not Allowed", "text/plain");
        return handle_auth(request);
    }
    if (path.rfind("/orderbook", 0) == 0) {
        return handle_orderbook(path, request);
    }
    if (path == "/symbols" || path.rfind("/symbols?", 0) == 0) {
        return handle_symbols();
    }
    if (path == "/index-prices" || path.rfind("/index-prices?", 0) == 0) {
        return handle_index_prices();
    }
    // /trades/historical must match before the /trades prefix below.
    if (path.rfind("/trades/historical", 0) == 0) {
        return handle_historical_trades(path);
    }
    if (path.rfind("/trades", 0) == 0) {
        return handle_trades(path);
    }
    if (path == "/bots" || path.rfind("/bots?", 0) == 0) {
        return handle_bots(path);
    }
    // /bots/:client_id/{pause,resume} — POST, requires API key, owner-only.
    if (path.rfind("/bots/", 0) == 0 &&
        (path.size() > 6) &&
        (path.find("/pause") != std::string::npos || path.find("/resume") != std::string::npos)) {
        if (method != "POST") return http_response(405, "Method Not Allowed", "text/plain");
        // Strip query string before splitting.
        std::string p_only = path;
        if (auto q = p_only.find('?'); q != std::string::npos) p_only.resize(q);
        const bool is_pause = p_only.size() >= 6 && p_only.compare(p_only.size() - 6, 6, "/pause") == 0;
        const bool is_resume = !is_pause && p_only.size() >= 7 && p_only.compare(p_only.size() - 7, 7, "/resume") == 0;
        if (!is_pause && !is_resume) return http_response(404, "Not Found", "text/plain");
        const size_t suffix_len = is_pause ? 6 : 7;
        std::string client_id = p_only.substr(6, p_only.size() - 6 - suffix_len);
        if (client_id.empty()) return http_response(400, "{\"error\":\"missing client_id\"}", "application/json");
        return handle_bot_pause(client_id, request, is_pause);
    }
    // DELETE /bots/:client_id — forget a (disconnected) bot row, owner-only.
    if (method == "DELETE" && path.rfind("/bots/", 0) == 0 && path.size() > 6) {
        std::string p_only{path};
        if (auto q = p_only.find('?'); q != std::string::npos) p_only.resize(q);
        std::string client_id = p_only.substr(6);
        if (client_id.empty()) return http_response(400, "{\"error\":\"missing client_id\"}", "application/json");
        return handle_bot_remove(client_id, request);
    }
    // /me/fills must match before the plain /me below.
    if (path.rfind("/me/fills", 0) == 0) {
        return handle_me_fills(path, request);
    }
    if (path == "/me" || path.rfind("/me?", 0) == 0) {
        return handle_me(request);
    }
    return http_response(404, "Not Found", "text/plain");
}

// GET /symbols — anonymous-friendly. Returns the registry as configured at
// boot so the frontend can populate symbol pickers/subscriptions instead of
// hardcoding the BTC/ETH/LTC default trio.
std::string RestRouter::handle_symbols() {
    std::ostringstream oss;
    oss << "{\"symbols\":[";
    const auto& syms = registry_->symbols();
    for (std::size_t i = 0; i < syms.size(); ++i) {
        const auto& s = syms[i];
        if (i) oss << ",";
        oss << "{\"name\":\"" << s.name << "\""
            << ",\"id\":" << s.id
            << ",\"mid\":" << s.mid;
        // Only emit caps when actually configured — sentinels would mean
        // "no limit" but the wire shouldn't carry UINT64_MAX.
        if (s.max_long != kNoPositionLimit)
            oss << ",\"max_long\":" << s.max_long;
        if (s.max_short != kNoPositionLimit)
            oss << ",\"max_short\":" << s.max_short;
        oss << "}";
    }
    oss << "]}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_index_prices() {
    // Live prices the engine fetched from the upstream — the authoritative
    // source the NestJS backend consumes (same wire shape it used to serve:
    // {prices:{SYM:price}, meta:{SYM:{ts,source}}, ts}).
    auto snap = index_prices_ ? index_prices_->snapshot()
                              : std::map<std::string, IndexPriceStore::Entry>{};
    std::ostringstream oss;
    oss.precision(12);  // enough for the largest index level without sci-notation
    oss << "{\"prices\":{";
    bool first = true;
    for (const auto& [sym, e] : snap) {
        if (!first) oss << ",";
        first = false;
        oss << "\"" << sym << "\":" << e.price;
    }
    oss << "},\"meta\":{";
    first = true;
    for (const auto& [sym, e] : snap) {
        if (!first) oss << ",";
        first = false;
        oss << "\"" << sym << "\":{\"ts\":" << e.ts
            << ",\"source\":\"" << e.source << "\"}";
    }
    oss << "},\"ts\":" << now_ms() << "}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_trades(std::string_view path) {
    std::string sym_q = parse_query_param(path, "symbol");
    std::string limit_s = parse_query_param(path, "limit");
    std::size_t limit = 50;
    if (!limit_s.empty()) {
        try {
            limit = std::min<std::size_t>(500, std::max<std::size_t>(1, std::stoul(limit_s)));
        } catch (...) {}
    }

    auto resolve = [&](const std::string& s) -> std::optional<SymbolId> {
        if (auto id = registry_->id_for(s)) return id;
        return registry_->id_for(s + "-USD");
    };

    std::vector<TradePrint> trades;
    if (sym_q.empty()) {
        trades = trades_->get_all(limit);
    } else if (auto sym = resolve(sym_q)) {
        trades = trades_->get(*sym, limit);
    }

    std::ostringstream oss;
    oss << "{\"trades\":[";
    for (std::size_t i = 0; i < trades.size(); ++i) {
        const auto& t = trades[i];
        if (i) oss << ",";
        auto name = registry_->name_for(t.symbol);
        oss << "{\"trade_id\":" << t.trade_id
            << ",\"symbol\":\"" << (name ? *name : std::string()) << "\""
            << ",\"price\":" << t.price
            << ",\"quantity\":" << t.quantity
            << ",\"taker_side\":\"" << side_name(t.taker_side) << "\""
            << ",\"ts\":" << t.ts << "}";
    }
    oss << "]}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_historical_trades(std::string_view path) {
    // Query params: symbol (e.g. "BTC-USD" or "btc"), from (ms), to (ms), limit.
    // All optional. The store hard-caps limit at 50_000.
    std::string sym_q   = parse_query_param(path, "symbol");
    std::string from_s  = parse_query_param(path, "from");
    std::string to_s    = parse_query_param(path, "to");
    std::string limit_s = parse_query_param(path, "limit");

    Timestamp from_ms = 0, to_ms = 0;
    std::size_t limit = 5000;
    auto try_uint = [](const std::string& s, auto& out) {
        if (s.empty()) return;
        try { out = static_cast<std::decay_t<decltype(out)>>(std::stoull(s)); } catch (...) {}
    };
    try_uint(from_s,  from_ms);
    try_uint(to_s,    to_ms);
    try_uint(limit_s, limit);
    limit = std::clamp<std::size_t>(limit, 1, 50000);

    // Resolve a friendly symbol (e.g. "btc" → "BTC-USD") into the canonical
    // name SQLite has indexed; pass empty string for "all symbols".
    std::string canonical;
    if (!sym_q.empty()) {
        auto id = registry_->id_for(sym_q);
        if (!id) id = registry_->id_for(sym_q + "-USD");
        if (id) {
            auto name = registry_->name_for(*id);
            if (name) canonical = *name;
        } else {
            canonical = sym_q;  // pass through; query just won't match
        }
    }

    auto rows = store_.query_trades(canonical, from_ms, to_ms, limit);

    std::ostringstream oss;
    oss << "{\"trades\":[";
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const auto& t = rows[i];
        if (i) oss << ",";
        oss << "{\"trade_id\":" << t.trade_id
            << ",\"symbol\":\"" << t.symbol_name << "\""
            << ",\"price\":"    << t.price
            << ",\"quantity\":" << t.quantity
            << ",\"taker_side\":\"" << t.taker_side << "\""
            << ",\"ts\":"       << t.ts << "}";
    }
    oss << "],\"count\":" << rows.size() << "}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_bots(std::string_view path) {
    int64_t window_ms = 60 * 60 * 1000;  // default 60min
    std::string w = parse_query_param(path, "window_ms");
    if (!w.empty()) {
        try { window_ms = std::stoll(w); } catch (...) {}
    }
    auto connected = sessions_.connected_client_ids();
    auto snaps = bots_ ? bots_->snapshot(connected, window_ms)
                       : std::vector<BotTracker::BotSnapshot>{};
    std::ostringstream oss;
    oss << "{\"bots\":[";
    for (std::size_t i = 0; i < snaps.size(); ++i) {
        const auto& b = snaps[i];
        if (i) oss << ",";
        // Escape strings minimally — our values are plaintext IDs/labels.
        auto esc = [](const std::string& s) {
            std::string r;
            r.reserve(s.size());
            for (char c : s) {
                if (c == '"' || c == '\\') { r.push_back('\\'); r.push_back(c); }
                else if (c == '\n') r += "\\n";
                else if (static_cast<unsigned char>(c) < 0x20) continue;
                else r.push_back(c);
            }
            return r;
        };
        oss << "{\"user_id\":\"" << esc(b.user_id) << "\""
            << ",\"client_id\":\"" << esc(b.client_id) << "\""
            << ",\"name\":\"" << esc(b.display_name) << "\""
            << ",\"strategy_name\":\"" << esc(b.strategy_name) << "\""
            << ",\"is_internal\":" << (b.is_internal ? "true" : "false")
            << ",\"status\":\"" << b.status << "\""
            << ",\"paused\":" << (b.paused ? "true" : "false")
            << ",\"orders_placed\":" << b.orders_placed
            << ",\"fills\":" << b.fills
            << ",\"volume\":" << b.volume
            << ",\"total_pnl\":" << b.total_pnl
            << ",\"hourly_pnl\":" << b.hourly_pnl
            << ",\"windowed_pnl\":" << b.windowed_pnl
            << ",\"window_ms\":" << b.window_ms
            << ",\"first_seen\":" << b.first_seen
            << ",\"last_activity\":" << b.last_activity
            << "}";
    }
    oss << "]}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_auth(std::string_view request) {
    std::string apiKey = extractApiKeyFromHttp(request);
    if (apiKey.empty()) {
        return http_response(401, "{\"authenticated\":false,\"error\":\"Missing API key\"}",
                             "application/json");
    }
    auto res = auth_.validate(apiKey);
    if (!res.valid) {
        return http_response(401, "{\"authenticated\":false,\"error\":\"Invalid API key\"}",
                             "application/json");
    }
    std::ostringstream oss;
    oss << "{\"authenticated\":true,\"user_id\":\"" << res.user_id << "\"}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_me(std::string_view request) {
    std::string apiKey = extractApiKeyFromHttp(request);
    if (apiKey.empty()) {
        return http_response(401, "{\"error\":\"missing api key\"}", "application/json");
    }
    auto res = auth_.validate(apiKey);
    if (!res.valid) {
        return http_response(401, "{\"error\":\"invalid api key\"}", "application/json");
    }
    std::ostringstream oss;
    oss << "{\"user_id\":\"" << res.user_id << "\"}";
    return http_response(200, oss.str(), "application/json");
}

// GET /me/fills?limit=N — the caller's own executions (most-recent-first),
// resolved from their API key. Same shape as /trades plus the resting side.
std::string RestRouter::handle_me_fills(std::string_view path, std::string_view request) {
    std::string apiKey = extractApiKeyFromHttp(request);
    if (apiKey.empty()) {
        return http_response(401, "{\"error\":\"missing api key\"}", "application/json");
    }
    auto res = auth_.validate(apiKey);
    if (!res.valid) {
        return http_response(401, "{\"error\":\"invalid api key\"}", "application/json");
    }

    std::size_t limit = 50;
    std::string limit_s = parse_query_param(path, "limit");
    if (!limit_s.empty()) {
        try {
            limit = std::min<std::size_t>(200, std::max<std::size_t>(1, std::stoul(limit_s)));
        } catch (...) {}
    }

    const auto fills = user_fills_->get(res.user_id, limit);
    std::ostringstream oss;
    oss << "{\"user_id\":\"" << res.user_id << "\",\"fills\":[";
    for (std::size_t i = 0; i < fills.size(); ++i) {
        const auto& f = fills[i];
        if (i) oss << ",";
        auto name = registry_->name_for(f.symbol);
        oss << "{\"trade_id\":" << f.trade_id
            << ",\"symbol\":\"" << (name ? *name : std::string()) << "\""
            << ",\"price\":" << f.price
            << ",\"quantity\":" << f.quantity
            << ",\"side\":\"" << side_name(f.side) << "\""
            << ",\"ts\":" << f.ts << "}";
    }
    oss << "]}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_bot_pause(std::string_view client_id,
                                         std::string_view request, bool pause) {
    std::string apiKey = extractApiKeyFromHttp(request);
    if (apiKey.empty()) {
        return http_response(401, "{\"error\":\"missing api key\"}", "application/json");
    }
    auto auth_res = auth_.validate(apiKey);
    if (!auth_res.valid || auth_res.user_id.empty()) {
        return http_response(401, "{\"error\":\"invalid api key\"}", "application/json");
    }
    if (!bots_) {
        return http_response(503, "{\"error\":\"bot tracker unavailable\"}", "application/json");
    }
    auto result = pause ? bots_->pause(client_id, auth_res.user_id)
                        : bots_->resume(client_id, auth_res.user_id);
    switch (result) {
        case BotTracker::PauseResult::Ok: {
            // On pause: cancel resting orders FIRST (while sessions are still
            // in the registry so own_orders is reachable), then kick the WS.
            // Otherwise the kick races on_disconnect and the bot's existing
            // orders sit on the book getting filled by the MM, which looks
            // like the pause didn't take. On resume, nothing to do — the bot
            // reconnects on its own.
            if (pause) {
                dispatcher_.cancel_orders_for_client(auth_res.user_id, client_id);
                sessions_.kick_by_client_id(auth_res.user_id, client_id);
            }
            std::ostringstream oss;
            oss << "{\"ok\":true,\"client_id\":\"" << client_id
                << "\",\"paused\":" << (pause ? "true" : "false") << "}";
            return http_response(200, oss.str(), "application/json");
        }
        case BotTracker::PauseResult::NotFound:
            return http_response(404, "{\"error\":\"unknown client_id\"}", "application/json");
        case BotTracker::PauseResult::NotOwner:
            return http_response(403, "{\"error\":\"not owner\"}", "application/json");
        case BotTracker::PauseResult::InternalBot:
            return http_response(409, "{\"error\":\"cannot pause internal bot\"}", "application/json");
    }
    return http_response(500, "{\"error\":\"unreachable\"}", "application/json");
}
std::string RestRouter::handle_bot_remove(std::string_view client_id,
                                          std::string_view request) {
    std::string apiKey = extractApiKeyFromHttp(request);
    if (apiKey.empty()) {
        return http_response(401, "{\"error\":\"missing api key\"}", "application/json");
    }
    auto auth_res = auth_.validate(apiKey);
    if (!auth_res.valid || auth_res.user_id.empty()) {
        return http_response(401, "{\"error\":\"invalid api key\"}", "application/json");
    }
    if (!bots_) {
        return http_response(503, "{\"error\":\"bot tracker unavailable\"}", "application/json");
    }
    // Disconnect first (cancel resting orders + kick any live session) so a
    // still-connected bot doesn't leave orphaned orders on the book or
    // immediately re-register the row. Both are no-ops for a disconnected bot.
    dispatcher_.cancel_orders_for_client(auth_res.user_id, client_id);
    sessions_.kick_by_client_id(auth_res.user_id, client_id);
    switch (bots_->remove(client_id, auth_res.user_id)) {
        case BotTracker::PauseResult::Ok: {
            std::ostringstream oss;
            oss << "{\"ok\":true,\"client_id\":\"" << client_id << "\",\"removed\":true}";
            return http_response(200, oss.str(), "application/json");
        }
        case BotTracker::PauseResult::NotFound:
            return http_response(404, "{\"error\":\"unknown client_id\"}", "application/json");
        case BotTracker::PauseResult::NotOwner:
            return http_response(403, "{\"error\":\"not owner\"}", "application/json");
        case BotTracker::PauseResult::InternalBot:
            return http_response(409, "{\"error\":\"cannot remove internal bot\"}", "application/json");
    }
    return http_response(500, "{\"error\":\"unreachable\"}", "application/json");
}

std::string RestRouter::handle_orderbook(std::string_view path, std::string_view request) {
    // Allow optional API key but don't require one — frontend polls anonymously.
    std::string apiKey = extractApiKeyFromHttp(request);
    if (!apiKey.empty()) {
        if (!auth_.validateApiKey(apiKey)) {
            return http_response(401, "{\"error\":\"Invalid API key\"}", "application/json");
        }
    }

    std::string sym_q = parse_query_param(path, "symbol");
    if (sym_q.empty()) sym_q = "BTC";

    // Try the raw query, then attach -USD suffix, then look up.
    auto resolve = [&](const std::string& s) -> std::optional<SymbolId> {
        if (auto id = registry_->id_for(s)) return id;
        return registry_->id_for(s + "-USD");
    };
    auto sym_id = resolve(sym_q);

    std::ostringstream oss;
    oss << "{\"symbol\":\"";
    if (sym_id) {
        auto name = registry_->name_for(*sym_id);
        oss << (name ? *name : sym_q);
    } else {
        oss << sym_q;
    }
    oss << "\",\"timestamp\":\"" << now_ms() << "\"";

    if (sym_id) {
        auto snap = snapshots_->get(*sym_id);
        if (snap) {
            oss << ",\"bids\":[";
            for (size_t i = 0; i < snap->bids.size(); ++i) {
                if (i) oss << ",";
                const auto& l = snap->bids[i];
                oss << "{\"price\":" << l.price << ",\"size\":" << l.qty
                    << ",\"total\":" << (l.price * static_cast<double>(l.qty)) << "}";
            }
            oss << "],\"asks\":[";
            for (size_t i = 0; i < snap->asks.size(); ++i) {
                if (i) oss << ",";
                const auto& l = snap->asks[i];
                oss << "{\"price\":" << l.price << ",\"size\":" << l.qty
                    << ",\"total\":" << (l.price * static_cast<double>(l.qty)) << "}";
            }
            oss << "]}";
            return http_response(200, oss.str(), "application/json");
        }
    }
    // Empty book or unknown symbol — return empty arrays to keep the frontend happy.
    oss << ",\"bids\":[],\"asks\":[]}";
    return http_response(200, oss.str(), "application/json");
}

}  // namespace TradingSystem
