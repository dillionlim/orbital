#pragma once
#include <atomic>
#include <chrono>
#include <cstdint>
#include <sstream>
#include <string>

namespace TradingSystem {

class ServerMetrics {
public:
    std::atomic<uint64_t> totalConnections{0};
    std::atomic<uint64_t> activeConnections{0};
    std::atomic<uint64_t> totalRequests{0};
    std::atomic<uint64_t> totalErrors{0};
    std::atomic<uint64_t> wsConnections{0};
    std::atomic<uint64_t> ordersAccepted{0};
    std::atomic<uint64_t> ordersRejected{0};
    std::atomic<uint64_t> tradesMatched{0};
    std::atomic<uint64_t> startTime{0};

    void recordConnection() { ++totalConnections; ++activeConnections; }
    void closeConnection() { --activeConnections; }
    void recordRequest() { ++totalRequests; }
    void recordError() { ++totalErrors; }

    uint64_t getUptimeSeconds() const {
        if (startTime == 0) return 0;
        const auto now = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
        return now - startTime;
    }

    std::string getMetricsJson() const {
        std::ostringstream oss;
        oss << "{\n"
            << "  \"uptime_seconds\": " << getUptimeSeconds() << ",\n"
            << "  \"total_connections\": " << totalConnections.load() << ",\n"
            << "  \"active_connections\": " << activeConnections.load() << ",\n"
            << "  \"total_requests\": " << totalRequests.load() << ",\n"
            << "  \"total_errors\": " << totalErrors.load() << ",\n"
            << "  \"ws_connections\": " << wsConnections.load() << ",\n"
            << "  \"orders_accepted\": " << ordersAccepted.load() << ",\n"
            << "  \"orders_rejected\": " << ordersRejected.load() << ",\n"
            << "  \"trades_matched\": " << tradesMatched.load() << "\n"
            << "}";
        return oss.str();
    }

    std::string getStatusJson(int port) const {
        std::ostringstream oss;
        oss << "{\n"
            << "  \"status\": \"running\",\n"
            << "  \"port\": " << port << ",\n"
            << "  \"version\": \"1.0.0\",\n"
            << "  \"uptime_seconds\": " << getUptimeSeconds() << ",\n"
            << "  \"metrics\": " << getMetricsJson() << "\n"
            << "}";
        return oss.str();
    }
};

}
