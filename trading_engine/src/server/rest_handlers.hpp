#pragma once
#include <memory>
#include <string>
#include <string_view>

#include "auth/api_key_authenticator.hpp"
#include "common/config.hpp"
#include "persistence/sqlite_store.hpp"
#include "server/bot_tracker.hpp"
#include "server/dispatcher.hpp"
#include "server/metrics.hpp"
#include "server/recent_trades.hpp"
#include "server/user_fills.hpp"
#include "server/session.hpp"
#include "server/snapshot_store.hpp"

namespace TradingSystem {

// Handles a single HTTP request (the full text up through the headers, body
// optional) and produces a complete HTTP response string. The caller writes the
// response to the socket and closes.
class RestRouter {
public:
    RestRouter(int port, ServerMetrics& metrics, ApiKeyAuthenticator& auth,
               std::shared_ptr<SymbolRegistry> registry,
               std::shared_ptr<SnapshotStore> snapshots,
               std::shared_ptr<RecentTradesCache> trades,
               std::shared_ptr<UserFillsCache> user_fills,
               std::shared_ptr<BotTracker> bots,
               SqliteStore& store, SessionRegistry& sessions,
               Dispatcher& dispatcher)
        : port_(port), metrics_(metrics), auth_(auth),
          registry_(std::move(registry)), snapshots_(std::move(snapshots)),
          trades_(std::move(trades)), user_fills_(std::move(user_fills)),
          bots_(std::move(bots)), store_(store),
          sessions_(sessions), dispatcher_(dispatcher) {}

    // Returns the full HTTP response text. `request` is the raw request (headers+body).
    [[nodiscard]] std::string handle(std::string_view request);

private:
    [[nodiscard]] std::string handle_orderbook(std::string_view path, std::string_view request);
    [[nodiscard]] std::string handle_auth(std::string_view request);
    [[nodiscard]] std::string handle_symbols();
    [[nodiscard]] std::string handle_trades(std::string_view path);
    [[nodiscard]] std::string handle_historical_trades(std::string_view path);
    [[nodiscard]] std::string handle_bots(std::string_view path);
    [[nodiscard]] std::string handle_me(std::string_view request);
    [[nodiscard]] std::string handle_me_fills(std::string_view path, std::string_view request);
    // pause==true → POST /bots/:client_id/pause; false → /resume.
    [[nodiscard]] std::string handle_bot_pause(std::string_view client_id,
                                               std::string_view request, bool pause);

    int port_;
    ServerMetrics& metrics_;
    ApiKeyAuthenticator& auth_;
    std::shared_ptr<SymbolRegistry> registry_;
    std::shared_ptr<SnapshotStore> snapshots_;
    std::shared_ptr<RecentTradesCache> trades_;
    std::shared_ptr<UserFillsCache> user_fills_;
    std::shared_ptr<BotTracker> bots_;
    SqliteStore& store_;
    SessionRegistry& sessions_;
    Dispatcher& dispatcher_;
};

// Helpers shared with the WS server (CORS, parsing). Defined in rest_handlers.cpp.
[[nodiscard]] std::string http_response(int status_code, std::string_view body, std::string_view content_type);
[[nodiscard]] std::string http_cors_preflight();
[[nodiscard]] std::string parse_http_path(std::string_view request);
[[nodiscard]] std::string parse_http_method(std::string_view request);
[[nodiscard]] std::string parse_query_param(std::string_view path, std::string_view key);

}
