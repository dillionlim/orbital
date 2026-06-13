import { Controller, Get, Query } from '@nestjs/common';
import { IndexPricesService } from './index-prices.service';
import { HistoricalDataService } from './historical-data.service';

@Controller('index-prices')
export class IndexPricesController {
  constructor(
    private readonly indexPrices: IndexPricesService,
    private readonly historical: HistoricalDataService,
  ) {}

  @Get()
  getPrices() {
    return this.indexPrices.getPrices();
  }

  // Display-only cash indices with 10-min / daily returns and graph series.
  @Get('indices')
  getIndices() {
    return this.indexPrices.getIndices();
  }

  // Return series (%) for every instrument, for the standalone returns chart.
  @Get('returns')
  getReturns() {
    return this.indexPrices.getReturns();
  }

  // Real historical candles mapped to backtester trades.
  @Get('candles')
  getCandles(
    @Query('symbol') symbol: string,
    @Query('range') range: string,
    @Query('interval') interval: string,
  ) {
    return this.indexPrices.getCandles(symbol, range, interval);
  }

  // Backtester trades from the generated L1 parquet datasets (with bid/ask).
  // granularity = 'daily' (~10y) | 'minute' (~2y); range e.g. 5y / 1mo / 5d.
  @Get('backtest')
  getBacktest(
    @Query('symbol') symbol: string,
    @Query('granularity') granularity: string,
    @Query('range') range: string,
  ) {
    return this.historical.getBacktestTrades(symbol, granularity, range);
  }
}
