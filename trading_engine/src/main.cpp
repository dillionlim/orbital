#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "auth/api_key_authenticator.hpp"
#include "common/config.hpp"
#include "common/log.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"
#include "feed/index_price_feed.hpp"
#include "market_maker/mm_bot.hpp"
#include "news_bot/gemini_client.hpp"
#include "news_bot/news_analyzer.hpp"
#include "news_bot/news_bot.hpp"
#include "persistence/sqlite_store.hpp"
#include "server/market_flow.hpp"
#include "server/bot_tracker.hpp"
#include "server/dispatcher.hpp"
#include "server/metrics.hpp"
#include "server/position_tracker.hpp"
#include "server/recent_trades.hpp"
#include "server/user_fills.hpp"
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
        // Tradeable markets only — driven by the backend /index-prices feed.
        // Seeds are recent real values; refreshed to live within seconds.
        // Cash indices (NIKKEI/HSI/KOSPI/STOXX50) are NOT tradeable and have no
        // book; they're shown read-only in the dashboard's Indices panel.
        // Index futures (CME, ~24h):
        {"ES",   1, 7400.0},     // S&P 500
        {"NKD",  2, 67475.0},    // Nikkei 225
        {"NQ",   3, 29678.0},    // Nasdaq-100
        {"YM",   4, 51608.0},    // Dow Jones
        {"RTY",  5, 2949.0},     // Russell 2000
        // ETFs:
        {"SPY",  6, 740.0},      // S&P 500
        {"EWJ",  7, 92.0},       // Japan / Nikkei
        {"EWH",  8, 22.0},       // Hong Kong / HSI
        {"EWY",  9, 197.0},      // Korea / KOSPI
        {"FEZ", 10, 69.0},       // Euro Stoxx 50
    };
    return cfg;
}

}  // namespace

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);
    std::signal(SIGPIPE, SIG_IGN);

    bool no_mm = false;
    std::string config_path;
    int port_override = 0;
    std::string backend_override;
    std::string db_override;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") { print_usage(argv[0]); return 0; }
        else if (arg == "--no-mm") no_mm = true;
        else if (arg == "--config" && i + 1 < argc) config_path = argv[++i];
        else if (arg == "--port" && i + 1 < argc) port_override = std::atoi(argv[++i]);
        else if (arg == "--backend-url" && i + 1 < argc) backend_override = argv[++i];
        else if (arg == "--db" && i + 1 < argc) db_override = argv[++i];
        else { std::cerr << "Unknown arg: " << arg << "\n"; print_usage(argv[0]); return 1; }
    }

    ServerConfig cfg;
    try {
        cfg = config_path.empty() ? default_config() : load_config(config_path);
    } catch (const std::exception& e) {
        LOG_ERROR("main: config load failed: " << e.what());
        return 1;
    }
    if (port_override > 0) cfg.port = port_override;
    // Env override for the backend URL. Without this, a containerized engine is
    // stuck with the baked config's `http://localhost:3010`, which inside the
    // container points at the container itself — so API-key validation and the
    // index-price feed can never reach the host backend (auth 401s, bots and
    // dashboard can't connect). Let `docker run` redirect it:
    //   docker run -e BUBBLES_BACKEND_URL=http://host.docker.internal:3010 ...
    // CLI --backend-url still wins over the env var.
    if (const char* env_backend = std::getenv("BUBBLES_BACKEND_URL")) {
        if (env_backend[0] != '\0') cfg.backend_url = env_backend;
    }
    if (!backend_override.empty()) cfg.backend_url = backend_override;
    if (!db_override.empty()) cfg.db_path = db_override;
    // Env override for the SQLite path, taking precedence over the baked --db so
    // hosted platforms that can't mount the /data volume (e.g. Koyeb's free
    // tier) can redirect the DB to a writable path without rebuilding:
    //   -e BUBBLES_DB_PATH=/tmp/engine.db
    // Otherwise the engine aborts on "unable to open database file".
    if (const char* env_db = std::getenv("BUBBLES_DB_PATH")) {
        if (env_db[0] != '\0') cfg.db_path = env_db;
    }
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
    auto user_fills = std::make_shared<UserFillsCache>(128);
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

    // Feed the per-user fills cache so /me/fills can serve a user's own
    // executions. Skip internal bots (MM/news) — only real users are queried.
    bus.subscribe([user_fills](const OutboundEvent& ev) {
        std::visit([&](auto&& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, ExecutionReport>) {
                if (e.kind == ExecutionReport::Kind::Fill && !e.is_internal &&
                    !e.user_id.empty()) {
                    user_fills->push(e.user_id,
                                     UserFill{e.trade_id, e.symbol, e.side,
                                              e.last_price, e.last_quantity, e.ts});
                }
            }
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

    // Position tracker subscribes BEFORE the in-process MM starts producing
    // orders so it sees every Ack from the very first one — otherwise the
    // open-qty bookkeeping would be off-by-N for any orders placed before
    // its subscribe call.
    auto positions = std::make_shared<PositionTracker>(registry);
    positions->start(bus);

    // Market-flow EMA — feeds news bots' noise direction so emergent
    // herding/fade dynamics show up even without news. Subscribed early
    // for the same reason as PositionTracker (don't miss MM's first prints).
    auto market_flow = std::make_shared<MarketFlow>();
    market_flow->start(bus);

    Dispatcher dispatcher(sequencer, bus, sessions, registry, snapshots, metrics,
                          bot_tracker, positions);
    dispatcher.start();

    // Shared store of live upstream prices: written by the IndexPriceFeed,
    // served by the REST /index-prices endpoint. The engine is the source of
    // truth for these; the NestJS backend consumes the endpoint.
    auto index_prices = std::make_shared<IndexPriceStore>();

    RestRouter rest(cfg.port, metrics, auth, registry, snapshots, trades_cache,
                    user_fills, bot_tracker, index_prices, store, sessions, dispatcher);
    WsServer ws(cfg.port, rest, dispatcher, auth, sessions, metrics);
    if (!ws.start()) {
        LOG_ERROR("main: WS server start failed");
        return 1;
    }

    MarketMakerBot mm(sequencer, bus, registry, cfg.market_maker);
    mm.start();

    // Live index/ETF/future prices: the engine fetches them from the upstream
    // (Yahoo, via curl) itself — it's the source of truth. Tradeable symbols
    // nudge the MM's per-symbol reference price; all prices land in the shared
    // store that GET /index-prices serves to the backend.
    IndexPriceFeed index_feed(mm, registry, index_prices, cfg.index_feed_poll_ms);
    index_feed.start();

    // News-analyzer + per-persona news bots. Whole subsystem is opt-in:
    // skipped entirely if no bot config is enabled OR if GEMINI_API_KEY is
    // missing/malformed (the GeminiClient validates the key shape).
    std::unique_ptr<NewsAnalyzer> news_analyzer;
    std::vector<std::unique_ptr<NewsBot>> news_bots;
    {
        int total_instances = 0;
        for (const auto& nb : cfg.news.bots) if (nb.count > 0) total_instances += nb.count;

        // Bots are constructed unconditionally (when count > 0). The Gemini
        // analyzer is the only piece that genuinely needs a valid API key —
        // noise trading runs purely off `noise_interval_seconds` and a
        // local RNG, so we want it active even when news/Gemini isn't.
        if (total_instances > 0) {
            std::string key = cfg.news.gemini_api_key;
            if (key.empty()) {
                const char* env_key = std::getenv("GEMINI_API_KEY");
                if (env_key) key = env_key;
            }

            std::shared_ptr<GeminiClient> gemini;
            if (!key.empty()) {
                gemini = std::make_shared<GeminiClient>(key, cfg.news.gemini_model);
                if (!gemini->is_configured()) {
                    LOG_WARN("main: Gemini key rejected (must be alnum + ._- only); "
                             "news-driven trading disabled, noise traders still active");
                    gemini.reset();
                }
            } else {
                LOG_WARN("main: no Gemini key (set news.gemini_api_key in server.json or "
                         "GEMINI_API_KEY env var); news-driven trading disabled, noise "
                         "traders still active");
            }
            if (gemini) {
                news_analyzer = std::make_unique<NewsAnalyzer>(
                    cfg.backend_url, registry, gemini,
                    cfg.news.poll_seconds, cfg.news.fetch_limit);
            }

            for (const auto& nb_cfg : cfg.news.bots) {
                if (nb_cfg.count <= 0) continue;
                for (int i = 1; i <= nb_cfg.count; ++i) {
                    auto bot = std::make_unique<NewsBot>(
                        nb_cfg, i, sequencer, registry, bot_tracker, market_flow);
                    if (news_analyzer) bot->attach_to(*news_analyzer);
                    else if (bot_tracker)  // still register so the row appears
                        bot_tracker->register_internal_bot(
                            "internal:news_" + nb_cfg.persona + "_" + std::to_string(i),
                            "news-" + nb_cfg.persona + "-" + std::to_string(i));
                    bot->start();   // no-op when noise_interval_seconds == 0
                    news_bots.push_back(std::move(bot));
                }
                // One summary line per persona instead of one per instance —
                // count=N (with N up in the dozens or higher) would otherwise
                // drown the boot log in nearly-identical entries.
                LOG_INFO("news_bot[" << nb_cfg.persona << " ×" << nb_cfg.count << "]: ready"
                         << " (threshold=" << nb_cfg.confidence_threshold
                         << " size=" << nb_cfg.size_per_signal
                         << " jitter=" << nb_cfg.size_jitter_pct << "%/"
                         << nb_cfg.price_offset_jitter_bps << "bps"
                         << " noise=" << nb_cfg.noise_interval_seconds << "s"
                         << " stagger=" << nb_cfg.signal_delay_ms << "ms)");
            }
            if (news_analyzer) news_analyzer->start();
            LOG_INFO("main: news subsystem on (" << news_bots.size() << " bots, "
                     << (news_analyzer ? "analyzer ON" : "analyzer OFF, noise only") << ")");
        }
    }

    LOG_INFO("main: ready. Press Ctrl+C to stop.");

    while (g_running.load()) std::this_thread::sleep_for(std::chrono::milliseconds(200));

    LOG_INFO("main: shutting down…");
    index_feed.stop();
    if (news_analyzer) news_analyzer->stop();
    for (auto& nb : news_bots) nb->stop();   // joins noise threads cleanly
    news_bots.clear();
    market_flow->stop();
    mm.stop();
    ws.stop();
    dispatcher.stop();
    bot_tracker->stop();
    positions->stop();
    store.persist_next_order_id(sequencer.peek_next_order_id());
    sequencer.stop_shards();
    store.stop();
    snapshots->stop();
    LOG_INFO("main: bye");
    return 0;
}
