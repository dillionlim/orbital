#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "server/ws_frame.hpp"

namespace {

using namespace TradingSystem;
using namespace std::chrono_literals;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_eq(auto actual, auto expected, const std::string& message) {
    if (!(actual == expected)) {
        std::cerr << "FAILED: " << message << " (expected " << expected
                  << ", got " << actual << ")\n";
        std::exit(1);
    }
}

// A connected AF_UNIX pair: the test writes raw bytes into `wr`, the code under
// test reads from `rd`.
struct SocketPair {
    int rd = -1;
    int wr = -1;

    SocketPair() {
        int fds[2];
        require(::socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0, "socketpair should succeed");
        rd = fds[0];
        wr = fds[1];
    }
    ~SocketPair() {
        close_wr();
        if (rd >= 0) ::close(rd);
    }
    SocketPair(const SocketPair&) = delete;
    SocketPair& operator=(const SocketPair&) = delete;

    void close_wr() {
        if (wr >= 0) {
            ::close(wr);
            wr = -1;
        }
    }
};

void write_bytes(int fd, const std::vector<uint8_t>& bytes) {
    size_t sent = 0;
    while (sent < bytes.size()) {
        ssize_t w = ::send(fd, bytes.data() + sent, bytes.size() - sent, MSG_NOSIGNAL);
        require(w > 0, "test write into the socketpair should succeed");
        sent += static_cast<size_t>(w);
    }
}

void write_str(int fd, const std::string& s) {
    write_bytes(fd, std::vector<uint8_t>(s.begin(), s.end()));
}

uint8_t opcode_byte(WsOpcode op) { return static_cast<uint8_t>(op); }

// Builds a frame byte-by-byte so the test controls every bit, including the
// declared length (which need not match the bytes actually appended).
std::vector<uint8_t> build_frame(bool fin, uint8_t opcode, const std::string& payload,
                                 bool masked, const uint8_t mask_key[4],
                                 uint64_t declared_len, int len_encoding) {
    std::vector<uint8_t> f;
    f.push_back(static_cast<uint8_t>((fin ? 0x80 : 0x00) | (opcode & 0x0F)));

    uint8_t b1 = masked ? 0x80 : 0x00;
    if (len_encoding == 7) {
        f.push_back(static_cast<uint8_t>(b1 | (declared_len & 0x7F)));
    } else if (len_encoding == 16) {
        f.push_back(static_cast<uint8_t>(b1 | 126));
        f.push_back(static_cast<uint8_t>((declared_len >> 8) & 0xFF));
        f.push_back(static_cast<uint8_t>(declared_len & 0xFF));
    } else {
        f.push_back(static_cast<uint8_t>(b1 | 127));
        for (int i = 7; i >= 0; --i) {
            f.push_back(static_cast<uint8_t>((declared_len >> (i * 8)) & 0xFF));
        }
    }
    if (masked) {
        for (int i = 0; i < 4; ++i) f.push_back(mask_key[i]);
    }
    for (size_t i = 0; i < payload.size(); ++i) {
        uint8_t c = static_cast<uint8_t>(payload[i]);
        f.push_back(masked ? static_cast<uint8_t>(c ^ mask_key[i & 3]) : c);
    }
    return f;
}

// Picks the smallest length encoding the payload actually needs.
std::vector<uint8_t> masked_frame(bool fin, WsOpcode op, const std::string& payload,
                                  const uint8_t mask_key[4]) {
    int enc = payload.size() < 126 ? 7 : (payload.size() <= 0xFFFF ? 16 : 64);
    return build_frame(fin, opcode_byte(op), payload, true, mask_key, payload.size(), enc);
}

// A well-formed masked client frame round-trips, and a mask key containing zero
// bytes still unmasks correctly (a zero byte leaves that column unchanged).
void reads_and_unmasks_a_well_formed_text_frame() {
    SocketPair sp;
    const uint8_t key[4] = {0x37, 0xFA, 0x21, 0x3D};
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Text, "Hello", key));

    const uint8_t zero_key[4] = {0x00, 0xAB, 0x00, 0x00};
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Text, "{\"t\":\"ping\"}", zero_key));
    sp.close_wr();

    WsFrame f;
    require(ws_read_frame(sp.rd, f), "well-formed masked text frame should parse");
    require(f.fin, "fin bit should be set");
    require_eq(opcode_byte(f.opcode), opcode_byte(WsOpcode::Text), "opcode should be Text");
    require_eq(f.payload, std::string("Hello"), "payload should be unmasked");

    WsFrame g;
    require(ws_read_frame(sp.rd, g), "second frame should parse");
    require_eq(g.payload, std::string("{\"t\":\"ping\"}"),
               "mask key with zero bytes should still unmask exactly");
}

