import { Logger } from '@nestjs/common';
import { Redis } from '@upstash/redis';
import { Pool } from 'pg';

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
  // Write every symbol's latest in ONE command (vs one hset per symbol).
  setManyLatest(map: Record<string, Latest>): Promise<void>;
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
  // Prefer Postgres (Supabase): no per-command cap like Upstash's free tier, and
  // the backend already runs it. Falls back to Upstash, then in-memory.
  if (process.env.DATABASE_URL) {
    logger?.log('index-prices: using Postgres store');
    return new PostgresPriceStore(process.env.DATABASE_URL);
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    logger?.log('index-prices: using Upstash Redis store');
    return new RedisPriceStore(new Redis({ url, token }));
  }
  logger?.log(
    'index-prices: using in-memory store (set DATABASE_URL or UPSTASH_REDIS_REST_*)',
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

  setManyLatest(map: Record<string, Latest>): Promise<void> {
    for (const [sym, e] of Object.entries(map)) this.latest.set(sym, e);
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

  async setManyLatest(map: Record<string, Latest>): Promise<void> {
    if (Object.keys(map).length === 0) return;
    await this.redis.hset(LATEST_KEY, map);
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

// --- Postgres (Supabase) -------------------------------------------------
//
// Same role as the Redis store, but backed by Postgres so there is no per-command
// quota to exhaust. Tables are created lazily on first use. The fetch throttle is
// kept in-process (per instance) — a distributed lock isn't worth a round trip
// for a low-traffic demo, and each warm instance still fetches at most once per
// interval.

export class PostgresPriceStore implements PriceStore {
  private readonly pool: Pool;
  private readonly locks = new Map<string, number>();
  private schemaReady: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 });
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS idx_latest (
             sym text PRIMARY KEY, price double precision NOT NULL,
             ts bigint NOT NULL, open boolean NOT NULL, source text NOT NULL);
           CREATE TABLE IF NOT EXISTS idx_sample (
             sym text NOT NULL, t bigint NOT NULL, p double precision NOT NULL);
           CREATE INDEX IF NOT EXISTS idx_sample_sym_t ON idx_sample (sym, t);
           CREATE TABLE IF NOT EXISTS idx_daily (
             sym text PRIMARY KEY, ts bigint NOT NULL,
             prev_close double precision NOT NULL, series jsonb NOT NULL);`,
        )
        .then(() => undefined)
        .catch((e: unknown) => {
          this.schemaReady = null; // allow retry on next call
          throw e;
        });
    }
    return this.schemaReady;
  }

  tryAcquireFetch(key: string, intervalMs: number): Promise<boolean> {
    const now = Date.now();
    if (now - (this.locks.get(key) ?? 0) >= intervalMs) {
      this.locks.set(key, now);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  async setLatest(sym: string, e: Latest): Promise<void> {
    await this.setManyLatest({ [sym]: e });
  }

  async setManyLatest(map: Record<string, Latest>): Promise<void> {
    const entries = Object.entries(map);
    if (entries.length === 0) return;
    await this.ensureSchema();
    const values: unknown[] = [];
    const rows = entries.map(([sym, e], i) => {
      const b = i * 5;
      values.push(sym, e.price, e.ts, e.open, e.source);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
    });
    await this.pool.query(
      `INSERT INTO idx_latest (sym, price, ts, open, source) VALUES ${rows.join(',')}
       ON CONFLICT (sym) DO UPDATE SET
         price = EXCLUDED.price, ts = EXCLUDED.ts,
         open = EXCLUDED.open, source = EXCLUDED.source`,
      values,
    );
  }

  async getAllLatest(): Promise<Record<string, Latest>> {
    await this.ensureSchema();
    const res = await this.pool.query<{
      sym: string;
      price: string;
      ts: string;
      open: boolean;
      source: string;
    }>(`SELECT sym, price, ts, open, source FROM idx_latest`);
    const out: Record<string, Latest> = {};
    for (const r of res.rows) {
      out[r.sym] = {
        price: Number(r.price),
        ts: Number(r.ts),
        open: r.open,
        source: r.source,
      };
    }
    return out;
  }

  async appendSample(
    sym: string,
    t: number,
    p: number,
    windowMs: number,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO idx_sample (sym, t, p) VALUES ($1, $2, $3)`,
      [sym, t, p],
    );
    await this.pool.query(`DELETE FROM idx_sample WHERE sym = $1 AND t < $2`, [
      sym,
      t - windowMs,
    ]);
  }

  async getWindow(sym: string, sinceMs: number): Promise<Sample[]> {
    await this.ensureSchema();
    const res = await this.pool.query<{ t: string; p: string }>(
      `SELECT t, p FROM idx_sample WHERE sym = $1 AND t >= $2 ORDER BY t`,
      [sym, sinceMs],
    );
    return res.rows.map((r) => ({ t: Number(r.t), p: Number(r.p) }));
  }

  async setDaily(sym: string, d: Daily): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO idx_daily (sym, ts, prev_close, series) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (sym) DO UPDATE SET
         ts = EXCLUDED.ts, prev_close = EXCLUDED.prev_close, series = EXCLUDED.series`,
      [sym, d.ts, d.prevClose, JSON.stringify(d.series)],
    );
  }

  async getDaily(sym: string): Promise<Daily | null> {
    await this.ensureSchema();
    const res = await this.pool.query<{
      ts: string;
      prev_close: string;
      series: Sample[];
    }>(`SELECT ts, prev_close, series FROM idx_daily WHERE sym = $1`, [sym]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      ts: Number(r.ts),
      prevClose: Number(r.prev_close),
      series: r.series ?? [],
    };
  }
}
