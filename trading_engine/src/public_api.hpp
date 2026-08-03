#pragma once

#include "common/types.hpp"

// Order enums shared by the book, the matching engine, and the wire protocol.
// Kept in their own header (rather than common/types.hpp) because the wire
// spellings in server/protocol.cpp are derived from these names directly — see
// side_name() / type_name() / status_name() there.
//
// Only values the engine can actually produce are listed. Adding one here means
// adding a case to the corresponding switch in protocol.cpp, and (for OrderType)
// teaching parse_type() to accept it.
namespace Bubbles {

enum class OrderSide {
    Buy,
    Sell
};

// The engine matches these two only; parse_type() rejects anything else.
enum class OrderType {
    Market,  // execute immediately against the resting book
    Limit    // rest at limit_price (or better) until filled or cancelled
};

enum class OrderStatus {
    Pending,          // accepted, resting, no fills yet
    PartiallyFilled,
    Filled,
    Cancelled,
    Rejected
};

} // namespace Bubbles
