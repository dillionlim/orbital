#pragma once
#include <atomic>
#include <thread>

#include "auth/api_key_authenticator.hpp"
#include "server/dispatcher.hpp"
#include "server/metrics.hpp"
#include "server/rest_handlers.hpp"
#include "server/session.hpp"

namespace TradingSystem {

// Single-port TCP server. Each accepted connection reads HTTP headers; if it's a
// WebSocket upgrade, we authenticate, perform the handshake, register a session,
// and spawn a per-session reader thread. Otherwise we route to RestRouter and
// close.
class WsServer {
public:
    WsServer(int port, RestRouter& rest, Dispatcher& dispatcher,
             ApiKeyAuthenticator& auth, SessionRegistry& sessions, ServerMetrics& metrics);
    ~WsServer();

    bool start();
    void stop();

private:
    void accept_loop();
    void handle_connection(int sockfd);
    void session_loop(SessionPtr s);

    int port_;
    RestRouter& rest_;
    Dispatcher& dispatcher_;
    ApiKeyAuthenticator& auth_;
    SessionRegistry& sessions_;
    ServerMetrics& metrics_;

    std::atomic<bool> running_{false};
    int listen_fd_ = -1;
    std::thread accept_thread_;

    // Every connection costs an OS thread (~8MB of reserved stack), and a
    // connection is accepted before its API key is checked — so without a cap an
    // anonymous client can exhaust threads/memory just by opening sockets. Past
    // the cap we answer 503 and close instead of spawning anything. Override with
    // BUBBLES_MAX_CONNECTIONS.
    int max_connections_ = 256;
    std::atomic<int> open_connections_{0};
};

}
