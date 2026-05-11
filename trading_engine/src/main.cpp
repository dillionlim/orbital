#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <thread>

namespace {
std::atomic<bool> g_running{true};
void on_signal(int) { g_running = false; }
}

int main() {
    std::signal(SIGINT,  on_signal);
    std::signal(SIGTERM, on_signal);

    constexpr int port = 9090;
    std::cout << "[engine] Starting on port=" << port << "\n";

    while (g_running.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    std::cout << "[engine] Engine shutting down\n";
    return 0;
}
