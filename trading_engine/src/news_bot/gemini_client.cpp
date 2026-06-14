#include "news_bot/gemini_client.hpp"

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <sstream>

#include "common/log.hpp"
#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

namespace TradingSystem {

namespace {

bool key_looks_safe(const std::string& key) {
    // Real Gemini keys are alphanumeric + `_-`. A control character or quote
    // here means either a copy-paste mistake or someone trying to inject
    // arguments into the curl shell command — refuse either way.
    if (key.empty() || key.size() > 256) return false;
    for (char c : key) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '-' && c != '.') {
            return false;
        }
    }
    return true;
}

// Build a lower-case version of `s` for case-insensitive matching.
std::string to_lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

// Pick the first symbol from `symbols_csv` whose stripped-suffix prefix
// (e.g. "BTC" from "BTC-USD") appears in `chosen`. Lets the model say
// "BTC" or "btc-usd" or "Bitcoin (BTC)" and still resolve to the right
// internal name.
std::string resolve_symbol(const std::string& chosen, const std::string& symbols_csv) {
    if (chosen.empty()) return "";
    const std::string lc = to_lower(chosen);
    std::stringstream ss(symbols_csv);
    std::string sym;
    while (std::getline(ss, sym, ',')) {
        // trim
        size_t a = 0, b = sym.size();
        while (a < b && std::isspace(static_cast<unsigned char>(sym[a]))) ++a;
        while (b > a && std::isspace(static_cast<unsigned char>(sym[b - 1]))) --b;
        const std::string s = sym.substr(a, b - a);
        if (s.empty()) continue;
        const std::string ls = to_lower(s);
        if (ls == lc) return s;
        // Match by prefix-before-dash (e.g. "BTC" → "BTC-USD").
        const auto dash = ls.find('-');
        if (dash != std::string::npos && ls.substr(0, dash) == lc) return s;
    }
    return "";
}

NewsDirection parse_direction(const std::string& s) {
    const std::string lc = to_lower(s);
    if (lc == "buy" || lc == "long" || lc == "bullish")  return NewsDirection::Buy;
    if (lc == "sell" || lc == "short" || lc == "bearish") return NewsDirection::Sell;
    return NewsDirection::Hold;
}

// Run `cmd` as a shell pipeline; write `stdin_body` to its stdin, capture
// stdout. Returns std::nullopt on non-zero exit. Used because popen is
// unidirectional — we need both directions for `curl --data-binary @-`.
std::optional<std::string> run_command_with_input(const std::string& cmd,
                                                  const std::string& stdin_body) {
    int in_pipe[2];   // parent → child
    int out_pipe[2];  // child → parent
    if (pipe(in_pipe) != 0) return std::nullopt;
    if (pipe(out_pipe) != 0) {
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        return std::nullopt;
    }

    pid_t pid = ::fork();
    if (pid < 0) {
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        ::close(out_pipe[0]); ::close(out_pipe[1]);
        return std::nullopt;
    }
    if (pid == 0) {
        // Child.
        ::dup2(in_pipe[0], STDIN_FILENO);
        ::dup2(out_pipe[1], STDOUT_FILENO);
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        ::close(out_pipe[0]); ::close(out_pipe[1]);
        ::execlp("sh", "sh", "-c", cmd.c_str(), nullptr);
        ::_exit(127);
    }

    // Parent.
    ::close(in_pipe[0]);
    ::close(out_pipe[1]);
    if (!stdin_body.empty()) {
        const char* p = stdin_body.data();
        size_t left = stdin_body.size();
        while (left > 0) {
            ssize_t n = ::write(in_pipe[1], p, left);
            if (n <= 0) break;
            p += n;
            left -= static_cast<size_t>(n);
        }
    }
    ::close(in_pipe[1]);

    std::string out;
    std::array<char, 4096> buf{};
    while (true) {
        ssize_t n = ::read(out_pipe[0], buf.data(), buf.size());
        if (n <= 0) break;
        out.append(buf.data(), buf.data() + n);
        if (out.size() > (1u << 20)) break;  // 1 MiB cap, reject runaway responses
    }
    ::close(out_pipe[0]);

    int status = 0;
    ::waitpid(pid, &status, 0);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        return std::nullopt;
    }
    return out;
}

}  // namespace

GeminiClient::GeminiClient(std::string api_key, std::string model)
    : api_key_(std::move(api_key)), model_(std::move(model)) {
    key_ok_ = key_looks_safe(api_key_);
    if (!key_ok_) {
        LOG_WARN("gemini: ignoring malformed GEMINI_API_KEY (must be alnum + _.- only)");
    }
}

