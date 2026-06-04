#pragma once
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

// Reads a single frame from sockfd. Returns false on EOF/error.
// Limits the payload to max_payload bytes (returns false if exceeded).
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
std::string ws_handshake_response(const std::string& sec_websocket_key);

// Read a full HTTP request from the socket (until \r\n\r\n).
// Reads only the headers; if a body exists, leaves it on the socket. Returns
// false on error/EOF/limit-exceeded.
bool read_http_headers(int sockfd, std::string& out, size_t max_size = 65536);

}
