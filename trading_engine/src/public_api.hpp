#pragma once

#include "common/types.hpp"

namespace Bubbles {

/**
 * @brief Order side - buy or sell
 */
enum class OrderSide {
    Buy,  ///< Purchase order
    Sell  ///< Sell order
};

/**
 * @brief Order type - market, limit, stop, etc.
 */
enum class OrderType {
    Market, ///< Execute immediately at best available price
    Limit,  ///< Execute at specified price or better
    Stop,   ///< Trigger order when price is reached
    StopLimit ///< Limit order triggered by stop price
};

/**
 * @brief Order status
 */
enum class OrderStatus {
    Pending,    ///< Order submitted, not yet filled
    PartiallyFilled, ///< Partial execution occurred
    Filled,     ///< Fully executed
    Cancelled,  ///< Order was cancelled
    Rejected,   ///< Order rejected by exchange
    Expired     ///< Order expired
};

/**
 * @brief Order request structure
 */
struct OrderRequest {
    TradingSystem::SymbolId symbol;      ///< Trading pair symbol ID
    OrderSide side;       ///< Buy or sell
    OrderType type;       ///< Order type
    TradingSystem::Quantity quantity;    ///< Order quantity
    std::optional<TradingSystem::Price> limitPrice;   ///< Price for limit orders
    std::optional<TradingSystem::Price> stopPrice;    ///< Stop price for stop orders
    std::optional<TradingSystem::OrderId> clientOrderId; ///< Client-provided order ID
};

/**
 * @brief Order response after submission
 */
struct OrderResponse {
    TradingSystem::OrderId orderId;          ///< Server-assigned order ID
    OrderStatus status;       ///< Current order status
    TradingSystem::Timestamp timestamp;      ///< Response timestamp
    std::string message;      ///< Status message or error
    TradingSystem::Quantity filledQuantity;  ///< Total filled quantity
    TradingSystem::Price averagePrice;       ///< Average fill price
};

/**
 * @brief Market data tick
 */
struct MarketTick {
    TradingSystem::SymbolId symbol;      ///< Symbol ID
    TradingSystem::Price bid;            ///< Best bid price
    TradingSystem::Price ask;            ///< Best ask price
    TradingSystem::Quantity bidSize;     ///< Bid quantity
    TradingSystem::Quantity askSize;     ///< Ask quantity
    TradingSystem::Timestamp timestamp;  ///< Tick timestamp
};

/**
 * @brief Candlestick/kline data
 */
struct Candle {
    TradingSystem::SymbolId symbol;          ///< Symbol ID
    TradingSystem::Timestamp openTime;       ///< Candle open timestamp
    TradingSystem::Price open;               ///< Open price
    TradingSystem::Price high;               ///< High price
    TradingSystem::Price low;                ///< Low price
    TradingSystem::Price close;              ///< Close price
    TradingSystem::Quantity volume;          ///< Trading volume
    TradingSystem::Timestamp closeTime;      ///< Candle close timestamp
};

/**
 * @brief Position information
 */
struct Position {
    TradingSystem::SymbolId symbol;      ///< Symbol
    TradingSystem::Quantity size;         ///< Position size (positive = long, negative = short)
    TradingSystem::Price entryPrice;     ///< Average entry price
    TradingSystem::Price unrealizedPnL;  ///< Unrealized profit/loss
};

/**
 * @brief Account balance
 */
struct Balance {
    std::string asset;    ///< Asset symbol (e.g., "BTC", "USDT")
    TradingSystem::Quantity available;   ///< Available balance
    TradingSystem::Quantity locked;      ///< Locked balance (in orders)
};

/**
 * @brief Callback for order updates
 */
using OrderCallback = std::function<void(const OrderResponse& order)>;

/**
 * @brief Callback for market data updates
 */
using MarketDataCallback = std::function<void(const MarketTick& tick)>;

/**
 * @brief Callback for connection events
 */
using ConnectionCallback = std::function<void(bool connected, const std::string& reason)>;

} // namespace Bubbles