GeminiResult GeminiClient::classify(const std::string& headline,
                                    const std::string& summary,
                                    const std::string& symbols_csv) const {
    if (!key_ok_) return GeminiResult{std::nullopt, GeminiError::AuthFailure};

    // Build the request body. responseSchema constrains the model to a
    // structured JSON output (no need to parse markdown or strip prose).
    const std::string prompt =
        "You are a market analyst classifying news for crypto trading.\n"
        "Symbols available: " + symbols_csv + "\n"
        "Pick the single symbol most affected (or NONE if no clear connection),\n"
        "decide direction (buy = positive, sell = negative, hold = unclear),\n"
        "and a confidence 0..1.\n\n"
        "Headline: " + headline + "\n"
        "Summary: " + summary;

    rapidjson::StringBuffer sb;
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
        w.Key("contents");        w.StartArray();
            w.StartObject();
                w.Key("role");    w.String("user");
                w.Key("parts");   w.StartArray();
                    w.StartObject(); w.Key("text"); w.String(prompt.c_str()); w.EndObject();
                w.EndArray();
            w.EndObject();
        w.EndArray();
        w.Key("generationConfig"); w.StartObject();
            w.Key("temperature"); w.Double(0.2);
            w.Key("responseMimeType"); w.String("application/json");
            w.Key("responseSchema"); w.StartObject();
                w.Key("type"); w.String("OBJECT");
                w.Key("properties"); w.StartObject();
                    w.Key("symbol"); w.StartObject();
                        w.Key("type"); w.String("STRING");
                    w.EndObject();
                    w.Key("direction"); w.StartObject();
                        w.Key("type"); w.String("STRING");
                        w.Key("enum"); w.StartArray();
                            w.String("buy"); w.String("sell"); w.String("hold");
                        w.EndArray();
                    w.EndObject();
                    w.Key("confidence"); w.StartObject();
                        w.Key("type"); w.String("NUMBER");
                    w.EndObject();
                w.EndObject();
                w.Key("required"); w.StartArray();
                    w.String("symbol"); w.String("direction"); w.String("confidence");
                w.EndArray();
            w.EndObject();
        w.EndObject();
    w.EndObject();
    const std::string body = sb.GetString();

    // Build the curl command. The API key goes in the `x-goog-api-key`
    // header (we validated its character set so embedding in the shell
    // string is safe); the body lands via stdin so we don't have to
    // worry about quoting JSON for the shell.
    const std::string url =
        "https://generativelanguage.googleapis.com/v1beta/models/" + model_ + ":generateContent";
    const std::string cmd =
        "curl -sS --max-time 30 -X POST "
        "-H 'Content-Type: application/json' "
        "-H 'x-goog-api-key: " + api_key_ + "' "
        "--data-binary @- " + url;

    auto resp = run_command_with_input(cmd, body);
    if (!resp) {
        LOG_WARN("gemini: curl failed (no network / quota / curl missing)");
        return GeminiResult{std::nullopt, GeminiError::Transport};
    }

    // Parse the outer response → extract candidates[0].content.parts[0].text.
    rapidjson::Document doc;
    if (doc.Parse(resp->c_str()).HasParseError() || !doc.IsObject()) {
        LOG_WARN("gemini: malformed JSON response: " << resp->substr(0, 200));
        return GeminiResult{std::nullopt, GeminiError::ResponseInvalid};
    }
    if (!doc.HasMember("candidates") || !doc["candidates"].IsArray() ||
        doc["candidates"].Empty()) {
        // Inspect the `error` object — Gemini surfaces auth issues as
        // INVALID_ARGUMENT / PERMISSION_DENIED / UNAUTHENTICATED. We
        // treat those as permanent so the caller can stop retrying.
        if (doc.HasMember("error") && doc["error"].IsObject()) {
            const auto& err = doc["error"];
            std::string status;
            int code = 0;
            if (err.HasMember("status") && err["status"].IsString())
                status = err["status"].GetString();
            if (err.HasMember("code") && err["code"].IsInt())
                code = err["code"].GetInt();
            const bool auth = (code == 400 || code == 401 || code == 403) &&
                              (status == "INVALID_ARGUMENT" ||
                               status == "PERMISSION_DENIED" ||
                               status == "UNAUTHENTICATED");
            return GeminiResult{std::nullopt,
                                 auth ? GeminiError::AuthFailure
                                      : GeminiError::ResponseInvalid};
        }
        return GeminiResult{std::nullopt, GeminiError::ResponseInvalid};
    }
    const auto& cand = doc["candidates"][0];
    if (!cand.HasMember("content") || !cand["content"].IsObject() ||
        !cand["content"].HasMember("parts") || !cand["content"]["parts"].IsArray() ||
        cand["content"]["parts"].Empty() ||
        !cand["content"]["parts"][0].HasMember("text") ||
        !cand["content"]["parts"][0]["text"].IsString()) {
        return GeminiResult{std::nullopt, GeminiError::ResponseInvalid};
    }
    const std::string inner_text = cand["content"]["parts"][0]["text"].GetString();

    rapidjson::Document inner;
    if (inner.Parse(inner_text.c_str()).HasParseError() || !inner.IsObject()) {
        LOG_WARN("gemini: inner JSON parse failed: " << inner_text.substr(0, 200));
        return GeminiResult{std::nullopt, GeminiError::ResponseInvalid};
    }

    NewsAnalysis out;
    if (inner.HasMember("symbol") && inner["symbol"].IsString()) {
        out.symbol_name = resolve_symbol(inner["symbol"].GetString(), symbols_csv);
    }
    if (inner.HasMember("direction") && inner["direction"].IsString()) {
        out.direction = parse_direction(inner["direction"].GetString());
    }
    if (inner.HasMember("confidence") && inner["confidence"].IsNumber()) {
        out.confidence = inner["confidence"].GetDouble();
        if (out.confidence < 0.0) out.confidence = 0.0;
        if (out.confidence > 1.0) out.confidence = 1.0;
    }
    return GeminiResult{out, GeminiError::None};
}

}  // namespace TradingSystem
