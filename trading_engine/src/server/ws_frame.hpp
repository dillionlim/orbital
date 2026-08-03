#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>

namespace TradingSystem {

enum class WsOpcode : uint8_t {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xA,
};

struct WsFrame {
    bool fin = true;
    WsOpcode opcode = WsOpcode::Text;
    std::string payload;
};

// RFC 6455 §5.5: control frames carry at most 125 bytes and are never fragmented.
inline constexpr size_t kMaxControlPayload = 125;

// Control opcodes are exactly those with the high bit of the 4-bit opcode set:
// Close (0x8), Ping (0x9), Pong (0xA) and the reserved 0xB-0xF.
inline constexpr bool is_control_opcode(WsOpcode op) {
    return (static_cast<uint8_t>(op) & 0x08) != 0;
}

// A socket together with bytes that have already been pulled off it.
//
// read_http_headers() reads in 1 KB blocks and stops at the first \r\n\r\n, so
// anything the client pipelined behind the request — the first WebSocket frame,
// for a client that doesn't wait for the 101 before sending `hello` — has
// already been consumed into memory and will never reappear on the socket.
// Reading frames through this replays those bytes before touching the fd again.
class WsReader {
public:
    explicit WsReader(int fd) : fd_(fd) {}
    WsReader(int fd, std::string_view already_read) : fd_(fd), pending_(already_read) {}

    [[nodiscard]] int fd() const { return fd_; }
    [[nodiscard]] bool has_buffered() const { return pos_ < pending_.size(); }

    // Fills `buf` with exactly n bytes, draining the pre-read buffer first.
    // Returns false on EOF/error.
    bool read_full(void* buf, size_t n);

private:
    int fd_;
    std::string pending_;
    size_t pos_ = 0;
};

// Reads a single frame. Returns false on EOF/error.
// Limits the payload to max_payload bytes (returns false if exceeded).
bool ws_read_frame(WsReader& in, WsFrame& out, size_t max_payload = (1u << 20));

// Convenience overload for a socket with nothing pre-read.
bool ws_read_frame(int sockfd, WsFrame& out, size_t max_payload = (1u << 20));

// Writes a single frame. Server frames must be unmasked.
bool ws_write_frame(int sockfd, const WsFrame& frame);

// Conveniences.
bool ws_write_text(int sockfd, std::string_view text);
bool ws_write_close(int sockfd, uint16_t code = 1000, std::string_view reason = "");
bool ws_write_pong(int sockfd, std::string_view payload);

// Computes Sec-WebSocket-Accept = base64(sha1(key + GUID)).
std::string ws_accept_key(const std::string& sec_websocket_key);

// Builds the 101 Switching Protocols response for a successful upgrade.
// `selected_subprotocol`, when non-empty, is echoed back in
// Sec-WebSocket-Protocol so the client accepts the upgrade. RFC 6455 §4.2.2:
// the server MUST include this header iff it actually selected a subprotocol.
std::string ws_handshake_response(const std::string& sec_websocket_key,
                                  std::string_view selected_subprotocol = {});

// Read a full HTTP request from the socket (until \r\n\r\n).
// Reads only the headers; if a body exists, leaves it on the socket. Returns
// false on error/EOF/limit-exceeded/deadline-exceeded.
//
// This runs before any API key is checked, so it is the one piece of the server
// an unauthenticated stranger can always reach. `timeout_ms` bounds the WHOLE
// header read, not each ::read: a per-read socket timeout alone still lets a
// client trickle one byte at a time and hold the connection's thread for days.
bool read_http_headers(int sockfd, std::string& out, size_t max_size = 65536,
                       int timeout_ms = 10000);

}
