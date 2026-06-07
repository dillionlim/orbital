#pragma once
#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <variant>

#include <sqlite3.h>

#include "common/config.hpp"
#include "common/spsc_queue.hpp"
#include "engine/event_bus.hpp"
#include "engine/events.hpp"

namespace TradingSystem {

struct OrderRecord {
    OrderId order_id = 0;
    std::string client_order_id;
    std::string user_id;
    std::string symbol_name;
    OrderSide side = OrderSide::Buy;
    OrderType type = OrderType::Limit;
    Quantity quantity = 0;          // total intended quantity
    Price limit_price = 0.0;
    OrderStatus status = OrderStatus::Pending;
    Quantity filled_qty = 0;
    Price avg_price = 0.0;
    Timestamp ts = 0;
    std::string reason;
};

struct TradeRecord {
    uint64_t trade_id = 0;
    SymbolId symbol = 0;
    std::string symbol_name;
    Price price = 0.0;
    Quantity quantity = 0;
    OrderId taker_order_id = 0;
    OrderId maker_order_id = 0;
    OrderSide taker_side = OrderSide::Buy;
    Timestamp ts = 0;
};

// Read-side row shape used by historical-trade queries (REST /trades/historical).
// Symbol stays as the string name because callers don't have a SymbolRegistry.
struct HistoricalTrade {
    uint64_t trade_id = 0;
    std::string symbol_name;
    Price price = 0.0;
    Quantity quantity = 0;
    std::string taker_side;     // "Buy" | "Sell"
    Timestamp ts = 0;
};

using PersistRecord = std::variant<OrderRecord, TradeRecord>;

class SqliteStore {
public:
    SqliteStore(std::string path, std::shared_ptr<SymbolRegistry> registry);
    ~SqliteStore();

    // Open + create schema if needed.
    bool open();

    // On boot: mark stale Pending/PartiallyFilled as Cancelled (reason=server_restart).
    // Returns the next OrderId to assign (1 if fresh DB).
    OrderId rehydrate_and_get_next_order_id();
    void persist_next_order_id(OrderId next);

    // Subscribe to the EventBus and translate events into persisted records.
    void start(EventBus& bus);
    void stop();

    void enqueue(PersistRecord r);

    // Read historical trades from the persistent store. Used by the
    // /trades/historical REST endpoint that powers the backtester. Empty
    // symbol_filter returns trades across all symbols. Range filters in
    // milliseconds; pass 0 to skip the bound. Hard cap at 50_000 rows.
    [[nodiscard]] std::vector<HistoricalTrade> query_trades(
        std::string_view symbol_filter,
        Timestamp from_ms,
        Timestamp to_ms,
        std::size_t limit) const;

private:
    void writer_loop();
    bool exec(const char* sql);

    std::string path_;
    std::shared_ptr<SymbolRegistry> registry_;
    sqlite3* db_ = nullptr;

    EventBus* bus_ = nullptr;
    EventBus::SubscriberId sub_id_ = 0;

    MPSCQueue<PersistRecord> q_;
    std::atomic<bool> running_{false};
    std::thread writer_;
};

}
