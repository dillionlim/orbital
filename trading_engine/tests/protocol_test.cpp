#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "rapidjson/document.h"
#include "server/protocol.hpp"

namespace {

using namespace TradingSystem;

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_eq(auto actual, auto expected, const std::string& message) {
    if (!(actual == expected)) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

void require_price(Price actual, Price expected, const std::string& message) {
    if (std::fabs(actual - expected) > 0.000001) {
        std::cerr << "FAILED: " << message << " (expected " << expected
                  << ", got " << actual << ")\n";
        std::exit(1);
    }
}

// A message is usable by the dispatcher only if it carries a concrete type and
// no parse_error; every rejection path must fail this predicate.
void require_rejected(const std::string& json, const std::string& message) {
    auto m = parse_inbound(json);
    const bool rejected = m.type == ParsedMessage::Type::Unknown || !m.parse_error.empty();
    require(rejected, "should be rejected: " + message);
}

// A rejected place must flag the exact reason, must never surface as a *clean*
// Place (empty parse_error), and must never carry a non-zero limit_price â
// limit_price is only ever set once its > 0 check has passed.
void require_rejected_place(const std::string& json, const std::string& expected_error,
                            const std::string& message) {
    auto m = parse_inbound(json);
    require_eq(m.parse_error, expected_error, "reject reason: " + message);
    require(!(m.type == ParsedMessage::Type::Place && m.parse_error.empty()),
            "rejected place is not a clean order: " + message);
    require_price(m.place.limit_price, 0.0, "rejected place carries no price: " + message);
}

rapidjson::Document reparse(const std::string& frame, const std::string& message) {
    rapidjson::Document doc;
    doc.Parse(frame.data(), frame.size());
    require(!doc.HasParseError(), "encoded frame must be valid JSON: " + message);
    require(doc.IsObject(), "encoded frame must be a JSON object: " + message);
    return doc;
}

std::string field(const rapidjson::Document& doc, const char* key, const std::string& message) {
    require(doc.HasMember(key) && doc[key].IsString(), std::string("missing string field ") + key +
                                                           ": " + message);
    return std::string(doc[key].GetString(), doc[key].GetStringLength());
}

SymbolRegistry registry(const std::string& name) {
    SymbolConfig sc;
    sc.name = name;
    sc.id = 1;
    sc.mid = 100.0;
    return SymbolRegistry(std::vector<SymbolConfig>{sc});
}

// Every string a client can put on the wire and get echoed back into someone
// else's frame: quote, backslash, newline, tab and a raw control byte.
const char* kHostile = "ev\"il\\ \n \t \x01 \x1f </script>";

// ---- inbound: happy paths -------------------------------------------------

void parses_hello_and_ping() {
    auto hello = parse_inbound(R"({"t":"hello","client_id":"mm-bot-1"})");
    require_eq(hello.type, ParsedMessage::Type::Hello, "hello type");
    require(hello.parse_error.empty(), "hello has no parse error");
    require_eq(hello.hello.client_id, std::string("mm-bot-1"), "hello client_id");

    // client_id is optional; a hello without one still stands.
    auto bare = parse_inbound(R"({"t":"hello"})");
    require_eq(bare.type, ParsedMessage::Type::Hello, "bare hello type");
    require(bare.hello.client_id.empty(), "bare hello has empty client_id");

    auto ping = parse_inbound(R"({"t":"ping"})");
    require_eq(ping.type, ParsedMessage::Type::Ping, "ping type");
    require(ping.parse_error.empty(), "ping has no parse error");
}

void parses_limit_place_order() {
    auto m = parse_inbound(R"({"t":"place_order","client_order_id":"c-1","symbol":"BTC-USD",
                               "side":"Sell","type":"Limit","quantity":25,"limit_price":101.5})");
    require_eq(m.type, ParsedMessage::Type::Place, "limit place type");
    require(m.parse_error.empty(), "limit place has no parse error");
    require_eq(m.place.client_order_id, std::string("c-1"), "client_order_id");
    require_eq(m.place.symbol, std::string("BTC-USD"), "symbol");
    require_eq(m.place.side, OrderSide::Sell, "side");
    require_eq(m.place.type, OrderType::Limit, "order type");
    require_eq(m.place.quantity, static_cast<Quantity>(25), "quantity");
    require_price(m.place.limit_price, 101.5, "limit price");

    // Side and type spellings are accepted in three cases each.
    for (const char* side : {"Buy", "buy", "BUY"}) {
        OrderSide s = OrderSide::Sell;
        require(parse_side(side, s) && s == OrderSide::Buy, std::string("parse_side ") + side);
    }
    for (const char* type : {"Market", "market", "MARKET"}) {
        OrderType t = OrderType::Limit;
        require(parse_type(type, t) && t == OrderType::Market, std::string("parse_type ") + type);
    }
    require_eq(std::string(side_name(OrderSide::Buy)), std::string("Buy"), "side_name");
    require_eq(std::string(type_name(OrderType::Limit)), std::string("Limit"), "type_name");
    require_eq(std::string(status_name(OrderStatus::Filled)), std::string("Filled"), "status_name");
}

void parses_market_place_order_without_price() {
    auto m = parse_inbound(
        R"({"t":"place_order","symbol":"ETH-USD","side":"BUY","type":"market","quantity":3})");
    require_eq(m.type, ParsedMessage::Type::Place, "market place type");
    require(m.parse_error.empty(), "market place needs no limit_price");
    require_eq(m.place.type, OrderType::Market, "order type is Market");
    require_eq(m.place.side, OrderSide::Buy, "side");
    require_eq(m.place.quantity, static_cast<Quantity>(3), "quantity");
    require_price(m.place.limit_price, 0.0, "market order has no limit price");
    require(m.place.client_order_id.empty(), "client_order_id is optional");

    // A limit_price supplied on a market order is simply not read.
    auto ignored = parse_inbound(
        R"({"t":"place_order","symbol":"ETH-USD","side":"buy","type":"market","quantity":3,"limit_price":-9})");
    require(ignored.parse_error.empty(), "market order ignores limit_price");
    require_price(ignored.place.limit_price, 0.0, "market order limit price stays 0");
}

void parses_cancel_order() {
    auto m = parse_inbound(R"({"t":"cancel_order","order_id":90210})");
    require_eq(m.type, ParsedMessage::Type::Cancel, "cancel type");
    require(m.parse_error.empty(), "cancel has no parse error");
    require_eq(m.cancel.order_id, static_cast<OrderId>(90210), "order_id");
}

void parses_subscribe_and_unsubscribe() {
    auto sub = parse_inbound(R"({"t":"subscribe","channel":"book","symbol":"BTC-USD","depth":5})");
    require_eq(sub.type, ParsedMessage::Type::Subscribe, "subscribe type");
    require(sub.parse_error.empty(), "subscribe has no parse error");
    require_eq(sub.subscribe.channel, std::string("book"), "channel");
    require_eq(sub.subscribe.symbol, std::string("BTC-USD"), "symbol");
    require_eq(sub.subscribe.depth, 5, "depth");

    auto defaulted = parse_inbound(R"({"t":"subscribe","channel":"trades","symbol":"BTC-USD"})");
    require_eq(defaulted.subscribe.depth, 10, "depth defaults to 10");

    auto unsub = parse_inbound(R"({"t":"unsubscribe","channel":"book","symbol":"ETH-USD"})");
    require_eq(unsub.type, ParsedMessage::Type::Unsubscribe, "unsubscribe type");
    require(unsub.parse_error.empty(), "unsubscribe has no parse error");
    require_eq(unsub.unsubscribe.channel, std::string("book"), "unsubscribe channel");
    require_eq(unsub.unsubscribe.symbol, std::string("ETH-USD"), "unsubscribe symbol");
}

// ---- inbound: malformed / hostile input -----------------------------------

void rejects_malformed_json() {
    const char* bad[] = {
        "", " ", "{", "}", "[", "]", "{,}", "{\"t\"", R"({"t":"ping")",
        R"({"t":"ping",})", R"({"t":'ping'})", "\x01\x02\xff\xfe", "\xef\xbb\xbf{}",
        "not json at all", R"({"t":"ping"}{"t":"ping"})",
    };
    for (const char* json : bad) {
        auto m = parse_inbound(json);
        require_eq(m.type, ParsedMessage::Type::Unknown, std::string("malformed rejected: ") + json);
        require_eq(m.parse_error, std::string("invalid_json_or_missing_t"),
                   std::string("malformed reason: ") + json);
    }

    // An embedded NUL truncates nothing: the length-aware overload sees the
    // trailing garbage and rejects the whole payload.
    const std::string with_nul(R"({"t":"ping"})" + std::string(1, '\0') + "junk", 17);
    require_rejected(with_nul, "payload with embedded NUL and trailing junk");
}

void rejects_non_object_toplevel() {
    for (const char* json : {"5", "-1", "3.14", R"("x")", "true", "false", "null", "[]",
                             R"(["t","ping"])", R"([{"t":"ping"}])"}) {
        auto m = parse_inbound(json);
        require_eq(m.type, ParsedMessage::Type::Unknown, std::string("non-object rejected: ") + json);
        require_eq(m.parse_error, std::string("invalid_json_or_missing_t"),
                   std::string("non-object reason: ") + json);
    }
}

void rejects_deeply_nested_payloads() {
    // rapidjson recurses on nesting; the parser must survive and reject, not blow up.
    for (const char* open : {"[", "{\"a\":"}) {
        std::string deep;
        for (int i = 0; i < 20000; ++i) deep += open;
        auto m = parse_inbound(deep);
        require_eq(m.type, ParsedMessage::Type::Unknown, "unterminated deep nesting rejected");
    }

    std::string closed(2000, '[');
    closed += std::string(2000, ']');
    auto arr = parse_inbound(closed);
    require_eq(arr.type, ParsedMessage::Type::Unknown, "well-formed deep array is not an object");

    // A valid object whose *value* is deeply nested still parses and dispatches on "t".
    std::string nested = R"({"t":"ping","junk":)" + std::string(500, '[') + std::string(500, ']') + "}";
    auto m = parse_inbound(nested);
    require_eq(m.type, ParsedMessage::Type::Ping, "deep junk value does not break dispatch");
}

void rejects_missing_or_untyped_t() {
    for (const char* json : {"{}", R"({"type":"ping"})", R"({"t":null})", R"({"t":5})",
                             R"({"t":true})", R"({"t":["ping"]})", R"({"t":{"x":1}})"}) {
        auto m = parse_inbound(json);
        require_eq(m.type, ParsedMessage::Type::Unknown, std::string("bad t rejected: ") + json);
        require_eq(m.parse_error, std::string("invalid_json_or_missing_t"),
                   std::string("bad t reason: ") + json);
    }
}

void rejects_unknown_message_type() {
    for (const char* json : {R"({"t":"place"})", R"({"t":"PING"})", R"({"t":""})",
                             R"({"t":"place_order "})", R"({"t":"amend_order"})"}) {
        auto m = parse_inbound(json);
        require_eq(m.type, ParsedMessage::Type::Unknown, std::string("unknown t rejected: ") + json);
        require_eq(m.parse_error, std::string("unknown_type"), std::string("unknown t reason: ") + json);
    }
}

void rejects_place_order_missing_required_fields() {
    require_rejected_place(R"({"t":"place_order","side":"buy","type":"limit","quantity":5,"limit_price":1})",
                           "missing_symbol", "no symbol");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","type":"limit","quantity":5,"limit_price":1})",
                           "missing_or_invalid_side", "no side");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","quantity":5,"limit_price":1})",
                           "missing_or_invalid_type", "no order type");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","limit_price":1})",
                           "missing_or_invalid_quantity", "no quantity");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5})",
                           "missing_or_invalid_limit_price", "limit order with no price");
    require_rejected(R"({"t":"cancel_order"})", "cancel with no order_id");
    require_eq(parse_inbound(R"({"t":"cancel_order"})").parse_error, std::string("missing_order_id"),
               "cancel reject reason");
}

