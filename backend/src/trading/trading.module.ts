import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingEngineService } from './trading-engine.service';

@Module({
  controllers: [TradingController],
  providers: [TradingEngineService],
})
export class TradingModule {}
