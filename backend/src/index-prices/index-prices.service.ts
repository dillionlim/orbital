import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface InstrumentDef {
  symbol: string;
  kind: 'index' | 'etf' | 'future';
  yahoo?: string;
  massive?: string; // US-listed ETF ticker on Massive (api.massive.com)
  twelveData?: string;
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
    twelveData: 'N225',
    tz: 'Asia/Tokyo',
    openHour: 9,
    closeHour: 15,
  },
  {
    symbol: 'HSI',
    kind: 'index',
    yahoo: '^HSI',
    twelveData: 'HSI',
    tz: 'Asia/Hong_Kong',
    openHour: 9,
    closeHour: 16,
  },
  {
    symbol: 'KOSPI',
    kind: 'index',
    yahoo: '^KS11',
    twelveData: 'KS11',
    tz: 'Asia/Seoul',
    openHour: 9,
    closeHour: 15,
  },
  {
    symbol: 'STOXX50',
    kind: 'index',
    yahoo: '^STOXX50E',
    twelveData: 'STOXX50E',
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
  }, // S&P 500
  {
    symbol: 'NKD',
    kind: 'future',
    yahoo: 'NKD=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  }, // Nikkei 225
  {
    symbol: 'NQ',
    kind: 'future',
    yahoo: 'NQ=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  }, // Nasdaq-100
  {
    symbol: 'YM',
    kind: 'future',
    yahoo: 'YM=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  }, // Dow Jones
  {
    symbol: 'RTY',
    kind: 'future',
    yahoo: 'RTY=F',
    tz: 'America/New_York',
    openHour: 0,
    closeHour: 24,
    always: true,
  }, // Russell 2000
  // ETF markets tracking the same indices
  {
    symbol: 'SPY',
    kind: 'etf',
    massive: 'SPY',
    yahoo: 'SPY',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  }, // S&P 500
  {
    symbol: 'EWJ',
    kind: 'etf',
    massive: 'EWJ',
    yahoo: 'EWJ',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  }, // Japan / Nikkei
  {
    symbol: 'EWH',
    kind: 'etf',
    massive: 'EWH',
    yahoo: 'EWH',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  }, // Hong Kong / HSI
  {
    symbol: 'EWY',
    kind: 'etf',
    massive: 'EWY',
    yahoo: 'EWY',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  }, // Korea / KOSPI
  {
    symbol: 'FEZ',
    kind: 'etf',
    massive: 'FEZ',
    yahoo: 'FEZ',
    tz: 'America/New_York',
    openHour: 9,
    closeHour: 16,
  }, // Euro Stoxx 50
];

interface CacheEntry {
  price: number;
  ts: number; // epoch ms of last successful fetch
  open: boolean; // was the market considered open at fetch time
  source: 'yahoo' | 'twelvedata' | 'massive';
}

const STALE_CLOSED_MS = 10 * 60 * 1000;

// Each instrument polls on its own timer at this cadence, independently — a slow
// fetch on one symbol never delays another (so the ES future stays ~1s fresh
// even if an ETF fetch is throttled).
const POLL_MS = 1000;

// Cash-index return graphs.
const HISTORY_MS = 11 * 60 * 1000; // rolling 1s samples kept for the 10-min graph
const RETURN_WINDOW_MS = 10 * 60 * 1000;
const DAILY_REFRESH_MS = 45 * 1000; // how often the intraday daily series is refetched

export interface Sample {
  t: number;
  p: number;
}

// Evenly thin a series down to at most `max` points (keeps first and last).
function downsample(arr: Sample[], max: number): Sample[] {
  if (arr.length <= max) return arr;
  const out: Sample[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

@Injectable()
export class IndexPricesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexPricesService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private tdKeys: string[] = [];
  private tdCursor = 0;
  private massiveKey = '';
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inflight = new Set<string>();
  // Cash-index return graphs: rolling 1s samples + a cached intraday series.
  private readonly history = new Map<string, Sample[]>();
  private readonly daily = new Map<
    string,
    { ts: number; prevClose: number; series: Sample[] }
  >();

  constructor(private readonly http: HttpService) {}

  async onModuleInit(): Promise<void> {
    this.tdKeys = (process.env.TWELVEDATA_API_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    this.massiveKey = (process.env.MASSIVE_API_KEY ?? '').trim();
    const indexCount = INSTRUMENTS.filter((i) => i.kind === 'index').length;
    const etfCount = INSTRUMENTS.filter((i) => i.kind === 'etf').length;
    this.logger.log(
      `index-prices: tracking ${indexCount} indices + ${etfCount} ETFs; ` +
        `${this.tdKeys.length} TD key(s), Massive ${this.massiveKey ? 'on' : 'off'}`,
    );
    await this.refreshSet(INSTRUMENTS);
    // One independent timer per instrument so a slow/throttled fetch on one
    // symbol never holds up the others.
    for (const def of INSTRUMENTS) {
      this.timers.push(setInterval(() => void this.pollOne(def), POLL_MS));
    }
    // Cash-index intraday daily series (for the daily return graph), on its own
    // slower timer.
    await Promise.all(INSTRUMENTS.map((d) => this.refreshDaily(d)));
    this.timers.push(
      setInterval(() => {
        for (const d of INSTRUMENTS) void this.refreshDaily(d);
      }, DAILY_REFRESH_MS),
    );
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  // Poll a single instrument, skipping if its previous fetch is still running.
  private async pollOne(def: InstrumentDef): Promise<void> {
    if (this.inflight.has(def.symbol)) return;
    this.inflight.add(def.symbol);
    try {
      await this.refreshOne(def, Date.now());
    } finally {
      this.inflight.delete(def.symbol);
    }
  }

  private async refreshSet(list: InstrumentDef[]): Promise<void> {
    const now = Date.now();
    await Promise.all(list.map((def) => this.refreshOne(def, now)));
  }

  private async refreshOne(def: InstrumentDef, now: number): Promise<void> {
    const open = def.always || this.isMarketOpen(def);
    const cached = this.cache.get(def.symbol);
    // Closed market with a recent value → skip the request (price won't move).
    if (!open && cached && now - cached.ts < STALE_CLOSED_MS) return;

    // Yahoo first (real-time for indices and US ETFs); Massive is a delayed
    // fallback for ETFs; Twelve Data a last resort.
    let price: number | null = null;
    let source: CacheEntry['source'] = 'yahoo';
    if (def.yahoo) {
      price = await this.fetchYahoo(def);
      if (price != null) source = 'yahoo';
    }
    if (price == null && def.massive && this.massiveKey) {
      price = await this.fetchMassive(def);
      if (price != null) source = 'massive';
    }
    if (price == null && def.twelveData && this.tdKeys.length) {
      price = await this.fetchTwelveData(def);
      if (price != null) source = 'twelvedata';
    }
    if (price != null && Number.isFinite(price) && price > 0) {
      this.cache.set(def.symbol, { price, ts: now, open, source });
      this.pushHistory(def.symbol, now, price);
    } else if (!cached) {
      this.logger.warn(`index-prices: no price yet for ${def.symbol}`);
    }
  }

  private pushHistory(symbol: string, t: number, p: number): void {
    let buf = this.history.get(symbol);
    if (!buf) {
      buf = [];
      this.history.set(symbol, buf);
    }
    buf.push({ t, p });
    const cutoff = t - HISTORY_MS;
    while (buf.length && buf[0].t < cutoff) buf.shift();
  }

  // Fetch the intraday series + previous close for a cash index (for the daily
  // return graph). Cached; refreshed on the DAILY_REFRESH_MS timer.
  private async refreshDaily(def: InstrumentDef): Promise<void> {
    if (!def.yahoo) return;
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
      if (!r) return;
      const prevClose: number =
        r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? 0;
      const ts: number[] = r.timestamp ?? [];
      const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
      const series: Sample[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === 'number') series.push({ t: ts[i] * 1000, p: c });
      }
      this.daily.set(def.symbol, { ts: Date.now(), prevClose, series });
    } catch (err) {
      this.logger.debug(
        `daily fetch failed for ${def.yahoo}: ${(err as Error).message}`,
      );
    }
  }

  getPrices() {
    const prices: Record<string, number> = {};
    const meta: Record<string, { ts: number; open: boolean; source: string }> =
      {};
    for (const [sym, e] of this.cache) {
      prices[sym] = e.price;
      meta[sym] = { ts: e.ts, open: e.open, source: e.source };
    }
    return { prices, meta, ts: Date.now() };
  }

  // Display-only cash indices with live price, 10-min and daily returns, and the
  // two series for the return graphs. Consumed by the dashboard's Indices panel.
  getIndices() {
    const indices = INSTRUMENTS.filter((i) => i.kind === 'index').map((def) => {
      const live = this.cache.get(def.symbol);
      const price = live?.price ?? null;
      const buf = this.history.get(def.symbol) ?? [];
      const daily = this.daily.get(def.symbol);
      const prevClose = daily?.prevClose ?? 0;

      // 10-minute return + series from the rolling 1s samples.
      let return10m: number | null = null;
      let series10m: Sample[] = [];
      if (buf.length) {
        const cutoff = buf[buf.length - 1].t - RETURN_WINDOW_MS;
        const window = buf.filter((s) => s.t >= cutoff);
        series10m = downsample(window, 80);
        if (window.length >= 2 && window[0].p > 0) {
          return10m = (window[window.length - 1].p - window[0].p) / window[0].p;
        }
      }

      // Daily return vs the previous close.
      const returnDay =
        price != null && prevClose > 0 ? (price - prevClose) / prevClose : null;

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
    });
    return { indices, ts: Date.now() };
  }

  // Return series (in %) for every instrument, for the standalone returns chart.
  // seriesDay is vs the previous close; series10m is vs the start of the window.
  getReturns() {
    const instruments = INSTRUMENTS.map((def) => {
      const live = this.cache.get(def.symbol);
      const price = live?.price ?? null;
      const daily = this.daily.get(def.symbol);
      const prevClose = daily?.prevClose ?? 0;
      const buf = this.history.get(def.symbol) ?? [];

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
      if (buf.length) {
        const cutoff = buf[buf.length - 1].t - RETURN_WINDOW_MS;
        const window = buf.filter((s) => s.t >= cutoff);
        if (window.length && window[0].p > 0) {
          const base = window[0].p;
          series10m = downsample(window, 120).map((s) => ({
            t: s.t,
            r: ((s.p - base) / base) * 100,
          }));
          return10m = ((window[window.length - 1].p - base) / base) * 100;
        }
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
    });
    return { instruments, ts: Date.now() };
  }

  // Real historical OHLC from Yahoo, mapped to the backtester's trade shape (one
  // synthetic trade per bar at the close). `range`/`interval` are validated.
  async getCandles(symbol: string, range: string, interval: string) {
    const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y']);
    const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1d']);
    const r = RANGES.has(range) ? range : '1mo';
    const iv = INTERVALS.has(interval) ? interval : '1d';

    const def = INSTRUMENTS.find(
      (i) => i.symbol.toLowerCase() === symbol.toLowerCase(),
    );
    const yahoo = def?.yahoo ?? symbol;
    const wire = def?.symbol ?? symbol;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}`;

    const res = await firstValueFrom(
      this.http.get(url, {
        params: { range: r, interval: iv },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000,
      }),
    );
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

  private async fetchMassive(def: InstrumentDef): Promise<number | null> {
    if (!def.massive || !this.massiveKey) return null;
    const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(def.massive)}`;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          params: { apiKey: this.massiveKey },
          timeout: 3000,
        }),
      );
      const t = res.data?.ticker;
      const price = t?.lastTrade?.p ?? t?.day?.c ?? t?.prevDay?.c ?? t?.min?.c;
      return typeof price === 'number' && price > 0 ? price : null;
    } catch (err) {
      this.logger.debug(
        `massive fetch failed for ${def.massive}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async fetchYahoo(def: InstrumentDef): Promise<number | null> {
    if (!def.yahoo) return null;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(def.yahoo)}`;
    try {
      const res = await firstValueFrom(
        this.http.get(url, {
          params: { interval: '1m', range: '1d' },
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 3000,
        }),
      );
      const price = res.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return typeof price === 'number' ? price : null;
    } catch (err) {
      this.logger.debug(
        `yahoo fetch failed for ${def.yahoo}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async fetchTwelveData(def: InstrumentDef): Promise<number | null> {
    if (!def.twelveData || !this.tdKeys.length) return null;
    const key = this.tdKeys[this.tdCursor % this.tdKeys.length];
    this.tdCursor++;
    try {
      const res = await firstValueFrom(
        this.http.get('https://api.twelvedata.com/price', {
          params: { symbol: def.twelveData, apikey: key },
          timeout: 3000,
        }),
      );
      if (res.data?.status === 'error' || res.data?.price == null) return null;
      const price = parseFloat(res.data.price);
      return Number.isFinite(price) ? price : null;
    } catch (err) {
      this.logger.debug(
        `twelvedata fetch failed for ${def.twelveData}: ${(err as Error).message}`,
      );
      return null;
    }
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
