#pragma once
#include <concepts>

namespace TradingSystem {

// Anything we put into SPSCQueue / MPSCQueue must be cheap to move; copies are
// never made on the hot path. `std::movable` is move-constructible AND
// move-assignable AND swappable — exactly what try_push / try_pop need.
template <typename T>
concept QueueValue = std::movable<T>;

}  // namespace TradingSystem