void rejects_place_order_with_wrong_field_types() {
    const char* qty_variants[] = {
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":"5","limit_price":1})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":null,"limit_price":1})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":true,"limit_price":1})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":{"v":5},"limit_price":1})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":[5],"limit_price":1})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5.5,"limit_price":1})",
    };
    for (const char* json : qty_variants)
        require_rejected_place(json, "missing_or_invalid_quantity", "non-integer quantity");

    const char* price_variants[] = {
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":"100"})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":null})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":true})",
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":[1]})",
    };
    for (const char* json : price_variants) {
        auto m = parse_inbound(json);
        require_eq(m.parse_error, std::string("missing_or_invalid_limit_price"), "non-numeric price");
        require_price(m.place.limit_price, 0.0, "rejected price is not carried");
    }

    // Non-string symbol / side / type are treated as absent.
    require_rejected_place(R"({"t":"place_order","symbol":5,"side":"buy","type":"limit","quantity":5,"limit_price":1})",
                           "missing_symbol", "numeric symbol");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":1,"type":"limit","quantity":5,"limit_price":1})",
                           "missing_or_invalid_side", "numeric side");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":null,"quantity":5,"limit_price":1})",
                           "missing_or_invalid_type", "null order type");

    for (const char* json : {R"({"t":"cancel_order","order_id":"7"})",
                             R"({"t":"cancel_order","order_id":null})",
                             R"({"t":"cancel_order","order_id":true})",
                             R"({"t":"cancel_order","order_id":7.5})",
                             R"({"t":"cancel_order","order_id":{"id":7}})"}) {
        auto m = parse_inbound(json);
        require_eq(m.parse_error, std::string("missing_order_id"),
                   std::string("non-integer order_id: ") + json);
        require_eq(m.cancel.order_id, static_cast<OrderId>(0), "rejected cancel carries no id");
    }
}

