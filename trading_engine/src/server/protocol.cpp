#include "server/protocol.hpp"

#include "rapidjson/document.h"
#include "rapidjson/stringbuffer.h"
#include "rapidjson/writer.h"

namespace TradingSystem {

const char* side_name(OrderSide s) {
    return s == OrderSide::Buy ? "Buy" : "Sell";
}
const char* type_name(OrderType t) {
    switch (t) {
        case OrderType::Market: return "Market";
        case OrderType::Limit: return "Limit";
        case OrderType::Stop: return "Stop";
        case OrderType::StopLimit: return "StopLimit";
    }
    return "Unknown";
}
const char* status_name(OrderStatus s) {
    switch (s) {
        case OrderStatus::Pending: return "Pending";
        case OrderStatus::PartiallyFilled: return "PartiallyFilled";
        case OrderStatus::Filled: return "Filled";
        case OrderStatus::Cancelled: return "Cancelled";
        case OrderStatus::Rejected: return "Rejected";
        case OrderStatus::Expired: return "Expired";
    }
    return "Unknown";
}

bool parse_side(std::string_view s, OrderSide& out) {
    if (s == "Buy" || s == "buy" || s == "BUY") { out = OrderSide::Buy; return true; }
    if (s == "Sell" || s == "sell" || s == "SELL") { out = OrderSide::Sell; return true; }
    return false;
}
bool parse_type(std::string_view s, OrderType& out) {
    if (s == "Limit" || s == "limit" || s == "LIMIT") { out = OrderType::Limit; return true; }
    if (s == "Market" || s == "market" || s == "MARKET") { out = OrderType::Market; return true; }
    return false;
}

ParsedMessage parse_inbound(std::string_view json) {
    ParsedMessage m;
    rapidjson::Document doc;
    doc.Parse(json.data(), json.size());
    if (doc.HasParseError() || !doc.IsObject() || !doc.HasMember("t") || !doc["t"].IsString()) {
        m.parse_error = "invalid_json_or_missing_t";
        return m;
    }
    const std::string t = doc["t"].GetString();

    auto get_str = [&](const char* k, std::string& out) -> bool {
        if (doc.HasMember(k) && doc[k].IsString()) { out = doc[k].GetString(); return true; }
        return false;
    };
    auto get_uint = [&](const char* k, uint64_t& out) -> bool {
        if (doc.HasMember(k) && doc[k].IsUint64()) { out = doc[k].GetUint64(); return true; }
        if (doc.HasMember(k) && doc[k].IsInt64()) { out = static_cast<uint64_t>(doc[k].GetInt64()); return true; }
        return false;
    };
    auto get_dbl = [&](const char* k, double& out) -> bool {
        if (doc.HasMember(k) && doc[k].IsNumber()) { out = doc[k].GetDouble(); return true; }
        return false;
    };

    if (t == "hello") {
        m.type = ParsedMessage::Type::Hello;
        get_str("client_id", m.hello.client_id);
        return m;
    }
    if (t == "ping") { m.type = ParsedMessage::Type::Ping; return m; }
    if (t == "place_order") {
        m.type = ParsedMessage::Type::Place;
        get_str("client_order_id", m.place.client_order_id);
        if (!get_str("symbol", m.place.symbol)) { m.parse_error = "missing_symbol"; return m; }
        std::string side, type;
        if (!get_str("side", side) || !parse_side(side, m.place.side)) {
            m.parse_error = "missing_or_invalid_side"; return m;
        }
        if (!get_str("type", type) || !parse_type(type, m.place.type)) {
            m.parse_error = "missing_or_invalid_type"; return m;
        }
        uint64_t qty = 0;
        if (!get_uint("quantity", qty) || qty == 0) {
            m.parse_error = "missing_or_invalid_quantity"; return m;
        }
        m.place.quantity = qty;
        if (m.place.type == OrderType::Limit) {
            double lp = 0;
            if (!get_dbl("limit_price", lp) || lp <= 0) {
                m.parse_error = "missing_or_invalid_limit_price"; return m;
            }
            m.place.limit_price = lp;
        }
        return m;
    }
    if (t == "cancel_order") {
        m.type = ParsedMessage::Type::Cancel;
        uint64_t id = 0;
        if (!get_uint("order_id", id) || id == 0) {
            m.parse_error = "missing_order_id"; return m;
        }
        m.cancel.order_id = id;
        return m;
    }
    if (t == "subscribe") {
        m.type = ParsedMessage::Type::Subscribe;
        get_str("channel", m.subscribe.channel);
        get_str("symbol", m.subscribe.symbol);
        uint64_t d = 10; get_uint("depth", d);
        m.subscribe.depth = static_cast<int>(d);
        return m;
    }
    if (t == "unsubscribe") {
        m.type = ParsedMessage::Type::Unsubscribe;
        get_str("channel", m.unsubscribe.channel);
        get_str("symbol", m.unsubscribe.symbol);
        return m;
    }
    m.parse_error = "unknown_type";
    return m;
}

namespace {

using rapidjson::StringBuffer;
using rapidjson::Writer;

std::string finish(StringBuffer& buf) { return std::string(buf.GetString(), buf.GetSize()); }

}  // namespace

std::string encode_welcome(std::string_view user_id, Timestamp server_time) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("welcome");
    w.Key("user_id"); w.String(user_id.data(), static_cast<rapidjson::SizeType>(user_id.size()));
    w.Key("server_time"); w.Uint64(server_time);
    w.EndObject();
    return finish(buf);
}

