import { Injectable } from '@nestjs/common';

@Injectable()
export class TradingEngineService {
  getMarketData() {
    return {
      price: 150.25,
      volume: 12000,
      timestamp: new Date().toISOString(),
      status: 'active',
    };
  }

  placeOrder(order: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return {
      orderId: 'ord_' + Math.random().toString(36).substr(2, 9),
      ...order,
      status: 'filled',
      filledAt: new Date().toISOString(),
    };
  }

  getPortfolio(userId: string) {
    return {
      userId,
      balance: 10000.0,
      positions: [
        { symbol: 'AAPL', quantity: 10, avgPrice: 145.0 },
        { symbol: 'TSLA', quantity: 5, avgPrice: 700.0 },
      ],
    };
  }
}
