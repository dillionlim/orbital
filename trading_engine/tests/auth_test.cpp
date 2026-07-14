#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "auth/api_key_authenticator.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_eq(auto actual, auto expected, const std::string& message) {
    if (!(actual == expected)) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_key(std::string_view request, const std::string& expected,
                 const std::string& message) {
    const std::string got = extractApiKeyFromHttp(request);
    if (got != expected) {
        std::cerr << "FAILED: " << message << " (expected \"" << expected
                  << "\", got \"" << got << "\")\n";
        std::exit(1);
    }
}

// A well-formed key: the validator's regex is ^sk_live_[a-f0-9]{32}$.
const std::string kKeyA = "sk_live_" + std::string(32, 'a');
const std::string kKeyB = "sk_live_" + std::string(16, 'b') + std::string(16, '0');

// ApiKeyAuthenticator holds a mutex, so it cannot be returned by value.
#define OFFLINE_AUTH(name)          \
    ApiKeyAuthenticator name;       \
    name.setUseBackendAuth(false)

// The documented happy path: Authorization: Bearer <key>, CRLF terminated.
void extracts_bearer_token_from_authorization_header() {
    require_key("GET /ws HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + kKeyA + "\r\n\r\n",
                kKeyA, "bearer token from a full request");
    require_key("GET / HTTP/1.1\nAuthorization: Bearer " + kKeyA + "\n\n", kKeyA,
                "bare-LF requests are also parsed");
    require_key("GET / HTTP/1.1\r\nAuthorization:Bearer " + kKeyA + "\r\n\r\n", kKeyA,
                "no space after the colon still parses");
}

// The impl matches only the exact spellings "Authorization:"/"authorization:"
// and "Api-Key:"/"api-key:" — other cases are not recognised.
void matches_only_the_two_spellings_of_each_header() {
    require_key("GET / HTTP/1.1\r\nauthorization: Bearer " + kKeyA + "\r\n\r\n", kKeyA,
                "lowercase authorization is recognised");
    require_key("GET / HTTP/1.1\r\napi-key: " + kKeyA + "\r\n\r\n", kKeyA,
                "lowercase api-key is recognised");
    require_key("GET / HTTP/1.1\r\nAUTHORIZATION: Bearer " + kKeyA + "\r\n\r\n", "",
                "uppercase AUTHORIZATION is not recognised");
    require_key("GET / HTTP/1.1\r\nAPI-KEY: " + kKeyA + "\r\n\r\n", "",
                "uppercase API-KEY is not recognised");
    require_key("GET / HTTP/1.1\r\nAuthorization: bearer " + kKeyA + "\r\n\r\n", "",
                "lowercase bearer scheme is not recognised");
}

// The Api-Key header form, and Authorization taking precedence over it.
void extracts_api_key_header_form() {
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyA + "\r\n\r\n", kKeyA,
                "Api-Key header value");
    require_key("GET / HTTP/1.1\r\nApi-Key:" + kKeyA + "\r\n\r\n", kKeyA,
                "Api-Key with no space after the colon");
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyB + "\r\nAuthorization: Bearer " + kKeyA +
                    "\r\n\r\n",
                kKeyA, "Authorization wins over Api-Key regardless of order");
}

// Query-string auth was deliberately removed; ?api_key= must yield nothing.
void ignores_query_string_api_key() {
    require_key("GET /ws?api_key=" + kKeyA + " HTTP/1.1\r\nHost: x\r\n\r\n", "",
                "?api_key= query param is not accepted");
    require_key("GET /ws?a=1&api_key=" + kKeyA + " HTTP/1.1\r\nHost: x\r\n\r\n", "",
                "&api_key= query param is not accepted");
}

// No credential anywhere → empty string, never a partial match.
void returns_empty_when_no_key_is_present() {
    require_key("", "", "empty request");
    require_key("   \r\n\r\n", "", "whitespace-only request");
    require_key("GET / HTTP/1.1\r\nHost: x\r\nUser-Agent: curl\r\n\r\n", "",
                "request with no auth headers");
    require_key("GET / HTTP/1.1\r\nAuthorization Bearer " + kKeyA + "\r\n\r\n", "",
                "header with no colon is not a header");
    require_key("Bearer " + kKeyA, "", "a bare Bearer token with no Authorization header");
    require_key("\r\n\r\n", "", "headerless CRLF pair");
    require_key("A", "", "single character request");
}