// RFC 6455 §5.1: an unmasked client frame is a protocol violation.
void rejects_an_unmasked_client_frame() {
    SocketPair sp;
    const uint8_t no_key[4] = {0, 0, 0, 0};
    write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Text), "Hello", false, no_key,
                                   5, 7));
    sp.close_wr();

    WsFrame f;
    require(!ws_read_frame(sp.rd, f), "unmasked client frame must be rejected");
}

// 7-bit, 16-bit (126 marker) and 64-bit (127 marker) length encodings.
void parses_every_payload_length_encoding() {
    const uint8_t key[4] = {0x01, 0x02, 0x03, 0x04};

    {
        SocketPair sp;
        const std::string small(125, 'a');  // largest 7-bit length
        write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Text), small, true, key,
                                       small.size(), 7));
        sp.close_wr();
        WsFrame f;
        require(ws_read_frame(sp.rd, f), "7-bit length frame should parse");
        require_eq(f.payload.size(), static_cast<size_t>(125), "7-bit length");
        require_eq(f.payload, small, "7-bit payload contents");
    }
    {
        SocketPair sp;
        const std::string mid(300, 'b');
        write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Binary), mid, true, key,
                                       mid.size(), 16));
        sp.close_wr();
        WsFrame f;
        require(ws_read_frame(sp.rd, f), "16-bit length frame should parse");
        require_eq(f.payload.size(), static_cast<size_t>(300), "16-bit length");
        require_eq(f.payload, mid, "16-bit payload contents");
    }
    {
        // 70000 > 0xFFFF, so it needs the 64-bit encoding. Feed it from a thread:
        // the frame may exceed the socket buffer and block the writer.
        SocketPair sp;
        const std::string big(70000, 'c');
        auto bytes = build_frame(true, opcode_byte(WsOpcode::Text), big, true, key,
                                 big.size(), 64);
        std::thread feeder([&] { write_bytes(sp.wr, bytes); });
        WsFrame f;
        bool ok = ws_read_frame(sp.rd, f, 1u << 20);
        feeder.join();
        sp.close_wr();
        require(ok, "64-bit length frame should parse");
        require_eq(f.payload.size(), static_cast<size_t>(70000), "64-bit length");
        require_eq(f.payload, big, "64-bit payload contents");
    }
}

// A frame declaring more than max_payload is refused before any payload is read
// or allocated — including the classic 0xFFFFFFFFFFFFFFFF OOM vector.
void refuses_payloads_above_max_payload() {
    const uint8_t key[4] = {0x11, 0x22, 0x33, 0x44};
    {
        SocketPair sp;
        // Declares 200 bytes but sends none: the limit must trip before any read.
        // 200 needs the 16-bit encoding (it does not fit the 7-bit length field).
        write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Text), "", true, key, 200, 16));
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f, 100), "payload above max_payload must be refused");
        require(f.payload.empty(), "refused frame must not allocate the payload");
    }
    {
        SocketPair sp;
        write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Text), "", true, key,
                                       0xFFFFFFFFFFFFFFFFULL, 64));
        sp.close_wr();
        WsFrame f;
        const auto start = std::chrono::steady_clock::now();
        bool ok = ws_read_frame(sp.rd, f, 1u << 20);
        const auto elapsed = std::chrono::steady_clock::now() - start;
        require(!ok, "64-bit length 0xFFFFFFFFFFFFFFFF must be refused");
        require(f.payload.empty(), "the 16-exabyte frame must not be allocated");
        require(elapsed < 2s, "the limit check must trip immediately, not after an allocation");
    }
    {
        SocketPair sp;
        write_bytes(sp.wr, build_frame(true, opcode_byte(WsOpcode::Text), "", true, key,
                                       0x8000000000000000ULL, 64));
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f, 1u << 20),
                "a length with the high bit set must be refused, not wrapped");
    }
}

