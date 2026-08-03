#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "market_maker/quote_math.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_price(Price actual, Price expected, const std::string& message) {
    if (std::fabs(actual - expected) > 0.000001) {
        std::cerr << "FAILED: " << message << " (expected " << expected
                  << ", got " << actual << ")\n";
        std::exit(1);
    }
}

// The ladder grid: ~4 significant figures, never finer than a cent.
void derives_a_tick_from_the_anchor_magnitude() {
    require_price(adaptive_tick(66020.0), 1.0, "five-figure anchor quotes on whole units");
    require_price(adaptive_tick(6155.0), 0.1, "four-figure anchor quotes on tenths");
    require_price(adaptive_tick(740.0), 0.01, "three-figure anchor quotes on cents");
    require_price(adaptive_tick(22.0), 0.01, "small anchors are floored at a cent");
    require_price(adaptive_tick(0.0), 0.01, "a missing anchor still yields a usable tick");
    require_price(adaptive_tick(-5.0), 0.01, "a negative anchor still yields a usable tick");
}

// requote_drift_bps == 0 means "one tick" — the smallest move that can actually
// reprice the ladder. Anything smaller would cancel and repost at the same
// prices, throwing away queue position for nothing.
void treats_zero_drift_bps_as_one_tick() {
    const Price tick = adaptive_tick(7400.0);  // 0.1
    require_price(requote_threshold(0, 7400.0, tick), tick, "0 bps means one tick");

    require(!anchor_has_drifted(0, 7400.0, 7400.05, tick),
            "half a tick of drift should not repaint");
    require(anchor_has_drifted(0, 7400.0, 7400.1, tick),
            "a full tick of drift should repaint");
    require(anchor_has_drifted(0, 7400.0, 7399.9, tick),
            "drift is symmetric — a tick down repaints too");
}

// A configured threshold is read as basis points of the resting anchor.
void honours_a_configured_drift_threshold() {
    const Price tick = adaptive_tick(7400.0);
    // 25 bps of 7400 is 18.5.
    require_price(requote_threshold(25, 7400.0, tick), 18.5, "threshold is bps of the anchor");

    require(!anchor_has_drifted(25, 7400.0, 7410.0, tick),
            "a 10-point move is inside a 25bp band and should not repaint");
    require(anchor_has_drifted(25, 7400.0, 7420.0, tick),
            "a 20-point move clears the 25bp band and should repaint");

    // Tighter than one tick is allowed: the knob is the whole rule, not a floor
    // layered on top of the tick grid.
    require(anchor_has_drifted(1, 7400.0, 7400.8, tick),
            "a 1bp threshold repaints on a sub-tick move");
}

// Nothing meaningful is resting yet, so there is nothing to preserve.
void repaints_unconditionally_without_a_usable_anchor() {
    const Price tick = 0.1;
    require(anchor_has_drifted(0, 0.0, 7400.0, tick), "no quoted anchor means repaint");
    require(anchor_has_drifted(0, 7400.0, 0.0, tick), "no live anchor means repaint");
    require(anchor_has_drifted(50, 0.0, 0.0, tick), "neither anchor set means repaint");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"derives_a_tick_from_the_anchor_magnitude", derives_a_tick_from_the_anchor_magnitude},
        {"treats_zero_drift_bps_as_one_tick", treats_zero_drift_bps_as_one_tick},
        {"honours_a_configured_drift_threshold", honours_a_configured_drift_threshold},
        {"repaints_unconditionally_without_a_usable_anchor",
         repaints_unconditionally_without_a_usable_anchor},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "quote_math_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown quote math test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
