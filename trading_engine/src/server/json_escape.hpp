#pragma once
#include <string>
#include <string_view>

namespace TradingSystem {

// Escapes `s` for use inside a JSON string literal (RFC 8259 §7).
//
// The REST layer builds its responses by streaming into an ostringstream rather
// than going through rapidjson, so every value interpolated between quotes has
// to be escaped here or it can terminate the string early and corrupt the whole
// document. Several of those values come straight off the wire: the `symbol`
// query parameter, the `client_id` path segment, bot-supplied labels.
//
// Bytes >= 0x80 pass through untouched, so well-formed UTF-8 in is well-formed
// UTF-8 out. JSON does not require them to be escaped.
inline std::string json_escape(std::string_view s) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(s.size() + 8);
    for (const unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out += kHex[(c >> 4) & 0x0F];
                    out += kHex[c & 0x0F];
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

}  // namespace TradingSystem