// Malformed Authorization lines must not yield a token.
void handles_malformed_authorization_headers() {
    require_key("GET / HTTP/1.1\r\nAuthorization:\r\nHost: x\r\n\r\n", "",
                "Authorization with no value");
    require_key("GET / HTTP/1.1\r\nAuthorization: \r\nHost: x\r\n\r\n", "",
                "Authorization with only a space");
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer\r\nHost: x\r\n\r\n", "",
                "Bearer with no token and no trailing space");
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer \r\nHost: x\r\n\r\n", "",
                "Bearer with an empty token");
    require_key("GET / HTTP/1.1\r\nAuthorization: Basic dXNlcjpwdw==\r\n\r\n", "",
                "a non-Bearer scheme yields nothing");
    require_key("Authorization:", "", "truncated straight after the header name");
    require_key("Authorization: Bearer", "", "truncated inside the scheme");
}

// Space/tab handling around the value is asymmetric between the two headers.
void handles_whitespace_and_tab_variations() {
    // Api-Key skips leading spaces only, so a tab survives into the value.
    require_key("GET / HTTP/1.1\r\nApi-Key:    " + kKeyA + "\r\n\r\n", kKeyA,
                "Api-Key skips runs of leading spaces");
    require_key("GET / HTTP/1.1\r\nApi-Key:\t" + kKeyA + "\r\n\r\n", "\t" + kKeyA,
                "Api-Key keeps a leading tab in the value");
    // Bearer takes everything after the single required space, untrimmed.
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer  " + kKeyA + "\r\n\r\n", " " + kKeyA,
                "a second space after Bearer lands in the value");
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + kKeyA + "   \r\n\r\n",
                kKeyA + "   ", "trailing spaces are kept in the value");
    // Untrimmed junk cannot become a valid key: validate() re-checks the format.
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");
    require(!auth.validateApiKey(" " + kKeyA), "a space-prefixed key must not validate");
    require(!auth.validateApiKey(kKeyA + "   "), "a space-suffixed key must not validate");
    require(!auth.validateApiKey("\t" + kKeyA), "a tab-prefixed key must not validate");
}

// A CR/LF inside the value terminates it: no header-injection smuggling.
void stops_value_at_header_boundary_against_injection() {
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyA + "\r\nX-Evil: 1\r\n\r\n", kKeyA,
                "Api-Key value stops at the CRLF");
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + kKeyA + "\r\nX-Evil: 1\r\n\r\n",
                kKeyA, "Bearer value stops at the CRLF");
    // A lone-LF-terminated header stops at the LF and does not swallow later lines.
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyA + "\nX-Evil: 1\r\n\r\n",
                kKeyA, "an LF-terminated value stops at the LF");
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");
    require(auth.validateApiKey(extractApiKeyFromHttp(
                "GET / HTTP/1.1\r\nApi-Key: " + kKeyA + "\nX-Evil: 1\r\n\r\n")),
            "the boundaried value validates");
    // A NUL byte is data, not a terminator — the value simply carries it.
    const std::string with_nul =
        std::string("GET / HTTP/1.1\r\nApi-Key: ab") + '\0' + "cd\r\n\r\n";
    require_key(std::string_view(with_nul.data(), with_nul.size()),
                std::string("ab") + '\0' + "cd", "an embedded NUL is not a terminator");
}

// Truncated and very large inputs must be read in-bounds and not crash.
void handles_truncated_and_oversized_requests() {
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + kKeyA, kKeyA,
                "an unterminated Bearer line returns the rest of the buffer");
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyA, kKeyA,
                "an unterminated Api-Key line returns the rest of the buffer");
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + kKeyA + "\r", kKeyA,
                "a dangling CR terminates the value");

    const std::string huge(256 * 1024, 'x');
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + huge + "\r\n\r\n", huge,
                "a 256KiB bearer value is returned whole without overflow");
    require_key("GET / HTTP/1.1\r\nApi-Key: " + huge, huge,
                "a 256KiB unterminated Api-Key value is read in-bounds");
    // Absurd values are still just invalid keys.
    OFFLINE_AUTH(auth);
    require(!auth.validateApiKey(huge), "a 256KiB value must not validate");
}