std::string encode_error(std::string_view code, std::string_view message) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("error");
    w.Key("code"); w.String(code.data(), static_cast<rapidjson::SizeType>(code.size()));
    w.Key("message"); w.String(message.data(), static_cast<rapidjson::SizeType>(message.size()));
    w.EndObject();
    return finish(buf);
}

std::string encode_pong(Timestamp ts) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("pong");
    w.Key("ts"); w.Uint64(ts);
    w.EndObject();
    return finish(buf);
}

std::string encode_execution_report(const ExecutionReport& er, const SymbolRegistry& reg) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    switch (er.kind) {
        case ExecutionReport::Kind::Ack: w.Key("t"); w.String("order_ack"); break;
        case ExecutionReport::Kind::Reject: w.Key("t"); w.String("order_reject"); break;
        case ExecutionReport::Kind::Fill: w.Key("t"); w.String("order_fill"); break;
        case ExecutionReport::Kind::CancelAck: w.Key("t"); w.String("cancel_ack"); break;
    }
    w.Key("order_id"); w.Uint64(er.order_id);
    if (!er.client_order_id.empty()) {
        w.Key("client_order_id"); w.String(er.client_order_id.c_str());
    }
    auto sym = reg.name_for(er.symbol);
    if (sym) { w.Key("symbol"); w.String(sym->c_str()); }
    w.Key("side"); w.String(side_name(er.side));
    w.Key("status"); w.String(status_name(er.status));
    if (er.kind == ExecutionReport::Kind::Fill) {
        w.Key("price"); w.Double(er.last_price);
        w.Key("quantity"); w.Uint64(er.last_quantity);
        w.Key("remaining"); w.Uint64(er.remaining);
        w.Key("total_filled"); w.Uint64(er.total_filled);
        w.Key("avg_price"); w.Double(er.avg_price);
        w.Key("trade_id"); w.Uint64(er.trade_id);
    }
    if (er.kind == ExecutionReport::Kind::Reject && !er.reason.empty()) {
        w.Key("reason"); w.String(er.reason.c_str());
    }
    if (er.kind == ExecutionReport::Kind::CancelAck && !er.reason.empty()) {
        w.Key("reason"); w.String(er.reason.c_str());
    }
    w.Key("ts"); w.Uint64(er.ts);
    w.EndObject();
    return finish(buf);
}

std::string encode_trade(const TradePrint& tp, const SymbolRegistry& reg) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("trade");
    auto sym = reg.name_for(tp.symbol);
    if (sym) { w.Key("symbol"); w.String(sym->c_str()); }
    w.Key("trade_id"); w.Uint64(tp.trade_id);
    w.Key("price"); w.Double(tp.price);
    w.Key("quantity"); w.Uint64(tp.quantity);
    w.Key("taker_side"); w.String(side_name(tp.taker_side));
    w.Key("ts"); w.Uint64(tp.ts);
    w.EndObject();
    return finish(buf);
}

namespace {

void write_levels(rapidjson::Writer<StringBuffer>& w, const std::vector<BookLevel>& levels) {
    w.StartArray();
    for (const auto& l : levels) {
        w.StartArray(); w.Double(l.price); w.Uint64(l.qty); w.EndArray();
    }
    w.EndArray();
}

}  // namespace

std::string encode_book_snapshot(const BookSnapshotEvent& s, const SymbolRegistry& reg) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("book");
    auto sym = reg.name_for(s.symbol);
    if (sym) { w.Key("symbol"); w.String(sym->c_str()); }
    w.Key("snapshot"); w.Bool(true);
    w.Key("seq"); w.Uint64(s.seq);
    w.Key("ts"); w.Uint64(s.ts);
    w.Key("bids"); write_levels(w, s.bids);
    w.Key("asks"); write_levels(w, s.asks);
    w.EndObject();
    return finish(buf);
}

std::string encode_book_snapshot_from_delta(const BookDelta& d, const SymbolRegistry& reg) {
    // Same wire shape as encode_book_snapshot, but sourced directly from the
    // initial-snapshot delta the matching engine emitted (no round-trip
    // through SnapshotStore needed when broadcasting to existing subs).
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("book");
    auto sym = reg.name_for(d.symbol);
    if (sym) { w.Key("symbol"); w.String(sym->c_str()); }
    w.Key("snapshot"); w.Bool(true);
    w.Key("seq"); w.Uint64(d.seq);
    w.Key("ts"); w.Uint64(d.ts);
    w.Key("bids"); write_levels(w, d.bid_changes);
    w.Key("asks"); write_levels(w, d.ask_changes);
    w.EndObject();
    return finish(buf);
}

std::string encode_book_delta(const BookDelta& d, const SymbolRegistry& reg) {
    StringBuffer buf;
    Writer<StringBuffer> w(buf);
    w.StartObject();
    w.Key("t"); w.String("book_delta");
    auto sym = reg.name_for(d.symbol);
    if (sym) { w.Key("symbol"); w.String(sym->c_str()); }
    w.Key("seq"); w.Uint64(d.seq);
    w.Key("ts"); w.Uint64(d.ts);
    w.Key("bids"); write_levels(w, d.bid_changes);
    w.Key("asks"); write_levels(w, d.ask_changes);
    w.EndObject();
    return finish(buf);
}

}  // namespace TradingSystem