void rejects_unknown_enum_spellings() {
    for (const char* side : {"bid", "BuY", "b", "", "0", "Buy "}) {
        OrderSide s = OrderSide::Sell;
        require(!parse_side(side, s), std::string("unknown side: ") + side);
    }
    for (const char* type : {"stop", "StopLimit", "ioc", "", "LiMiT"}) {
        OrderType t = OrderType::Limit;
        require(!parse_type(type, t), std::string("unknown order type: ") + type);
    }
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"bid","type":"limit","quantity":5,"limit_price":1})",
                           "missing_or_invalid_side", "unknown side value");
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"stop","quantity":5,"limit_price":1})",
                           "missing_or_invalid_type", "Stop is not accepted on the wire");
}

void rejects_zero_and_out_of_range_quantities() {
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":0,"limit_price":1})",
                           "missing_or_invalid_quantity", "zero quantity");
    // > uint64 max and 1e999 are stored as doubles / overflow the parser: neither is an integer.
    require_rejected_place(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":99999999999999999999,"limit_price":1})",
                           "missing_or_invalid_quantity", "quantity beyond uint64 max");
    require_rejected(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":1e999,"limit_price":1})",
                     "quantity 1e999 overflows the number parser");
    require_eq(parse_inbound(R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":1e999,"limit_price":1})").type,
               ParsedMessage::Type::Unknown, "1e999 fails the whole document parse");

    // uint64 max itself is a well-formed integer and is accepted at this layer;
    // sizing limits are enforced downstream by the risk checks.
    auto max = parse_inbound(
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":18446744073709551615,"limit_price":1})");
    require(max.parse_error.empty(), "uint64-max quantity parses");
    require_eq(max.place.quantity, static_cast<Quantity>(18446744073709551615ULL), "uint64-max quantity");

    // A negative quantity must be rejected, not cast to a huge uint64: static_cast of a
    // negative int is non-zero, so a naive cast slips past the zero-guard as ~1.8e19 units.
    for (const char* q : {"-1", "-5", "-9223372036854775808"}) {
        const std::string json = std::string(
            R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":)") +
            q + R"(,"limit_price":1})";
        require_rejected_place(json, "missing_or_invalid_quantity",
                               std::string("negative quantity ") + q);
    }
    // Same wrap hazard on cancel's order_id.
    require_rejected(R"({"t":"cancel_order","order_id":-1})",
                     "negative order_id is rejected, not wrapped");
    require_eq(parse_inbound(R"({"t":"cancel_order","order_id":-1})").cancel.order_id,
               static_cast<OrderId>(0), "rejected cancel carries no order_id");
}

