import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoricalDataService } from './historical-data.service';

const DAY = 86_400_000;

interface Row {
  ts: number;
  open: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
}

// One row per day, ending today — so a '5d' request maps to a known row count.
function rows(n: number, lastTs = Date.now()): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const ts = lastTs - (n - 1 - i) * DAY;
    return { ts, open: 100 + i, close: 101 + i, volume: 1000, bid: 100.5, ask: 101.5 };
  });
}

// hyparquet is loaded through a dynamic import the service memoizes in `lib`;
// seeding that field swaps in a fake reader without touching the ESM boundary.
function fakeLib(getRows: () => Row[]) {
  const parquetReadObjects = jest.fn(
    ({ rowStart, rowEnd }: { rowStart: number; rowEnd: number }) =>
      Promise.resolve(getRows().slice(rowStart, rowEnd)),
  );
  return {
    parquetReadObjects,
    lib: {
      hp: {
        asyncBufferFromFile: jest.fn(() => Promise.resolve({})),
        asyncBufferFromUrl: jest.fn(),
        parquetMetadataAsync: jest.fn(() =>
          Promise.resolve({ num_rows: getRows().length }),
        ),
        parquetReadObjects,
      },
      compressors: {},
    },
  };
}

describe('HistoricalDataService', () => {
  let dir: string;
  let service: HistoricalDataService;
  let data: Row[];
  let parquetReadObjects: jest.Mock;

  beforeEach(() => {
    // The file is never actually parsed (the reader is faked) but it does have to
    // exist — the service 404s on a missing path before it ever reads.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-'));
    fs.mkdirSync(path.join(dir, 'l1_daily_10y'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'l1_daily_10y', 'ES.parquet'), '');

    delete process.env.DATA_BASE_URL;
    process.env.HISTORICAL_DATA_DIR = dir;
    service = new HistoricalDataService();

    data = rows(3653); // ~10y of daily bars
    const fake = fakeLib(() => data);
    parquetReadObjects = fake.parquetReadObjects;
    (service as unknown as { lib: unknown }).lib = Promise.resolve(fake.lib);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HISTORICAL_DATA_DIR;
  });

  it('rejects an unknown symbol', async () => {
    await expect(
      service.getBacktestTrades('NOPE', 'daily', '5d'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // The window is a lookback from the last bar, so a 5d range on daily bars is a
  // handful of rows out of the ~3.6k in the file.
  it('slices the requested range off the tail of the file', async () => {
    const out = await service.getBacktestTrades('ES', 'daily', '5d');

    expect(out.count).toBeLessThanOrEqual(6);
    expect(out.trades.at(-1)?.ts).toBe(data.at(-1)?.ts);
    expect(out.trades[0]).toMatchObject({ bid: 100.5, ask: 101.5 });
  });

  // The ts column is cached per file to keep repeat runs cheap; nothing should
  // re-decode it while the file is unchanged.
  it('reuses the cached ts column across calls on an unchanged file', async () => {
    await service.getBacktestTrades('ES', 'daily', '5d');
    const tsDecodes = () =>
      parquetReadObjects.mock.calls.filter(
        (c: [{ columns: string[] }]) => c[0].columns.length === 1,
      ).length;
    expect(tsDecodes()).toBe(1);

    await service.getBacktestTrades('ES', 'daily', '1mo');
    expect(tsDecodes()).toBe(1);
  });

  // Regression: the ts cache was keyed by path alone while nrows was re-read
  // fresh. Regenerating the parquet larger under a warm process left tsArr short,
  // so tsArr[nrows-1] was undefined -> NaN -> lowerBound(0) -> the WHOLE 10-year
  // file came back for a '5d' request. Silently wrong backtest data.
  it('re-decodes the ts column when the parquet is regenerated with more rows', async () => {
    const first = await service.getBacktestTrades('ES', 'daily', '5d');
    expect(first.count).toBeLessThanOrEqual(6);

    // The file gets regenerated with a year of extra bars while we're warm.
    data = rows(4018);

    const second = await service.getBacktestTrades('ES', 'daily', '5d');

    expect(second.count).toBeLessThanOrEqual(6);
    expect(second.count).not.toBe(data.length);
    expect(second.trades.at(-1)?.ts).toBe(data.at(-1)?.ts);
  });

  // A corrupt/null ts tail must not fall back to "return everything" — the range
  // the caller asked for is unknowable, so serve nothing.
  it('serves no trades when the ts column is unusable', async () => {
    data = rows(10);
    data[9] = { ...data[9], ts: NaN };

    const out = await service.getBacktestTrades('ES', 'daily', '5d');

    expect(out).toMatchObject({ count: 0, trades: [] });
  });

  it('returns an empty result for a file with no rows', async () => {
    data = [];

    await expect(
      service.getBacktestTrades('ES', 'daily', '5d'),
    ).resolves.toMatchObject({ count: 0, trades: [] });
  });
});
