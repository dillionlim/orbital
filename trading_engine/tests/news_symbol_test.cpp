// Covers resolve_symbol() against the exact catalog format NewsAnalyzer emits.
//
// Regression origin: the catalog is newline-separated "NAME — description"
// (news_analyzer.cpp), but resolve_symbol split it on ','. Configured
// descriptions contain no commas, so getline() returned the whole blob as one
// token, every comparison failed, and every Gemini news signal resolved to ""
// and was silently dropped — bots connected and logged normally but never
// traded on news. These cases pin the format so that can't regress unnoticed.

#include <iostream>
#include <string>
#include <vector>

#include "news_bot/gemini_client.hpp"

namespace {

using namespace TradingSystem;

void require_eq(const std::string& actual, const std::string& expected,
                const std::string& message) {
    if (actual != expected) {
        std::cerr << "FAILED: " << message << " (expected \"" << expected
                  << "\", got \"" << actual << "\")\n";
        std::exit(1);
    }
}

// Mirrors what NewsAnalyzer::set_registry builds: one line per symbol, name and
// description separated by a spaced em-dash. Descriptions deliberately include a
// comma and a hyphen — the two characters the old parser tripped over.
const char* kCatalog =
    "ES \xE2\x80\x94 S&P 500 E-mini future (US large-cap)\n"
    "NQ \xE2\x80\x94 Nasdaq-100 E-mini future, US tech\n"
    "NKD \xE2\x80\x94 Nikkei 225 future (Japan)\n"
    "EWH \xE2\x80\x94 Hong Kong ETF\n"
    "BARENAME\n";

void resolves_a_name_from_the_descriptive_catalog() {
    require_eq(resolve_symbol("ES", kCatalog), "ES", "exact name with description");
    require_eq(resolve_symbol("NKD", kCatalog), "NKD", "later line in the catalog");
}

void resolves_case_insensitively() {
    require_eq(resolve_symbol("es", kCatalog), "ES", "lower-case model answer");
    require_eq(resolve_symbol("eWh", kCatalog), "EWH", "mixed-case model answer");
}

void is_not_confused_by_commas_or_hyphens_in_descriptions() {
    // "NQ — Nasdaq-100 E-mini future, US tech" has both. The old comma split
    // returned "ES — ...\nNQ — Nasdaq-100 E-mini future" as one token here.
    require_eq(resolve_symbol("NQ", kCatalog), "NQ", "description containing a comma");
}

void handles_a_line_with_no_description() {
    require_eq(resolve_symbol("BARENAME", kCatalog), "BARENAME", "bare name, no separator");
}

void returns_empty_for_anything_unconfigured() {
    require_eq(resolve_symbol("BTC", kCatalog), "", "symbol not in the catalog");
    require_eq(resolve_symbol("", kCatalog), "", "empty model answer");
    // The description text must not itself be matchable.
    require_eq(resolve_symbol("Hong Kong ETF", kCatalog), "", "description is not a name");
    require_eq(resolve_symbol("S&P 500 E-mini future (US large-cap)", kCatalog), "",
               "full description is not a name");
}

void returns_empty_for_an_empty_catalog() {
    require_eq(resolve_symbol("ES", ""), "", "no symbols configured");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"resolves_a_name_from_the_descriptive_catalog",
         resolves_a_name_from_the_descriptive_catalog},
        {"resolves_case_insensitively", resolves_case_insensitively},
        {"is_not_confused_by_commas_or_hyphens_in_descriptions",
         is_not_confused_by_commas_or_hyphens_in_descriptions},
        {"handles_a_line_with_no_description", handles_a_line_with_no_description},
        {"returns_empty_for_anything_unconfigured", returns_empty_for_anything_unconfigured},
        {"returns_empty_for_an_empty_catalog", returns_empty_for_an_empty_catalog},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "news_symbol_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown news symbol test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
