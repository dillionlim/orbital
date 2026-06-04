#include "persistence/sqlite_store.hpp"

#include <cstring>
#include <sstream>
#include <utility>

#include "common/log.hpp"
#include "common/time.hpp"
#include "server/protocol.hpp"

namespace TradingSystem {

namespace {

const char* kSchema = R"SQL(
CREATE TABLE IF NOT EXISTS orders (
  order_id        INTEGER PRIMARY KEY,
  client_order_id TEXT,
  user_id         TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,
  type            TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  limit_price     REAL,
  status          TEXT NOT NULL,
  filled_qty      INTEGER NOT NULL DEFAULT 0,
  avg_price       REAL NOT NULL DEFAULT 0,
  reason          TEXT,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, symbol);

CREATE TABLE IF NOT EXISTS trades (
  trade_id        INTEGER PRIMARY KEY,
  symbol          TEXT NOT NULL,
  price           REAL NOT NULL,
  quantity        INTEGER NOT NULL,
  taker_order_id  INTEGER NOT NULL,
  maker_order_id  INTEGER NOT NULL,
  taker_side      TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades(symbol, ts_ms DESC);

CREATE TABLE IF NOT EXISTS server_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
)SQL";

}  // namespace

SqliteStore::SqliteStore(std::string path, std::shared_ptr<SymbolRegistry> registry)
    : path_(std::move(path)), registry_(std::move(registry)) {}

SqliteStore::~SqliteStore() { stop(); if (db_) ::sqlite3_close(db_); }

bool SqliteStore::open() {
    int rc = ::sqlite3_open(path_.c_str(), &db_);
    if (rc != SQLITE_OK) {
        LOG_ERROR("sqlite_store: open failed: " << sqlite3_errmsg(db_));
        return false;
    }
    if (!exec("PRAGMA journal_mode=WAL")) return false;
    if (!exec("PRAGMA synchronous=NORMAL")) return false;
    char* err = nullptr;
    rc = ::sqlite3_exec(db_, kSchema, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        LOG_ERROR("sqlite_store: schema failed: " << (err ? err : "?"));
        ::sqlite3_free(err);
        return false;
    }
    LOG_INFO("sqlite_store: opened " << path_);
    return true;
}

bool SqliteStore::exec(const char* sql) {
    char* err = nullptr;
    int rc = ::sqlite3_exec(db_, sql, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        LOG_ERROR("sqlite_store: exec failed (" << sql << "): " << (err ? err : "?"));
        ::sqlite3_free(err);
        return false;
    }
    return true;
}

OrderId SqliteStore::rehydrate_and_get_next_order_id() {
    // Cancel stale Pending / PartiallyFilled rows.
    const char* upd =
        "UPDATE orders SET status='Cancelled', reason='server_restart', updated_ms=? "
        "WHERE status IN ('Pending','PartiallyFilled')";
    sqlite3_stmt* stmt = nullptr;
    if (::sqlite3_prepare_v2(db_, upd, -1, &stmt, nullptr) == SQLITE_OK) {
        ::sqlite3_bind_int64(stmt, 1, static_cast<sqlite3_int64>(now_ms()));
        ::sqlite3_step(stmt);
        ::sqlite3_finalize(stmt);
    }

    // Read max(order_id) from orders + persisted next.
    OrderId next = 1;
    {
        sqlite3_stmt* s = nullptr;
        if (::sqlite3_prepare_v2(db_, "SELECT IFNULL(MAX(order_id),0) FROM orders", -1, &s,
                                 nullptr) == SQLITE_OK) {
            if (::sqlite3_step(s) == SQLITE_ROW) {
                next = static_cast<OrderId>(::sqlite3_column_int64(s, 0)) + 1;
            }
            ::sqlite3_finalize(s);
        }
    }
    {
        sqlite3_stmt* s = nullptr;
        if (::sqlite3_prepare_v2(db_, "SELECT v FROM server_state WHERE k='next_order_id'", -1, &s,
                                 nullptr) == SQLITE_OK) {
            if (::sqlite3_step(s) == SQLITE_ROW) {
                std::string v = reinterpret_cast<const char*>(::sqlite3_column_text(s, 0));
                try {
                    OrderId stored = static_cast<OrderId>(std::stoull(v));
                    if (stored > next) next = stored;
                } catch (...) {}
            }
            ::sqlite3_finalize(s);
        }
    }
    LOG_INFO("sqlite_store: rehydrated; next_order_id=" << next);
    return next;
}

void SqliteStore::persist_next_order_id(OrderId next) {
    sqlite3_stmt* s = nullptr;
    if (::sqlite3_prepare_v2(
            db_,
            "INSERT INTO server_state(k,v) VALUES('next_order_id',?) "
            "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            -1, &s, nullptr) == SQLITE_OK) {
        std::string v = std::to_string(next);
        ::sqlite3_bind_text(s, 1, v.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_step(s);
        ::sqlite3_finalize(s);
    }
}

void SqliteStore::start(EventBus& bus) {
    bus_ = &bus;
    sub_id_ = bus.subscribe([this](const OutboundEvent& ev) {
        std::visit([&](auto&& e) {
            using T = std::decay_t<decltype(e)>;
            if constexpr (std::is_same_v<T, ExecutionReport>) {
                if (e.kind == ExecutionReport::Kind::Reject && e.order_id == 0) return;
                OrderRecord r;
                r.order_id = e.order_id;
                r.client_order_id = e.client_order_id;
                r.user_id = e.user_id;
                auto sn = registry_->name_for(e.symbol);
                r.symbol_name = sn ? *sn : "";
                r.side = e.side;
                r.type = e.type;
                r.quantity = e.remaining + e.total_filled;
                r.limit_price = e.limit_price;
                r.status = e.status;
                r.filled_qty = e.total_filled;
                r.avg_price = e.avg_price;
                r.ts = e.ts ? e.ts : now_ms();
                r.reason = e.reason;
                enqueue(std::move(r));
            } else if constexpr (std::is_same_v<T, TradePrint>) {
                TradeRecord r;
                r.trade_id = e.trade_id;
                r.symbol = e.symbol;
                auto sn = registry_->name_for(e.symbol);
                r.symbol_name = sn ? *sn : "";
                r.price = e.price;
                r.quantity = e.quantity;
                r.taker_order_id = e.taker_order_id;
                r.maker_order_id = e.maker_order_id;
                r.taker_side = e.taker_side;
                r.ts = e.ts;
                enqueue(std::move(r));
            }
        }, ev);
    });
    running_ = true;
    writer_ = std::thread([this] { writer_loop(); });
}

void SqliteStore::stop() {
    if (bus_ && sub_id_) {
        bus_->unsubscribe(sub_id_);
        sub_id_ = 0;
        bus_ = nullptr;
    }
    if (running_.exchange(false)) {
        q_.close();
        if (writer_.joinable()) writer_.join();
    }
}

void SqliteStore::enqueue(PersistRecord r) {
    if (!running_.load()) return;
    q_.push(std::move(r));
}

void SqliteStore::writer_loop() {
    sqlite3_stmt* up_order = nullptr;
    sqlite3_stmt* in_trade = nullptr;
    if (::sqlite3_prepare_v2(
            db_,
            "INSERT INTO orders (order_id, client_order_id, user_id, symbol, side, type, "
            " quantity, limit_price, status, filled_qty, avg_price, reason, created_ms, updated_ms) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(order_id) DO UPDATE SET "
            "  status=excluded.status, filled_qty=excluded.filled_qty, "
            "  avg_price=excluded.avg_price, reason=excluded.reason, "
            "  updated_ms=excluded.updated_ms",
            -1, &up_order, nullptr) != SQLITE_OK) {
        LOG_ERROR("sqlite_store: prepare(up_order) failed: " << sqlite3_errmsg(db_));
        return;
    }
    if (::sqlite3_prepare_v2(
            db_,
            "INSERT OR IGNORE INTO trades (trade_id, symbol, price, quantity, taker_order_id, "
            " maker_order_id, taker_side, ts_ms) VALUES (?,?,?,?,?,?,?,?)",
            -1, &in_trade, nullptr) != SQLITE_OK) {
        LOG_ERROR("sqlite_store: prepare(in_trade) failed: " << sqlite3_errmsg(db_));
        ::sqlite3_finalize(up_order);
        return;
    }

    bool in_tx = false;
    int batch = 0;
    auto last_flush = std::chrono::steady_clock::now();

    auto begin = [&] {
        if (!in_tx) { exec("BEGIN"); in_tx = true; }
    };
    auto commit = [&] {
        if (in_tx) { exec("COMMIT"); in_tx = false; batch = 0; last_flush = std::chrono::steady_clock::now(); }
    };

    auto write_order = [&](const OrderRecord& r) {
        ::sqlite3_reset(up_order);
        ::sqlite3_clear_bindings(up_order);
        ::sqlite3_bind_int64(up_order, 1, static_cast<sqlite3_int64>(r.order_id));
        if (r.client_order_id.empty()) ::sqlite3_bind_null(up_order, 2);
        else ::sqlite3_bind_text(up_order, 2, r.client_order_id.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_bind_text(up_order, 3, r.user_id.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_bind_text(up_order, 4, r.symbol_name.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_bind_text(up_order, 5, side_name(r.side), -1, SQLITE_STATIC);
        ::sqlite3_bind_text(up_order, 6, type_name(r.type), -1, SQLITE_STATIC);
        ::sqlite3_bind_int64(up_order, 7, static_cast<sqlite3_int64>(r.quantity));
        if (r.limit_price > 0) ::sqlite3_bind_double(up_order, 8, r.limit_price);
        else ::sqlite3_bind_null(up_order, 8);
        ::sqlite3_bind_text(up_order, 9, status_name(r.status), -1, SQLITE_STATIC);
        ::sqlite3_bind_int64(up_order, 10, static_cast<sqlite3_int64>(r.filled_qty));
        ::sqlite3_bind_double(up_order, 11, r.avg_price);
        if (r.reason.empty()) ::sqlite3_bind_null(up_order, 12);
        else ::sqlite3_bind_text(up_order, 12, r.reason.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_bind_int64(up_order, 13, static_cast<sqlite3_int64>(r.ts));
        ::sqlite3_bind_int64(up_order, 14, static_cast<sqlite3_int64>(r.ts));
        if (::sqlite3_step(up_order) != SQLITE_DONE) {
            LOG_WARN("sqlite_store: insert order failed: " << sqlite3_errmsg(db_));
        }
    };

    auto write_trade = [&](const TradeRecord& r) {
        ::sqlite3_reset(in_trade);
        ::sqlite3_clear_bindings(in_trade);
        ::sqlite3_bind_int64(in_trade, 1, static_cast<sqlite3_int64>(r.trade_id));
        ::sqlite3_bind_text(in_trade, 2, r.symbol_name.c_str(), -1, SQLITE_TRANSIENT);
        ::sqlite3_bind_double(in_trade, 3, r.price);
        ::sqlite3_bind_int64(in_trade, 4, static_cast<sqlite3_int64>(r.quantity));
        ::sqlite3_bind_int64(in_trade, 5, static_cast<sqlite3_int64>(r.taker_order_id));
        ::sqlite3_bind_int64(in_trade, 6, static_cast<sqlite3_int64>(r.maker_order_id));
        ::sqlite3_bind_text(in_trade, 7, side_name(r.taker_side), -1, SQLITE_STATIC);
        ::sqlite3_bind_int64(in_trade, 8, static_cast<sqlite3_int64>(r.ts));
        if (::sqlite3_step(in_trade) != SQLITE_DONE) {
            LOG_WARN("sqlite_store: insert trade failed: " << sqlite3_errmsg(db_));
        }
    };

    PersistRecord item;
    while (running_.load()) {
        if (q_.wait_pop(item, 50)) {
            begin();
            std::visit([&](auto&& r) {
                using T = std::decay_t<decltype(r)>;
                if constexpr (std::is_same_v<T, OrderRecord>) write_order(r);
                else if constexpr (std::is_same_v<T, TradeRecord>) write_trade(r);
            }, item);
            ++batch;
            if (batch >= 50) commit();
        } else {
            // No item; commit if anything is buffered.
            if (in_tx && std::chrono::steady_clock::now() - last_flush >
                             std::chrono::milliseconds(50)) commit();
        }
    }
    // Drain remaining.
    while (q_.try_pop(item)) {
        begin();
        std::visit([&](auto&& r) {
            using T = std::decay_t<decltype(r)>;
            if constexpr (std::is_same_v<T, OrderRecord>) write_order(r);
            else if constexpr (std::is_same_v<T, TradeRecord>) write_trade(r);
        }, item);
    }
    commit();
    ::sqlite3_finalize(up_order);
    ::sqlite3_finalize(in_trade);
    LOG_INFO("sqlite_store: writer thread exited");
}

}  // namespace TradingSystem
