import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { SupabaseAuthGuard } from '../src/auth/supabase-auth.guard';
import { TradingController } from '../src/trading/trading.controller';
import { TradingEngineService } from '../src/trading/trading-engine.service';

describe('TradingController (e2e)', () => {
  let app: INestApplication;
  let tradingService: {
    getMarketData: jest.Mock;
    getPortfolio: jest.Mock;
  };

  const authGuard: CanActivate = {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      req.auth = {
        userId: 'auth_user_1',
        sessionId: 'session_1',
        claims: { email: 'ada@example.com' },
      };
      return true;
    },
  };

  beforeEach(async () => {
    tradingService = {
      getMarketData: jest.fn().mockReturnValue({
        price: 150.25,
        volume: 12000,
        timestamp: '2026-07-04T00:00:00.000Z',
        status: 'active',
      }),
      getPortfolio: jest.fn().mockReturnValue({
        userId: 'auth_user_1',
        balance: 10000,
        positions: [],
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TradingController],
      providers: [{ provide: TradingEngineService, useValue: tradingService }],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue(authGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // Exercises the authenticated market-data route over HTTP.
  it('serves market data over HTTP', async () => {
    await request(app.getHttpServer())
      .get('/trading/market')
      .expect(200)
      .expect({
        price: 150.25,
        volume: 12000,
        timestamp: '2026-07-04T00:00:00.000Z',
        status: 'active',
      });

    expect(tradingService.getMarketData).toHaveBeenCalledTimes(1);
  });

  // Ensures the HTTP portfolio route forwards guard-provided identity.
  it('passes the authenticated user to the portfolio service call', async () => {
    await request(app.getHttpServer())
      .get('/trading/portfolio')
      .expect(200)
      .expect({
        userId: 'auth_user_1',
        balance: 10000,
        positions: [],
      });

    expect(tradingService.getPortfolio).toHaveBeenCalledWith('auth_user_1');
  });
});