void rejects_non_positive_and_non_finite_prices() {
    for (const char* price : {"0", "-0.01", "-1", "-1e308"}) {
        const std::string json = std::string(
            R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":)") +
            price + "}";
        require_rejected_place(json, "missing_or_invalid_limit_price",
                               std::string("non-positive price ") + price);
    }

    // NaN / Infinity are not JSON: rapidjson refuses the document outright.
    for (const char* price : {"NaN", "Infinity", "-Infinity", "nan", "inf"}) {
        const std::string json = std::string(
            R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":)") +
            price + "}";
        auto m = parse_inbound(json);
        require_eq(m.type, ParsedMessage::Type::Unknown, std::string("non-finite price ") + price);
        require_eq(m.parse_error, std::string("invalid_json_or_missing_t"),
                   std::string("non-finite price reason ") + price);
    }

    // A finite-but-absurd price passes the parser; bounds are a risk-layer concern.
    auto huge = parse_inbound(
        R"({"t":"place_order","symbol":"BTC","side":"buy","type":"limit","quantity":5,"limit_price":1e308})");
    require(huge.parse_error.empty(), "1e308 is a finite double and parses");
    require(std::isfinite(huge.place.limit_price) && huge.place.limit_price > 0.0,
            "huge price stays finite and positive");
}

