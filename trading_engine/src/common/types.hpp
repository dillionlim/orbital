#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <optional>
#include <functional>
#include <memory>
#include <utility>

namespace TradingSystem {
    using Price = double;
    using Quantity = uint64_t;
    using OrderId = uint64_t;
    using ClientId = uint64_t;
    using SymbolId = uint64_t;
    using Timestamp = uint64_t;
}
