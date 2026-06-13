#pragma once
#include <optional>
#include <string>

namespace TradingSystem {

enum class NewsDirection { Buy, Sell, Hold };

struct NewsAnalysis {
    // The wire-name symbol the model picked from `symbols_csv`, or "" if it
    // returned "NONE" / something we didn't recognise.
    std::string symbol_name;
    NewsDirection direction = NewsDirection::Hold;
    double confidence = 0.0;       // 0..1
};

// Categorises why classify() failed so callers can back off appropriately.
//   None             — success (analysis is populated)
//   Transport        — curl error, network down, timeout — retry next tick
//   AuthFailure      — Gemini rejected the key (HTTP 4xx with key-related
//                      error). Permanent until config changes; the
//                      analyzer should stop hammering the endpoint.
//   ResponseInvalid  — got a 2xx but couldn't parse / no candidates / etc.
enum class GeminiError { None, Transport, AuthFailure, ResponseInvalid };

struct GeminiResult {
    std::optional<NewsAnalysis> analysis;
    GeminiError error = GeminiError::None;
};

// Wraps Gemini's REST API by shelling out to `curl`. We deliberately don't
// link against libcurl/openssl so the engine binary stays compact and the
// distroless-style runtime image still works (curl needs to be installed
// in the runtime image — Dockerfile handles this).
//
// Constructor validates the key shape (alphanumerics + ._- only). Anything
// else is rejected up front since we pass the value into a shell command,
// and we'd rather fail loudly at startup than hand-craft escaping for a
// third-party-supplied secret.
class GeminiClient {
public:
    GeminiClient(std::string api_key, std::string model = "gemini-2.5-flash");

    // True if construction picked up a syntactically-valid key. Use this
    // pre-flight before kicking off the analyzer thread.
    [[nodiscard]] bool is_configured() const { return key_ok_; }

    // Returns the analysis on success along with an error category on
    // failure so callers can decide between retry (Transport, ResponseInvalid)
    // and back-off (AuthFailure).
    [[nodiscard]] GeminiResult classify(
        const std::string& headline,
        const std::string& summary,
        const std::string& symbols_csv) const;

private:
    std::string api_key_;
    std::string model_;
    bool key_ok_ = false;
};

}  // namespace TradingSystem
