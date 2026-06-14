import { AxiosResponse } from 'axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma.service';
import { News } from './types/news';
import { firstValueFrom } from 'rxjs';

// Keyless financial RSS feeds. Region-diverse so headlines map across the whole
// tradeable universe (US indices, Japan/Asia ETFs, eurozone). Verified to return
// items; a feed that breaks just yields nothing that cycle (per-feed try/catch).
const RSS_FEEDS: { url: string; category: string; source: string }[] = [
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', category: 'markets', source: 'CNBC' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', category: 'finance', source: 'CNBC' },
  { url: 'https://asia.nikkei.com/rss/feed/nar', category: 'asia', source: 'Nikkei Asia' },
  { url: 'https://finance.yahoo.com/news/rssindex', category: 'markets', source: 'Yahoo Finance' },
  { url: 'https://www.investing.com/rss/news.rss', category: 'markets', source: 'Investing.com' },
];

// Row shape for the Prisma `news` insert (matches the News model).
interface NewsRow {
  id: number;
  category: string;
  headline: string;
  summary: string;
  url: string;
  image?: string;
  source: string;
  datetime: Date;
  related: string;
}

// Strip CDATA/HTML tags and decode the common entities to plain text.
function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the first <tag>…</tag> from an RSS <item> block, cleaned.
function rssTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? clean(m[1]) : '';
}

// Stable positive 31-bit id from a URL (Prisma News.id is Int). FNV-1a.
function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647;
}

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  // Finnhub news categories pulled each cycle. The tradeable universe is equity
  // index futures + regional ETFs, so we pull market-relevant categories
  // (general macro, forex — drives international/Nikkei exposure, M&A) and skip
  // crypto. Querying several yields more distinct headlines; we dedupe overlaps.
  private static readonly CATEGORIES = ['general', 'forex', 'merger'];

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Ingest market news every 30 seconds. RSS feeds are the keyless workhorse
   * (high volume, region-diverse); Finnhub is added on top when a key is set.
   */
  @Cron('*/30 * * * * *')
  async ingestMarketNews(): Promise<void> {
    try {
      const [rss, finnhub] = await Promise.all([
        this.fetchRss(),
        this.fetchFinnhub(),
      ]);

      // Dedupe by id across all sources before the insert.
      const byId = new Map<number, NewsRow>();
      for (const row of [...rss, ...finnhub]) byId.set(row.id, row);
      if (byId.size === 0) return;

      await this.prisma.news.createMany({
        data: [...byId.values()],
        skipDuplicates: true,
      });

      this.logger.log(
        `Ingested ${byId.size} news items (rss=${rss.length}, finnhub=${finnhub.length})`,
      );
    } catch (error) {
      this.logger.error('Failed to ingest market news', error);
    }
  }

  /** Pull + parse all RSS feeds into news rows. Keyless. */
  private async fetchRss(): Promise<NewsRow[]> {
    const batches = await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        try {
          const res = await firstValueFrom(
            this.http.get<string>(feed.url, {
              responseType: 'text',
              timeout: 8000,
              headers: { 'User-Agent': 'Mozilla/5.0 (OrbitalNewsBot)' },
            }),
          );
          const xml = res.data;
          const rows: NewsRow[] = [];
          const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
          for (const block of items) {
            const title = rssTag(block, 'title');
            const link = rssTag(block, 'link') || rssTag(block, 'guid');
            if (!title || !link) continue;
            const when = new Date(rssTag(block, 'pubDate') || rssTag(block, 'dc:date'));
            rows.push({
              id: hashId(link),
              category: feed.category,
              headline: title,
              summary: rssTag(block, 'description') || title,
              url: link,
              source: feed.source,
              datetime: isNaN(when.getTime()) ? new Date() : when,
              related: '',
            });
          }
          return rows;
        } catch {
          return [] as NewsRow[]; // a broken feed shouldn't sink the cycle
        }
      }),
    );
    return batches.flat();
  }

  /** Finnhub market news across categories. Empty when no key is configured. */
  private async fetchFinnhub(): Promise<NewsRow[]> {
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return [];
    const batches = await Promise.all(
      NewsService.CATEGORIES.map((category) =>
        firstValueFrom(
          this.http.get<News[]>('https://finnhub.io/api/v1/news', {
            params: { category, token: apiKey },
          }),
        )
          .then((r: AxiosResponse<News[]>) => r.data)
          .catch(() => [] as News[]),
      ),
    );
    return batches.flat().map((item) => ({
      id: item.id,
      category: item.category,
      headline: item.headline,
      summary: item.summary,
      url: item.url,
      image: item.image,
      source: item.source,
      datetime: new Date(item.datetime * 1000),
      related: item.related,
    }));
  }

  /**
   * Serve cached news
   */
  async getLatestNews(limit = 50) {
    try {
      return await this.prisma.news.findMany({
        orderBy: { datetime: 'desc' },
        take: limit,
      });
    } catch (error) {
      // Distinguish DB-unreachable (transient infra issue) from a real query
      // error: code 'EAI_AGAIN' / 'ENOTFOUND' / 'ETIMEDOUT' / 'P1001' all mean
      // we couldn't talk to the DB. Surface as 503 so callers can retry rather
      // than treating it as "no news exists."
      const code = (error as { code?: string })?.code ?? '';
      const transient = ['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'P1001', 'P1002', 'P1008', 'P1017']
        .includes(code);
      if (transient) {
        this.logger.warn(`getLatestNews: DB unreachable (${code}); returning 503`);
        throw new ServiceUnavailableException({
          error: 'database_unavailable',
          code,
          message: 'News database is temporarily unreachable. Try again shortly.',
        });
      }
      throw error;
    }
  }
}
