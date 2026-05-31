#pragma once

#include "common/types.hpp"

namespace Bubbles {

enum class OrderSide {
    Buy,
    Sell
};

enum class OrderType {
    Market,
    Limit,
    Stop,
    StopLimit
};

enum class OrderStatus {
    Pending,
    PartiallyFilled,
    Filled,
    Cancelled,
    Rejected,
    Expired
};

struct OrderRequest {
    TradingSystem::SymbolId symbol;
    OrderSide side;
    OrderType type;
    TradingSystem::Quantity quantity;
    std::optional<TradingSystem::Price> limitPrice;
    std::optional<TradingSystem::Price> stopPrice;
    std::optional<TradingSystem::OrderId> clientOrderId;
};

struct OrderResponse {
    TradingSystem::OrderId orderId;
    OrderStatus status;
    TradingSystem::Timestamp timestamp;
    std::string message;
    TradingSystem::Quantity filledQuantity;
    TradingSystem::Price averagePrice;
};

struct MarketTick {
    TradingSystem::SymbolId symbol;
    TradingSystem::Price bid;
    TradingSystem::Price ask;
    TradingSystem::Quantity bidSize;
    TradingSystem::Quantity askSize;
    TradingSystem::Timestamp timestamp;
};

struct Candle {
    TradingSystem::SymbolId symbol;
    TradingSystem::Timestamp openTime;
    TradingSystem::Price open;
    TradingSystem::Price high;
    TradingSystem::Price low;
    TradingSystem::Price close;
    TradingSystem::Quantity volume;
    TradingSystem::Timestamp closeTime;
};

struct Position {
    TradingSystem::SymbolId symbol;
    TradingSystem::Quantity size;
    TradingSystem::Price entryPrice;
    TradingSystem::Price unrealizedPnL;
};

struct Balance {
    std::string asset;
    TradingSystem::Quantity available;
    TradingSystem::Quantity locked;
};

using OrderCallback = std::function<void(const OrderResponse& order)>;
using MarketDataCallback = std::function<void(const MarketTick& tick)>;
using ConnectionCallback = std::function<void(bool connected, const std::string& reason)>;

} // namespace Bubbles

namespace Bubbles::API {

class TradingClient {
public:
    static std::shared_ptr<TradingClient> connect(const std::string& endpoint);

    virtual ~TradingClient() = default;

    virtual Bubbles::OrderResponse placeOrder(const Bubbles::OrderRequest& request) = 0;
    virtual bool cancelOrder(TradingSystem::OrderId orderId) = 0;
    virtual std::optional<Bubbles::OrderResponse> getOrder(TradingSystem::OrderId orderId) = 0;
    virtual std::vector<Bubbles::OrderResponse> getOpenOrders(std::optional<TradingSystem::SymbolId> symbol = std::nullopt) = 0;
    virtual std::vector<Bubbles::Balance> getBalances() = 0;
    virtual std::vector<Bubbles::Position> getPositions() = 0;
    virtual int subscribeMarketData(const std::vector<TradingSystem::SymbolId>& symbols, Bubbles::MarketDataCallback callback) = 0;
    virtual void unsubscribeMarketData(int subscriptionId) = 0;
    virtual void setOrderCallback(Bubbles::OrderCallback callback) = 0;
    virtual void setConnectionCallback(Bubbles::ConnectionCallback callback) = 0;
    virtual bool isConnected() const = 0;
    virtual TradingSystem::Timestamp getServerTime() = 0;
};

class MarketDataClient {
public:
    static std::shared_ptr<MarketDataClient> connect(const std::string& endpoint);

    virtual ~MarketDataClient() = default;

    virtual std::optional<Bubbles::MarketTick> getTicker(TradingSystem::SymbolId symbol) = 0;
    virtual std::pair<std::vector<Bubbles::MarketTick>, std::vector<Bubbles::MarketTick>> 
        getOrderBook(TradingSystem::SymbolId symbol, int depth = 20) = 0;
    virtual std::vector<Bubbles::Candle> getCandles(
        TradingSystem::SymbolId symbol,
        int interval,
        TradingSystem::Timestamp startTime,
        TradingSystem::Timestamp endTime) = 0;
    virtual int subscribeTicker(const std::vector<TradingSystem::SymbolId>& symbols, 
                                  Bubbles::MarketDataCallback callback) = 0;
    virtual int subscribeOrderBook(const std::vector<TradingSystem::SymbolId>& symbols,
                                    int depth,
                                    std::function<void(TradingSystem::SymbolId, const std::vector<Bubbles::MarketTick>&, const std::vector<Bubbles::MarketTick>&)> callback) = 0;
    virtual void unsubscribe(int subscriptionId) = 0;
    virtual bool isConnected() const = 0;
};

class RESTClient {
public:
    static std::shared_ptr<RESTClient> create(const std::string& baseUrl);

    virtual ~RESTClient() = default;

    virtual std::string getExchangeInfo() = 0;
    virtual std::vector<std::string> getTradingPairs() = 0;
    virtual std::string getTrades(TradingSystem::SymbolId symbol, int limit = 100) = 0;
    virtual std::string getAggTrades(TradingSystem::SymbolId symbol, 
                                      TradingSystem::Timestamp startTime,
                                      TradingSystem::Timestamp endTime) = 0;
    virtual std::string get24hrTicker(std::optional<TradingSystem::SymbolId> symbol = std::nullopt) = 0;
};

} 