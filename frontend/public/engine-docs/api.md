# Bubbles Trading Engine API

## Overview

Bubbles provides a comprehensive API for building automated trading bots. The API is designed to be:
- **Easy to use**: Simple, intuitive interfaces
- **Fast**: WebSocket-based for real-time data
- **Reliable**: Built for production trading systems

## Quick Start

```cpp
#include <public_api.hpp>

using namespace Bubbles::API;

int main() {
    // Connect to the trading engine
    auto client = TradingClient::connect("ws://localhost:8080");
    
    // Place a buy order
    OrderRequest order{
        .symbol = 1,              // BTC/USDT
        .side = OrderSide::Buy,
        .type = OrderType::Limit,
        .quantity = 100,
        .limitPrice = 50000.0
    };
    
    auto response = client->placeOrder(order);
    std::cout << "Order placed: " << response.orderId << std::endl;
    
    return 0;
}
```

## Connection Endpoints

| Environment | WebSocket | REST API |
|------------|-----------|----------|
| Production | `ws://localhost:8080` | `http://localhost:8080` |
| Market Data | `ws://localhost:8081` | `http://localhost:8081` |

## WebSocket API

### TradingClient

The main client for authenticated trading operations.

```cpp
auto client = TradingClient::connect("ws://localhost:8080");
```

#### Methods

| Method | Description |
|--------|-------------|
| `placeOrder(request)` | Submit a new order |
| `cancelOrder(orderId)` | Cancel an existing order |
| `getOrder(orderId)` | Get order status |
| `getOpenOrders(symbol)` | Get all open orders |
| `getBalances()` | Get account balances |
| `getPositions()` | Get open positions |
| `subscribeMarketData(symbols, callback)` | Subscribe to real-time price feeds |
| `setOrderCallback(callback)` | Receive order updates |
| `getServerTime()` | Get server time |

#### Order Types

```cpp
enum class OrderSide {
    Buy,   // Purchase order
    Sell   // Sell order
};

enum class OrderType {
    Market,     // Execute immediately at best available price
    Limit,      // Execute at specified price or better
    Stop,       // Trigger order when price is reached
    StopLimit   // Limit order triggered by stop price
};
```

#### Example: Place Order

```cpp
OrderRequest order;
order.symbol = 1;              // Symbol ID for BTC/USDT
order.side = OrderSide::Buy;
order.type = OrderType::Limit;
order.quantity = 100;
order.limitPrice = 50000.0;    // Buy at 50000 or lower

auto response = client->placeOrder(order);
std::cout << "Order ID: " << response.orderId << std::endl;
std::cout << "Status: " << response.status << std::endl;
```

#### Example: Subscribe to Market Data

```cpp
client->subscribeMarketData({1, 2, 3}, [](const MarketTick& tick) {
    std::cout << "Symbol " << tick.symbol << ": ";
    std::cout << tick.bid << " / " << tick.ask << std::endl;
});
```

### MarketDataClient

Read-only client for market data. No authentication required.

```cpp
auto market = MarketDataClient::connect("ws://localhost:8081");
```

#### Methods

| Method | Description |
|--------|-------------|
| `getTicker(symbol)` | Get current price |
| `getOrderBook(symbol, depth)` | Get order book |
| `getCandles(symbol, interval, start, end)` | Get historical candles |
| `subscribeTicker(symbols, callback)` | Real-time price updates |
| `subscribeOrderBook(symbols, depth, callback)` | Real-time order book |

#### Candle Intervals

| Interval | Description |
|----------|-------------|
| 60 | 1 minute |
| 300 | 5 minutes |
| 900 | 15 minutes |
| 3600 | 1 hour |
| 86400 | 1 day |

## REST API

### RESTClient

```cpp
auto rest = RESTClient::create("http://localhost:8080");
```

#### Methods

| Method | Description |
|--------|-------------|
| `getExchangeInfo()` | Get exchange metadata |
| `getTradingPairs()` | List all trading pairs |
| `getTrades(symbol, limit)` | Get recent trades |
| `getAggTrades(symbol, start, end)` | Get aggregated trades |
| `get24hrTicker(symbol)` | Get 24hr statistics |

## Data Types

### Price
```cpp
using Price = double;
```

### Quantity
```cpp
using Quantity = uint64_t;
```

### OrderId
```cpp
using OrderId = uint64_t;
```

### SymbolId
```cpp
using SymbolId = uint64_t;
```

### Timestamp
```cpp
using Timestamp = uint64_t;  // Unix timestamp in milliseconds
```

## Error Handling

All methods throw exceptions on critical errors. Check `response.message` for error details:

```cpp
try {
    auto response = client->placeOrder(order);
    if (response.status == OrderStatus::Rejected) {
        std::cerr << "Order rejected: " << response.message << std::endl;
    }
} catch (const std::exception& e) {
    std::cerr << "Connection error: " << e.what() << std::endl;
}
```

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| Orders | 100 per second |
| Market Data | 1000 per second |
| REST API | 60 per minute |

## Best Practices

1. **Use WebSocket for real-time data** - More efficient than polling
2. **Handle reconnections** - Set connection callback to detect disconnects
3. **Use client order IDs** - Track orders across reconnections
4. **Implement idempotency** - Use unique clientOrderId for each order
5. **Subscribe to order updates** - Don't poll for order status

## Security

- Use API keys for authenticated endpoints
- Keep credentials secure
- Implement IP whitelisting
- Use TLS/SSL connections

## Support

- GitHub Issues: Report bugs and feature requests
- Documentation: See `/docs` for full reference