namespace Bubbles::API {

/**
 * @class TradingClient
 * @brief Main interface for bot developers to interact with the trading engine
 * 
 * Example usage:
 * @code
 * auto client = TradingClient::connect("ws://localhost:8080");
 * 
 * // Place an order
 * OrderRequest order{
 *     .symbol = 1,
 *     .side = OrderSide::Buy,
 *     .type = OrderType::Limit,
 *     .quantity = 100,
 *     .limitPrice = 50000.0
 * };
 * auto response = client.placeOrder(order);
 * 
 * // Subscribe to market data
 * client.subscribeMarketData({1, 2, 3}, [](const MarketTick& tick) {
 *     std::cout << tick.symbol << ": " << tick.bid << " / " << tick.ask << std::endl;
 * });
 * @endcode
 */
class TradingClient {
public:
    /**
     * @brief Connect to the trading engine
     * @param endpoint WebSocket endpoint (e.g., "ws://localhost:8080")
     * @return Shared pointer to TradingClient instance
     */
    static std::shared_ptr<TradingClient> connect(const std::string& endpoint);

    /**
     * @brief Destructor
     */
    virtual ~TradingClient() = default;

    /**
     * @brief Place a new order
     * @param request Order details
     * @return Order response with order ID and status
     */
    virtual Bubbles::OrderResponse placeOrder(const Bubbles::OrderRequest& request) = 0;

    /**
     * @brief Cancel an existing order
     * @param orderId Order ID to cancel
     * @return true if cancellation was accepted
     */
    virtual bool cancelOrder(TradingSystem::OrderId orderId) = 0;

    /**
     * @brief Get order status
     * @param orderId Order ID to query
     * @return Current order information
     */
    virtual std::optional<Bubbles::OrderResponse> getOrder(TradingSystem::OrderId orderId) = 0;

    /**
     * @brief Get open orders
     * @param symbol Optional symbol filter
     * @return List of open orders
     */
    virtual std::vector<Bubbles::OrderResponse> getOpenOrders(std::optional<TradingSystem::SymbolId> symbol = std::nullopt) = 0;

    /**
     * @brief Get account balances
     * @return List of asset balances
     */
    virtual std::vector<Bubbles::Balance> getBalances() = 0;

    /**
     * @brief Get positions
     * @return List of open positions
     */
    virtual std::vector<Bubbles::Position> getPositions() = 0;

    /**
     * @brief Subscribe to market data for symbols
     * @param symbols List of symbol IDs to subscribe
     * @param callback Callback for each tick
     * @return Subscription ID for unsubscribing
     */
    virtual int subscribeMarketData(const std::vector<TradingSystem::SymbolId>& symbols, Bubbles::MarketDataCallback callback) = 0;

    /**
     * @brief Unsubscribe from market data
     * @param subscriptionId Subscription ID from subscribeMarketData
     */
    virtual void unsubscribeMarketData(int subscriptionId) = 0;

    /**
     * @brief Set callback for order updates
     * @param callback Function to call on order status changes
     */
    virtual void setOrderCallback(Bubbles::OrderCallback callback) = 0;

    /**
     * @brief Set callback for connection events
     * @param callback Function to call on connection changes
     */
    virtual void setConnectionCallback(Bubbles::ConnectionCallback callback) = 0;

    /**
     * @brief Check if client is connected
     * @return true if connected
     */
    virtual bool isConnected() const = 0;

    /**
     * @brief Get server time
     * @return Current server timestamp
     */
    virtual TradingSystem::Timestamp getServerTime() = 0;
};

/**
 * @class MarketDataClient
 * @brief Read-only market data client for price feeds
 * 
 * No authentication required for market data.
 * 
 * Example:
 * @code
 * auto market = MarketDataClient::connect("ws://localhost:8081");
 * market.subscribeTicker({1}, [](const MarketTick& tick) {
 *     std::cout << "BTC/USDT: " << tick.ask << std::endl;
 * });
 * @endcode
 */
class MarketDataClient {
public:
    static std::shared_ptr<MarketDataClient> connect(const std::string& endpoint);

