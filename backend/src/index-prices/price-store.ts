import { Logger } from '@nestjs/common';
import { Redis } from '@upstash/redis';

// Storage backend for the index-price service. Two implementations:
//   - RedisPriceStore: Upstash Redis (HTTP) — used when UPSTASH_REDIS_REST_URL
//     + UPSTASH_REDIS_REST_TOKEN are set. Required on Vercel, where the function
//     keeps no state between invocations.
//   - MemoryPriceStore: in-process maps — used for local dev / always-on hosts
//     with no Upstash configured.
//
// The service samples prices *pull-through on read* (no background timers), so
// either backend works the same way; only persistence across invocations
// differs.

export interface Sample {
  t: number;
  p: number;
}

export interface Latest {
  price: number;
  ts: number;
  open: boolean;
  source: string;
}

export interface Daily {
  ts: number;
  prevClose: number;
  series: Sample[];
}

export interface PriceStore {
  // Throttle/lock: returns true at most once per intervalMs (across all
  // concurrent callers) so a burst of reads triggers a single engine fetch.
  tryAcquireFetch(key: string, intervalMs: number): Promise<boolean>;
  setLatest(sym: string, e: Latest): Promise<void>;
  getAllLatest(): Promise<Record<string, Latest>>;
  // Append a sample and trim anything older than windowMs.
  appendSample(
    sym: string,
    t: number,
    p: number,
    windowMs: number,
  ): Promise<void>;
  getWindow(sym: string, sinceMs: number): Promise<Sample[]>;
  setDaily(sym: string, d: Daily): Promise<void>;
  getDaily(sym: string): Promise<Daily | null>;
}

export function createPriceStore(logger?: Logger): PriceStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    logger?.log('index-prices: using Upstash Redis store');
    return new RedisPriceStore(new Redis({ url, token }));
  }
  logger?.log(
    'index-prices: using in-memory store (set UPSTASH_REDIS_REST_* for Redis)',
  );
  return new MemoryPriceStore();
}

// --- In-memory (local dev / always-on) -----------------------------------

export class MemoryPriceStore implements PriceStore {
  private locks = new Map<string, number>();
  private latest = new Map<string, Latest>();
  private hist = new Map<string, Sample[]>();
  private daily = new Map<string, Daily>();

  tryAcquireFetch(key: string, intervalMs: number): Promise<boolean> {
    const now = Date.now();
    if (now - (this.locks.get(key) ?? 0) >= intervalMs) {
      this.locks.set(key, now);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  setLatest(sym: string, e: Latest): Promise<void> {
    this.latest.set(sym, e);
    return Promise.resolve();
  }

  getAllLatest(): Promise<Record<string, Latest>> {
    return Promise.resolve(Object.fromEntries(this.latest));
  }

  appendSample(
    sym: string,
    t: number,
    p: number,
    windowMs: number,
  ): Promise<void> {
    let buf = this.hist.get(sym);
    if (!buf) {
      buf = [];
      this.hist.set(sym, buf);
    }
    buf.push({ t, p });
    const cutoff = t - windowMs;
    while (buf.length && buf[0].t < cutoff) buf.shift();
    return Promise.resolve();
  }

  getWindow(sym: string, sinceMs: number): Promise<Sample[]> {
    const buf = this.hist.get(sym) ?? [];
    return Promise.resolve(buf.filter((s) => s.t >= sinceMs));
  }

  setDaily(sym: string, d: Daily): Promise<void> {
    this.daily.set(sym, d);
    return Promise.resolve();
  }

  getDaily(sym: string): Promise<Daily | null> {
    return Promise.resolve(this.daily.get(sym) ?? null);
  }
}

// --- Upstash Redis (serverless / Vercel) ---------------------------------

const LATEST_KEY = 'idx:latest';

export class RedisPriceStore implements PriceStore {
  constructor(private readonly redis: Redis) {}

  async tryAcquireFetch(key: string, intervalMs: number): Promise<boolean> {
    // SET NX PX acts as a short-lived lock: the first caller wins, the rest get
    // null until it expires.
    const res = await this.redis.set(`idx:lock:${key}`, '1', {
      nx: true,
      px: intervalMs,
    });
    return res === 'OK';
  }

  async setLatest(sym: string, e: Latest): Promise<void> {
    await this.redis.hset(LATEST_KEY, { [sym]: e });
  }

  async getAllLatest(): Promise<Record<string, Latest>> {
    const all = await this.redis.hgetall<Record<string, Latest>>(LATEST_KEY);
    return all ?? {};
  }

  async appendSample(
    sym: string,
    t: number,
    p: number,
    windowMs: number,
  ): Promise<void> {
    const key = `idx:hist:${sym}`;
    await this.redis.zadd(key, { score: t, member: `${t}:${p}` });
    await this.redis.zremrangebyscore(key, 0, t - windowMs);
    // Self-clean abandoned symbols.
    await this.redis.expire(key, Math.ceil(windowMs / 1000) + 60);
  }

  async getWindow(sym: string, sinceMs: number): Promise<Sample[]> {
    const members = await this.redis.zrange<string[]>(
      `idx:hist:${sym}`,
      sinceMs,
      '+inf',
      { byScore: true },
    );
    return members
      .map((m) => {
        const i = m.indexOf(':');
        return { t: Number(m.slice(0, i)), p: Number(m.slice(i + 1)) };
      })
      .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.p));
  }

  async setDaily(sym: string, d: Daily): Promise<void> {
    await this.redis.set(`idx:daily:${sym}`, d);
  }

  async getDaily(sym: string): Promise<Daily | null> {
    return (await this.redis.get<Daily>(`idx:daily:${sym}`)) ?? null;
  }
}
