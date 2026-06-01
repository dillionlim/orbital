#include "server/ws_frame.hpp"

#include <openssl/evp.h>
#include <openssl/sha.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <sstream>
#include <vector>

#include "common/log.hpp"

namespace TradingSystem {

namespace {

bool read_full(int fd, void* buf, size_t n) {
    auto* p = static_cast<uint8_t*>(buf);
    size_t got = 0;
    while (got < n) {
        ssize_t r = ::read(fd, p + got, n - got);
        if (r <= 0) return false;
        got += r;
    }
    return true;
}

bool write_full(int fd, const void* buf, size_t n) {
    const auto* p = static_cast<const uint8_t*>(buf);
    size_t sent = 0;
    while (sent < n) {
        ssize_t w = ::send(fd, p + sent, n - sent, MSG_NOSIGNAL);
        if (w <= 0) return false;
        sent += w;
    }
    return true;
}

std::string base64_encode(const unsigned char* data, size_t len) {
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= len) {
        uint32_t n = (uint32_t(data[i]) << 16) | (uint32_t(data[i + 1]) << 8) | data[i + 2];
        out.push_back(tbl[(n >> 18) & 0x3F]);
        out.push_back(tbl[(n >> 12) & 0x3F]);
        out.push_back(tbl[(n >> 6) & 0x3F]);
        out.push_back(tbl[n & 0x3F]);
        i += 3;
    }
    if (i < len) {
        uint32_t n = (uint32_t(data[i]) << 16);
        if (i + 1 < len) n |= (uint32_t(data[i + 1]) << 8);
        out.push_back(tbl[(n >> 18) & 0x3F]);
        out.push_back(tbl[(n >> 12) & 0x3F]);
        if (i + 1 < len) {
            out.push_back(tbl[(n >> 6) & 0x3F]);
            out.push_back('=');
        } else {
            out.push_back('=');
            out.push_back('=');
        }
    }
    return out;
}

}  // namespace

std::string ws_accept_key(const std::string& sec_websocket_key) {
    static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    std::string concat = sec_websocket_key + kGuid;
    unsigned char hash[SHA_DIGEST_LENGTH];
    ::SHA1(reinterpret_cast<const unsigned char*>(concat.data()), concat.size(), hash);
    return base64_encode(hash, SHA_DIGEST_LENGTH);
}

std::string ws_handshake_response(const std::string& sec_websocket_key) {
    std::ostringstream oss;
    oss << "HTTP/1.1 101 Switching Protocols\r\n"
        << "Upgrade: websocket\r\n"
        << "Connection: Upgrade\r\n"
        << "Sec-WebSocket-Accept: " << ws_accept_key(sec_websocket_key) << "\r\n"
        << "\r\n";
    return oss.str();
}

bool read_http_headers(int sockfd, std::string& out, size_t max_size) {
    out.clear();
    char buf[1024];
    while (out.size() < max_size) {
        ssize_t n = ::read(sockfd, buf, sizeof(buf));
        if (n <= 0) return false;
        out.append(buf, buf + n);
        if (out.find("\r\n\r\n") != std::string::npos) return true;
    }
    return false;
}

bool ws_read_frame(int sockfd, WsFrame& out, size_t max_payload) {
    uint8_t hdr[2];
    if (!read_full(sockfd, hdr, 2)) return false;
    out.fin = (hdr[0] & 0x80) != 0;
    out.opcode = static_cast<WsOpcode>(hdr[0] & 0x0F);
    bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
        uint8_t ext[2];
        if (!read_full(sockfd, ext, 2)) return false;
        len = (uint64_t(ext[0]) << 8) | ext[1];
    } else if (len == 127) {
        uint8_t ext[8];
        if (!read_full(sockfd, ext, 8)) return false;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    if (len > max_payload) {
        LOG_WARN("ws_read_frame: payload " << len << " exceeds limit " << max_payload);
        return false;
    }
    uint8_t mask_key[4] = {0, 0, 0, 0};
    if (masked) {
        if (!read_full(sockfd, mask_key, 4)) return false;
    }
    out.payload.resize(len);
    if (len > 0) {
        if (!read_full(sockfd, out.payload.data(), len)) return false;
        if (masked) {
            for (uint64_t i = 0; i < len; ++i) {
                out.payload[i] ^= mask_key[i & 3];
            }
        }
    }
    return true;
}

bool ws_write_frame(int sockfd, const WsFrame& frame) {
    std::vector<uint8_t> hdr;
    hdr.reserve(10);
    uint8_t b0 = (frame.fin ? 0x80 : 0x00) | (static_cast<uint8_t>(frame.opcode) & 0x0F);
    hdr.push_back(b0);
    const size_t len = frame.payload.size();
    if (len < 126) {
        hdr.push_back(static_cast<uint8_t>(len));
    } else if (len <= 0xFFFF) {
        hdr.push_back(126);
        hdr.push_back(static_cast<uint8_t>((len >> 8) & 0xFF));
        hdr.push_back(static_cast<uint8_t>(len & 0xFF));
    } else {
        hdr.push_back(127);
        for (int i = 7; i >= 0; --i) {
            hdr.push_back(static_cast<uint8_t>((len >> (i * 8)) & 0xFF));
        }
    }
    if (!write_full(sockfd, hdr.data(), hdr.size())) return false;
    if (len > 0) {
        if (!write_full(sockfd, frame.payload.data(), len)) return false;
    }
    return true;
}

bool ws_write_text(int sockfd, std::string_view text) {
    WsFrame f;
    f.fin = true;
    f.opcode = WsOpcode::Text;
    f.payload.assign(text);
    return ws_write_frame(sockfd, f);
}

bool ws_write_close(int sockfd, uint16_t code, std::string_view reason) {
    WsFrame f;
    f.opcode = WsOpcode::Close;
    f.payload.push_back(static_cast<char>((code >> 8) & 0xFF));
    f.payload.push_back(static_cast<char>(code & 0xFF));
    f.payload.append(reason);
    return ws_write_frame(sockfd, f);
}

bool ws_write_pong(int sockfd, std::string_view payload) {
    WsFrame f;
    f.opcode = WsOpcode::Pong;
    f.payload.assign(payload);
    return ws_write_frame(sockfd, f);
}

}  // namespace TradingSystem