// Duplicate credentials: the first Authorization header in the buffer wins.
void takes_the_first_of_multiple_authorization_headers() {
    require_key("GET / HTTP/1.1\r\nAuthorization: Bearer " + kKeyA + "\r\nAuthorization: Bearer " +
                    kKeyB + "\r\n\r\n",
                kKeyA, "the first Authorization header wins");
    require_key("GET / HTTP/1.1\r\nApi-Key: " + kKeyA + "\r\nApi-Key: " + kKeyB + "\r\n\r\n",
                kKeyA, "the first Api-Key header wins");
    // An empty Authorization header yields no key: the Bearer scan is bounded to that
    // line, so a Bearer sitting in a later header is not picked up.
    require_key("GET / HTTP/1.1\r\nAuthorization:\r\nX-Note: Bearer " + kKeyB + "\r\n\r\n", "",
                "the Bearer scan is bounded to the Authorization line");
    // With no Authorization header at all, a stray Bearer elsewhere is ignored.
    require_key("POST /x HTTP/1.1\r\nHost: x\r\n\r\nBearer " + kKeyB, "",
                "a Bearer in the body alone is ignored");
}

// Offline mode: addValidKey seeds the cache, validate serves it without a network hop.
void validates_known_key_offline() {
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");

    AuthResult res = auth.validate(kKeyA);
    require(res.valid, "a seeded key validates offline");
    require_eq(res.user_id, std::string("user1"), "validate returns the seeded user id");
    require(auth.validateApiKey(kKeyA), "validateApiKey agrees with validate");

    // A key seeded with no user id is valid with an empty user id.
    auth.addValidKey(kKeyB);
    AuthResult anon = auth.validate(kKeyB);
    require(anon.valid, "a key seeded without a user id is still valid");
    require(anon.user_id.empty(), "its user id is empty");

    // Re-seeding overwrites the user id.
    auth.addValidKey(kKeyA, "user2");
    require_eq(auth.validate(kKeyA).user_id, std::string("user2"), "re-seeding updates the user id");
}

// Everything that is not a seeded, well-formed key must be rejected.
void rejects_unknown_and_malformed_keys() {
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");

    require(!auth.validateApiKey(kKeyB), "an unseeded but well-formed key is invalid offline");
    require(!auth.validateApiKey(""), "the empty key is invalid");
    require(!auth.validateApiKey("garbage"), "garbage is invalid");
    require(!auth.validateApiKey("sk_test_" + std::string(32, 'a')), "a wrong prefix is invalid");
    require(!auth.validateApiKey("sk_live_"), "the bare prefix is invalid");
    require(!auth.validateApiKey("sk_live_" + std::string(31, 'a')), "31 hex chars is invalid");
    require(!auth.validateApiKey("sk_live_" + std::string(33, 'a')), "33 hex chars is invalid");
    require(!auth.validateApiKey("sk_live_" + std::string(32, 'A')), "uppercase hex is invalid");
    require(!auth.validateApiKey("sk_live_" + std::string(32, 'z')), "non-hex chars are invalid");
    require(!auth.validateApiKey("xsk_live_" + std::string(32, 'a')), "a prefixed key is invalid");
    require(!auth.validateApiKey(kKeyA + "\n"), "a trailing newline defeats the anchored regex");
    require(!auth.validateApiKey(std::string("sk_live_") + '\0' + std::string(31, 'a')),
            "an embedded NUL is invalid");

    // The format check runs before the cache: a malformed key cannot be seeded in.
    auth.addValidKey("sk_live_x", "user1");
    require(!auth.validateApiKey("sk_live_x"), "a malformed seeded key still fails the format check");
    auth.addValidKey("", "user1");
    require(!auth.validateApiKey(""), "an empty seeded key stays invalid");

    // The valid key is untouched by all of the above.
    require(auth.validateApiKey(kKeyA), "the good key still validates");
}

// removeKey revokes immediately, and a removed key does not come back.
void revokes_keys_with_remove_key() {
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");
    require(auth.validateApiKey(kKeyA), "key is valid before revocation");

    auth.removeKey(kKeyA);
    require(!auth.validateApiKey(kKeyA), "key is invalid after removeKey");
    require(auth.validate(kKeyA).user_id.empty(), "a revoked key carries no user id");

    auth.removeKey(kKeyA);
    require(!auth.validateApiKey(kKeyA), "removing twice is harmless");
    auth.removeKey(kKeyB);
    require(!auth.validateApiKey(kKeyB), "removing an absent key is harmless");

    auth.addValidKey(kKeyA, "user3");
    require_eq(auth.validate(kKeyA).user_id, std::string("user3"), "the key can be re-added");
}

