import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { IndexPricesService, Sample } from './index-prices.service';

interface Internals {
  cache: Map<
    string,
    { price: number; ts: number; open: boolean; source: string }
  >;
  history: Map<string, Sample[]>;
  daily: Map<string, { ts: number; prevClose: number; series: Sample[] }>;
  massiveKey: string;
  fetchYahoo: (def: unknown) => Promise<number | null>;
  fetchMassive: (def: unknown) => Promise<number | null>;
  refreshOne: (def: unknown, now: number) => Promise<void>;
  pushHistory: (symbol: string, t: number, p: number) => void;
}

describe('IndexPricesService', () => {
  let service: IndexPricesService;
  let internals: Internals;
  let httpGet: jest.Mock;

  beforeEach(async () => {
    httpGet = jest.fn();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IndexPricesService,
        { provide: HttpService, useValue: { get: httpGet } },
      ],
    }).compile();

    service = moduleRef.get(IndexPricesService);
    internals = service as unknown as Internals;
  });

  describe('getPrices', () => {
    it('returns cached prices and meta', () => {
      internals.cache.set('ES', {
        price: 7400,
        ts: 111,
        open: true,
        source: 'yahoo',
      });

      const out = service.getPrices();

      expect(out.prices.ES).toBe(7400);
      expect(out.meta.ES).toEqual({ ts: 111, open: true, source: 'yahoo' });
    });

    it('returns empty maps when nothing is cached', () => {
      const out = service.getPrices();

      expect(out.prices).toEqual({});
      expect(out.meta).toEqual({});
    });
  });

  describe('getIndices', () => {
    it('returns only the four cash indices', () => {
      const symbols = service
        .getIndices()
        .indices.map((i) => i.symbol)
        .sort();

      expect(symbols).toEqual(['HSI', 'KOSPI', 'NIKKEI', 'STOXX50']);
    });

    it('computes the daily return from the previous close', () => {
      internals.cache.set('NIKKEI', {
        price: 110,
        ts: 1,
        open: true,
        source: 'yahoo',
      });
      internals.daily.set('NIKKEI', { ts: 1, prevClose: 100, series: [] });

      const row = service
        .getIndices()
        .indices.find((i) => i.symbol === 'NIKKEI');

      expect(row?.returnDay).toBeCloseTo(0.1);
    });

    it('computes the 10-minute return from rolling samples', () => {
      const now = 10_000_000;
      internals.cache.set('HSI', {
        price: 220,
        ts: now,
        open: true,
        source: 'yahoo',
      });
      internals.history.set('HSI', [
        { t: now - 60_000, p: 200 },
        { t: now, p: 220 },
      ]);

      const row = service.getIndices().indices.find((i) => i.symbol === 'HSI');

      expect(row?.return10m).toBeCloseTo(0.1);
    });

    it('excludes samples older than the 10-minute window', () => {
      const now = 10_000_000;
      internals.history.set('KOSPI', [
        { t: now - 20 * 60_000, p: 100 },
        { t: now - 60_000, p: 200 },
        { t: now, p: 220 },
      ]);

      const row = service
        .getIndices()
        .indices.find((i) => i.symbol === 'KOSPI');

      expect(row?.return10m).toBeCloseTo(0.1);
    });

    it('downsamples the daily series to at most 120 points keeping both ends', () => {
      const series: Sample[] = Array.from({ length: 500 }, (_, i) => ({
        t: i,
        p: i,
      }));
      internals.daily.set('STOXX50', { ts: 1, prevClose: 1, series });

      const row = service
        .getIndices()
        .indices.find((i) => i.symbol === 'STOXX50');

      expect(row?.series1d.length).toBeLessThanOrEqual(120);
      expect(row?.series1d[0]).toEqual({ t: 0, p: 0 });
      expect(row?.series1d[row.series1d.length - 1]).toEqual({
        t: 499,
        p: 499,
      });
    });

    it('returns null fields when data is missing', () => {
      const row = service.getIndices().indices.find((i) => i.symbol === 'HSI');

      expect(row?.price).toBeNull();
      expect(row?.returnDay).toBeNull();
      expect(row?.return10m).toBeNull();
    });
  });

  describe('refreshOne source priority', () => {
    const def = {
      symbol: 'SPY',
      kind: 'etf',
      yahoo: 'SPY',
      massive: 'SPY',
      tz: 'America/New_York',
      openHour: 9,
      closeHour: 16,
      always: true,
    };

    it('prefers Yahoo and does not call Massive when Yahoo succeeds', async () => {
      const massive = jest.fn().mockResolvedValue(999);
      internals.fetchYahoo = jest.fn().mockResolvedValue(500);
      internals.fetchMassive = massive;
      internals.massiveKey = 'key';

      await internals.refreshOne(def, 1);

      expect(internals.cache.get('SPY')).toMatchObject({
        price: 500,
        source: 'yahoo',
      });
      expect(massive).not.toHaveBeenCalled();
    });

    it('falls back to Massive when Yahoo returns null', async () => {
      internals.fetchYahoo = jest.fn().mockResolvedValue(null);
      internals.fetchMassive = jest.fn().mockResolvedValue(321);
      internals.massiveKey = 'key';

      await internals.refreshOne(def, 1);

      expect(internals.cache.get('SPY')).toMatchObject({
        price: 321,
        source: 'massive',
      });
    });
  });

  describe('pushHistory', () => {
    it('drops samples older than the retention window', () => {
      const now = 100_000_000;
      internals.pushHistory('NIKKEI', now - 20 * 60 * 1000, 1);
      internals.pushHistory('NIKKEI', now, 2);

      const buf = internals.history.get('NIKKEI');

      expect(buf).toHaveLength(1);
      expect(buf?.[0].p).toBe(2);
    });
  });

  describe('getReturns', () => {
    it('returns every tracked instrument', () => {
      const out = service.getReturns();

      expect(out.instruments.length).toBe(14);
    });

    it('expresses the daily return as a percent of the previous close', () => {
      internals.cache.set('ES', {
        price: 110,
        ts: 1,
        open: true,
        source: 'yahoo',
      });
      internals.daily.set('ES', {
        ts: 1,
        prevClose: 100,
        series: [{ t: 1, p: 105 }],
      });

      const row = service
        .getReturns()
        .instruments.find((i) => i.symbol === 'ES');

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
      const url = calls[0][0];

      expect(url).toContain('ES%3DF');
      expect(out.count).toBe(2);
      expect(out.trades[0]).toMatchObject({
        price: 12,
        taker_side: 'Buy',
        ts: 100000,
      });
      expect(out.trades[1]).toMatchObject({
        price: 18,
        taker_side: 'Sell',
        ts: 200000,
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