void rejects_zero_order_id_on_cancel() {
    require_rejected(R"({"t":"cancel_order","order_id":0})", "cancel with order_id 0");
    require_eq(parse_inbound(R"({"t":"cancel_order","order_id":0})").parse_error,
               std::string("missing_order_id"), "zero order_id reason");
    require_eq(parse_inbound(R"({"t":"cancel_order","order_id":0})").cancel.order_id,
               static_cast<OrderId>(0), "zero order_id is not carried");
}

void accepts_any_channel_string_on_subscribe() {
    // Channel/symbol are not validated here â the dispatcher resolves them â
    // but they must be echoed back verbatim, with no default substitution.
    auto m = parse_inbound(R"({"t":"subscribe","channel":"not_a_channel","symbol":"NOPE","depth":2})");
    require_eq(m.type, ParsedMessage::Type::Subscribe, "unknown channel still parses");
    require(m.parse_error.empty(), "unknown channel is not a parse error");
    require_eq(m.subscribe.channel, std::string("not_a_channel"), "channel echoed verbatim");
    require_eq(m.subscribe.symbol, std::string("NOPE"), "symbol echoed verbatim");

    // Non-string channel/symbol and non-integer depth fall back to the defaults.
    auto typed = parse_inbound(R"({"t":"subscribe","channel":7,"symbol":null,"depth":"5"})");
    require_eq(typed.type, ParsedMessage::Type::Subscribe, "subscribe with bad field types");
    require(typed.subscribe.channel.empty(), "non-string channel yields empty");
    require(typed.subscribe.symbol.empty(), "non-string symbol yields empty");
    require_eq(typed.subscribe.depth, 10, "non-integer depth falls back to the default");

    auto unsub = parse_inbound(R"({"t":"unsubscribe","channel":[1],"symbol":2})");
    require_eq(unsub.type, ParsedMessage::Type::Unsubscribe, "unsubscribe with bad field types");
    require(unsub.unsubscribe.channel.empty(), "non-string unsubscribe channel yields empty");
    require(unsub.unsubscribe.symbol.empty(), "non-string unsubscribe symbol yields empty");
}

void carries_long_and_escaped_strings_without_truncation() {
    const std::string long_id(64 * 1024, 'A');
    auto hello = parse_inbound(R"({"t":"hello","client_id":")" + long_id + R"("})");
    require_eq(hello.type, ParsedMessage::Type::Hello, "long client_id parses");
    require_eq(hello.hello.client_id.size(), long_id.size(), "long client_id is not truncated");

    const std::string long_sym(32 * 1024, 'S');
    const std::string long_coid(32 * 1024, 'C');
    auto place = parse_inbound(R"({"t":"place_order","client_order_id":")" + long_coid +
                               R"(","symbol":")" + long_sym +
                               R"(","side":"buy","type":"limit","quantity":1,"limit_price":1})");
    require(place.parse_error.empty(), "long symbol/client_order_id parse");
    require_eq(place.place.symbol.size(), long_sym.size(), "long symbol is not truncated");
    require_eq(place.place.client_order_id.size(), long_coid.size(), "long client_order_id intact");

    // JSON escapes decode to their raw bytes â this is the string that must be
    // re-escaped on the way out.
    auto esc = parse_inbound(R"({"t":"hello","client_id":"a\"b\\c\nde"})");
    require_eq(esc.hello.client_id, std::string("a\"b\\c\nde"), "escapes decode to raw bytes");
}