// Every truncation point must return false rather than hang or read garbage.
void rejects_truncated_frames() {
    const uint8_t key[4] = {0x0A, 0x0B, 0x0C, 0x0D};
    {
        SocketPair sp;  // header cut short (1 of 2 bytes)
        write_bytes(sp.wr, {0x81});
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f), "one-byte header must be refused");
    }
    {
        SocketPair sp;  // 16-bit extended length cut short
        write_bytes(sp.wr, {0x81, 0xFE, 0x01});
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f), "truncated 16-bit length must be refused");
    }
    {
        SocketPair sp;  // 64-bit extended length cut short
        write_bytes(sp.wr, {0x81, 0xFF, 0x00, 0x00, 0x00});
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f), "truncated 64-bit length must be refused");
    }
    {
        SocketPair sp;  // mask key cut short (2 of 4 bytes)
        write_bytes(sp.wr, {0x81, 0x85, 0x0A, 0x0B});
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f), "truncated mask key must be refused");
    }
    {
        SocketPair sp;  // declares 10 bytes, sends 4
        auto bytes = build_frame(true, opcode_byte(WsOpcode::Text), "abcd", true, key, 10, 7);
        write_bytes(sp.wr, bytes);
        sp.close_wr();
        WsFrame f;
        require(!ws_read_frame(sp.rd, f), "payload shorter than the declared length is refused");
    }
}

// A peer that connects and immediately hangs up.
void returns_false_on_immediate_eof() {
    SocketPair sp;
    sp.close_wr();
    WsFrame f;
    require(!ws_read_frame(sp.rd, f), "EOF before any byte must return false");
}

// Close / Ping / Pong parse with the right opcode; a zero-length payload works.
void parses_control_frames_and_zero_length_payloads() {
    SocketPair sp;
    const uint8_t key[4] = {0x5A, 0x00, 0xC3, 0x11};

    std::string close_payload;  // status code 1000 + reason
    close_payload.push_back(static_cast<char>(0x03));
    close_payload.push_back(static_cast<char>(0xE8));
    close_payload += "bye";

    write_bytes(sp.wr, masked_frame(true, WsOpcode::Close, close_payload, key));
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Ping, "hb", key));
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Pong, "", key));
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Text, "", key));
    sp.close_wr();

    WsFrame f;
    require(ws_read_frame(sp.rd, f), "close frame should parse");
    require_eq(opcode_byte(f.opcode), opcode_byte(WsOpcode::Close), "Close opcode");
    require_eq(f.payload, close_payload, "close payload survives unmasking");

    require(ws_read_frame(sp.rd, f), "ping frame should parse");
    require_eq(opcode_byte(f.opcode), opcode_byte(WsOpcode::Ping), "Ping opcode");
    require_eq(f.payload, std::string("hb"), "ping payload");

    require(ws_read_frame(sp.rd, f), "zero-length pong should parse");
    require_eq(opcode_byte(f.opcode), opcode_byte(WsOpcode::Pong), "Pong opcode");
    require(f.payload.empty(), "zero-length pong payload");

    require(ws_read_frame(sp.rd, f), "zero-length text frame should parse");
    require_eq(opcode_byte(f.opcode), opcode_byte(WsOpcode::Text), "Text opcode");
    require(f.payload.empty(), "zero-length text payload");
}

// A fragmented message: fin=false on the head, a Continuation frame after it.
void reports_the_fin_bit_for_fragmented_frames() {
    SocketPair sp;
    const uint8_t key[4] = {0x21, 0x43, 0x65, 0x87};
    write_bytes(sp.wr, masked_frame(false, WsOpcode::Text, "frag", key));
    write_bytes(sp.wr, masked_frame(true, WsOpcode::Continuation, "ment", key));
    sp.close_wr();

    WsFrame head;
    require(ws_read_frame(sp.rd, head), "fragment head should parse");
    require(!head.fin, "fin=false must be reported on the struct");
    require_eq(opcode_byte(head.opcode), opcode_byte(WsOpcode::Text), "head keeps its opcode");
    require_eq(head.payload, std::string("frag"), "head payload");

    WsFrame tail;
    require(ws_read_frame(sp.rd, tail), "continuation should parse");
    require(tail.fin, "final fragment sets fin");
    require_eq(opcode_byte(tail.opcode), opcode_byte(WsOpcode::Continuation),
               "Continuation opcode");
    require_eq(tail.payload, std::string("ment"), "continuation payload");
}

