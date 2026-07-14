#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "server/session.hpp"

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

// EventBus::publish runs on the matching shard's worker thread, so queuing must never
// block or touch the socket, no matter how far behind the client is.
void queues_outbound_without_touching_the_socket() {
    Session s;
    s.sockfd = -1;   // no socket at all: a write would fault

    require(queue_outbound(s, "a"), "first frame queues");
    require(queue_outbound(s, "b"), "second frame queues");

    std::lock_guard<std::mutex> lk(s.out_mu);
    require_eq(s.out_q.size(), static_cast<size_t>(2), "both frames are pending");
    require_eq(s.out_q.front(), std::string("a"), "frames stay in order");
}

// A client that stops reading would otherwise grow the queue without bound. Dropping
// frames would corrupt the L2 delta stream, so the session is marked closing instead.
void kicks_a_session_whose_queue_overflows() {
    Session s;
    for (size_t i = 0; i < kMaxOutboundFrames; ++i) {
        require(queue_outbound(s, "x"), "frames queue up to the cap");
    }
    require(!queue_outbound(s, "overflow"), "the frame past the cap is refused");

    std::lock_guard<std::mutex> lk(s.out_mu);
    require(s.out_closing, "an overflowing session is marked closing");
    require_eq(s.out_q.size(), kMaxOutboundFrames, "no frame is silently dropped");
}

// Once the writer thread is gone nothing will drain the queue, so queuing must stop.
void refuses_to_queue_after_the_writer_exits() {
    Session s;
    {
        std::lock_guard<std::mutex> lk(s.out_mu);
        s.out_dead = true;
    }
    require(!queue_outbound(s, "late"), "queuing is refused once the writer is dead");

    std::lock_guard<std::mutex> lk(s.out_mu);
    require(s.out_q.empty(), "nothing is left stranded on the queue");
}

void request_close_marks_the_session_closing() {
    Session s;
    require(queue_outbound(s, "pending"), "frame queues while open");
    request_close(s);

    require(!queue_outbound(s, "after"), "queuing is refused once closing");
    std::lock_guard<std::mutex> lk(s.out_mu);
    require(s.out_closing, "the session is marked closing");
    require_eq(s.out_q.size(), static_cast<size_t>(1), "already-queued frames still drain");
}

// client_id is written by the reader thread on hello and read by REST threads (pause,
// leaderboard). It used to be a bare std::string, which is a data race and, on a
// reallocating assignment, a read of freed memory. Run both under ThreadSanitizer.
void client_id_survives_concurrent_reads_and_writes() {
    Session s;
    std::atomic<bool> go{false};
    std::atomic<bool> stop{false};

    std::thread writer([&] {
        while (!go.load()) {
        }
        // Alternate short (SSO) and long (heap) values so assignment reallocates.
        for (int i = 0; i < 20000 && !stop.load(); ++i) {
            s.set_client_id(i % 2 ? "short" : "a-much-longer-client-id-that-heap-allocates");
        }
        stop.store(true);
    });

    std::vector<std::thread> readers;
    for (int r = 0; r < 4; ++r) {
        readers.emplace_back([&] {
            while (!go.load()) {
            }
            while (!stop.load()) {
                const std::string cid = s.get_client_id();
                require(cid == "short" ||
                            cid == "a-much-longer-client-id-that-heap-allocates" ||
                            cid.empty(),
                        "a reader only ever observes a whole value");
            }
        });
    }

    go.store(true);
    writer.join();
    for (auto& t : readers) t.join();
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"queues_outbound_without_touching_the_socket",
         queues_outbound_without_touching_the_socket},
        {"kicks_a_session_whose_queue_overflows", kicks_a_session_whose_queue_overflows},
        {"refuses_to_queue_after_the_writer_exits", refuses_to_queue_after_the_writer_exits},
        {"request_close_marks_the_session_closing", request_close_marks_the_session_closing},
        {"client_id_survives_concurrent_reads_and_writes",
         client_id_survives_concurrent_reads_and_writes},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "session_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown session test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
