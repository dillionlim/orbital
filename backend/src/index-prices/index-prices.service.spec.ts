import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { IndexPricesService } from './index-prices.service';
import { MemoryPriceStore, type Sample } from './price-store';

const WINDOW = 11 * 60 * 1000;

// Reach the in-memory store the service builds when UPSTASH_REDIS_REST_* is unset.
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
      ],
    }).compile();

    service = moduleRef.get(IndexPricesService);
    store = storeOf(service);
  });

  describe('getPrices', () => {
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

    it('returns empty maps when nothing is stored', async () => {
      const out = await service.getPrices();
      expect(out.prices).toEqual({});
      expect(out.meta).toEqual({});
    });
  });

  describe('pull-through sampling', () => {
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
    it('returns only the four cash indices', async () => {
      const out = await service.getIndices();
      expect(out.indices.map((i) => i.symbol).sort()).toEqual([
        'HSI',
        'KOSPI',
        'NIKKEI',
        'STOXX50',
      ]);
    });

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

    it('computes the 10-minute return from rolling samples', async () => {
      const now = Date.now();
      await store.appendSample('HSI', now - 60_000, 200, WINDOW);
      await store.appendSample('HSI', now, 220, WINDOW);

      const row = (await service.getIndices()).indices.find(
        (i) => i.symbol === 'HSI',
      );
      expect(row?.return10m).toBeCloseTo(0.1);
    });

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
    it('returns every tracked instrument', async () => {
      const out = await service.getReturns();
      expect(out.instruments.length).toBe(14);
    });

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

    it('clamps an invalid range and interval to defaults', async () => {
      httpGet.mockReturnValue(of(yahoo));
      const out = await service.getCandles('ES', 'bogus', 'bogus');
      expect(out.range).toBe('1mo');
      expect(out.interval).toBe('1d');
    });
  });
});