// Seeded entries carry their own long expiry, so the configured TTL does not
// expire them; revocation is what ends them.
void serves_cached_positive_and_honours_revocation() {
    OFFLINE_AUTH(auth);
    auth.setCacheTtlSeconds(0);
    auth.addValidKey(kKeyA, "user1");

    for (int i = 0; i < 100; ++i) {
        AuthResult res = auth.validate(kKeyA);
        require(res.valid, "the cached positive is served on every hit");
        require_eq(res.user_id, std::string("user1"), "the cached user id is stable");
    }

    auth.setCacheTtlSeconds(3600);
    require(auth.validateApiKey(kKeyA), "changing the TTL does not drop the entry");
    auth.removeKey(kKeyA);
    require(!auth.validateApiKey(kKeyA), "revocation beats a long TTL");
}

// Readers and mutators race on the same keys; nothing may crash, tear or race.
void survives_concurrent_validate_and_mutation() {
    OFFLINE_AUTH(auth);
    auth.addValidKey(kKeyA, "user1");

    constexpr int kReaders = 6;
    constexpr int kIters = 2000;
    std::atomic<bool> stop{false};
    std::atomic<long> valid_hits{0};

    std::vector<std::thread> readers;
    for (int t = 0; t < kReaders; ++t) {
        readers.emplace_back([&] {
            while (!stop.load(std::memory_order_relaxed)) {
                AuthResult a = auth.validate(kKeyA);
                if (a.valid) {
                    require(a.user_id == "user1", "a concurrent read must not tear the user id");
                    valid_hits.fetch_add(1, std::memory_order_relaxed);
                }
                // Keys that are never seeded must never validate under load.
                require(!auth.validateApiKey("sk_live_" + std::string(32, 'c')),
                        "an unseeded key must never validate under contention");
                require(!auth.validateApiKey("garbage"), "garbage must never validate under load");
            }
        });
    }

    std::thread mutator([&] {
        for (int i = 0; i < kIters; ++i) {
            auth.addValidKey(kKeyB, "user2");
            auth.removeKey(kKeyB);
            auth.addValidKey(kKeyA, "user1");
        }
        stop.store(true, std::memory_order_relaxed);
    });

    mutator.join();
    for (auto& r : readers) r.join();

    require(valid_hits.load() > 0, "the readers observed the seeded key at least once");
    require(auth.validateApiKey(kKeyA), "the seeded key survives the hammering");
    require(!auth.validateApiKey(kKeyB), "the mutator's final removeKey left kKeyB revoked");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"extracts_bearer_token_from_authorization_header",
         extracts_bearer_token_from_authorization_header},
        {"matches_only_the_two_spellings_of_each_header",
         matches_only_the_two_spellings_of_each_header},
        {"extracts_api_key_header_form", extracts_api_key_header_form},
        {"ignores_query_string_api_key", ignores_query_string_api_key},
        {"returns_empty_when_no_key_is_present", returns_empty_when_no_key_is_present},
        {"handles_malformed_authorization_headers", handles_malformed_authorization_headers},
        {"handles_whitespace_and_tab_variations", handles_whitespace_and_tab_variations},
        {"stops_value_at_header_boundary_against_injection",
         stops_value_at_header_boundary_against_injection},
        {"handles_truncated_and_oversized_requests", handles_truncated_and_oversized_requests},
        {"takes_the_first_of_multiple_authorization_headers",
         takes_the_first_of_multiple_authorization_headers},
        {"validates_known_key_offline", validates_known_key_offline},
        {"rejects_unknown_and_malformed_keys", rejects_unknown_and_malformed_keys},
        {"revokes_keys_with_remove_key", revokes_keys_with_remove_key},
        {"serves_cached_positive_and_honours_revocation",
         serves_cached_positive_and_honours_revocation},
        {"survives_concurrent_validate_and_mutation", survives_concurrent_validate_and_mutation},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "auth_tests passed (" << cases.size() << " cases)\n";
        return 0;
    }

    const std::string requested = argv[1];
    for (const auto& test : cases) {
        if (requested == test.name) {
            test.run();
            std::cout << test.name << " passed\n";
            return 0;
        }
    }

    std::cerr << "Unknown auth test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