    virtual ~MarketDataClient() = default;

    /**
     * @brief Get current ticker for a symbol
     * @param symbol Symbol ID
     * @return Latest market tick
     */
    virtual std::optional<Bubbles::MarketTick> getTicker(TradingSystem::SymbolId symbol) = 0;

    /**
     * @brief Get order book for a symbol
     * @param symbol Symbol ID
     * @param depth Order book depth
     * @return Bid/Ask levels
     */
    virtual std::pair<std::vector<Bubbles::MarketTick>, std::vector<Bubbles::MarketTick>> 
        getOrderBook(TradingSystem::SymbolId symbol, int depth = 20) = 0;

    /**
     * @brief Get candlestick data
     * @param symbol Symbol ID
     * @param interval Candle interval in seconds
     * @param startTime Start timestamp
     * @param endTime End timestamp
     * @return List of candles
     */
    virtual std::vector<Bubbles::Candle> getCandles(
        TradingSystem::SymbolId symbol,
        int interval,
        TradingSystem::Timestamp startTime,
        TradingSystem::Timestamp endTime) = 0;

    /**
     * @brief Subscribe to real-time ticker updates
     * @param symbols Symbol IDs
     * @param callback Callback for each tick
     * @return Subscription ID
     */
    virtual int subscribeTicker(const std::vector<TradingSystem::SymbolId>& symbols, 
                                 Bubbles::MarketDataCallback callback) = 0;

    /**
     * @brief Subscribe to order book updates
     * @param symbols Symbol IDs
     * @param depth Order book depth
     * @param callback Callback for order book updates
     * @return Subscription ID
     */
    virtual int subscribeOrderBook(const std::vector<TradingSystem::SymbolId>& symbols,
                                    int depth,
                                    std::function<void(TradingSystem::SymbolId, const std::vector<Bubbles::MarketTick>&, const std::vector<Bubbles::MarketTick>&)> callback) = 0;

    virtual void unsubscribe(int subscriptionId) = 0;
    virtual bool isConnected() const = 0;
};

/**
 * @class RESTClient
 * @brief HTTP REST client for additional operations
 * 
 * Useful for historical data and account management.
 */
class RESTClient {
public:
    static std::shared_ptr<RESTClient> create(const std::string& baseUrl);

    virtual ~RESTClient() = default;

    /**
     * @brief Get exchange information
     * @return Exchange details and supported symbols
     */
    virtual std::string getExchangeInfo() = 0;

    /**
     * @brief Get list of trading pairs
     * @return Vector of symbol information
     */
    virtual std::vector<std::string> getTradingPairs() = 0;

    /**
     * @brief Get historical trades
     * @param symbol Symbol ID
     * @param limit Number of trades (max 1000)
     * @return List of recent trades
     */
    virtual std::string getTrades(TradingSystem::SymbolId symbol, int limit = 100) = 0;

    /**
     * @brief Get aggregated trades
     * @param symbol Symbol ID
     * @param startTime Start timestamp
     * @param endTime End timestamp
     * @return List of aggregated trades
     */
    virtual std::string getAggTrades(TradingSystem::SymbolId symbol, 
                                      TradingSystem::Timestamp startTime,
                                      TradingSystem::Timestamp endTime) = 0;

    /**
     * @brief Get 24hr ticker statistics
     * @param symbol Symbol ID (optional, all if null)
     * @return 24hr statistics
     */
    virtual std::string get24hrTicker(std::optional<TradingSystem::SymbolId> symbol = std::nullopt) = 0;
};

} // namespace Bubbles::API
