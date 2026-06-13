#pragma once
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>

#include "common/config.hpp"
#include "engine/event_bus.hpp"
#include "engine/sequencer.hpp"
#include "server/bot_tracker.hpp"
#include "server/position_tracker.hpp"
#include "server/protocol.hpp"
#include "server/session.hpp"
#include "server/snapshot_store.hpp"
#include "server/metrics.hpp"

namespace TradingSystem {

// Glue between WS server, Sequencer, and EventBus.
//   - WS server calls on_connect/on_message/on_disconnect.
//   - Dispatcher subscribes to EventBus and routes outbound events to relevant sessions.
class Dispatcher {
public:
    Dispatcher(Sequencer& seq, EventBus& bus, SessionRegistry& sessions,
               std::shared_ptr<SymbolRegistry> registry,
               std::shared_ptr<SnapshotStore> snapshots,
               ServerMetrics& metrics,
               std::shared_ptr<BotTracker> bots,
               std::shared_ptr<PositionTracker> positions);
    ~Dispatcher();

    void start();
    void stop();

    // WS server callbacks.
    void on_connect(SessionPtr s);
    void on_message(SessionPtr s, std::string_view payload);
    void on_disconnect(SessionPtr s);

    // Called by the REST `/bots/:id/pause` handler. Cancels every resting
    // order placed by sessions matching `(user_id, client_id)` so the paused
    // bot stops having its old orders filled by the MM. Filtering by
    // user_id is mandatory: two distinct users may legitimately use the same
    // client_id, and one user's pause must not cancel another's orders.
    void cancel_orders_for_client(std::string_view user_id, std::string_view client_id);

private:
    void handle_place(SessionPtr s, const InboundPlaceOrder& p);
    void handle_cancel(SessionPtr s, const InboundCancelOrder& c);
    void handle_subscribe(SessionPtr s, const InboundSubscribe& sub);
    void handle_unsubscribe(SessionPtr s, const InboundUnsubscribe& sub);

    void on_outbound(const OutboundEvent& ev);
    void send_text(SessionPtr s, const std::string& text);

    Sequencer& seq_;
    EventBus& bus_;
    EventBus::SubscriberId sub_id_ = 0;
    SessionRegistry& sessions_;
    std::shared_ptr<SymbolRegistry> registry_;
    std::shared_ptr<SnapshotStore> snapshots_;
    ServerMetrics& metrics_;
    std::shared_ptr<BotTracker> bots_;
    std::shared_ptr<PositionTracker> positions_;

    // OrderId → SessionId for routing maker fills back to original placer.
    std::mutex order_owner_mu_;
    std::unordered_map<OrderId, SessionId> order_owner_;
};

}
