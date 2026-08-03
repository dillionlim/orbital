#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "engine/event_bus.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

OutboundEvent some_event() {
    TradePrint tp;
    tp.trade_id = 1;
    tp.symbol = 1;
    tp.price = 100.0;
    tp.quantity = 1;
    return tp;
}

// The contract that makes it safe to destroy a subscriber after unsubscribing:
// unsubscribe must not return while that subscriber's callback is still running.
// Publishing from a detached snapshot breaks this — the callback keeps running
// on the publisher's thread after unsubscribe has returned and the owner has
// been torn down.
void unsubscribe_waits_for_an_in_flight_callback() {
    EventBus bus;
    std::atomic<bool> inside{false};
    std::atomic<bool> finished{false};
    std::atomic<bool> release{false};

    const auto id = bus.subscribe([&](const OutboundEvent&) {
        inside = true;
        while (!release.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        finished = true;
    });

    std::thread publisher([&] { bus.publish(some_event()); });
    while (!inside.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));

    std::atomic<bool> unsubscribed{false};
    std::thread remover([&] {
        bus.unsubscribe(id);
        unsubscribed = true;
    });

    // The callback is parked mid-flight; unsubscribe must be parked too.
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    require(!unsubscribed.load(),
            "unsubscribe must not return while the callback is still running");

    release = true;
    publisher.join();
    remover.join();
    require(finished.load(), "the callback should have completed");
    require(unsubscribed.load(), "unsubscribe should return once the callback is done");
}

// Once unsubscribe has returned, the callback must never be entered again.
void never_invokes_a_callback_after_unsubscribe_returns() {
    EventBus bus;
    std::atomic<int> calls{0};
    const auto id = bus.subscribe([&](const OutboundEvent&) { ++calls; });

    bus.publish(some_event());
    require(calls.load() == 1, "a live subscriber should be invoked");

    bus.unsubscribe(id);
    const int after_unsubscribe = calls.load();
    for (int i = 0; i < 100; ++i) bus.publish(some_event());
    require(calls.load() == after_unsubscribe, "an unsubscribed callback must not fire");
}

// Publishes are shared, not exclusive: two matching shards fanning out at once
// must not serialize behind each other.
void lets_publishes_overlap() {
    EventBus bus;
    std::atomic<int> concurrent{0};
    std::atomic<int> peak{0};

    bus.subscribe([&](const OutboundEvent&) {
        const int now = ++concurrent;
        int seen = peak.load();
        while (now > seen && !peak.compare_exchange_weak(seen, now)) { /* retry */ }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        --concurrent;
    });

    std::vector<std::thread> publishers;
    for (int i = 0; i < 4; ++i) publishers.emplace_back([&] { bus.publish(some_event()); });
    for (auto& t : publishers) t.join();

    require(peak.load() > 1, "concurrent publishes should overlap rather than serialize");
}

// Subscribing and unsubscribing from other threads while events flow must not
// corrupt the subscriber list or lose a live subscriber's events.
void survives_concurrent_publish_and_mutation() {
    EventBus bus;
    std::atomic<bool> stop{false};
    std::atomic<uint64_t> delivered{0};

    const auto stable = bus.subscribe([&](const OutboundEvent&) { ++delivered; });

    std::thread publisher([&] {
        while (!stop.load()) bus.publish(some_event());
    });
    std::thread churn([&] {
        while (!stop.load()) {
            const auto id = bus.subscribe([](const OutboundEvent&) {});
            bus.unsubscribe(id);
        }
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    stop = true;
    publisher.join();
    churn.join();

    require(delivered.load() > 0, "the stable subscriber should have received events");
    bus.unsubscribe(stable);
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"unsubscribe_waits_for_an_in_flight_callback",
         unsubscribe_waits_for_an_in_flight_callback},
        {"never_invokes_a_callback_after_unsubscribe_returns",
         never_invokes_a_callback_after_unsubscribe_returns},
        {"lets_publishes_overlap", lets_publishes_overlap},
        {"survives_concurrent_publish_and_mutation", survives_concurrent_publish_and_mutation},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "event_bus_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown event bus test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
