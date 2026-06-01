#pragma once
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>

namespace TradingSystem {

struct AuthResult {
    bool valid = false;
    std::string user_id;   // populated when valid; "" if backend did not return one
};

// Validates `sk_live_<32hex>` API keys against the NestJS backend at backendUrl.
// Caches positive results with a TTL (configurable in seconds).
class ApiKeyAuthenticator {
public:
    ApiKeyAuthenticator();

    void setBackendUrl(std::string_view url);
    void setCacheTtlSeconds(int seconds);
    void setUseBackendAuth(bool use);

    // Returns {valid, user_id}. user_id may be empty if backend response had no userId.
    [[nodiscard]] AuthResult validate(std::string_view apiKey);

    // Convenience for callers that only care about the boolean.
    [[nodiscard]] bool validateApiKey(std::string_view apiKey) {
        return validate(apiKey).valid;
    }

    void addValidKey(std::string_view apiKey, std::string_view userId = {});
    void removeKey(std::string_view apiKey);

private:
    struct CacheEntry {
        std::string user_id;
        std::chrono::steady_clock::time_point expires_at;
    };

    AuthResult validateWithBackend(std::string_view apiKey);

    std::mutex mutex_;
    std::unordered_map<std::string, CacheEntry> cache_;
    std::string backend_url_;
    std::string backend_host_;     // parsed from backend_url_
    int backend_port_ = 3010;
    std::atomic<bool> use_backend_auth_{true};
    int cache_ttl_seconds_ = 300;
};

// Extracts an API key from a raw HTTP request (Authorization Bearer / Api-Key header / ?api_key=).
[[nodiscard]] std::string extractApiKeyFromHttp(std::string_view request);

}
