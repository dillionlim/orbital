#include "feed/index_price_feed.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>

#include "common/log.hpp"
#include "rapidjson/document.h"

namespace TradingSystem {

namespace {

// Parses "http://host:port" → {host, port}. Defaults to localhost:3010.
std::pair<std::string, int> parse_backend_url(const std::string& url) {
    std::string s = url;
    const std::string http = "http://";
    if (s.rfind(http, 0) == 0) s = s.substr(http.size());
    auto slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    auto colon = s.find(':');
    std::string host = (colon == std::string::npos) ? s : s.substr(0, colon);
    int port = 3010;
    if (colon != std::string::npos) {
        try { port = std::stoi(s.substr(colon + 1)); } catch (...) {}
    }
    if (host.empty()) host = "localhost";
    return {host, port};
}

}  // namespace

IndexPriceFeed::IndexPriceFeed(MarketMakerBot& mm,
                               std::shared_ptr<SymbolRegistry> registry,
                               std::string backend_url, int poll_ms)
    : mm_(mm), registry_(std::move(registry)), poll_ms_(poll_ms) {
    auto [h, p] = parse_backend_url(backend_url);
    backend_host_ = h;
    backend_port_ = p;
}

IndexPriceFeed::~IndexPriceFeed() { stop(); }

void IndexPriceFeed::start() {
    running_ = true;
    thread_ = std::thread([this] { loop(); });
    LOG_INFO("index_feed: started; backend=" << backend_host_ << ":" << backend_port_
             << " poll_ms=" << poll_ms_);
}

void IndexPriceFeed::stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
}

void IndexPriceFeed::loop() {
    while (running_.load()) {
        if (!fetch_and_apply()) {
            LOG_DEBUG("index_feed: fetch failed (backend down?); will retry");
        }
        // Sleep in small slices so shutdown is responsive.
        for (int slept = 0; slept < poll_ms_ && running_.load(); slept += 100) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

bool IndexPriceFeed::fetch_and_apply() {
    int sockfd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) return false;

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(backend_port_);

    struct hostent* he = ::gethostbyname(backend_host_.c_str());
    if (!he) { ::close(sockfd); return false; }
    std::memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);

    if (::connect(sockfd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        ::close(sockfd);
        return false;
    }

    std::string req = "GET /index-prices HTTP/1.1\r\n";
    req += "Host: " + backend_host_ + ":" + std::to_string(backend_port_) + "\r\n";
    req += "Connection: close\r\n\r\n";
    if (::send(sockfd, req.data(), req.size(), 0) < 0) {
        ::close(sockfd);
        return false;
    }

    std::string resp;
    char buf[4096];
    while (true) {
        ssize_t n = ::read(sockfd, buf, sizeof(buf));
        if (n <= 0) break;
        resp.append(buf, buf + n);
        if (resp.size() > 1 << 20) break;  // 1 MiB cap
    }
    ::close(sockfd);

    if (resp.find("200 OK") == std::string::npos) return false;
    auto body_start = resp.find("\r\n\r\n");
    if (body_start == std::string::npos) return false;
    std::string body = resp.substr(body_start + 4);

    rapidjson::Document doc;
    if (doc.Parse(body.c_str()).HasParseError() || !doc.IsObject()) return false;
    if (!doc.HasMember("prices") || !doc["prices"].IsObject()) return false;

    int applied = 0;
    for (auto it = doc["prices"].MemberBegin(); it != doc["prices"].MemberEnd(); ++it) {
        if (!it->name.IsString() || !it->value.IsNumber()) continue;
        auto id = registry_->id_for(it->name.GetString());
        if (!id) continue;  // symbol not configured in the engine — skip
        mm_.update_reference_price(*id, it->value.GetDouble());
        ++applied;
    }
    LOG_DEBUG("index_feed: applied " << applied << " anchor update(s)");
    return true;
}

}  // namespace TradingSystem
