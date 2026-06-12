#pragma once

// Minimal SHA-1 implementation. Public-domain construction (Steve Reid style),
// adapted to a single header so the engine has no external crypto dependency.
// Used only for the WebSocket handshake (`Sec-WebSocket-Accept`); it is NOT a
// general-purpose crypto primitive — do not use SHA-1 for new security work.

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace TradingSystem {

constexpr int SHA1_DIGEST_LEN = 20;

namespace sha1_detail {

inline uint32_t rol(uint32_t v, int n) { return (v << n) | (v >> (32 - n)); }

inline void transform(uint32_t state[5], const uint8_t block[64]) {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
        w[i] = (uint32_t(block[i * 4]) << 24) |
               (uint32_t(block[i * 4 + 1]) << 16) |
               (uint32_t(block[i * 4 + 2]) << 8) |
               uint32_t(block[i * 4 + 3]);
    }
    for (int i = 16; i < 80; ++i) {
        w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];
    for (int i = 0; i < 80; ++i) {
        uint32_t f, k;
        if (i < 20)      { f = (b & c) | ((~b) & d);            k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d;                       k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);     k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;                       k = 0xCA62C1D6; }
        uint32_t t = rol(a, 5) + f + e + k + w[i];
        e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
}

}  // namespace sha1_detail

inline void sha1(const void* data, size_t len, uint8_t out[SHA1_DIGEST_LEN]) {
    uint32_t state[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    const auto* p = static_cast<const uint8_t*>(data);
    uint64_t bit_len = uint64_t(len) * 8;

    uint8_t block[64];
    size_t off = 0;
    while (len - off >= 64) {
        sha1_detail::transform(state, p + off);
        off += 64;
    }
    size_t rem = len - off;
    std::memcpy(block, p + off, rem);
    block[rem++] = 0x80;
    if (rem > 56) {
        std::memset(block + rem, 0, 64 - rem);
        sha1_detail::transform(state, block);
        rem = 0;
    }
    std::memset(block + rem, 0, 56 - rem);
    for (int i = 0; i < 8; ++i) {
        block[56 + i] = static_cast<uint8_t>((bit_len >> (56 - i * 8)) & 0xFF);
    }
    sha1_detail::transform(state, block);

    for (int i = 0; i < 5; ++i) {
        out[i * 4]     = static_cast<uint8_t>((state[i] >> 24) & 0xFF);
        out[i * 4 + 1] = static_cast<uint8_t>((state[i] >> 16) & 0xFF);
        out[i * 4 + 2] = static_cast<uint8_t>((state[i] >> 8) & 0xFF);
        out[i * 4 + 3] = static_cast<uint8_t>(state[i] & 0xFF);
    }
}

inline void sha1(std::string_view s, uint8_t out[SHA1_DIGEST_LEN]) {
    sha1(s.data(), s.size(), out);
}

}  // namespace TradingSystem