// Reserved/unknown opcodes are passed through verbatim (the framing layer does
// not police them; the caller decides what to do with an unhandled opcode).
void passes_unknown_opcodes_through() {
    SocketPair sp;
    const uint8_t key[4] = {0x9E, 0x7C, 0x5B, 0x3A};
    write_bytes(sp.wr, build_frame(true, 0x3, "reserved", true, key, 8, 7));   // reserved non-control
    write_bytes(sp.wr, build_frame(true, 0xB, "ctl", true, key, 3, 7));        // reserved control
    // The 4 high bits (fin + RSV1..3) are masked off, so RSV bits set must not
    // leak into the opcode.
    write_bytes(sp.wr, build_frame(true, 0xF, "", true, key, 0, 7));
    sp.close_wr();

    WsFrame f;
    require(ws_read_frame(sp.rd, f), "reserved data opcode 0x3 should still parse");
    require_eq(opcode_byte(f.opcode), static_cast<uint8_t>(0x3), "opcode reported verbatim");
    require_eq(f.payload, std::string("reserved"), "reserved-opcode payload is unmasked");

    require(ws_read_frame(sp.rd, f), "reserved control opcode 0xB should still parse");
    require_eq(opcode_byte(f.opcode), static_cast<uint8_t>(0xB), "control opcode verbatim");

    require(ws_read_frame(sp.rd, f), "opcode 0xF should still parse");
    require_eq(opcode_byte(f.opcode), static_cast<uint8_t>(0xF), "opcode is only the low nibble");
}

// A normal request ends at \r\n\r\n; the reader does not block waiting for a
// body that has not arrived, and the socket stays usable afterwards.
void reads_headers_terminated_by_crlfcrlf() {
    SocketPair sp;
    const std::string req =
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\r\n";
    write_str(sp.wr, req);

    std::string out;
    require(read_http_headers(sp.rd, out, 65536, 1000), "well-formed headers should be read");
    require_eq(out, req, "headers are returned verbatim");

    // The body arrives only after the call returned: it is still on the socket.
    write_str(sp.wr, "BODY");
    sp.close_wr();
    char buf[16] = {};
    ssize_t n = ::read(sp.rd, buf, sizeof(buf));
    require_eq(n, static_cast<ssize_t>(4), "later bytes are still readable from the socket");
    require_eq(std::string(buf, 4), std::string("BODY"), "socket is left usable for the body");
}

// Actual behaviour: ::read grabs up to 1024 bytes at a time, so a body sent in
// the same segment as the headers ends up appended to `out` past the \r\n\r\n.
void keeps_body_bytes_that_arrive_in_the_same_read() {
    SocketPair sp;
    const std::string headers = "POST /orders HTTP/1.1\r\nContent-Length: 4\r\n\r\n";
    write_str(sp.wr, headers + "{\"a\"");
    sp.close_wr();

    std::string out;
    require(read_http_headers(sp.rd, out, 65536, 1000), "request with a body should be read");
    require_eq(out, headers + "{\"a\"", "the body arriving with the headers is consumed into out");
    require(out.find("\r\n\r\n") != std::string::npos, "terminator is present in out");
}

// A header block that blows past max_size is dropped, not grown without bound.
void refuses_headers_above_max_size() {
    SocketPair sp;
    const std::string flood = "GET / HTTP/1.1\r\n" + std::string(8192, 'x');  // no terminator
    write_str(sp.wr, flood);
    sp.close_wr();

    std::string out;
    require(!read_http_headers(sp.rd, out, 256, 1000), "headers above max_size must be refused");
    // The loop stops once the cap is passed; it never reads the whole flood.
    require(out.size() < flood.size(), "the reader stops instead of growing without bound");
}

// Slowloris: a peer that keeps the socket open and trickles bytes forever without
// ever sending \r\n\r\n. The deadline must bound the WHOLE read, not each ::read.
void enforces_the_deadline_against_a_trickling_client() {
    SocketPair sp;
    std::atomic<bool> stop{false};
    std::thread trickler([&] {
        const char byte = 'x';
        while (!stop.load(std::memory_order_relaxed)) {
            if (::send(sp.wr, &byte, 1, MSG_NOSIGNAL) <= 0) break;
            std::this_thread::sleep_for(10ms);
        }
    });

    const auto start = std::chrono::steady_clock::now();
    std::string out;
    bool ok = read_http_headers(sp.rd, out, 65536, 200);
    const auto elapsed = std::chrono::steady_clock::now() - start;
    stop.store(true, std::memory_order_relaxed);
    trickler.join();

    require(!ok, "a client that never terminates its headers must be dropped");
    require(elapsed >= 150ms, "the deadline should not fire early");
    require(elapsed < 3s, "the deadline must bound the total read, not each ::read");
    require(out.size() < 65536, "the trickle never reaches the size cap; the deadline fires first");
}

