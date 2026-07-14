import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma.service';
import {
  createPriceStore,
  type Daily,
  type Latest,
  type PriceStore,
  type Sample,
} from './price-store';

export type { Sample } from './price-store';

// The slice of Yahoo's v8 chart payload we read.
interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { chartPreviousClose?: number; previousClose?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }> | null;
  };
}

interface InstrumentDef {
  symbol: string;
  kind: 'index' | 'etf' | 'future';
  yahoo?: string;
  tz: string;
  openHour: number; // local session open (24h)
  closeHour: number; // local session close (24h)
  always?: boolean; // futures trade ~around the clock — never gate
}

const INSTRUMENTS: InstrumentDef[] = [
  {
    symbol: 'NIKKEI',
    kind: 'index',
    yahoo: '^N225',
    tz: 'Asia/Tokyo',
    openHour: 9,
    closeHour: 15,
  },
  {
    symbol: 'HSI',
    kind: 'index',
    yahoo: '^HSI',
    tz: 'Asia/Hong_Kong',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'KOSPI',
    kind: 'index',
    yahoo: '^KS11',
    tz: 'Asia/Seoul',
    openHour: 9,
    closeHour: 15,
  },
  {
    symbol: 'STOXX50',
    kind: 'index',
    yahoo: '^STOXX50E',
    tz: 'Europe/Berlin',
    openHour: 9,
    closeHour: 17,
  },
  // Index futures (CME, ~24h via Yahoo) — tradeable, stay live off cash-session.
  {
    symbol: 'ES',
    kind: 'future',
    yahoo: 'ES=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  },
  {
    symbol: 'NKD',
    kind: 'future',
    yahoo: 'NKD=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  },
  {
    symbol: 'NQ',
    kind: 'future',
    yahoo: 'NQ=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  },
  {
    symbol: 'YM',
    kind: 'future',
    yahoo: 'YM=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  },
  {
    symbol: 'RTY',
    kind: 'future',
    yahoo: 'RTY=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  },
  // ETF markets tracking the same indices
  {
    symbol: 'SPY',
    kind: 'etf',
    yahoo: 'SPY',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'EWJ',
    kind: 'etf',
    yahoo: 'EWJ',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'EWH',
    kind: 'etf',
    yahoo: 'EWH',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'EWY',
    kind: 'etf',
    yahoo: 'EWY',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'FEZ',
    kind: 'etf',
    yahoo: 'FEZ',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  },
];

// Cash-index return graphs.
const HISTORY_MS = 11 * 60 * 1000; // rolling samples kept for the 10-min graph
const RETURN_WINDOW_MS = 10 * 60 * 1000;
const DAILY_REFRESH_MS = 45 * 1000; // how often the intraday daily series is refetched
// Floor between live engine fetches — also the effective sampling resolution.
const ENGINE_FETCH_MS = 1500;

// Evenly thin a series down to at most `max` points (keeps first and last).
function downsample(arr: Sample[], max: number): Sample[] {
  if (arr.length <= max) return arr;
  const out: Sample[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

@Injectable()
export class IndexPricesService {
  private readonly logger = new Logger(IndexPricesService.name);
  private readonly store: PriceStore;
  private readonly engineUrl: string;

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {
    this.engineUrl = (
      process.env.TRADING_ENGINE_URL ?? 'http://localhost:9090'
    ).replace(/\/+$/, '');
    // Back the store with the app's Prisma connection (Supabase Postgres).
    this.store = createPriceStore(this.logger, this.prisma);
  }

  // Top up the live prices + rolling samples from the engine, at most once per
  // ENGINE_FETCH_MS across all concurrent readers.
  private async ensureFresh(): Promise<void> {
    if (!(await this.store.tryAcquireFetch('engine', ENGINE_FETCH_MS))) return;
    try {
      const res = await firstValueFrom(
        this.http.get<{ prices?: Record<string, number> }>(
          `${this.engineUrl}/index-prices`,
          { timeout: 3000 },
        ),
      );
      const prices = res.data?.prices ?? {};
      const now = Date.now();
      const latestMap: Record<string, Latest> = {};
      await Promise.all(
        INSTRUMENTS.map(async (def) => {
          const price = prices[def.symbol];
          if (
            typeof price !== 'number' ||
            !Number.isFinite(price) ||
            price <= 0
          ) {
            return;
          }
          const open = def.always || this.isMarketOpen(def);
          latestMap[def.symbol] = { price, ts: now, open, source: 'engine' };
          await this.store.appendSample(def.symbol, now, price, HISTORY_MS);
        }),
      );
      // One write for all symbols instead of one per symbol.
      await this.store.setManyLatest(latestMap);
    } catch (err) {
      this.logger.debug(
        `index-prices: engine fetch failed: ${(err as Error).message}`,
      );
    }
  }

  // Return the cached intraday daily series, refetching from Yahoo (throttled)
  // when missing or older than DAILY_REFRESH_MS.
  private async ensureDaily(def: InstrumentDef): Promise<Daily | null> {
    if (!def.yahoo) return null;
    const existing = await this.store.getDaily(def.symbol);
    if (existing && Date.now() - existing.ts < DAILY_REFRESH_MS)
      return existing;
    if (
      !(await this.store.tryAcquireFetch(
        `daily:${def.symbol}`,
        DAILY_REFRESH_MS,
      ))
    ) {
      return existing; // someone else is refreshing — use the stale copy
    }
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.yahoo)}`;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          params: { interval: '2m', range: '1d' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 3000,
        }),
      );
      const r = res.data?.chart?.result?.[0];
      if (!r) return existing;
      const prevClose: number =
        r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? 0;
      const ts: number[] = r.timestamp ?? [];
      const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
      const series: Sample[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === 'number') series.push({ t: ts[i] * 1000, p: c });
      }
      const daily: Daily = { ts: Date.now(), prevClose, series };
      await this.store.setDaily(def.symbol, daily);
      return daily;
    } catch (err) {
      this.logger.debug(
        `daily fetch failed for ${def.yahoo}: ${(err as Error).message}`,
      );
      return existing;
    }
  }

  async getPrices() {
    await this.ensureFresh();
    const latest = await this.store.getAllLatest();
    const prices: Record<string, number> = {};
    const meta: Record<string, { ts: number; open: boolean; source: string }> =
      {};
    for (const [sym, e] of Object.entries(latest)) {
      prices[sym] = e.price;
      meta[sym] = { ts: e.ts, open: e.open, source: e.source };
    }
    return { prices, meta, ts: Date.now() };
  }

  // Display-only cash indices with live price, 10-min and daily returns, and the
  // two series for the return graphs. Consumed by the dashboard's Indices panel.
  async getIndices() {
    await this.ensureFresh();
    const now = Date.now();
    const latest = await this.store.getAllLatest();
    const indices = await Promise.all(
      INSTRUMENTS.filter((i) => i.kind === 'index').map(async (def) => {
        const [window, daily] = await Promise.all([
          this.store.getWindow(def.symbol, now - RETURN_WINDOW_MS),
          this.ensureDaily(def),
        ]);
        const live = latest[def.symbol];
        const price = live?.price ?? null;
        const prevClose = daily?.prevClose ?? 0;

        let return10m: number | null = null;
        let series10m: Sample[] = [];
        if (window.length) {
          series10m = downsample(window, 80);
          if (window.length >= 2 && window[0].p > 0) {
            return10m =
              (window[window.length - 1].p - window[0].p) / window[0].p;
          }
        }
        const returnDay =
          price != null && prevClose > 0
            ? (price - prevClose) / prevClose
            : null;

        return {
          symbol: def.symbol,
          price,
          open: live?.open ?? false,
          ts: live?.ts ?? 0,
          prevClose,
          return10m,
          returnDay,
          series10m,
          series1d: downsample(daily?.series ?? [], 120),
        };
      }),
    );
    return { indices, ts: now };
  }

  // Return series (in %) for every instrument, for the standalone returns chart.
  async getReturns() {
    await this.ensureFresh();
    const now = Date.now();
    const latest = await this.store.getAllLatest();
    const instruments = await Promise.all(
      INSTRUMENTS.map(async (def) => {
        const [window, daily] = await Promise.all([
          this.store.getWindow(def.symbol, now - RETURN_WINDOW_MS),
          this.ensureDaily(def),
        ]);
        const price = latest[def.symbol]?.price ?? null;
        const prevClose = daily?.prevClose ?? 0;

        const seriesDay =
          daily && prevClose > 0
            ? downsample(daily.series, 200).map((s) => ({
                t: s.t,
                r: ((s.p - prevClose) / prevClose) * 100,
              }))
            : [];
        const returnDay =
          price != null && prevClose > 0
            ? ((price - prevClose) / prevClose) * 100
            : null;

        let series10m: { t: number; r: number }[] = [];
        let return10m: number | null = null;
        if (window.length && window[0].p > 0) {
          const base = window[0].p;
          series10m = downsample(window, 120).map((s) => ({
            t: s.t,
            r: ((s.p - base) / base) * 100,
          }));
          return10m = ((window[window.length - 1].p - base) / base) * 100;
        }

        return {
          symbol: def.symbol,
          kind: def.kind,
          price,
          returnDay,
          return10m,
          seriesDay,
          series10m,
        };
      }),
    );
    return { instruments, ts: now };
  }

  // Real historical OHLC from Yahoo, mapped to the backtester's trade shape (one
  // synthetic trade per bar at the close). `symbol`/`range`/`interval` are validated.
  async getCandles(symbol: string, range: string, interval: string) {
    const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y']);
    const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1d']);
    const r = RANGES.has(range) ? range : '1mo';
    const iv = INTERVALS.has(interval) ? interval : '1d';

    // Only known instruments — forwarding an arbitrary query string to Yahoo
    // would make this endpoint an open unauthenticated relay.
    const def = INSTRUMENTS.find(
      (i) => i.symbol.toLowerCase() === (symbol ?? '').toLowerCase(),
    );
    if (!def?.yahoo) {
      throw new BadRequestException(`unknown symbol '${symbol ?? ''}'`);
    }
    const wire = def.symbol;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.yahoo)}`;

    let res: { data?: YahooChart };
    try {
      res = await firstValueFrom(
        this.http.get<YahooChart>(url, {
          params: { range: r, interval: iv },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 8000,
        }),
      );
    } catch (err) {
      // Yahoo rate-limiting or timing out is not a server error on our side —
      // degrade to an empty series like every other fetch in this service.
      this.logger.debug(
        `candles fetch failed for ${def.yahoo}: ${(err as Error).message}`,
      );
      return { symbol: wire, range: r, interval: iv, trades: [], count: 0 };
    }
    const result = res.data?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0] ?? {};
    const open: (number | null)[] = q.open ?? [];
    const close: (number | null)[] = q.close ?? [];
    const vol: (number | null)[] = q.volume ?? [];

    const trades: {
      trade_id: number;
      symbol: string;
      price: number;
      quantity: number;
      taker_side: 'Buy' | 'Sell';
      ts: number;
    }[] = [];
    let id = 1;
    for (let i = 0; i < ts.length; i++) {
      const c = close[i];
      if (typeof c !== 'number') continue;
      const o = typeof open[i] === 'number' ? (open[i] as number) : c;
      const v = typeof vol[i] === 'number' ? (vol[i] as number) : 0;
      trades.push({
        trade_id: id++,
        symbol: wire,
        price: c,
        quantity: Math.max(1, Math.round(v / 1000) || 1),
        taker_side: c >= o ? 'Buy' : 'Sell',
        ts: ts[i] * 1000,
      });
    }
    return {
      symbol: wire,
      range: r,
      interval: iv,
      trades,
      count: trades.length,
    };
  }

  private isMarketOpen(def: InstrumentDef): boolean {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: def.tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hour =
      parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    return hour >= def.openHour && hour < def.closeHour;
  }
}
