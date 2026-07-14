#include "auth/api_key_authenticator.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <regex>

#include "common/http_fetch.hpp"
#include "common/log.hpp"
#include "rapidjson/document.h"

namespace TradingSystem {

namespace {

// Parses "http://host:port" → {host, port}. Defaults to localhost:3010 on failure.
std::pair<std::string, int> parse_backend_url(std::string_view url) {
    std::string s(url);
    const std::string http = "http://";
    if (s.rfind(http, 0) == 0) s = s.substr(http.size());
    auto slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    auto colon = s.find(':');
    std::string host = (colon == std::string::npos) ? s : s.substr(0, colon);
    int port = 3010;
    if (colon != std::string::npos) {
        try { port = std::stoi(s.substr(colon + 1)); } catch (...) {}
    }
    if (host.empty()) host = "localhost";
    return {host, port};
}

}  // namespace

ApiKeyAuthenticator::ApiKeyAuthenticator() {
    setBackendUrl("http://localhost:3010");
}

void ApiKeyAuthenticator::setBackendUrl(std::string_view url) {
    backend_url_ = std::string(url);
    auto [h, p] = parse_backend_url(url);
    backend_host_ = h;
    backend_port_ = p;
}

void ApiKeyAuthenticator::setCacheTtlSeconds(int seconds) {
    cache_ttl_seconds_ = seconds;
}

void ApiKeyAuthenticator::setUseBackendAuth(bool use) {
    use_backend_auth_ = use;
}

AuthResult ApiKeyAuthenticator::validate(std::string_view apiKey) {
    if (apiKey.empty()) return {false, ""};

    static const std::regex pattern("^sk_live_[a-f0-9]{32}$");
    const std::string key(apiKey);
    if (!std::regex_match(key, pattern)) {
        LOG_DEBUG("auth: regex mismatch for key prefix=" << key.substr(0, 8));
        return {false, ""};
    }

    {
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = cache_.find(key);
        if (it != cache_.end()) {
            if (std::chrono::steady_clock::now() < it->second.expires_at) {
                return {true, it->second.user_id};
            }
            cache_.erase(it);
        }
    }

    if (!use_backend_auth_.load()) return {false, ""};

    AuthResult res = validateWithBackend(apiKey);
    if (res.valid) {
        std::lock_guard<std::mutex> lk(mutex_);
        cache_[key] = CacheEntry{
            res.user_id,
            std::chrono::steady_clock::now() + std::chrono::seconds(cache_ttl_seconds_)
        };
    }
    return res;
}

void ApiKeyAuthenticator::addValidKey(std::string_view apiKey, std::string_view userId) {
    std::lock_guard<std::mutex> lk(mutex_);
    cache_[std::string(apiKey)] = CacheEntry{
        std::string(userId),
        std::chrono::steady_clock::now() + std::chrono::hours(24 * 365)
    };
}

void ApiKeyAuthenticator::removeKey(std::string_view apiKey) {
    std::lock_guard<std::mutex> lk(mutex_);
    cache_.erase(std::string(apiKey));
}

AuthResult ApiKeyAuthenticator::validateWithBackend(std::string_view apiKey) {
    // Build the validate URL from the configured backend URL, preserving its
    // scheme so an https:// backend works — the request goes through curl,
    // which does the TLS the engine doesn't link itself.
    std::string base = backend_url_;
    while (!base.empty() && base.back() == '/') base.pop_back();
    const std::string url = base + "/api-keys/validate";

    // POST + body + shared-secret header. The key rides in the body (sent on
    // stdin by http_fetch) so it never lands in logs or `ps`; the shared secret
    // ($BUBBLES_ENGINE_SECRET) stops anyone else hammering /api-keys/validate.
    // If unset we still try — the backend refuses if its own secret is set.
    const char* shared = std::getenv("BUBBLES_ENGINE_SECRET");
    const std::string secret = shared ? shared : "";
    const std::string req_body = std::string("{\"key\":\"") + std::string(apiKey) + "\"}";
    std::vector<std::string> headers = {"Content-Type: application/json"};
    if (!secret.empty()) headers.push_back("X-Engine-Secret: " + secret);

    HttpResponse resp = http_fetch("POST", url, req_body, headers, 5);
    if (!resp.ok) return {false, ""};
    // Accept any 2xx (NestJS returns 201 on POST routes by default).
    if (resp.status < 200 || resp.status >= 300) return {false, ""};

    rapidjson::Document doc;
    if (doc.Parse(resp.body.c_str()).HasParseError() || !doc.IsObject()) {
        // Fall back to substring detection (matches old behavior).
        bool valid = resp.body.find("\"valid\":true") != std::string::npos ||
                     resp.body.find("\"valid\": true") != std::string::npos;
        return {valid, ""};
    }

    bool valid = false;
    if (doc.HasMember("valid") && doc["valid"].IsBool()) valid = doc["valid"].GetBool();
    std::string user_id;
    if (doc.HasMember("userId") && doc["userId"].IsString()) user_id = doc["userId"].GetString();
    else if (doc.HasMember("user_id") && doc["user_id"].IsString()) user_id = doc["user_id"].GetString();

    return {valid, user_id};
}

std::string extractApiKeyFromHttp(std::string_view request) {
    // Header-only. The previous `?api_key=` / `&api_key=` query-string fallback
    // was removed because:
    //   1. URLs end up in reverse-proxy / NestJS / browser-history logs;
    //      bodies and headers don't.
    //   2. Query-param auth on POST is a "simple" CORS request — no preflight,
    //      so any cross-origin page could fire mutating requests with a leaked
    //      key (combined with the engine's `Allow-Origin: *`). Header auth
    //      forces a preflight which the browser blocks for unknown origins.
    //
    // End of the header line at/after `pos`: the FIRST of \r\n or \n. Searching for \r\n
    // first (with an \n fallback) instead lets a lone-LF-terminated header run on and
    // swallow later lines up to the next \r\n.
    auto line_end = [&](size_t pos) -> size_t {
        size_t e = request.size();
        for (size_t i = pos; i < request.size(); ++i) {
            if (request[i] == '\n') { e = i; break; }
            if (request[i] == '\r') { e = i; break; }
        }
        return e;
    };

    // 1. Authorization: Bearer <key>
    size_t authPos = request.find("Authorization:");
    if (authPos == std::string_view::npos) authPos = request.find("authorization:");
    if (authPos != std::string_view::npos) {
        size_t eol = line_end(authPos);
        // Scope the Bearer scan to the Authorization line so a "Bearer x" sitting in some
        // later header can't be picked up as the credential.
        std::string_view line = request.substr(authPos, eol - authPos);
        size_t b = line.find("Bearer ");
        if (b != std::string_view::npos) {
            return std::string(line.substr(b + 7));
        }
    }

    // 2. Api-Key: <key>
    size_t apiPos = request.find("Api-Key:");
    if (apiPos == std::string_view::npos) apiPos = request.find("api-key:");
    if (apiPos != std::string_view::npos) {
        size_t start = apiPos + 8;
        size_t eol = line_end(start);
        while (start < eol && request[start] == ' ') start++;
        return std::string(request.substr(start, eol - start));
    }

    return "";
}

}  // namespace TradingSystem
