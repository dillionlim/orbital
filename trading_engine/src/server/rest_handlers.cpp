#include "server/rest_handlers.hpp"

#include <sstream>

#include "common/time.hpp"
#include "server/docs_bundle.hpp"
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
        case 401: phrase = "Unauthorized"; break;
        case 404: phrase = "Not Found"; break;
        case 405: phrase = "Method Not Allowed"; break;
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
    if (path.rfind("/trades", 0) == 0) {
        return handle_trades(path);
    }
    if (path == "/bots" || path.rfind("/bots?", 0) == 0) {
        return handle_bots();
    }
    if (path == "/docs" || path == "/docs/") {
        return handle_docs("index.html");
    }
    if (path.rfind("/docs/", 0) == 0) {
        return handle_docs(std::string_view(path).substr(6));
    }
    return http_response(404, "Not Found", "text/plain");
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

std::string RestRouter::handle_bots() {
    auto snaps = bots_ ? bots_->snapshot() : std::vector<BotTracker::BotSnapshot>{};
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
            << ",\"orders_placed\":" << b.orders_placed
            << ",\"fills\":" << b.fills
            << ",\"volume\":" << b.volume
            << ",\"total_pnl\":" << b.total_pnl
            << ",\"hourly_pnl\":" << b.hourly_pnl
            << ",\"first_seen\":" << b.first_seen
            << ",\"last_activity\":" << b.last_activity
            << "}";
    }
    oss << "]}";
    return http_response(200, oss.str(), "application/json");
}

std::string RestRouter::handle_docs(std::string_view asset_path) {
    const auto& assets = docs_assets();
    auto it = assets.find(std::string(asset_path));
    if (it == assets.end()) {
        return http_response(404, "doc asset not found: " + std::string(asset_path), "text/plain");
    }
    const auto& a = it->second;
    std::string body(reinterpret_cast<const char*>(a.data), a.size);
    return http_response(200, body, a.mime);
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
