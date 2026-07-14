import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { IndexPricesService } from './index-prices.service';
import { PrismaService } from '../prisma.service';
import { MemoryPriceStore, type Sample } from './price-store';

const WINDOW = 11 * 60 * 1000;

// Use in-memory store the service builds .
function storeOf(service: IndexPricesService): MemoryPriceStore {
  return (service as unknown as { store: MemoryPriceStore }).store;
}

describe('IndexPricesService', () => {
  let service: IndexPricesService;
  let store: MemoryPriceStore;
  let httpGet: jest.Mock;

  beforeEach(async () => {
    httpGet = jest.fn();
    // Default: engine + Yahoo both return nothing useful, so ensureFresh /
    // ensureDaily are no-ops and tests see only what they seed.
    httpGet.mockReturnValue(of({ data: {} }));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IndexPricesService,
        { provide: HttpService, useValue: { get: httpGet } },
        { provide: PrismaService, useValue: null },
      ],
    }).compile();

    service = moduleRef.get(IndexPricesService);
    store = storeOf(service);
  });

  describe('getPrices', () => {
    // Checks cached latest prices are exposed with their metadata intact.
    it('returns the latest prices + meta from the store', async () => {
      await store.setLatest('ES', {
        price: 7400,
        ts: 111,
        open: true,
        source: 'engine',
      });

      const out = await service.getPrices();

      expect(out.prices.ES).toBe(7400);
      expect(out.meta.ES).toEqual({ ts: 111, open: true, source: 'engine' });
    });

    // Covers the empty-cache response shape for price reads.
    it('returns empty maps when nothing is stored', async () => {
      const out = await service.getPrices();
      expect(out.prices).toEqual({});
      expect(out.meta).toEqual({});
    });
  });

  describe('pull-through sampling', () => {
    // Verifies pull-through engine reads update both latest price and samples.
    it('fetches the engine on read and records the price', async () => {
      httpGet.mockReturnValue(of({ data: { prices: { NIKKEI: 38000 } } }));

      const out = await service.getPrices();

      expect(out.prices.NIKKEI).toBe(38000);
      expect(out.meta.NIKKEI.source).toBe('engine');
      // A sample should now be in the window.
      const win = await store.getWindow('NIKKEI', 0);
      expect(win.at(-1)?.p).toBe(38000);
    });
  });

  describe('getIndices', () => {
    // Ensures the cash-index endpoint excludes futures and ETFs.
    it('returns only the four cash indices', async () => {
      const out = await service.getIndices();
      expect(out.indices.map((i) => i.symbol).sort()).toEqual([
        'HSI',
        'KOSPI',
        'NIKKEI',
        'STOXX50',
      ]);
    });

    // Pins daily return math against a seeded previous close.
    it('computes the daily return from the previous close', async () => {
      const now = Date.now();
      await store.setLatest('NIKKEI', {
        price: 110,
        ts: now,
        open: true,
        source: 'engine',
      });
      await store.setDaily('NIKKEI', { ts: now, prevClose: 100, series: [] });

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'NIKKEI',
      );
      expect(row?.returnDay).toBeCloseTo(0.1);
    });

    // Checks rolling-window return calculation from in-memory samples.
    it('computes the 10-minute return from rolling samples', async () => {
      const now = Date.now();
      await store.appendSample('HSI', now - 60_000, 200, WINDOW);
      await store.appendSample('HSI', now, 220, WINDOW);

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'HSI',
      );
      expect(row?.return10m).toBeCloseTo(0.1);
    });

    // Protects chart downsampling so endpoints are preserved.
    it('downsamples the daily series to at most 120 points keeping both ends', async () => {
      const now = Date.now();
      const series: Sample[] = Array.from({ length: 500 }, (_, i) => ({
        t: i,
        p: i,
      }));
      await store.setDaily('STOXX50', { ts: now, prevClose: 1, series });

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'STOXX50',
      );
      expect(row?.series1d.length).toBeLessThanOrEqual(120);
      expect(row?.series1d[0]).toEqual({ t: 0, p: 0 });
      expect(row?.series1d.at(-1)).toEqual({ t: 499, p: 499 });
    });

    // Documents the sparse-data response for indices without prices.
    it('returns null fields when data is missing', async () => {
      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'HSI',
      );
      expect(row?.price).toBeNull();
      expect(row?.returnDay).toBeNull();
      expect(row?.return10m).toBeNull();
    });
  });

  describe('getReturns', () => {
    // Ensures the returns endpoint covers the full instrument universe.
    it('returns every tracked instrument', async () => {
      const out = await service.getReturns();
      expect(out.instruments.length).toBe(14);
    });

    // Checks return percentages and series conversion for daily charts.
    it('expresses the daily return as a percent of the previous close', async () => {
      const now = Date.now();
      await store.setLatest('ES', {
        price: 110,
        ts: now,
        open: true,
        source: 'engine',
      });
      await store.setDaily('ES', {
        ts: now,
        prevClose: 100,
        series: [{ t: 1, p: 105 }],
      });

      const row = (await service.getReturns()).instruments.find(
        (i) => i.symbol === 'ES',
      );
      expect(row?.returnDay).toBeCloseTo(10);
      expect(row?.seriesDay[0]).toEqual({ t: 1, r: 5 });
    });
  });

  describe('getCandles', () => {
    const yahoo = {
      data: {
        chart: {
          result: [
            {
              timestamp: [100, 200],
              indicators: {
                quote: [{ open: [10, 20], close: [12, 18], volume: [3000, 0] }],
              },
            },
          ],
        },
      },
    };

    // Verifies Yahoo candle data is normalized into trade-like rows.
    it('maps bars to trades and resolves the Yahoo ticker', async () => {
      httpGet.mockReturnValue(of(yahoo));

      const out = await service.getCandles('ES', '5d', '30m');
      const calls = httpGet.mock.calls as unknown as string[][];
      expect(calls[0][0]).toContain('ES%3DF');
      expect(out.count).toBe(2);
      expect(out.trades[0]).toMatchObject({
        price: 12,
        taker_side: 'Buy',
        ts: 100000,
      });
    });

    // Covers defensive defaulting for unsupported candle query params.
    it('clamps an invalid range and interval to defaults', async () => {
      httpGet.mockReturnValue(of(yahoo));
      const out = await service.getCandles('ES', 'bogus', 'bogus');
      expect(out.range).toBe('1mo');
      expect(out.interval).toBe('1d');
    });

    // Yahoo returns `chart.result: null` for an unknown ticker. That is an empty
    // backtest, not a 500 — the response shape must survive intact.
    it('returns an empty trade list when the payload has no chart result', async () => {
      httpGet.mockReturnValue(of({ data: { chart: { result: null } } }));

      const out = await service.getCandles('ES', '5d', '30m');

      expect(out.count).toBe(0);
      expect(out.trades).toEqual([]);
      expect(out.symbol).toBe('ES');
    });

    // A truncated bar (nulls for a holiday/halted session) is skipped rather than
    // emitted as a NaN-priced trade the backtester would choke on.
    it('drops bars with a null close and defaults missing open/volume', async () => {
      httpGet.mockReturnValue(
        of({
          data: {
            chart: {
              result: [
                {
                  timestamp: [100, 200, 300],
                  indicators: {
                    quote: [
                      {
                        open: [null, 20, null],
                        close: [null, 18, 25],
                        volume: [null, null, null],
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
      );

      const out = await service.getCandles('ES', '5d', '30m');

      expect(out.count).toBe(2);
      // Bar 2: close 18 < open 20 -> a sell; no volume -> minimum size of 1.
      expect(out.trades[0]).toMatchObject({
        price: 18,
        taker_side: 'Sell',
        quantity: 1,
      });
      // Bar 3: no open, so it defaults to the close -> c >= o -> a buy.
      expect(out.trades[1]).toMatchObject({ price: 25, taker_side: 'Buy' });
    });

    // An entirely empty Yahoo body still has to produce a well-formed response.
    it('survives a completely empty payload', async () => {
      httpGet.mockReturnValue(of({ data: {} }));

      await expect(
        service.getCandles('HSI', '1d', '5m'),
      ).resolves.toMatchObject({ count: 0, trades: [] });
    });

    // A missing ?symbol= used to hit `symbol.toLowerCase()` on undefined and 500.
    it('rejects a missing symbol with a 400 instead of throwing a TypeError', async () => {
      await expect(
        service.getCandles(undefined as unknown as string, '5d', '30m'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(httpGet).not.toHaveBeenCalled();
    });

    // An unknown symbol used to be forwarded verbatim to Yahoo, making this
    // endpoint an open unauthenticated relay for arbitrary tickers.
    it('rejects an unknown symbol rather than relaying it to Yahoo', async () => {
      await expect(service.getCandles('AAPL', '5d', '30m')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        service.getCandles('../../etc/passwd', '5d', '30m'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(httpGet).not.toHaveBeenCalled();
    });

    // Yahoo rate-limiting us is not a server error on our side: degrade to an
    // empty series, like every other upstream fetch in this service.
    it('degrades to an empty series when Yahoo fails', async () => {
      httpGet.mockReturnValue(
        throwError(() => new Error('Request failed with status code 429')),
      );

      const out = await service.getCandles('ES', '5d', '30m');

      expect(out).toMatchObject({
        symbol: 'ES',
        range: '5d',
        interval: '30m',
        trades: [],
        count: 0,
      });
    });
  });

  describe('upstream failures', () => {
    // A dead engine must not 500 the dashboard: the price read degrades to the
    // last cached values instead of throwing.
    it('serves cached prices when the engine fetch fails', async () => {
      await store.setLatest('ES', {
        price: 7400,
        ts: 111,
        open: true,
        source: 'engine',
      });
      httpGet.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

      const out = await service.getPrices();

      expect(out.prices.ES).toBe(7400);
      expect(out.meta.ES.source).toBe('engine');
    });

    // With nothing cached and the engine down, the endpoint is empty but healthy.
    it('returns empty maps rather than throwing when the engine is down and the cache is cold', async () => {
      httpGet.mockReturnValue(throwError(() => new Error('socket hang up')));

      await expect(service.getPrices()).resolves.toMatchObject({
        prices: {},
        meta: {},
      });
    });

    // A Yahoo 5xx on the daily series must not take the whole indices panel with
    // it — the rows still render, just without the daily numbers.
    it('still renders every index when the Yahoo daily fetch 5xxs', async () => {
      httpGet.mockReturnValue(
        throwError(() => new Error('Request failed with status code 503')),
      );

      const out = await service.getIndices();

      expect(out.indices.map((i) => i.symbol).sort()).toEqual([
        'HSI',
        'KOSPI',
        'NIKKEI',
        'STOXX50',
      ]);
      expect(out.indices.every((i) => i.returnDay === null)).toBe(true);
      expect(out.indices.every((i) => i.series1d.length === 0)).toBe(true);
    });

    // The daily cache is the fallback: once seeded, a failing refetch serves the
    // stale copy instead of blanking the chart.
    it('falls back to the stale daily series when the refetch fails', async () => {
      await store.setLatest('NIKKEI', {
        price: 110,
        ts: Date.now(),
        open: true,
        source: 'engine',
      });
      // Stale enough to trigger a refetch (DAILY_REFRESH_MS is 45s).
      await store.setDaily('NIKKEI', {
        ts: Date.now() - 120_000,
        prevClose: 100,
        series: [{ t: 1, p: 105 }],
      });
      httpGet.mockReturnValue(throwError(() => new Error('ETIMEDOUT')));

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'NIKKEI',
      );

      expect(row?.prevClose).toBe(100);
      expect(row?.returnDay).toBeCloseTo(0.1);
      expect(row?.series1d).toEqual([{ t: 1, p: 105 }]);
    });

    // A network failure anywhere must leave the returns endpoint serving its full
    // instrument universe with null returns, not an error.
    it('degrades the returns endpoint to nulls on a network failure', async () => {
      httpGet.mockReturnValue(throwError(() => new Error('EAI_AGAIN')));

      const out = await service.getReturns();

      expect(out.instruments.length).toBe(14);
      expect(out.instruments.every((i) => i.price === null)).toBe(true);
      expect(out.instruments.every((i) => i.returnDay === null)).toBe(true);
      expect(out.instruments.every((i) => i.seriesDay.length === 0)).toBe(true);
    });

    // Yahoo answering 200 with `chart.result: null` is indistinguishable from an
    // outage as far as the daily series goes: no data, but no crash either.
    it('ignores a malformed Yahoo daily payload with no chart result', async () => {
      httpGet.mockImplementation((url: string) =>
        url.includes('finance.yahoo.com')
          ? of({ data: { chart: { result: null } } })
          : of({ data: { prices: { NIKKEI: 38000 } } }),
      );

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'NIKKEI',
      );

      // The live engine price still lands; only the daily numbers are missing.
      expect(row?.price).toBe(38000);
      expect(row?.prevClose).toBe(0);
      expect(row?.returnDay).toBeNull();
      expect(row?.series1d).toEqual([]);
    });

    // The engine answering with junk instead of numbers must not poison the
    // store with NaN/negative prices.
    it('ignores non-numeric and non-positive engine prices', async () => {
      httpGet.mockImplementation((url: string) =>
        url.includes('finance.yahoo.com')
          ? of({ data: {} })
          : of({
              data: {
                prices: { ES: 'abc', NQ: -5, YM: 0, SPY: null, NIKKEI: 38000 },
              },
            }),
      );

      const out = await service.getPrices();

      expect(Object.keys(out.prices)).toEqual(['NIKKEI']);
    });
  });
});
