#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "common/spsc_queue.hpp"

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
        std::cerr << "FAILED: " << message << " (expected " << expected << ", got "
                  << actual << ")\n";
        std::exit(1);
    }
}

// The old SPSCQueue did a non-atomic read-modify-write on head_, so two of the engine's
// many producer threads could claim one slot and an order would vanish with no reject.
void loses_no_commands_under_concurrent_producers() {
    constexpr size_t kProducers = 8;
    constexpr size_t kPerProducer = 4096;
    constexpr size_t kTotal = kProducers * kPerProducer;

    // Smaller than the total, so producers genuinely contend on a full ring.
    MPSCRing<uint64_t, 1024> ring;

    std::atomic<bool> go{false};
    std::atomic<size_t> pushed{0};

    std::vector<std::thread> producers;
    producers.reserve(kProducers);
    for (size_t p = 0; p < kProducers; ++p) {
        producers.emplace_back([&, p] {
            while (!go.load(std::memory_order_acquire)) {
            }
            for (size_t i = 0; i < kPerProducer; ++i) {
                // Encode producer + index so we can prove exactly-once delivery.
                const uint64_t value = static_cast<uint64_t>(p) * kPerProducer + i;
                while (!ring.try_push(value)) {
                    std::this_thread::yield();  // Ring full: back off, never drop.
                }
                pushed.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    // Single consumer, matching the engine's shard worker.
    std::vector<int> seen(kTotal, 0);
    size_t popped = 0;
    std::thread consumer([&] {
        uint64_t value = 0;
        while (popped < kTotal) {
            if (ring.try_pop(value)) {
                require(value < kTotal, "popped value is in range");
                ++seen[value];
                ++popped;
            } else {
                std::this_thread::yield();
            }
        }
    });

    go.store(true, std::memory_order_release);
    for (auto& t : producers) t.join();
    consumer.join();

    require_eq(pushed.load(), kTotal, "every command was accepted");
    require_eq(popped, kTotal, "every command was consumed");
    for (size_t i = 0; i < kTotal; ++i) {
        require_eq(seen[i], 1, "each command delivered exactly once");
    }
}

// try_push must report a full ring rather than overwrite an unread slot; the Sequencer
// turns that false into a "queue_full" reject for the client.
void reports_full_instead_of_overwriting() {
    MPSCRing<uint64_t, 4> ring;

    require(ring.try_push(1), "first push fits");
    require(ring.try_push(2), "second push fits");
    require(ring.try_push(3), "third push fits");
    require(ring.try_push(4), "fourth push fits");
    require(!ring.try_push(5), "push onto a full ring reports full");

    uint64_t out = 0;
    require(ring.try_pop(out), "pop from a full ring succeeds");
    require_eq(out, static_cast<uint64_t>(1), "FIFO order preserved");

    require(ring.try_push(5), "push fits once a slot is freed");

    for (uint64_t expected = 2; expected <= 5; ++expected) {
        require(ring.try_pop(out), "drains remaining entries");
        require_eq(out, expected, "FIFO order preserved while draining");
    }
    require(!ring.try_pop(out), "empty ring reports empty");
    require(ring.empty(), "empty() agrees once drained");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"loses_no_commands_under_concurrent_producers",
         loses_no_commands_under_concurrent_producers},
        {"reports_full_instead_of_overwriting", reports_full_instead_of_overwriting},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "mpsc_ring_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown mpsc ring test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