// ---- outbound: JSON-injection safety --------------------------------------

void escapes_hostile_strings_in_welcome_and_error() {
    const std::string welcome = encode_welcome(kHostile, 1700000000000ULL);
    auto wdoc = reparse(welcome, "welcome");
    require_eq(field(wdoc, "t", "welcome"), std::string("welcome"), "welcome type");
    require_eq(field(wdoc, "user_id", "welcome"), std::string(kHostile),
               "hostile user_id round-trips exactly");
    require(wdoc["server_time"].IsUint64() && wdoc["server_time"].GetUint64() == 1700000000000ULL,
            "welcome server_time");
    require(welcome.find("\n") == std::string::npos, "raw newline never reaches the frame");
    require(welcome.find("\x01") == std::string::npos, "raw control byte never reaches the frame");

    // The classic break-out attempt: a user_id that tries to close the string
    // and append its own key must land inside the value, not beside it.
    const char* breakout = R"(x","admin":true,"z":")";
    auto bdoc = reparse(encode_welcome(breakout, 0), "breakout welcome");
    require_eq(field(bdoc, "user_id", "breakout"), std::string(breakout), "breakout stays one value");
    require(!bdoc.HasMember("admin"), "no injected key appears in the frame");
    require_eq(bdoc.MemberCount(), static_cast<rapidjson::SizeType>(3), "welcome has exactly 3 keys");

    const std::string err = encode_error(kHostile, kHostile);
    auto edoc = reparse(err, "error");
    require_eq(field(edoc, "code", "error"), std::string(kHostile), "hostile error code escaped");
    require_eq(field(edoc, "message", "error"), std::string(kHostile), "hostile error message escaped");

    auto pong = reparse(encode_pong(42), "pong");
    require_eq(field(pong, "t", "pong"), std::string("pong"), "pong type");
    require(pong["ts"].GetUint64() == 42ULL, "pong ts");
}

void escapes_hostile_strings_in_execution_reports() {
    // symbol comes from config, client_order_id straight from the client, and
    // both are echoed into frames the client's counterparties may see.
    SymbolRegistry reg = registry(kHostile);
    ExecutionReport er;
    er.kind = ExecutionReport::Kind::Reject;
    er.order_id = 7;
    er.symbol = 1;
    er.client_order_id = kHostile;
    er.reason = kHostile;
    er.side = OrderSide::Sell;
    er.status = OrderStatus::Rejected;
    er.ts = 99;

    auto doc = reparse(encode_execution_report(er, reg), "reject report");
    require_eq(field(doc, "t", "reject"), std::string("order_reject"), "reject frame type");
    require_eq(field(doc, "client_order_id", "reject"), std::string(kHostile),
               "hostile client_order_id escaped");
    require_eq(field(doc, "symbol", "reject"), std::string(kHostile), "hostile symbol escaped");
    require_eq(field(doc, "reason", "reject"), std::string(kHostile), "hostile reason escaped");
    require_eq(field(doc, "side", "reject"), std::string("Sell"), "side name");
    require_eq(field(doc, "status", "reject"), std::string("Rejected"), "status name");
    require(doc["order_id"].GetUint64() == 7ULL, "order_id");

    ExecutionReport fill = er;
    fill.kind = ExecutionReport::Kind::Fill;
    fill.status = OrderStatus::PartiallyFilled;
    fill.last_price = 101.25;
    fill.last_quantity = 4;
    fill.remaining = 6;
    fill.total_filled = 4;
    fill.avg_price = 101.25;
    fill.trade_id = 55;
    auto fdoc = reparse(encode_execution_report(fill, reg), "fill report");
    require_eq(field(fdoc, "t", "fill"), std::string("order_fill"), "fill frame type");
    require_price(fdoc["price"].GetDouble(), 101.25, "fill price");
    require(fdoc["quantity"].GetUint64() == 4ULL, "fill quantity");
    require(fdoc["remaining"].GetUint64() == 6ULL, "fill remaining");
    require(fdoc["total_filled"].GetUint64() == 4ULL, "fill total_filled");
    require(fdoc["trade_id"].GetUint64() == 55ULL, "fill trade_id");
    require(!fdoc.HasMember("reason"), "fills carry no reason");

    ExecutionReport ack = er;
    ack.kind = ExecutionReport::Kind::Ack;
    ack.client_order_id.clear();
    auto adoc = reparse(encode_execution_report(ack, reg), "ack report");
    require_eq(field(adoc, "t", "ack"), std::string("order_ack"), "ack frame type");
    require(!adoc.HasMember("client_order_id"), "empty client_order_id is omitted");
    require(!adoc.HasMember("price"), "acks carry no fill fields");

    // A symbol the registry does not know is dropped, not emitted as garbage.
    ExecutionReport unknown = er;
    unknown.symbol = 4242;
    auto udoc = reparse(encode_execution_report(unknown, reg), "unknown symbol report");
    require(!udoc.HasMember("symbol"), "unresolvable symbol id is omitted");

    ExecutionReport cancel = er;
    cancel.kind = ExecutionReport::Kind::CancelAck;
    cancel.status = OrderStatus::Cancelled;
    auto cdoc = reparse(encode_execution_report(cancel, reg), "cancel ack");
    require_eq(field(cdoc, "t", "cancel"), std::string("cancel_ack"), "cancel_ack frame type");
    require_eq(field(cdoc, "reason", "cancel"), std::string(kHostile), "cancel reason escaped");
}

