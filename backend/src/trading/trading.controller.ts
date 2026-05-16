import { Controller, Get, Req } from '@nestjs/common';
import { TradingEngineService } from './trading-engine.service';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  auth: {
    userId: string;
    sessionId: string;
    claims: any;
  };
}

@Controller('trading')
export class TradingController {
  constructor(private readonly tradingService: TradingEngineService) {}

  @Get('market')
  getMarketData() {
    return this.tradingService.getMarketData();
  }

  @Get('portfolio')
  getPortfolio(@Req() req: AuthenticatedRequest) {
    const userId = req.auth.userId;
    return this.tradingService.getPortfolio(userId);
  }
}
