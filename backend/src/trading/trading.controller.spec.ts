import { TradingEngineService } from './trading-engine.service';
import { TradingController } from './trading.controller';

describe('TradingController', () => {
  let service: {
    getMarketData: jest.Mock;
    getPortfolio: jest.Mock;
  };
  let controller: TradingController;

  beforeEach(() => {
    service = {
      getMarketData: jest.fn(),
      getPortfolio: jest.fn(),
    };
    controller = new TradingController(service as unknown as TradingEngineService);
  });

  // Confirms market reads pass through to the trading service.
  it('returns market data from the trading service', () => {
    const market = {
      price: 150.25,
      volume: 12000,
      timestamp: '2026-07-04T00:00:00.000Z',
      status: 'active',
    };
    service.getMarketData.mockReturnValue(market);

    expect(controller.getMarketData()).toBe(market);
  });

  // Ensures portfolio reads are scoped to the authenticated user.
  it('uses the authenticated user id when loading a portfolio', () => {
    const portfolio = { userId: 'auth_user_1', balance: 10000, positions: [] };
    service.getPortfolio.mockReturnValue(portfolio);

    const req = {
      auth: {
        userId: 'auth_user_1',
        sessionId: 'session_1',
        claims: {},
      },
    };

    expect(controller.getPortfolio(req as any)).toBe(portfolio);
    expect(service.getPortfolio).toHaveBeenCalledWith('auth_user_1');
  });
});
