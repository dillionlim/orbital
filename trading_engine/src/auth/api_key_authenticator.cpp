#include "auth/api_key_authenticator.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <regex>

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
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) return {false, ""};

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(backend_port_);

    // Resolve host (handles "localhost", IPs, and hostnames).
    struct hostent* he = gethostbyname(backend_host_.c_str());
    if (!he) {
        close(sockfd);
        return {false, ""};
    }
    std::memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);

    if (connect(sockfd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(sockfd);
        return {false, ""};
    }

    // POST + body + shared-secret header. Two reasons over the old GET ?key=:
    //   1. Reverse-proxy and NestJS access logs capture full URLs but never
    //      bodies, so secrets stop leaking into log files.
    //   2. The shared secret stops anyone other than this engine from
    //      hammering /api-keys/validate as a free DB-DoS amplifier.
    // The shared secret comes from $BUBBLES_ENGINE_SECRET; if unset, we still
    // try the request — backend will refuse if its own secret is configured,
    // and dev/local-only setups stay one-step.
    const char* shared = std::getenv("BUBBLES_ENGINE_SECRET");
    const std::string secret = shared ? shared : "";
    const std::string req_body = std::string("{\"key\":\"") + std::string(apiKey) + "\"}";
    std::string req = "POST /api-keys/validate HTTP/1.1\r\n";
    req += "Host: " + backend_host_ + ":" + std::to_string(backend_port_) + "\r\n";
    req += "Content-Type: application/json\r\n";
    req += "Content-Length: " + std::to_string(req_body.size()) + "\r\n";
    if (!secret.empty()) req += "X-Engine-Secret: " + secret + "\r\n";
    req += "Connection: close\r\n\r\n";
    req += req_body;
    if (::send(sockfd, req.data(), req.size(), 0) < 0) {
        close(sockfd);
        return {false, ""};
    }

    std::string resp;
    char buf[4096];
    while (true) {
        ssize_t n = read(sockfd, buf, sizeof(buf));
        if (n <= 0) break;
        resp.append(buf, buf + n);
        if (resp.size() > 1 << 20) break;  // 1 MiB cap
    }
    close(sockfd);

    // Accept any 2xx status. NestJS returns 201 Created on POST routes by
    // default, so a hardcoded "200 OK" check would treat every key as
    // invalid (which is exactly the bug that was making /me return 401
    // for valid keys after the GET→POST validate switch).
    if (resp.size() < 12 || resp.compare(0, 9, "HTTP/1.1 ") != 0) return {false, ""};
    if (resp[9] != '2') return {false, ""};

    // Skip headers, parse JSON body.
    auto body_start = resp.find("\r\n\r\n");
    if (body_start == std::string::npos) return {false, ""};
    std::string body = resp.substr(body_start + 4);

    rapidjson::Document doc;
    if (doc.Parse(body.c_str()).HasParseError() || !doc.IsObject()) {
        // Fall back to substring detection (matches old behavior).
        bool valid = body.find("\"valid\":true") != std::string::npos ||
                     body.find("\"valid\": true") != std::string::npos;
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
    // 1. Authorization: Bearer <key>
    size_t authPos = request.find("Authorization:");
    if (authPos == std::string_view::npos) authPos = request.find("authorization:");
    if (authPos != std::string_view::npos) {
        size_t start = request.find("Bearer ", authPos);
        if (start != std::string_view::npos) {
            start += 7;
            size_t end = request.find("\r\n", start);
            if (end == std::string_view::npos) end = request.find("\n", start);
            if (end != std::string_view::npos) return std::string(request.substr(start, end - start));
            return std::string(request.substr(start));
        }
    }

    // 2. Api-Key: <key>
    size_t apiPos = request.find("Api-Key:");
    if (apiPos == std::string_view::npos) apiPos = request.find("api-key:");
    if (apiPos != std::string_view::npos) {
        size_t start = apiPos + 8;
        while (start < request.size() && request[start] == ' ') start++;
        size_t end = request.find("\r\n", start);
        if (end == std::string_view::npos) end = request.find("\n", start);
        if (end != std::string_view::npos) return std::string(request.substr(start, end - start));
        return std::string(request.substr(start));
    }

    return "";
}

}  // namespace TradingSystem
