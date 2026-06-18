import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

import { IndexPricesController } from './index-prices.controller';
import { IndexPricesService } from './index-prices.service';
import { HistoricalDataService } from './historical-data.service';

@Module({
  imports: [HttpModule, ScheduleModule.forRoot()],
  controllers: [IndexPricesController],
  providers: [IndexPricesService, HistoricalDataService],
})
export class IndexPricesModule {}
