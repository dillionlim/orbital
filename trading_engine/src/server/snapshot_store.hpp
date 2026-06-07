#pragma once
#include <memory>
#include <mutex>
#include <unordered_map>

#include "engine/event_bus.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

// Reconstructs the latest top-N L2 per symbol from the BookDelta stream and
// caches it as a BookSnapshotEvent. Used by the REST /orderbook handler and
// by the WS dispatcher to seed new `book` subscribers with a starting state
// + seq before they begin applying deltas.
class SnapshotStore {
public:
    SnapshotStore() = default;
    ~SnapshotStore();

    void start(EventBus& bus);
    void stop();

    [[nodiscard]] std::shared_ptr<const BookSnapshotEvent> get(SymbolId sym) const;

private:
    void on_event(const OutboundEvent& ev);
    void apply(const BookDelta& d);

    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;

    mutable std::mutex mu_;
    std::unordered_map<SymbolId, std::shared_ptr<const BookSnapshotEvent>> by_sym_;
};

}
