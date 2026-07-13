#include "server/ws_server.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <sstream>

#include "common/log.hpp"
#include "server/ws_frame.hpp"

namespace TradingSystem {

namespace {

bool header_contains(const std::string& req, const char* key, const char* value_substr) {
    // Case-insensitive header lookup.
    const std::string lower_key = [&] {
        std::string k(key);
        for (auto& c : k) c = static_cast<char>(::tolower(c));
        return k;
    }();
    std::string lower = req;
    for (auto& c : lower) c = static_cast<char>(::tolower(c));
    size_t pos = lower.find("\r\n" + lower_key + ":");
    if (pos == std::string::npos) {
        // Maybe at very start
        if (lower.rfind(lower_key + ":", 0) != 0) return false;
        pos = 0;
    } else {
        pos += 2;
    }
    size_t eol = lower.find("\r\n", pos);
    if (eol == std::string::npos) eol = lower.size();
    std::string val_substr = value_substr;
    for (auto& c : val_substr) c = static_cast<char>(::tolower(c));
    return lower.find(val_substr, pos) < eol;
}

std::string get_header(const std::string& req, const std::string& key) {
    // Case-insensitive search; returns trimmed value.
    std::string lower = req;
    for (auto& c : lower) c = static_cast<char>(::tolower(c));
    std::string lk = key;
    for (auto& c : lk) c = static_cast<char>(::tolower(c));
    auto needle = "\r\n" + lk + ":";
    size_t pos = lower.find(needle);
    if (pos == std::string::npos) {
        if (lower.rfind(lk + ":", 0) == 0) pos = 0;
        else return "";
    } else {
        pos += 2;  // skip \r\n
    }
    pos = lower.find(':', pos) + 1;
    while (pos < req.size() && (req[pos] == ' ' || req[pos] == '\t')) pos++;
    size_t end = req.find("\r\n", pos);
    if (end == std::string::npos) end = req.size();
    return req.substr(pos, end - pos);
}

}  // namespace

WsServer::WsServer(int port, RestRouter& rest, Dispatcher& dispatcher,
                   ApiKeyAuthenticator& auth, SessionRegistry& sessions, ServerMetrics& metrics)
    : port_(port), rest_(rest), dispatcher_(dispatcher), auth_(auth),
      sessions_(sessions), metrics_(metrics) {}

WsServer::~WsServer() { stop(); }

bool WsServer::start() {
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd_ < 0) {
        LOG_ERROR("ws_server: socket() failed: " << strerror(errno));
        return false;
    }
    int opt = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);
    if (::bind(listen_fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        LOG_ERROR("ws_server: bind() failed on port " << port_ << ": " << strerror(errno));
        ::close(listen_fd_);
        listen_fd_ = -1;
        return false;
    }
    if (::listen(listen_fd_, 64) < 0) {
        LOG_ERROR("ws_server: listen() failed: " << strerror(errno));
        ::close(listen_fd_);
        listen_fd_ = -1;
        return false;
    }
    running_ = true;
    accept_thread_ = std::thread([this] { accept_loop(); });
    LOG_INFO("ws_server: listening on :" << port_);
    return true;
}

void WsServer::stop() {
    running_ = false;
    if (listen_fd_ >= 0) {
        ::shutdown(listen_fd_, SHUT_RDWR);
        ::close(listen_fd_);
        listen_fd_ = -1;
    }
    if (accept_thread_.joinable()) accept_thread_.join();
}

void WsServer::accept_loop() {
    while (running_.load()) {
        struct sockaddr_in cli{};
        socklen_t cl = sizeof(cli);
        int fd = ::accept(listen_fd_, (struct sockaddr*)&cli, &cl);
        if (fd < 0) {
            if (running_.load()) LOG_WARN("ws_server: accept() error: " << strerror(errno));
            continue;
        }
        // Disable Nagle for low-latency frames.
        int one = 1;
        ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        metrics_.recordConnection();
        std::thread([this, fd] {
            handle_connection(fd);
            metrics_.closeConnection();
        }).detach();
    }
}