void escapes_hostile_symbols_in_market_data_frames() {
    SymbolRegistry reg = registry(kHostile);

    TradePrint tp;
    tp.trade_id = 3;
    tp.symbol = 1;
    tp.price = 99.5;
    tp.quantity = 12;
    tp.taker_side = OrderSide::Sell;
    tp.ts = 8;
    auto tdoc = reparse(encode_trade(tp, reg), "trade");
    require_eq(field(tdoc, "t", "trade"), std::string("trade"), "trade frame type");
    require_eq(field(tdoc, "symbol", "trade"), std::string(kHostile), "hostile symbol escaped in trade");
    require_eq(field(tdoc, "taker_side", "trade"), std::string("Sell"), "taker side");
    require_price(tdoc["price"].GetDouble(), 99.5, "trade price");
    require(tdoc["quantity"].GetUint64() == 12ULL, "trade quantity");

    BookDelta d;
    d.symbol = 1;
    d.seq = 17;
    d.ts = 21;
    d.bid_changes = {{99.0, 5}, {98.0, 0}};
    d.ask_changes = {{101.0, 7}};
    auto ddoc = reparse(encode_book_delta(d, reg), "book delta");
    require_eq(field(ddoc, "t", "delta"), std::string("book_delta"), "delta frame type");
    require_eq(field(ddoc, "symbol", "delta"), std::string(kHostile), "hostile symbol escaped in delta");
    require(ddoc["seq"].GetUint64() == 17ULL, "delta seq");
    require(ddoc["bids"].IsArray() && ddoc["bids"].Size() == 2, "two bid changes");
    require_price(ddoc["bids"][0][0].GetDouble(), 99.0, "bid change price");
    require(ddoc["bids"][0][1].GetUint64() == 5ULL, "bid change qty");
    require(ddoc["bids"][1][1].GetUint64() == 0ULL, "qty 0 encodes a level removal");
    require(ddoc["asks"].IsArray() && ddoc["asks"].Size() == 1, "one ask change");

    auto sdoc = reparse(encode_book_snapshot_from_delta(d, reg), "snapshot from delta");
    require_eq(field(sdoc, "t", "snapshot"), std::string("book"), "snapshot frame type");
    require(sdoc["snapshot"].IsBool() && sdoc["snapshot"].GetBool(), "snapshot flag");
    require_eq(field(sdoc, "symbol", "snapshot"), std::string(kHostile), "hostile symbol escaped");

    BookSnapshotEvent s;
    s.symbol = 1;
    s.seq = 4;
    s.ts = 5;
    s.bids = {{100.0, 1}};
    auto bdoc = reparse(encode_book_snapshot(s, reg), "book snapshot");
    require_eq(field(bdoc, "t", "book"), std::string("book"), "book frame type");
    require(bdoc["asks"].IsArray() && bdoc["asks"].Size() == 0, "empty side encodes as []");
    require(bdoc["seq"].GetUint64() == 4ULL, "snapshot seq");

    // An unknown symbol id must not emit a dangling "symbol" key in any frame.
    SymbolRegistry other = registry("SAFE");
    TradePrint orphan = tp;
    orphan.symbol = 77;
    require(!reparse(encode_trade(orphan, other), "orphan trade").HasMember("symbol"),
            "trade omits unresolvable symbol");
}