// A peer that sends nothing at all: with the SO_RCVTIMEO the server sets, ::read
// surfaces EAGAIN and the header read fails instead of parking the thread.
void treats_a_socket_recv_timeout_as_a_failed_read() {
    SocketPair sp;
    struct timeval tv{};
    tv.tv_usec = 50 * 1000;
    require(::setsockopt(sp.rd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) == 0,
            "SO_RCVTIMEO should be settable");

    const auto start = std::chrono::steady_clock::now();
    std::string out;
    bool ok = read_http_headers(sp.rd, out, 65536, 5000);  // peer stays open, sends nothing
    const auto elapsed = std::chrono::steady_clock::now() - start;

    require(!ok, "a silent peer must not be read successfully");
    require(elapsed < 2s, "the recv timeout must surface as a failed read, not a hang");
    require(out.empty(), "nothing was read");
}

// RFC 6455 §1.3 worked example.
void computes_the_rfc6455_accept_key() {
    require_eq(ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
               std::string("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "RFC 6455 §1.3 accept key");
    require(ws_accept_key("x3JJHMbDL1EzLkh9GBhXDw==") != ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "different keys produce different accepts");
    require_eq(ws_accept_key("").size(), static_cast<size_t>(28),
               "an accept key is always base64 of a 20-byte digest");
}

// §4.2.2: Sec-WebSocket-Protocol is echoed iff a subprotocol was selected.
void builds_the_handshake_response() {
    const std::string plain = ws_handshake_response("dGhlIHNhbXBsZSBub25jZQ==");
    require(plain.rfind("HTTP/1.1 101 Switching Protocols\r\n", 0) == 0, "101 status line");
    require(plain.find("Upgrade: websocket\r\n") != std::string::npos, "Upgrade header");
    require(plain.find("Connection: Upgrade\r\n") != std::string::npos, "Connection header");
    require(plain.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n") != std::string::npos,
            "accept header carries the RFC example value");
    require(plain.find("Sec-WebSocket-Protocol") == std::string::npos,
            "no subprotocol header when none was selected");
    require(plain.size() >= 4 && plain.compare(plain.size() - 4, 4, "\r\n\r\n") == 0,
            "response ends with a blank line");

    const std::string with_proto =
        ws_handshake_response("dGhlIHNhbXBsZSBub25jZQ==", "engine.bearer");
    require(with_proto.find("Sec-WebSocket-Protocol: engine.bearer\r\n") != std::string::npos,
            "selected subprotocol is echoed back");
    require(with_proto.size() >= 4 && with_proto.compare(with_proto.size() - 4, 4, "\r\n\r\n") == 0,
            "response with a subprotocol still ends with a blank line");
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"reads_and_unmasks_a_well_formed_text_frame", reads_and_unmasks_a_well_formed_text_frame},
        {"rejects_an_unmasked_client_frame", rejects_an_unmasked_client_frame},
        {"parses_every_payload_length_encoding", parses_every_payload_length_encoding},
        {"refuses_payloads_above_max_payload", refuses_payloads_above_max_payload},
        {"rejects_truncated_frames", rejects_truncated_frames},
        {"returns_false_on_immediate_eof", returns_false_on_immediate_eof},
        {"parses_control_frames_and_zero_length_payloads",
         parses_control_frames_and_zero_length_payloads},
        {"reports_the_fin_bit_for_fragmented_frames", reports_the_fin_bit_for_fragmented_frames},
        {"passes_unknown_opcodes_through", passes_unknown_opcodes_through},
        {"reads_headers_terminated_by_crlfcrlf", reads_headers_terminated_by_crlfcrlf},
        {"keeps_body_bytes_that_arrive_in_the_same_read",
         keeps_body_bytes_that_arrive_in_the_same_read},
        {"refuses_headers_above_max_size", refuses_headers_above_max_size},
        {"enforces_the_deadline_against_a_trickling_client",
         enforces_the_deadline_against_a_trickling_client},
        {"treats_a_socket_recv_timeout_as_a_failed_read",
         treats_a_socket_recv_timeout_as_a_failed_read},
        {"computes_the_rfc6455_accept_key", computes_the_rfc6455_accept_key},
        {"builds_the_handshake_response", builds_the_handshake_response},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "ws_frame_tests passed (" << cases.size() << " cases)\n";
        return 0;
    }

    const std::string requested = argv[1];
    for (const auto& test : cases) {
        if (requested == test.name) {
            test.run();
            std::cout << test.name << " passed\n";
            return 0;
        }
    }

    std::cerr << "Unknown ws frame test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
