#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include "auth/api_key_authenticator.hpp"
#include "common/config.hpp"
#include "common/log.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"
#include "market_maker/mm_bot.hpp"
#include "persistence/sqlite_store.hpp"
#include "server/bot_tracker.hpp"
#include "server/dispatcher.hpp"
#include "server/metrics.hpp"
#include "server/recent_trades.hpp"
#include "server/rest_handlers.hpp"
#include "server/session.hpp"
#include "server/snapshot_store.hpp"
#include "server/ws_server.hpp"

using namespace TradingSystem;

namespace {

std::atomic<bool> g_running{true};

void signal_handler(int signum) {
    LOG_INFO("main: received signal " << signum << ", initiating shutdown");
    g_running = false;
}

void print_usage(const char* prog) {
    std::cout << "Usage: " << prog << " [OPTIONS]\n\n"
              << "Options:\n"
              << "  --config <path>       Path to JSON config file\n"
              << "  --port <n>            Override server port\n"
              << "  --backend-url <url>   Override NestJS backend URL for API key validation\n"
              << "  --db <path>           Override SQLite database path\n"
              << "  --no-mm               Disable in-process market maker\n"
              << "  --docs                Run docs server on :8081 instead of trading engine\n"
              << "  --help                Show this help\n";
}

// Default config used when --config is not provided. Lets `./engine` work out
// of the box for the existing dev workflow.
ServerConfig default_config() {
    ServerConfig cfg;
    cfg.port = 9090;
    cfg.backend_url = "http://localhost:3010";
    cfg.db_path = "./engine.db";
    cfg.symbols = {
        {"BTC-USD", 1, 50000.0},
        {"ETH-USD", 2, 3000.0},
        {"LTC-USD", 3, 100.0},
    };
    return cfg;
}

// ---- legacy: docs server on :8081 (kept verbatim API) ----

std::string parse_path_simple(const std::string& request) {
    size_t start = request.find("GET ") + 4;
    size_t end = request.find(" ", start);
    if (start == std::string::npos || end == std::string::npos) return "/";
    return request.substr(start, end - start);
}
std::string read_file_simple(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) return "<html><body><h1>404 Not Found</h1></body></html>";
    std::stringstream b; b << file.rdbuf();
    return b.str();
}
std::string content_type_simple(const std::string& path) {
    if (path.find(".html") != std::string::npos) return "text/html";
    if (path.find(".css") != std::string::npos) return "text/css";
    if (path.find(".js") != std::string::npos) return "application/javascript";
    if (path.find(".png") != std::string::npos) return "image/png";
    if (path.find(".jpg") != std::string::npos) return "image/jpeg";
    if (path.find(".svg") != std::string::npos) return "image/svg+xml";
    return "text/plain";
}
std::string http_simple(const std::string& body, const std::string& ct) {
    std::ostringstream o;
    o << (body.find("404") != std::string::npos ? "HTTP/1.1 404 Not Found\r\n" : "HTTP/1.1 200 OK\r\n");
    o << "Content-Type: " << ct << "\r\nContent-Length: " << body.size()
      << "\r\nConnection: close\r\n\r\n" << body;
    return o.str();
}
void run_docs_server() {
    int sockfd = ::socket(AF_INET, SOCK_STREAM, 0);
    int one = 1; ::setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_addr.s_addr = INADDR_ANY; a.sin_port = htons(8081);
    if (::bind(sockfd, (sockaddr*)&a, sizeof(a)) < 0) { LOG_ERROR("docs: bind failed"); return; }
    ::listen(sockfd, 5);
    LOG_INFO("docs: serving docs/html/ on http://localhost:8081");
    while (g_running) {
        sockaddr_in c{}; socklen_t cl = sizeof(c);
        int fd = ::accept(sockfd, (sockaddr*)&c, &cl);
        if (fd < 0) continue;
        char buf[4096] = {0};
        ssize_t n = ::read(fd, buf, sizeof(buf) - 1);
        if (n <= 0) { ::close(fd); continue; }
        std::string path = parse_path_simple(buf);
        std::string fp = "docs/html" + (path == "/" ? std::string("/index.html") : path);
        std::string body = read_file_simple(fp);
        std::string resp = http_simple(body, content_type_simple(path));
        ::send(fd, resp.data(), resp.size(), 0);
        ::close(fd);
    }
    ::close(sockfd);
}

}  // namespace

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);
    std::signal(SIGPIPE, SIG_IGN);

    bool docs = false;
    bool no_mm = false;
    std::string config_path;
    int port_override = 0;
    std::string backend_override;
    std::string db_override;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") { print_usage(argv[0]); return 0; }
        else if (arg == "--docs") docs = true;
        else if (arg == "--no-mm") no_mm = true;
        else if (arg == "--config" && i + 1 < argc) config_path = argv[++i];
        else if (arg == "--port" && i + 1 < argc) port_override = std::atoi(argv[++i]);
        else if (arg == "--backend-url" && i + 1 < argc) backend_override = argv[++i];
        else if (arg == "--db" && i + 1 < argc) db_override = argv[++i];
        else { std::cerr << "Unknown arg: " << arg << "\n"; print_usage(argv[0]); return 1; }
    }

    if (docs) { run_docs_server(); return 0; }

    ServerConfig cfg;
    try {
        cfg = config_path.empty() ? default_config() : load_config(config_path);
    } catch (const std::exception& e) {
        LOG_ERROR("main: config load failed: " << e.what());
        return 1;
    }
    if (port_override > 0) cfg.port = port_override;
    if (!backend_override.empty()) cfg.backend_url = backend_override;
    if (!db_override.empty()) cfg.db_path = db_override;
    if (no_mm) cfg.market_maker.enabled = false;

    LOG_INFO("main: starting trading engine port=" << cfg.port
             << " backend=" << cfg.backend_url << " db=" << cfg.db_path
             << " symbols=" << cfg.symbols.size()
             << " mm=" << (cfg.market_maker.enabled ? "on" : "off"));

    auto registry = std::make_shared<SymbolRegistry>(cfg.symbols);

    ServerMetrics metrics;
    metrics.startTime = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();

    ApiKeyAuthenticator auth;
    auth.setBackendUrl(cfg.backend_url);
    auth.setCacheTtlSeconds(cfg.auth_cache_ttl_seconds);

    auto snapshots = std::make_shared<SnapshotStore>();
    auto trades_cache = std::make_shared<RecentTradesCache>(256);
    EventBus bus;
    SessionRegistry sessions;

    // SnapshotStore reconstructs L2 from the BookDelta stream. Subscribe BEFORE
    // matching shards start so we don't miss the shards' initial snapshot.
    snapshots->start(bus);

    // Feed the recent-trades cache from the EventBus so /trades has data.
    bus.subscribe([trades_cache](const OutboundEvent& ev) {
        std::visit([&](auto&& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, TradePrint>) trades_cache->push(e);
        }, ev);
    });

    // Persistence — open + rehydrate before assigning order ids.
    SqliteStore store(cfg.db_path, registry);
    if (!store.open()) {
        LOG_ERROR("main: SQLite open failed; aborting");
        return 1;
    }
    OrderId next_order_id = store.rehydrate_and_get_next_order_id();

    Sequencer sequencer(bus, registry);
    sequencer.set_starting_order_id(next_order_id);

    // trade_id watermark — derive from existing orders' max trade row, fall back to 1.
    // (Not strictly required for v1 since we use INSERT OR IGNORE on trades.)
    std::atomic<uint64_t> trade_id_counter{1};
    sequencer.start_shards(trade_id_counter);

    // Start persistence subscriber AFTER shards are up so we don't lose initial events.
    store.start(bus);

    auto bot_tracker = std::make_shared<BotTracker>();
    bot_tracker->start(bus, snapshots);

    Dispatcher dispatcher(sequencer, bus, sessions, registry, snapshots, metrics,
                          bot_tracker);
    dispatcher.start();

    RestRouter rest(cfg.port, metrics, auth, registry, snapshots, trades_cache,
                    bot_tracker, store, sessions, dispatcher);
    WsServer ws(cfg.port, rest, dispatcher, auth, sessions, metrics);
    if (!ws.start()) {
        LOG_ERROR("main: WS server start failed");
        return 1;
    }

    MarketMakerBot mm(sequencer, bus, registry, cfg.market_maker);
    mm.start();

    LOG_INFO("main: ready. Press Ctrl+C to stop.");

    while (g_running.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));

    LOG_INFO("main: shutting down…");
    mm.stop();
    ws.stop();
    dispatcher.stop();
    bot_tracker->stop();
    store.persist_next_order_id(sequencer.peek_next_order_id());
    sequencer.stop_shards();
    store.stop();
    snapshots->stop();
    LOG_INFO("main: bye");
    return 0;
}