// A frame built entirely from hostile strings must still be a single, valid,
// fully-decodable JSON object â the property the WS broadcast path depends on.
void keeps_frames_valid_json_under_every_control_byte() {
    std::string all_controls;
    for (int c = 1; c < 32; ++c) all_controls += static_cast<char>(c);
    all_controls += "\"\\/";

    SymbolRegistry reg = registry(all_controls);
    auto wdoc = reparse(encode_welcome(all_controls, 0), "all-controls welcome");
    require_eq(field(wdoc, "user_id", "all-controls"), all_controls,
               "every control byte round-trips through welcome");

    auto edoc = reparse(encode_error(all_controls, all_controls), "all-controls error");
    require_eq(field(edoc, "message", "all-controls"), all_controls,
               "every control byte round-trips through error");

    ExecutionReport er;
    er.kind = ExecutionReport::Kind::Reject;
    er.symbol = 1;
    er.client_order_id = all_controls;
    er.reason = all_controls;
    const std::string frame = encode_execution_report(er, reg);
    auto rdoc = reparse(frame, "all-controls report");
    require_eq(field(rdoc, "client_order_id", "all-controls"), all_controls,
               "every control byte round-trips through the execution report");
    for (int c = 1; c < 32; ++c) {
        require(frame.find(static_cast<char>(c)) == std::string::npos,
                "no raw control byte survives into the frame");
    }
}

struct TestCase {
    const char* name;
    void (*run)();
};

const std::vector<TestCase>& test_cases() {
    static const std::vector<TestCase> cases = {
        {"parses_hello_and_ping", parses_hello_and_ping},
        {"parses_limit_place_order", parses_limit_place_order},
        {"parses_market_place_order_without_price", parses_market_place_order_without_price},
        {"parses_cancel_order", parses_cancel_order},
        {"parses_subscribe_and_unsubscribe", parses_subscribe_and_unsubscribe},
        {"rejects_malformed_json", rejects_malformed_json},
        {"rejects_non_object_toplevel", rejects_non_object_toplevel},
        {"rejects_deeply_nested_payloads", rejects_deeply_nested_payloads},
        {"rejects_missing_or_untyped_t", rejects_missing_or_untyped_t},
        {"rejects_unknown_message_type", rejects_unknown_message_type},
        {"rejects_place_order_missing_required_fields",
         rejects_place_order_missing_required_fields},
        {"rejects_place_order_with_wrong_field_types", rejects_place_order_with_wrong_field_types},
        {"rejects_unknown_enum_spellings", rejects_unknown_enum_spellings},
        {"rejects_zero_and_out_of_range_quantities", rejects_zero_and_out_of_range_quantities},
        {"rejects_non_positive_and_non_finite_prices", rejects_non_positive_and_non_finite_prices},
        {"rejects_zero_order_id_on_cancel", rejects_zero_order_id_on_cancel},
        {"accepts_any_channel_string_on_subscribe", accepts_any_channel_string_on_subscribe},
        {"carries_long_and_escaped_strings_without_truncation",
         carries_long_and_escaped_strings_without_truncation},
        {"escapes_hostile_strings_in_welcome_and_error",
         escapes_hostile_strings_in_welcome_and_error},
        {"escapes_hostile_strings_in_execution_reports",
         escapes_hostile_strings_in_execution_reports},
        {"escapes_hostile_symbols_in_market_data_frames",
         escapes_hostile_symbols_in_market_data_frames},
        {"keeps_frames_valid_json_under_every_control_byte",
         keeps_frames_valid_json_under_every_control_byte},
    };
    return cases;
}

}  // namespace

int main(int argc, char** argv) {
    const auto& cases = test_cases();
    if (argc == 1) {
        for (const auto& test : cases) test.run();
        std::cout << "protocol_tests passed (" << cases.size() << " cases)\n";
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

    std::cerr << "Unknown protocol test case: " << requested << "\nAvailable cases:\n";
    for (const auto& test : cases) std::cerr << "  " << test.name << "\n";
    return 2;
}