void WsServer::handle_connection(int sockfd) {
    std::string req;
    if (!read_http_headers(sockfd, req)) {
        ::close(sockfd);
        return;
    }

    bool is_upgrade =
        header_contains(req, "Upgrade", "websocket") &&
        header_contains(req, "Connection", "Upgrade");

    if (!is_upgrade) {
        std::string resp = rest_.handle(req);
        ::send(sockfd, resp.data(), resp.size(), MSG_NOSIGNAL);
        ::close(sockfd);
        return;
    }

    // WebSocket upgrade path.
    std::string sec_key = get_header(req, "Sec-WebSocket-Key");
    if (sec_key.empty()) {
        const std::string r = http_response(400, "Missing Sec-WebSocket-Key", "text/plain");
        ::send(sockfd, r.data(), r.size(), MSG_NOSIGNAL);
        ::close(sockfd);
        return;
    }

    // Auth precedence on WS upgrade:
    //   1. Authorization / Api-Key headers (used by Python bots; lib.py sets
    //      Api-Key explicitly).
    //   2. Sec-WebSocket-Protocol: engine.bearer, <key>  — used by browsers,
    //      which can't set custom headers on the WebSocket constructor but
    //      CAN pass subprotocol values via `new WebSocket(url, [...])`.
    // The query-string `?api_key=` form was removed (URLs leak to logs).
    std::string api_key = extractApiKeyFromHttp(req);
    std::string echo_subproto;  // sent back in 101 if we used the subprotocol path
    if (api_key.empty()) {
        const std::string proto_hdr = get_header(req, "Sec-WebSocket-Protocol");
        if (!proto_hdr.empty()) {
            // Comma-separated list; we want "engine.bearer" followed by a key.
            const std::string sentinel = "engine.bearer";
            size_t pos = proto_hdr.find(sentinel);
            if (pos != std::string::npos) {
                size_t after = pos + sentinel.size();
                // Skip a comma + optional space.
                while (after < proto_hdr.size() &&
                       (proto_hdr[after] == ',' || proto_hdr[after] == ' ')) ++after;
                size_t end = proto_hdr.find(',', after);
                if (end == std::string::npos) end = proto_hdr.size();
                api_key = proto_hdr.substr(after, end - after);
                // Trim trailing whitespace.
                while (!api_key.empty() && (api_key.back() == ' ' || api_key.back() == '\r')) {
                    api_key.pop_back();
                }
                echo_subproto = sentinel;
            }
        }
    }
    auto auth_res = auth_.validate(api_key);
    if (!auth_res.valid) {
        const std::string r = http_response(401, "{\"error\":\"invalid_api_key\"}",
                                            "application/json");
        ::send(sockfd, r.data(), r.size(), MSG_NOSIGNAL);
        ::close(sockfd);
        return;
    }

    // Send 101. If we accepted via subprotocol, the server MUST echo the
    // selected one back per RFC 6455 §4.2.2 — otherwise browsers reject.
    std::string handshake = ws_handshake_response(sec_key, echo_subproto);
    if (::send(sockfd, handshake.data(), handshake.size(), MSG_NOSIGNAL) < 0) {
        ::close(sockfd);
        return;
    }

    auto sess = sessions_.create(sockfd, api_key, auth_res.user_id);
    LOG_INFO("ws_server: session id=" << sess->id << " user=" << sess->user_id
                                       << " connected (fd=" << sockfd << ")");
    dispatcher_.on_connect(sess);

    // Reader loop runs on this thread.
    session_loop(sess);

    dispatcher_.on_disconnect(sess);
    sessions_.erase(sess->id);
    ::close(sockfd);
    LOG_INFO("ws_server: session id=" << sess->id << " disconnected");
}

void WsServer::session_loop(SessionPtr s) {
    while (running_.load() && s->alive.load()) {
        WsFrame f;
        if (!ws_read_frame(s->sockfd, f)) break;
        if (f.opcode == WsOpcode::Close) {
            std::lock_guard<std::mutex> lk(s->write_mu);
            ws_write_close(s->sockfd);
            break;
        }
        if (f.opcode == WsOpcode::Ping) {
            std::lock_guard<std::mutex> lk(s->write_mu);
            ws_write_pong(s->sockfd, f.payload);
            continue;
        }
        if (f.opcode == WsOpcode::Pong) continue;
        if (f.opcode != WsOpcode::Text) continue;  // ignore binary for v1
        if (!f.fin) continue;                       // no fragmentation support v1
        dispatcher_.on_message(s, f.payload);
    }
    s->alive = false;
}

}  // namespace TradingSystem
