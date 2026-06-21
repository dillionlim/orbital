import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// Serves the generated L1 parquet datasets to the backtester. Two granularities,
// each a directory of per-symbol parquet (zstd) under the repo `data/` dir:
//   daily  -> data/l1_daily_10y/<SYM>.parquet   (~10y, real OHLCV + modeled L1)
//   minute -> data/l1_minute_2y/<SYM>.parquet   (~2y, hourly-interpolated minutes)
// Rows carry real-ish OHLCV plus a MODELED top-of-book (bid/ask); the backtester
// fills buys at ask and sells at bid so the spread actually costs something.

type Granularity = 'daily' | 'minute';

export interface BacktestTrade {
  trade_id: number;
  symbol: string;
  price: number; // close (mid)
  quantity: number;
  taker_side: 'Buy' | 'Sell';
  ts: number;
  bid: number;
  ask: number;
}

const GRAN_DIR: Record<Granularity, string> = {
  daily: 'l1_daily_10y',
  minute: 'l1_minute_2y',
};

const DAY = 86_400_000;
// Lookback window (ms from the latest bar) for each range token.
const RANGE_MS: Record<string, number> = {
  '1d': 1 * DAY,
  '5d': 5 * DAY,
  '1mo': 30 * DAY,
  '3mo': 91 * DAY,
  '6mo': 182 * DAY,
  '1y': 365 * DAY,
  '2y': 730 * DAY,
  '5y': 1826 * DAY,
  '10y': 3653 * DAY,
};

const SYMBOLS = new Set([
  'ES', 'NKD', 'NQ', 'YM', 'RTY', // futures
  'SPY', 'EWJ', 'EWH', 'EWY', 'FEZ', // ETFs
  'NIKKEI', 'HSI', 'KOSPI', 'STOXX50', // cash indices (display-only; notional L1)
]);

// Pyodide does one FFI hop per tick; past ~20k the replay gets sluggish, so we
// stride-downsample longer windows down to this cap (kept whole, lower-res).
const MAX_TRADES = 20_000;

// hyparquet is ESM-only; under `module: nodenext` this dynamic import is
// preserved at runtime (a static import would emit require() and throw).
type Hyparquet = typeof import('hyparquet');
type Compressors = typeof import('hyparquet-compressors');

@Injectable()
export class HistoricalDataService {
  private readonly logger = new Logger(HistoricalDataService.name);
  // Backtester parquet source. Prefer a remote base URL (e.g. a Supabase
  // Storage public bucket) — hyparquet reads it with HTTP range requests, so the
  // ~260 MB of datasets are never bundled into the serverless function. Fall
  // back to a local dir for dev. BOTH come from env (no static path), so
  // Vercel's file-tracer has nothing to pull in.
  //   DATA_BASE_URL        e.g. https://<ref>.supabase.co/storage/v1/object/public/backtest
  //   HISTORICAL_DATA_DIR  e.g. ../data   (local dev)
  private readonly remoteBase = (process.env.DATA_BASE_URL ?? '').replace(/\/+$/, '');
  private readonly localDir = process.env.HISTORICAL_DATA_DIR
    ? path.resolve(process.env.HISTORICAL_DATA_DIR)
    : '';

  private lib: Promise<{ hp: Hyparquet; compressors: Compressors['compressors'] }> | null =
    null;
  // Cache the ts column per file (cheap, ~one number array) so range-slicing on
  // repeat runs doesn't re-decode it.
  private readonly tsCache = new Map<string, number[]>();

  private load() {
    if (!this.lib) {
      this.lib = (async () => {
        const hp = await import('hyparquet');
        const { compressors } = await import('hyparquet-compressors');
        return { hp, compressors };
      })();
    }
    return this.lib;
  }

  async getBacktestTrades(
    symbolRaw: string,
    granularityRaw: string,
    rangeRaw: string,
  ): Promise<{
    symbol: string;
    granularity: Granularity;
    range: string;
    trades: BacktestTrade[];
    count: number;
    stride: number;
  }> {
    const symbol = (symbolRaw ?? '').toUpperCase();
    if (!SYMBOLS.has(symbol)) {
      throw new BadRequestException(`unknown symbol '${symbolRaw}'`);
    }
    const granularity: Granularity =
      granularityRaw === 'daily' ? 'daily' : 'minute';
    const rel = `${GRAN_DIR[granularity]}/${symbol}.parquet`;
    const { hp, compressors } = await this.load();

    // Remote (range-read over HTTP) takes precedence; else local file; else 404.
    let f: Awaited<ReturnType<Hyparquet['asyncBufferFromFile']>>;
    try {
      if (this.remoteBase) {
        f = await hp.asyncBufferFromUrl({ url: `${this.remoteBase}/${rel}` });
      } else if (this.localDir) {
        const file = path.join(this.localDir, rel);
        if (!fs.existsSync(file)) {
          throw new NotFoundException(`no ${granularity} data for ${symbol}`);
        }
        f = await hp.asyncBufferFromFile(file);
      } else {
        throw new NotFoundException(
          'backtester data not configured (set DATA_BASE_URL or HISTORICAL_DATA_DIR)',
        );
      }
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(`no ${granularity} data for ${symbol}`);
    }

    const meta = await hp.parquetMetadataAsync(f);
    const nrows = Number(meta.num_rows);
    if (nrows === 0) {
      return { symbol, granularity, range: rangeRaw, trades: [], count: 0, stride: 1 };
    }

    // ts column (cached) → find the first row inside the lookback window.
    let tsArr = this.tsCache.get(rel);
    if (!tsArr) {
      const tsRows = (await hp.parquetReadObjects({
        file: f,
        compressors,
        columns: ['ts'],
        rowStart: 0,
        rowEnd: nrows,
      })) as Array<{ ts: number | bigint }>;
      tsArr = tsRows.map((r) => Number(r.ts));
      this.tsCache.set(rel, tsArr);
    }
    const lastTs = tsArr[nrows - 1];
    const winMs = RANGE_MS[rangeRaw] ?? RANGE_MS['1mo'];
    const startIdx = lowerBound(tsArr, lastTs - winMs);
    const windowLen = nrows - startIdx;
    const stride = windowLen > MAX_TRADES ? Math.ceil(windowLen / MAX_TRADES) : 1;

    // Decode only the needed columns over the tail row range.
    const rows = (await hp.parquetReadObjects({
      file: f,
      compressors,
      columns: ['ts', 'open', 'close', 'volume', 'bid', 'ask'],
      rowStart: startIdx,
      rowEnd: nrows,
    })) as Array<Record<string, number | bigint | null>>;

    const trades: BacktestTrade[] = [];
    let id = 1;
    for (let i = 0; i < rows.length; i += stride) {
      const r = rows[i];
      const close = Number(r.close);
      const open = Number(r.open);
      const vol = Number(r.volume) || 0;
      trades.push({
        trade_id: id++,
        symbol,
        price: close,
        quantity: Math.max(1, Math.round(vol / 1000) || 1),
        taker_side: close >= open ? 'Buy' : 'Sell',
        ts: Number(r.ts),
        bid: Number(r.bid),
        ask: Number(r.ask),
      });
    }
    this.logger.debug(
      `backtest ${symbol}/${granularity}/${rangeRaw}: ${trades.length} trades (stride ${stride})`,
    );
    return { symbol, granularity, range: rangeRaw, trades, count: trades.length, stride };
  }
}

// First index with arr[i] >= target (arr ascending).
function lowerBound(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
